import type { AppConfig } from "../config.js";
import { assertDeidentified, truncateText } from "../privacy.js";
import { fetchJson, retrievedAt, type FetchImplementation } from "../upstream.js";
import type { LiteratureRecord, LiteratureSearchResult } from "./types.js";

interface NcbiSearchResponse {
  esearchresult?: { count?: string; idlist?: string[] };
}

interface NcbiAuthor {
  name?: string;
}

interface NcbiArticleId {
  idtype?: string;
  value?: string;
}

interface NcbiSummary {
  uid?: string;
  title?: string;
  authors?: NcbiAuthor[];
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  sortpubdate?: string;
  articleids?: NcbiArticleId[];
}

interface NcbiSummaryResponse {
  result?: Record<string, NcbiSummary | string[]> & { uids?: string[] };
}

interface EuropePmcRecord {
  title?: string;
  authorString?: string;
  journalTitle?: string;
  firstPublicationDate?: string;
  firstIndexDate?: string;
  abstractText?: string;
  citedByCount?: number;
  isOpenAccess?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  id?: string;
  source?: string;
}

interface EuropePmcResponse {
  hitCount?: number;
  resultList?: { result?: EuropePmcRecord[] };
}

export async function searchLiterature(
  config: AppConfig,
  input: { query: string; limit: number; sort: "relevance" | "newest" },
  fetchImpl?: FetchImplementation,
): Promise<LiteratureSearchResult> {
  const query = assertDeidentified(input.query);
  const [ncbi, europePmc] = await Promise.allSettled([
    searchNcbi(config, query, input.limit, input.sort, fetchImpl),
    searchEuropePmc(config, query, input.limit, input.sort, fetchImpl),
  ]);

  const warnings: string[] = [];
  const providers: string[] = [];
  const records: LiteratureRecord[] = [];
  let totalFound: number | null = null;

  if (europePmc.status === "fulfilled") {
    providers.push("Europe PMC");
    records.push(...europePmc.value.records);
    totalFound = europePmc.value.total;
  } else {
    warnings.push("Europe PMC was unavailable for this request.");
  }

  if (ncbi.status === "fulfilled") {
    providers.push("NCBI PubMed");
    records.push(...ncbi.value.records);
    totalFound ??= ncbi.value.total;
  } else {
    warnings.push("NCBI PubMed was unavailable for this request.");
  }

  if (providers.length === 0) {
    throw new Error("Both literature providers were unavailable.");
  }

  const deduplicated = deduplicateLiterature(records).slice(0, input.limit);
  return {
    query,
    totalFound,
    returned: deduplicated.length,
    records: deduplicated,
    providers,
    warnings,
    retrievedAt: retrievedAt(),
  };
}

