import type { AppConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { assertDeidentified, truncateText } from "../privacy.js";
import {
  retrievedAt,
  type FetchImplementation,
  type FetchJsonOptions,
} from "../upstream.js";
import { fetchDataGovSgJson } from "./data-gov-sg.js";
import type {
  SingaporeTherapeuticProductRecord,
  SingaporeTherapeuticProductSearchField,
  SingaporeTherapeuticProductSearchResult,
} from "./types.js";

const DATASET_ID = "d_767279312753558cbf19d48344577084";
const DATASET_NAME = "Listing of Registered Therapeutic Products";
const DATASET_URL = `https://data.gov.sg/datasets/${DATASET_ID}/view`;
const OPEN_DATA_LICENCE_URL = "https://data.gov.sg/open-data-licence";
const DATASTORE_URL = "https://data.gov.sg/api/action/datastore_search";
const METADATA_URL = `https://api-production.data.gov.sg/v2/public/api/datasets/${DATASET_ID}/metadata`;
const METADATA_CACHE_TTL_MS = 60 * 60 * 1_000;

const API_FIELDS: Record<SingaporeTherapeuticProductSearchField, string> = {
  active_ingredient: "active_ingredients",
  product_name: "product_name",
  licence_number: "licence_no",
};

const INGREDIENT_SPELLING_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  aciclovir: ["aciclovir", "acyclovir"],
  acyclovir: ["acyclovir", "aciclovir"],
  valaciclovir: ["valaciclovir", "valacyclovir"],
  valacyclovir: ["valacyclovir", "valaciclovir"],
};

interface DataGovSgSearchResponse {
  success?: boolean;
  result?: {
    total?: number;
    records?: DataGovSgProduct[];
  };
}

interface DataGovSgProduct {
  licence_no?: string;
  product_name?: string;
  license_holder?: string;
  approval_d?: string;
  forensic_classification?: string;
  atc_code?: string;
  dosage_form?: string;
  route_of_administration?: string;
  manufacturer?: string;
  country_of_manufacturer?: string;
  active_ingredients?: string;
  strength?: string;
}

interface DataGovSgMetadataResponse {
  code?: number;
  data?: {
    datasetId?: string;
    name?: string;
    managedBy?: string;
    lastUpdatedAt?: string;
  };
}

type DatasetMetadata = SingaporeTherapeuticProductSearchResult["dataset"];

interface CachedMetadata {
  expiresAt: number;
  value: DatasetMetadata;
}

const metadataCache = new WeakMap<FetchImplementation, CachedMetadata>();
const metadataRequests = new WeakMap<FetchImplementation, Promise<DatasetMetadata>>();

