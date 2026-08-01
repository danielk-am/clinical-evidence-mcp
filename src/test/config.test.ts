import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

test("loads a complete private syndicated source configuration", () => {
  const config = loadConfig({
    PORT: "3946",
    MCP_PUBLIC_URL: "https://clinical.example.test",
    SYNDICATED_SOURCE_NAME: "Private evidence source",
    SYNDICATED_SOURCE_URL: "http://private-evidence-bridge:4010",
    SYNDICATED_SOURCE_TOKEN: "x".repeat(32),
    SYNDICATED_SOURCE_ALLOWED_ACCOUNT_IDS: "acct_one,acct_two",
    SYNDICATED_SOURCE_LOGIN_PROXY_URL: "http://private-evidence-bridge:6080",
  });

  assert.equal(config.syndicatedSource?.baseUrl, "http://private-evidence-bridge:4010");
  assert.equal(config.syndicatedSource?.name, "Private evidence source");
  assert.equal(config.syndicatedSource?.allowedAccountIds.has("acct_two"), true);
  assert.equal(config.syndicatedSource?.loginProxyUrl, "http://private-evidence-bridge:6080");
});

test("rejects incomplete or publicly exposed plain HTTP source configuration", () => {
  assert.throws(
    () =>
      loadConfig({
        MCP_PUBLIC_URL: "https://clinical.example.test",
        SYNDICATED_SOURCE_URL: "http://private-evidence-bridge:4010",
      }),
    /must be configured together/,
  );

  assert.throws(
    () =>
      loadConfig({
        MCP_PUBLIC_URL: "https://clinical.example.test",
        SYNDICATED_SOURCE_URL: "http://bridge.example.test",
        SYNDICATED_SOURCE_TOKEN: "x".repeat(32),
        SYNDICATED_SOURCE_ALLOWED_ACCOUNT_IDS: "acct_one",
      }),
    /must use HTTPS/,
  );

  assert.throws(
    () =>
      loadConfig({
        MCP_PUBLIC_URL: "https://clinical.example.test",
        SYNDICATED_SOURCE_URL: "http://private-evidence-bridge:4010",
        SYNDICATED_SOURCE_TOKEN: "x".repeat(32),
        SYNDICATED_SOURCE_ALLOWED_ACCOUNT_IDS: "acct_one",
        SYNDICATED_SOURCE_LOGIN_PROXY_URL: "https://public.example.test:6080",
      }),
    /private service hostname/,
  );

  assert.throws(
    () =>
      loadConfig({
        MCP_PUBLIC_URL: "https://clinical.example.test",
        SYNDICATED_SOURCE_URL: "http://private-evidence-bridge:4010",
        SYNDICATED_SOURCE_TOKEN: "x".repeat(32),
        SYNDICATED_SOURCE_ALLOWED_ACCOUNT_IDS: "acct_one",
        SYNDICATED_SOURCE_LOGIN_PROXY_URL: "http://private-evidence-bridge:6080/?secret=x",
      }),
    /must not include/,
  );
});