export async function getLiteratureArticle(
  config: AppConfig,
  identifier: string,
  fetchImpl?: FetchImplementation,
): Promise<{ record: LiteratureRecord | null; retrievedAt: string }> {
  const cleanIdentifier = assertDeidentified(identifier).replace(/^https?:\/\//i, "");
  const query = articleIdentifierQuery(cleanIdentifier);
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", "1");
  const response = await fetchJson<EuropePmcResponse>(url, {
    source: "Europe PMC",
    timeoutMs: config.upstreamTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const source = response.resultList?.result?.[0];
  return {
    record: source ? fromEuropePmc(source) : null,
    retrievedAt: retrievedAt(),
  };
}

async function searchNcbi(
  config: AppConfig,
  query: string,
  limit: number,
  sort: "relevance" | "newest",
  fetchImpl?: FetchImplementation,
): Promise<{ total: number | null; records: LiteratureRecord[] }> {
  const searchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  searchUrl.searchParams.set("db", "pubmed");
  searchUrl.searchParams.set("retmode", "json");
  searchUrl.searchParams.set("term", query);
  searchUrl.searchParams.set("retmax", String(limit));
  searchUrl.searchParams.set("sort", sort === "newest" ? "pub date" : "relevance");
  addNcbiIdentity(searchUrl, config);
  const search = await fetchJson<NcbiSearchResponse>(searchUrl, {
    source: "NCBI PubMed",
    timeoutMs: config.upstreamTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const ids = search.esearchresult?.idlist ?? [];
  if (ids.length === 0) {
    return { total: parseCount(search.esearchresult?.count), records: [] };
  }

  const summaryUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  summaryUrl.searchParams.set("db", "pubmed");
  summaryUrl.searchParams.set("retmode", "json");
  summaryUrl.searchParams.set("id", ids.join(","));
  addNcbiIdentity(summaryUrl, config);
  const summary = await fetchJson<NcbiSummaryResponse>(summaryUrl, {
    source: "NCBI PubMed",
    timeoutMs: config.upstreamTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const records = ids
    .map((id) => summary.result?.[id])
    .filter((value): value is NcbiSummary => Boolean(value) && !Array.isArray(value))
    .map(fromNcbi);
  return { total: parseCount(search.esearchresult?.count), records };
}

async function searchEuropePmc(
  config: AppConfig,
  query: string,
  limit: number,
  sort: "relevance" | "newest",
  fetchImpl?: FetchImplementation,
): Promise<{ total: number | null; records: LiteratureRecord[] }> {
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", sort === "newest" ? `(${query}) sort_date:y` : query);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", String(limit));
  const response = await fetchJson<EuropePmcResponse>(url, {
    source: "Europe PMC",
    timeoutMs: config.upstreamTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    total: typeof response.hitCount === "number" ? response.hitCount : null,
    records: (response.resultList?.result ?? []).map(fromEuropePmc),
  };
}

function fromNcbi(summary: NcbiSummary): LiteratureRecord {
  const identifiers = Object.fromEntries(
    (summary.articleids ?? [])
      .filter((item) => item.idtype && item.value)
      .map((item) => [String(item.idtype).toLowerCase(), String(item.value)]),
  );
  const pmid = identifiers.pubmed ?? summary.uid ?? "";
  if (pmid) {
    identifiers.pmid = pmid;
  }
  return {
    title: truncateText(summary.title, 1_000) ?? "Untitled PubMed record",
    authors: (summary.authors ?? []).map((author) => author.name).filter(isString),
    journal: truncateText(summary.fulljournalname ?? summary.source, 500),
    publishedDate: truncateText(summary.sortpubdate ?? summary.pubdate, 100),
    abstract: null,
    citationCount: null,
    openAccess: null,
    source: {
      name: "NCBI PubMed",
      recordUrl: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`,
      identifiers,
    },
  };
}

function fromEuropePmc(record: EuropePmcRecord): LiteratureRecord {
  const identifiers: Record<string, string> = {};
  if (record.pmid) identifiers.pmid = record.pmid;
  if (record.pmcid) identifiers.pmcid = record.pmcid;
  if (record.doi) identifiers.doi = record.doi;
  const recordId = record.pmcid ?? record.pmid ?? record.id ?? "";
  const sourceType = record.pmcid ? "PMC" : record.source ?? "MED";
  return {
    title: truncateText(record.title, 1_000) ?? "Untitled Europe PMC record",
    authors: record.authorString
      ? record.authorString.split(",").map((author) => author.trim()).filter(Boolean)
      : [],
    journal: truncateText(record.journalTitle, 500),
    publishedDate: truncateText(record.firstPublicationDate ?? record.firstIndexDate, 100),
    abstract: truncateText(record.abstractText, 8_000),
    citationCount: typeof record.citedByCount === "number" ? record.citedByCount : null,
    openAccess: record.isOpenAccess ? record.isOpenAccess.toUpperCase() === "Y" : null,
    source: {
      name: "Europe PMC",
      recordUrl: `https://europepmc.org/article/${encodeURIComponent(sourceType)}/${encodeURIComponent(recordId)}`,
      identifiers,
    },
  };
}

function deduplicateLiterature(records: LiteratureRecord[]): LiteratureRecord[] {
  const selected = new Map<string, LiteratureRecord>();
  for (const record of records) {
    const key =
      record.source.identifiers.pmid ??
      record.source.identifiers.doi?.toLowerCase() ??
      record.title.toLowerCase();
    const existing = selected.get(key);
    if (!existing || (!existing.abstract && record.abstract)) {
      selected.set(key, mergeRecords(existing, record));
    }
  }
  return [...selected.values()];
}

function mergeRecords(existing: LiteratureRecord | undefined, preferred: LiteratureRecord): LiteratureRecord {
  if (!existing) return preferred;
  return {
    ...preferred,
    authors: preferred.authors.length > 0 ? preferred.authors : existing.authors,
    journal: preferred.journal ?? existing.journal,
    publishedDate: preferred.publishedDate ?? existing.publishedDate,
    abstract: preferred.abstract ?? existing.abstract,
    citationCount: preferred.citationCount ?? existing.citationCount,
    openAccess: preferred.openAccess ?? existing.openAccess,
    source: {
      ...preferred.source,
      identifiers: { ...existing.source.identifiers, ...preferred.source.identifiers },
    },
  };
}

function articleIdentifierQuery(identifier: string): string {
  if (/^PMC\d+$/i.test(identifier)) return `PMCID:${identifier.toUpperCase()}`;
  if (/^\d+$/.test(identifier)) return `EXT_ID:${identifier} AND SRC:MED`;
  return `DOI:"${identifier.replace(/["\\]/g, "")}"`;
}

function addNcbiIdentity(url: URL, config: AppConfig): void {
  url.searchParams.set("tool", "clinical-evidence-mcp");
  if (config.ncbiEmail) url.searchParams.set("email", config.ncbiEmail);
  if (config.ncbiApiKey) url.searchParams.set("api_key", config.ncbiApiKey);
}

function parseCount(value: string | undefined): number | null {
  const count = Number.parseInt(value ?? "", 10);
  return Number.isFinite(count) ? count : null;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