export async function searchSingaporeTherapeuticProducts(
  config: AppConfig,
  input: {
    query: string;
    field: SingaporeTherapeuticProductSearchField;
    limit: number;
  },
  fetchImpl?: FetchImplementation,
): Promise<SingaporeTherapeuticProductSearchResult> {
  const query = assertDeidentified(input.query);
  const searchedQueries = ingredientQueries(query, input.field);
  const headers = config.dataGovSgApiKey
    ? { "x-api-key": config.dataGovSgApiKey }
    : undefined;
  const requestOptions = {
    timeoutMs: config.upstreamTimeoutMs,
    ...(headers ? { headers } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  const [dataset, ...searchResponses] = await Promise.all([
    loadMetadata(requestOptions),
    ...searchedQueries.map((searchQuery) => {
      const url = searchUrl(API_FIELDS[input.field], searchQuery, input.limit);
      return fetchDataGovSgJson<DataGovSgSearchResponse>(url, {
        source: "Singapore HSA therapeutic product register",
        ...requestOptions,
      });
    }),
  ]);

  const totalsByQuery: Record<string, number> = {};
  const recordsByLicence = new Map<string, SingaporeTherapeuticProductRecord>();

  for (const [index, response] of searchResponses.entries()) {
    const total = response.result?.total;
    const products = response.result?.records;
    if (
      response.success !== true ||
      typeof total !== "number" ||
      !Number.isFinite(total) ||
      total < 0 ||
      !Array.isArray(products)
    ) {
      throw new UpstreamError(
        "Singapore HSA therapeutic product register",
        200,
        "Singapore HSA therapeutic product register returned an invalid response.",
      );
    }
    const searchQuery = searchedQueries[index];
    if (searchQuery) totalsByQuery[searchQuery] = total;
    for (const product of products) {
      const record = fromDataGovSgProduct(product);
      if (record && !recordsByLicence.has(record.licenceNumber)) {
        recordsByLicence.set(record.licenceNumber, record);
      }
    }
  }

  const records = [...recordsByLicence.values()].slice(0, input.limit);
  const retrievalTime = retrievedAt();
  return {
    query,
    field: input.field,
    searchedQueries,
    totalFound:
      searchedQueries.length === 1
        ? (totalsByQuery[searchedQueries[0] as string] ?? 0)
        : null,
    totalsByQuery,
    returned: records.length,
    records,
    dataset,
    attribution: `Contains information from ${dataset.name} accessed on ${retrievalTime} from data.gov.sg, made available under the Singapore Open Data Licence version 1.0 (${OPEN_DATA_LICENCE_URL}).`,
    warnings: [
      `This is an HSA dataset snapshot last updated ${dataset.lastUpdatedAt}. Verify current registration in HSA Infosearch before relying on it for patient care.`,
      "A matching record does not establish current stock, retail price, subsidy, comparative effectiveness, recommendation, or suitability for a person.",
      "A missing record is not proof that no registered product exists. Search spelling variants and check the live HSA register.",
      "The Singapore Government and HSA do not endorse this service or its use of the dataset.",
    ],
    retrievedAt: retrievalTime,
  };
}

function ingredientQueries(
  query: string,
  field: SingaporeTherapeuticProductSearchField,
): string[] {
  if (field !== "active_ingredient") return [query];
  return [...(INGREDIENT_SPELLING_VARIANTS[query.toLowerCase()] ?? [query])];
}

function searchUrl(field: string, query: string, limit: number): URL {
  const url = new URL(DATASTORE_URL);
  url.searchParams.set("resource_id", DATASET_ID);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("q", JSON.stringify({ [field]: query }));
  return url;
}

function exactRecordUrl(licenceNumber: string): string {
  return searchUrl("licence_no", licenceNumber, 1).toString();
}

async function loadMetadata(
  options: Omit<FetchJsonOptions, "source">,
): Promise<DatasetMetadata> {
  const fetchKey = options.fetchImpl ?? fetch;
  const cached = metadataCache.get(fetchKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const existingRequest = metadataRequests.get(fetchKey);
  if (existingRequest) return existingRequest;

  const request = fetchDataGovSgJson<DataGovSgMetadataResponse>(new URL(METADATA_URL), {
    source: "data.gov.sg dataset metadata",
    ...options,
  }).then((response) => {
    const value = parseMetadata(response);
    metadataCache.set(fetchKey, {
      expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
      value,
    });
    return value;
  });
  metadataRequests.set(fetchKey, request);
  try {
    return await request;
  } finally {
    if (metadataRequests.get(fetchKey) === request) metadataRequests.delete(fetchKey);
  }
}

function parseMetadata(response: DataGovSgMetadataResponse): DatasetMetadata {
  const data = response.data;
  if (
    response.code !== 0 ||
    data?.datasetId !== DATASET_ID ||
    typeof data.lastUpdatedAt !== "string"
  ) {
    throw new UpstreamError(
      "data.gov.sg dataset metadata",
      200,
      "data.gov.sg dataset metadata returned an invalid response.",
    );
  }
  return {
    id: DATASET_ID,
    name: truncateText(data.name, 500) ?? DATASET_NAME,
    managedBy: truncateText(data.managedBy, 500) ?? "Health Sciences Authority",
    lastUpdatedAt: data.lastUpdatedAt,
    url: DATASET_URL,
    licenceUrl: OPEN_DATA_LICENCE_URL,
  };
}

function fromDataGovSgProduct(
  product: DataGovSgProduct,
): SingaporeTherapeuticProductRecord | null {
  const licenceNumber = truncateText(product.licence_no, 100);
  const productName = truncateText(product.product_name, 1_000);
  if (!licenceNumber || !productName) return null;
  return {
    licenceNumber,
    productName,
    licenceHolder: truncateText(product.license_holder, 1_000),
    approvalDate: normalizeDate(product.approval_d),
    forensicClassification: truncateText(product.forensic_classification, 200),
    atcCode: truncateText(product.atc_code, 100),
    dosageForm: truncateText(product.dosage_form, 500),
    routeOfAdministration: truncateText(product.route_of_administration, 500),
    manufacturer: truncateText(product.manufacturer, 2_000),
    countryOfManufacturer: truncateText(product.country_of_manufacturer, 1_000),
    activeIngredients: truncateText(product.active_ingredients, 2_000),
    strength: truncateText(product.strength, 1_000),
    source: {
      name: "Singapore HSA therapeutic product register via data.gov.sg",
      recordUrl: exactRecordUrl(licenceNumber),
      identifiers: { hsaLicenceNumber: licenceNumber, dataGovSgDatasetId: DATASET_ID },
    },
  };
}

function normalizeDate(value: string | undefined): string | null {
  const cleaned = truncateText(value, 100);
  const matched = cleaned?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return matched ?? cleaned;
}
