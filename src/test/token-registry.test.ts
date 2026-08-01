import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { TokenRegistry } from "../token-registry.js";

test("stores token digests and binds tokens to one email account", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clinical-evidence-token-test-"));
  const registry = new TokenRegistry(dataDir);
  const first = await registry.createToken("Clinician@Example.com", "laptop");
  const second = await registry.createToken("clinician@example.com", "server");

  assert.equal(first.accountId, second.accountId);
  assert.deepEqual(await registry.verifyToken(first.token), {
    accountId: first.accountId,
    tokenId: first.tokenId,
  });
  assert.equal(await registry.verifyToken(`${first.token}x`), null);

  const stored = await readFile(registry.filePath, "utf8");
  assert.equal(stored.includes(first.token), false);
  assert.equal(stored.includes(first.token.split(".")[1] ?? "missing"), false);

  assert.equal(await registry.revokeToken(first.tokenId), true);
  assert.equal(await registry.verifyToken(first.token), null);
  assert.equal((await registry.listTokens())[0]?.status, "revoked");
});
