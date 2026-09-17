import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../config.js";
import { searchClinicalTrials } from "../providers/clinical-trials.js";
import { fetchDataGovSgJson } from "../providers/data-gov-sg.js";
import { searchDrugLabels } from "../providers/openfda.js";
import { searchSingaporeTherapeuticProducts } from "../providers/singapore-hsa.js";
import { searchSingaporeHealthierSgDrugs } from "../providers/singapore-moh.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3946,
  dataDir: "/tmp/unused",
  publicUrl: "http://127.0.0.1:3946",
  mcpUrl: "http://127.0.0.1:3946/mcp",
  allowedOrigins: new Set(["https://claude.ai"]),
  requestsPerMinute: 60,
  upstreamTimeoutMs: 1_000,
};

test("maps ClinicalTrials.gov records with source metadata", async () => {
  const fetchImpl = mockFetch({
    totalCount: 1,
    studies: [
      {
        hasResults: true,
        protocolSection: {
          identificationModule: { nctId: "NCT12345678", briefTitle: "Example trial" },
          statusModule: { overallStatus: "COMPLETED" },
          designModule: { studyType: "INTERVENTIONAL", phases: ["PHASE3"] },
          conditionsModule: { conditions: ["Example condition"] },
        },
      },
    ],
  });
  const result = await searchClinicalTrials(config, { query: "example trial", limit: 1 }, fetchImpl);
  assert.equal(result.returned, 1);
  assert.equal(result.records[0]?.nctId, "NCT12345678");
  assert.equal(result.records[0]?.source.recordUrl, "https://clinicaltrials.gov/study/NCT12345678");
});

test("maps openFDA labels and preserves direct source attribution", async () => {
  const fetchImpl = mockFetch({
    meta: { results: { total: 1 } },
    results: [
      {
        id: "label-id",
        effective_time: "20250101",
        openfda: { brand_name: ["Example"], generic_name: ["example ingredient"] },
        boxed_warning: ["Example warning"],
      },
    ],
  });
  const result = await searchDrugLabels(config, { drug: "example", limit: 1 }, fetchImpl);
  assert.equal(result.totalFound, 1);
  assert.deepEqual(result.records[0]?.brandNames, ["Example"]);
  assert.equal(result.records[0]?.source.name, "openFDA drug labels");
});

test("fails fast before exceeding local data.gov.sg request capacity", async () => {
  let fetchRequests = 0;
  const fetchImpl = (async () => {
    fetchRequests += 1;
    return jsonResponse({ success: true });
  }) as typeof fetch;
  const url = new URL("https://data.gov.sg/api/action/datastore_search");
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      fetchDataGovSgJson(url, {
        source: "data.gov.sg test",
        timeoutMs: 1_000,
        fetchImpl,
      }),
    ),
  );

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(fetchRequests, 4);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.match(String(rejected?.reason), /reached local data\.gov\.sg request capacity/);
});

