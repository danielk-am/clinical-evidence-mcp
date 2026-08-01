import type { AppConfig } from "../config.js";
import { InputError } from "../errors.js";
import { assertDeidentified, truncateText } from "../privacy.js";
import { fetchJson, retrievedAt, type FetchImplementation } from "../upstream.js";
import type { TrialRecord } from "./types.js";

interface DateStruct {
  date?: string;
}

interface ClinicalTrialsStudy {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string; officialTitle?: string };
    statusModule?: {
      overallStatus?: string;
      startDateStruct?: DateStruct;
      completionDateStruct?: DateStruct;
    };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
    descriptionModule?: { briefSummary?: string };
    conditionsModule?: { conditions?: string[] };
    designModule?: {
      studyType?: string;
      phases?: string[];
      enrollmentInfo?: { count?: number };
    };
    armsInterventionsModule?: {
      interventions?: Array<{ type?: string; name?: string; description?: string }>;
    };
    outcomesModule?: {
      primaryOutcomes?: Array<{ measure?: string; timeFrame?: string; description?: string }>;
    };
    contactsLocationsModule?: {
      locations?: Array<{ facility?: string; city?: string; state?: string; country?: string }>;
    };
  };
  hasResults?: boolean;
}

interface ClinicalTrialsSearchResponse {
  studies?: ClinicalTrialsStudy[];
  totalCount?: number;
}

export interface ClinicalTrialsSearchInput {
  query?: string | undefined;
  condition?: string | undefined;
  intervention?: string | undefined;
  status?: string | undefined;
  country?: string | undefined;
  limit: number;
}

export async function searchClinicalTrials(
  config: AppConfig,
  input: ClinicalTrialsSearchInput,
  fetchImpl?: FetchImplementation,
): Promise<{
  totalFound: number | null;
  returned: number;
  records: TrialRecord[];
  warning: string;
  retrievedAt: string;
}> {
  const url = new URL("https://clinicaltrials.gov/api/v2/studies");
  addOptionalQuery(url, "query.term", input.query);
  addOptionalQuery(url, "query.cond", input.condition);
  addOptionalQuery(url, "query.intr", input.intervention);
  addOptionalQuery(url, "query.locn", input.country);
  if (input.status) url.searchParams.set("filter.overallStatus", input.status);
  if (![input.query, input.condition, input.intervention, input.country, input.status].some(Boolean)) {
    throw new InputError("Provide at least one trial search field.");
  }
  url.searchParams.set("pageSize", String(input.limit));
  url.searchParams.set("countTotal", "true");
  url.searchParams.set("format", "json");

  const response = await fetchJson<ClinicalTrialsSearchResponse>(url, {
    source: "ClinicalTrials.gov",
    timeoutMs: config.upstreamTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const records = (response.studies ?? []).map(fromClinicalTrialsStudy).filter(isTrialRecord);
  return {
    totalFound: typeof response.totalCount === "number" ? response.totalCount : null,
    returned: records.length,
    records,
    warning:
      "ClinicalTrials.gov records are submitted by study sponsors and investigators. Registration does not mean the study has been evaluated or approved by the U.S. government.",
    retrievedAt: retrievedAt(),
  };
}

export async function getClinicalTrial(
  config: AppConfig,
  nctId: string,
  fetchImpl?: FetchImplementation,
): Promise<{ record: TrialRecord | null; warning: string; retrievedAt: string }> {
  const normalized = nctId.trim().toUpperCase();
  if (!/^NCT\d{8}$/.test(normalized)) {
    throw new InputError("Trial identifier must use the NCT######## format.");
  }
  const url = new URL(`https://clinicaltrials.gov/api/v2/studies/${normalized}`);
  url.searchParams.set("format", "json");
  const response = await fetchJson<ClinicalTrialsStudy>(url, {
    source: "ClinicalTrials.gov",
    timeoutMs: config.upstreamTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    record: fromClinicalTrialsStudy(response),
    warning:
      "ClinicalTrials.gov records are submitted by study sponsors and investigators. Registration does not mean the study has been evaluated or approved by the U.S. government.",
    retrievedAt: retrievedAt(),
  };
}

function fromClinicalTrialsStudy(study: ClinicalTrialsStudy): TrialRecord | null {
  const protocol = study.protocolSection;
  const identity = protocol?.identificationModule;
  const nctId = identity?.nctId;
  if (!nctId) return null;
  const status = protocol?.statusModule;
  const design = protocol?.designModule;
  return {
    nctId,
    title: truncateText(identity.briefTitle, 1_000) ?? "Untitled clinical trial",
    officialTitle: truncateText(identity.officialTitle, 1_000),
    status: truncateText(status?.overallStatus, 100),
    studyType: truncateText(design?.studyType, 100),
    phases: design?.phases ?? [],
    conditions: protocol?.conditionsModule?.conditions ?? [],
    interventions: (protocol?.armsInterventionsModule?.interventions ?? [])
      .filter((item) => Boolean(item.name))
      .map((item) => ({
        type: truncateText(item.type, 100),
        name: truncateText(item.name, 500) ?? "Unnamed intervention",
        description: truncateText(item.description, 4_000),
      })),
    sponsor: truncateText(protocol?.sponsorCollaboratorsModule?.leadSponsor?.name, 500),
    enrollment: typeof design?.enrollmentInfo?.count === "number" ? design.enrollmentInfo.count : null,
    startDate: truncateText(status?.startDateStruct?.date, 100),
    completionDate: truncateText(status?.completionDateStruct?.date, 100),
    briefSummary: truncateText(protocol?.descriptionModule?.briefSummary, 8_000),
    primaryOutcomes: (protocol?.outcomesModule?.primaryOutcomes ?? [])
      .filter((item) => Boolean(item.measure))
      .map((item) => ({
        measure: truncateText(item.measure, 1_000) ?? "Unspecified outcome",
        timeFrame: truncateText(item.timeFrame, 1_000),
        description: truncateText(item.description, 4_000),
      })),
    locations: (protocol?.contactsLocationsModule?.locations ?? []).slice(0, 50).map((location) => ({
      facility: truncateText(location.facility, 500),
      city: truncateText(location.city, 200),
      state: truncateText(location.state, 200),
      country: truncateText(location.country, 200),
    })),
    hasResults: study.hasResults === true,
    source: {
      name: "ClinicalTrials.gov",
      recordUrl: `https://clinicaltrials.gov/study/${encodeURIComponent(nctId)}`,
      identifiers: { nct: nctId },
    },
  };
}

function addOptionalQuery(url: URL, name: string, value: string | undefined): void {
  if (value) url.searchParams.set(name, assertDeidentified(value));
}

function isTrialRecord(value: TrialRecord | null): value is TrialRecord {
  return value !== null;
}
