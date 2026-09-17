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
  SingaporeHealthierSgDrugRecord,
  SingaporeHealthierSgDrugSearchResult,
} from "./types.js";

const DATASET_ID = "d_2a57d4e672be2a52118ae0bf4a0f4a4b";
const DATASET_NAME = "Healthier SG Whitelisted Drugs";
const DATASET_URL = `https://data.gov.sg/datasets/${DATASET_ID}/view`;
const OPEN_DATA_LICENCE_URL = "https://data.gov.sg/open-data-licence";
const DATASTORE_URL = "https://data.gov.sg/api/action/datastore_search";
const METADATA_URL = `https://api-production.data.gov.sg/v2/public/api/datasets/${DATASET_ID}/metadata`;
const METADATA_CACHE_TTL_MS = 60 * 60 * 1_000;

interface DataGovSgSearchResponse {
  success?: boolean;
  result?: {
    total?: number;
    records?: HealthierSgDrug[];
  };
}

interface HealthierSgDrug {
  sn?: string;
  medication?: string;
  subsidy?: string;
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

type DatasetMetadata = SingaporeHealthierSgDrugSearchResult["dataset"];

interface CachedMetadata {
  expiresAt: number;
  value: DatasetMetadata;
}

const metadataCache = new WeakMap<FetchImplementation, CachedMetadata>();
const metadataRequests = new WeakMap<FetchImplementation, Promise<DatasetMetadata>>();

export async function searchSingaporeHealthierSgDrugs(
  config: AppConfig,
  input: { query: string; limit: number },
  fetchImpl?: FetchImplementation,
): Promise<SingaporeHealthierSgDrugSearchResult> {
  const query = assertDeidentified(input.query);
  const headers = config.dataGovSgApiKey
    ? { "x-api-key": config.dataGovSgApiKey }
    : undefined;
  const requestOptions = {
    timeoutMs: config.upstreamTimeoutMs,
    ...(headers ? { headers } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  const url = searchUrl(query, input.limit);
  const [dataset, searchResponse] = await Promise.all([
    loadMetadata(requestOptions),
    fetchDataGovSgJson<DataGovSgSearchResponse>(url, {
      source: "MOH Healthier SG whitelisted drugs",
      ...requestOptions,
    }),
  ]);
  const total = searchResponse.result?.total;
  const drugs = searchResponse.result?.records;
  if (
    searchResponse.success !== true ||
    typeof total !== "number" ||
    !Number.isFinite(total) ||
    total < 0 ||
    !Array.isArray(drugs)
  ) {
    throw new UpstreamError(
      "MOH Healthier SG whitelisted drugs",
      200,
      "MOH Healthier SG whitelisted drugs returned an invalid response.",
    );
  }

  const records = drugs
    .map(fromHealthierSgDrug)
    .filter(isHealthierSgDrugRecord)
    .slice(0, input.limit);
  const retrievalTime = retrievedAt();
  return {
    query,
    totalFound: total,
    returned: records.length,
    records,
    dataset,
    attribution: `Contains information from ${dataset.name} accessed on ${retrievalTime} from data.gov.sg, made available under the Singapore Open Data Licence version 1.0 (${OPEN_DATA_LICENCE_URL}).`,
    warnings: [
      `This is an MOH dataset snapshot last updated ${dataset.lastUpdatedAt}. Check current Healthier SG guidance before relying on it.`,
      "This dataset covers drugs whitelisted for the Healthier SG Chronic Tier. It is not the complete Standard Drug List, Medication Assistance Fund, or Singapore formulary.",
      "A subsidy class does not establish individual eligibility, subsidy amount, clinic stock, retail price, recommendation, or suitability for a person.",
      "The Singapore Government and MOH do not endorse this service or its use of the dataset.",
    ],
    retrievedAt: retrievalTime,
  };
}

function searchUrl(query: string, limit: number): URL {
  const url = new URL(DATASTORE_URL);
  url.searchParams.set("resource_id", DATASET_ID);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("q", JSON.stringify({ medication: query }));
  return url;
}

function exactRecordUrl(sequenceNumber: string | null, medication: string): string {
  if (!sequenceNumber) return searchUrl(medication, 1).toString();
  const url = new URL(DATASTORE_URL);
  url.searchParams.set("resource_id", DATASET_ID);
  url.searchParams.set("limit", "1");
  url.searchParams.set("filters", JSON.stringify({ sn: sequenceNumber }));
  return url.toString();
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
    managedBy: truncateText(data.managedBy, 500) ?? "Ministry of Health",
    lastUpdatedAt: data.lastUpdatedAt,
    url: DATASET_URL,
    licenceUrl: OPEN_DATA_LICENCE_URL,
  };
}

function fromHealthierSgDrug(drug: HealthierSgDrug): SingaporeHealthierSgDrugRecord | null {
  const medication = truncateText(drug.medication, 2_000);
  if (!medication) return null;
  const sequenceNumber = truncateText(drug.sn, 100);
  return {
    sequenceNumber,
    medication,
    subsidyClass: truncateText(drug.subsidy, 100),
    source: {
      name: "MOH Healthier SG whitelisted drugs via data.gov.sg",
      recordUrl: exactRecordUrl(sequenceNumber, medication),
      identifiers: {
        dataGovSgDatasetId: DATASET_ID,
        ...(sequenceNumber ? { sourceSequenceNumber: sequenceNumber } : {}),
      },
    },
  };
}

function isHealthierSgDrugRecord(
  value: SingaporeHealthierSgDrugRecord | null,
): value is SingaporeHealthierSgDrugRecord {
  return value !== null;
}