test("maps Singapore HSA product records with freshness and licence attribution", async () => {
  const requests: Array<{ url: URL; headers: Headers }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url.pathname.endsWith("/metadata")) {
      return jsonResponse({
        code: 0,
        data: {
          datasetId: "d_767279312753558cbf19d48344577084",
          name: "Listing of Registered Therapeutic Products",
          managedBy: "Health Sciences Authority",
          lastUpdatedAt: "2025-07-06T10:02:29+08:00",
        },
      });
    }
    return jsonResponse({
      success: true,
      result: {
        total: 1,
        records: [
          {
            licence_no: "SIN12345P",
            product_name: "EXAMPLE TABLET 500 MG",
            license_holder: "EXAMPLE PTE LTD",
            approval_d: "2024-05-01 00:00:00",
            forensic_classification: "General Sale List",
            atc_code: "N02BE01",
            dosage_form: "TABLET",
            route_of_administration: "ORAL",
            active_ingredients: "PARACETAMOL",
            strength: "500 MG",
          },
        ],
      },
    });
  }) as typeof fetch;
  const result = await searchSingaporeTherapeuticProducts(
    { ...config, dataGovSgApiKey: "secret-key" },
    { query: "paracetamol", field: "active_ingredient", limit: 5 },
    fetchImpl,
  );

  assert.equal(result.totalFound, 1);
  assert.equal(result.returned, 1);
  assert.equal(result.dataset.lastUpdatedAt, "2025-07-06T10:02:29+08:00");
  assert.equal(result.records[0]?.licenceNumber, "SIN12345P");
  assert.equal(result.records[0]?.approvalDate, "2024-05-01");
  assert.match(result.records[0]?.source.recordUrl ?? "", /licence_no/);
  assert.match(result.attribution, /Singapore Open Data Licence version 1\.0/);
  assert.equal(requests.length, 2);
  assert.equal(requests.every((request) => request.headers.get("x-api-key") === "secret-key"), true);
  const searchRequest = requests.find((request) => request.url.hostname === "data.gov.sg");
  assert.deepEqual(JSON.parse(searchRequest?.url.searchParams.get("q") ?? "{}"), {
    active_ingredients: "paracetamol",
  });
});

test("caches Singapore HSA dataset metadata between searches", async () => {
  let metadataRequests = 0;
  let searchRequests = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/metadata")) {
      metadataRequests += 1;
      return jsonResponse({
        code: 0,
        data: {
          datasetId: "d_767279312753558cbf19d48344577084",
          lastUpdatedAt: "2025-07-06T10:02:29+08:00",
        },
      });
    }
    searchRequests += 1;
    return jsonResponse({ success: true, result: { total: 0, records: [] } });
  }) as typeof fetch;

  await searchSingaporeTherapeuticProducts(
    config,
    { query: "famciclovir", field: "active_ingredient", limit: 5 },
    fetchImpl,
  );
  await searchSingaporeTherapeuticProducts(
    config,
    { query: "famciclovir", field: "active_ingredient", limit: 5 },
    fetchImpl,
  );

  assert.equal(metadataRequests, 1);
  assert.equal(searchRequests, 2);
});

test("searches Singapore antiviral spelling variants without inflating a combined total", async () => {
  const searched: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/metadata")) {
      return jsonResponse({
        code: 0,
        data: {
          datasetId: "d_767279312753558cbf19d48344577084",
          lastUpdatedAt: "2025-07-06T10:02:29+08:00",
        },
      });
    }
    const q = JSON.parse(url.searchParams.get("q") ?? "{}") as {
      active_ingredients?: string;
    };
    searched.push(q.active_ingredients ?? "");
    const suffix = q.active_ingredients === "aciclovir" ? "1" : "2";
    return jsonResponse({
      success: true,
      result: {
        total: 1,
        records: [{ licence_no: `SIN0000${suffix}P`, product_name: `PRODUCT ${suffix}` }],
      },
    });
  }) as typeof fetch;
  const result = await searchSingaporeTherapeuticProducts(
    config,
    { query: "aciclovir", field: "active_ingredient", limit: 10 },
    fetchImpl,
  );

  assert.deepEqual(searched, ["aciclovir", "acyclovir"]);
  assert.equal(result.totalFound, null);
  assert.deepEqual(result.totalsByQuery, { aciclovir: 1, acyclovir: 1 });
  assert.equal(result.returned, 2);
});

test("rejects malformed Singapore HSA search responses instead of reporting zero results", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/metadata")) {
      return jsonResponse({
        code: 0,
        data: {
          datasetId: "d_767279312753558cbf19d48344577084",
          lastUpdatedAt: "2025-07-06T10:02:29+08:00",
        },
      });
    }
    return jsonResponse({ success: true, result: {} });
  }) as typeof fetch;

  await assert.rejects(
    searchSingaporeTherapeuticProducts(
      config,
      { query: "famciclovir", field: "active_ingredient", limit: 5 },
      fetchImpl,
    ),
    /invalid response/,
  );
});

