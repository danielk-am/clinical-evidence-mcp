import type { AppConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { assertDeidentified, truncateText } from "../privacy.js";
import { fetchJson, retrievedAt, type FetchImplementation } from "../upstream.js";
import type { DrugAdverseEventSummary, DrugLabelRecord } from "./types.js";

interface OpenFdaLabel {
  id?: string;
  set_id?: string;
  effective_time?: string;
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    substance_name?: string[];
    manufacturer_name?: string[];
  };
  indications_and_usage?: string[];
  boxed_warning?: string[];
  warnings?: string[];
  warnings_and_cautions?: string[];
  contraindications?: string[];
  dosage_and_administration?: string[];
  adverse_reactions?: string[];
}

interface OpenFdaLabelResponse {
  meta?: { results?: { total?: number } };
  results?: OpenFdaLabel[];
}

interface OpenFdaCountResponse {
  results?: Array<{ term?: string; count?: number }>;
}

export async function searchDrugLabels(
  config: AppConfig,
  input: { drug: string; limit: number },
  fetchImpl?: FetchImplementation,
): Promise<{
  drug: string;
  totalFound: number | null;
  returned: number;
  records: DrugLabelRecord[];
  retrievedAt: string;
}> {
  const drug = assertDeidentified(input.drug);
  const url = new URL("https://api.fda.gov/drug/label.json");
  url.searchParams.set("search", drugSearch(drug, "openfda"));
  url.searchParams.set("limit", String(input.limit));
  try {
    const response = await fetchJson<OpenFdaLabelResponse>(url, {
      source: "openFDA drug labels",
      timeoutMs: config.upstreamTimeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const records = (response.results ?? []).map(fromOpenFdaLabel);
    return {
      drug,
      totalFound:
        typeof response.meta?.results?.total === "number" ? response.meta.results.total : null,
      returned: records.length,
      records,
      retrievedAt: retrievedAt(),
    };
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) {
      return { drug, totalFound: 0, returned: 0, records: [], retrievedAt: retrievedAt() };
    }
    throw error;
  }
}

export async function getDrugAdverseEventSummary(
  config: AppConfig,
  input: { drug: string; seriousOnly: boolean; limit: number },
  fetchImpl?: FetchImplementation,
): Promise<DrugAdverseEventSummary> {
  const drug = assertDeidentified(input.drug);
  const url = new URL("https://api.fda.gov/drug/event.json");
  const search = drugSearch(drug, "patient.drug.openfda");
  url.searchParams.set("search", input.seriousOnly ? `(${search}) AND serious:1` : search);
  url.searchParams.set("count", "patient.reaction.reactionmeddrapt.exact");
  url.searchParams.set("limit", String(input.limit));

  let reactions: DrugAdverseEventSummary["reactions"] = [];
  try {
    const response = await fetchJson<OpenFdaCountResponse>(url, {
      source: "openFDA adverse event reports",
      timeoutMs: config.upstreamTimeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    reactions = (response.results ?? [])
      .filter((item) => typeof item.term === "string" && typeof item.count === "number")
      .map((item) => ({ reaction: item.term as string, reportCount: item.count as number }));
  } catch (error) {
    if (!(error instanceof UpstreamError) || error.status !== 404) throw error;
  }

  return {
    drug,
    seriousOnly: input.seriousOnly,
    reactions,
    returned: reactions.length,
    warning:
      "FAERS reports are voluntary and incomplete. Report counts do not establish causation, incidence, prevalence, or comparative risk.",
    source: {
      name: "openFDA drug adverse events",
      recordUrl: "https://open.fda.gov/apis/drug/event/",
      identifiers: {},
    },
    retrievedAt: retrievedAt(),
  };
}

function fromOpenFdaLabel(label: OpenFdaLabel): DrugLabelRecord {
  const id = label.id ?? "unknown";
  const stableId = label.set_id ?? id;
  return {
    id,
    effectiveTime: truncateText(label.effective_time, 100),
    brandNames: cleanList(label.openfda?.brand_name, 20, 500),
    genericNames: cleanList(label.openfda?.generic_name, 20, 500),
    substanceNames: cleanList(label.openfda?.substance_name, 30, 500),
    manufacturers: cleanList(label.openfda?.manufacturer_name, 20, 500),
    indicationsAndUsage: cleanList(label.indications_and_usage, 5, 8_000),
    boxedWarning: cleanList(label.boxed_warning, 5, 8_000),
    warnings: cleanList([...(label.warnings ?? []), ...(label.warnings_and_cautions ?? [])], 5, 8_000),
    contraindications: cleanList(label.contraindications, 5, 8_000),
    dosageAndAdministration: cleanList(label.dosage_and_administration, 5, 8_000),
    adverseReactions: cleanList(label.adverse_reactions, 5, 8_000),
    source: {
      name: "openFDA drug labels",
      recordUrl: openFdaLabelUrl(id),
      identifiers: { setId: stableId, revisionId: id },
    },
  };
}

function openFdaLabelUrl(id: string): string {
  const url = new URL("https://api.fda.gov/drug/label.json");
  url.searchParams.set("search", `id:\"${id.replace(/["\\]/g, "")}\"`);
  url.searchParams.set("limit", "1");
  return url.toString();
}

function drugSearch(drug: string, prefix: string): string {
  const escaped = drug.replace(/["\\]/g, " ").trim();
  return ["brand_name", "generic_name", "substance_name"]
    .map((field) => `${prefix}.${field}:\"${escaped}\"`)
    .join(" OR ");
}

function cleanList(values: string[] | undefined, limit: number, maxLength: number): string[] {
  return (values ?? [])
    .map((value) => truncateText(value, maxLength))
    .filter((value): value is string => value !== null)
    .slice(0, limit);
}
