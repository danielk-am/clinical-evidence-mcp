export interface EvidenceSource {
  name: string;
  recordUrl: string;
  identifiers: Record<string, string>;
}

export interface LiteratureRecord {
  title: string;
  authors: string[];
  journal: string | null;
  publishedDate: string | null;
  abstract: string | null;
  citationCount: number | null;
  openAccess: boolean | null;
  source: EvidenceSource;
}

export interface LiteratureSearchResult {
  query: string;
  totalFound: number | null;
  returned: number;
  records: LiteratureRecord[];
  providers: string[];
  warnings: string[];
  retrievedAt: string;
}

export interface TrialRecord {
  nctId: string;
  title: string;
  officialTitle: string | null;
  status: string | null;
  studyType: string | null;
  phases: string[];
  conditions: string[];
  interventions: Array<{ type: string | null; name: string; description: string | null }>;
  sponsor: string | null;
  enrollment: number | null;
  startDate: string | null;
  completionDate: string | null;
  briefSummary: string | null;
  primaryOutcomes: Array<{ measure: string; timeFrame: string | null; description: string | null }>;
  locations: Array<{ facility: string | null; city: string | null; state: string | null; country: string | null }>;
  hasResults: boolean;
  source: EvidenceSource;
}

export interface DrugLabelRecord {
  id: string;
  effectiveTime: string | null;
  brandNames: string[];
  genericNames: string[];
  substanceNames: string[];
  manufacturers: string[];
  indicationsAndUsage: string[];
  boxedWarning: string[];
  warnings: string[];
  contraindications: string[];
  dosageAndAdministration: string[];
  adverseReactions: string[];
  source: EvidenceSource;
}

export interface AdverseEventReaction {
  reaction: string;
  reportCount: number;
}

export interface DrugAdverseEventSummary {
  drug: string;
  seriousOnly: boolean;
  reactions: AdverseEventReaction[];
  returned: number;
  warning: string;
  source: EvidenceSource;
  retrievedAt: string;
}
