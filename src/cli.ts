#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { TokenRegistry } from "./token-registry.js";

async function main(): Promise<void> {
  const [group, command, ...args] = process.argv.slice(2);
  if (group !== "token") {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const registry = new TokenRegistry(loadConfig().dataDir);
  await registry.initialize();

  if (command === "create") {
    const email = option(args, "--email");
    if (!email) {
      throw new Error("token create requires --email EMAIL");
    }
    const result = await registry.createToken(email, option(args, "--label") ?? "default");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "list") {
    process.stdout.write(`${JSON.stringify(await registry.listTokens(), null, 2)}\n`);
    return;
  }

  if (command === "revoke") {
    const tokenId = args.find((value) => !value.startsWith("--"));
    if (!tokenId) {
      throw new Error("token revoke requires TOKEN_ID");
    }
    if (!(await registry.revokeToken(tokenId))) {
      throw new Error("Token was not found or was already revoked.");
    }
    process.stdout.write(`${JSON.stringify({ tokenId, status: "revoked" })}\n`);
    return;
  }

  printUsage();
  process.exitCode = 2;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  clinical-evidence-mcp token create --email EMAIL [--label LABEL]",
      "  clinical-evidence-mcp token list",
      "  clinical-evidence-mcp token revoke TOKEN_ID",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Command failed.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