test("accepts a valid empty Singapore HSA search response", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/metadata")) {
      return jsonResponse({
        code: 0,
        data: {
          datasetId: "d_767279312753558cbf19d48344577084",
          lastUpdatedAt: "2025-07-06T10:02:29+08:00",
        },
      });
    }
    return jsonResponse({ success: true, result: { total: 0, records: [] } });
  }) as typeof fetch;
  const result = await searchSingaporeTherapeuticProducts(
    config,
    { query: "famciclovir", field: "active_ingredient", limit: 5 },
    fetchImpl,
  );

  assert.equal(result.totalFound, 0);
  assert.equal(result.returned, 0);
});

test("maps Healthier SG Chronic Tier drugs without overstating subsidy scope", async () => {
  const requests: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith("/metadata")) {
      return jsonResponse({
        code: 0,
        data: {
          datasetId: "d_2a57d4e672be2a52118ae0bf4a0f4a4b",
          name: "Healthier SG Whitelisted Drugs",
          managedBy: "Ministry of Health",
          lastUpdatedAt: "2026-05-25T16:47:32+08:00",
        },
      });
    }
    return jsonResponse({
      success: true,
      result: {
        total: 1,
        records: [{ sn: "3", medication: "Amlodipine 10 mg Tablet", subsidy: "SDL" }],
      },
    });
  }) as typeof fetch;
  const result = await searchSingaporeHealthierSgDrugs(
    config,
    { query: "amlodipine", limit: 5 },
    fetchImpl,
  );

  assert.equal(result.totalFound, 1);
  assert.equal(result.records[0]?.medication, "Amlodipine 10 mg Tablet");
  assert.equal(result.records[0]?.subsidyClass, "SDL");
  assert.equal(result.dataset.lastUpdatedAt, "2026-05-25T16:47:32+08:00");
  assert.match(result.warnings.join(" "), /Chronic Tier/);
  assert.match(result.warnings.join(" "), /not the complete Standard Drug List/);
  const searchRequest = requests.find((request) => request.hostname === "data.gov.sg");
  assert.deepEqual(JSON.parse(searchRequest?.searchParams.get("q") ?? "{}"), {
    medication: "amlodipine",
  });
  const recordUrl = new URL(result.records[0]?.source.recordUrl ?? "https://invalid.example");
  assert.deepEqual(JSON.parse(recordUrl.searchParams.get("filters") ?? "{}"), { sn: "3" });
});

test("caches Healthier SG dataset metadata between searches", async () => {
  let metadataRequests = 0;
  let searchRequests = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/metadata")) {
      metadataRequests += 1;
      return jsonResponse({
        code: 0,
        data: {
          datasetId: "d_2a57d4e672be2a52118ae0bf4a0f4a4b",
          lastUpdatedAt: "2026-05-25T16:47:32+08:00",
        },
      });
    }
    searchRequests += 1;
    return jsonResponse({ success: true, result: { total: 0, records: [] } });
  }) as typeof fetch;

  await searchSingaporeHealthierSgDrugs(config, { query: "missing", limit: 5 }, fetchImpl);
  await searchSingaporeHealthierSgDrugs(config, { query: "missing", limit: 5 }, fetchImpl);

  assert.equal(metadataRequests, 1);
  assert.equal(searchRequests, 2);
});

test("rejects malformed Healthier SG search responses instead of reporting zero results", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/metadata")) {
      return jsonResponse({
        code: 0,
        data: {
          datasetId: "d_2a57d4e672be2a52118ae0bf4a0f4a4b",
          lastUpdatedAt: "2026-05-25T16:47:32+08:00",
        },
      });
    }
    return jsonResponse({ success: true, result: {} });
  }) as typeof fetch;

  await assert.rejects(
    searchSingaporeHealthierSgDrugs(config, { query: "amlodipine", limit: 5 }, fetchImpl),
    /invalid response/,
  );
});

function mockFetch(body: object): typeof fetch {
  return (async () => jsonResponse(body)) as typeof fetch;
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
