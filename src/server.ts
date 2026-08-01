import { createServer, type Server as HttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Express, NextFunction, Request, Response } from "express";
import { loadConfig, type AppConfig } from "./config.js";
import { InputError } from "./errors.js";
import { createClinicalEvidenceServer } from "./mcp.js";
import { AccountRateLimiter } from "./rate-limit.js";
import { TokenRegistry, type Principal } from "./token-registry.js";

interface ApplicationDependencies {
  registry?: TokenRegistry;
  rateLimiter?: AccountRateLimiter;
}

interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

export async function createApplication(
  config: AppConfig,
  dependencies: ApplicationDependencies = {},
): Promise<Express> {
  const registry = dependencies.registry ?? new TokenRegistry(config.dataDir);
  const rateLimiter = dependencies.rateLimiter ?? new AccountRateLimiter(config.requestsPerMinute);
  await registry.initialize();

  const publicHostname = new URL(config.publicUrl).hostname;
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: [publicHostname, "clinical-evidence-mcp", "localhost", "127.0.0.1", "[::1]"],
  });
  app.disable("x-powered-by");

  app.get("/healthz", (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json({ status: "ok", service: "clinical-evidence-mcp", version: "0.1.0" });
  });

  app.use("/mcp", validateOrigin(config));
  app.use("/mcp", authenticate(registry));
  app.use("/mcp", (request: AuthenticatedRequest, response, next) => {
    try {
      rateLimiter.consume(requiredPrincipal(request).accountId);
      response.setHeader("cache-control", "no-store");
      next();
    } catch (error) {
      const message = error instanceof InputError ? error.message : "Request rejected.";
      jsonRpcError(response, 429, -32000, message);
    }
  });

  app.post("/mcp", async (request: AuthenticatedRequest, response: Response) => {
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const mcpServer = createClinicalEvidenceServer(config, requiredPrincipal(request));
    try {
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        jsonRpcError(response, 500, -32603, "Internal server error.");
      }
    } finally {
      await mcpServer.close().catch(() => undefined);
    }
  });

  app.get("/mcp", (_request, response) => methodNotAllowed(response));
  app.delete("/mcp", (_request, response) => methodNotAllowed(response));
  app.all("/mcp", (_request, response) => methodNotAllowed(response));

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found." });
  });
  return app;
}

export async function startServer(config = loadConfig()): Promise<HttpServer> {
  const app = await createApplication(config);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write(`clinical-evidence-mcp listening on ${config.mcpUrl}\n`);
  return server;
}

function authenticate(registry: TokenRegistry) {
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    const header = request.header("authorization");
    const match = header?.match(/^Bearer ([A-Za-z0-9_.-]+)$/);
    const principal = match?.[1] ? await registry.verifyToken(match[1]) : null;
    if (!principal) {
      response.setHeader("www-authenticate", 'Bearer realm="clinical-evidence-mcp", error="invalid_token"');
      jsonRpcError(response, 401, -32001, "Invalid or missing bearer token.");
      return;
    }
    request.principal = principal;
    next();
  };
}

function validateOrigin(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    const origin = request.header("origin");
    if (origin && !config.allowedOrigins.has(origin)) {
      jsonRpcError(response, 403, -32000, "Origin is not allowed.");
      return;
    }
    next();
  };
}

function requiredPrincipal(request: AuthenticatedRequest): Principal {
  if (!request.principal) throw new Error("Authentication middleware was not applied.");
  return request.principal;
}

function methodNotAllowed(response: Response): void {
  response.setHeader("allow", "POST");
  jsonRpcError(response, 405, -32600, "Only POST is supported for this stateless MCP endpoint.");
}

function jsonRpcError(response: Response, status: number, code: number, message: string): void {
  response.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer();
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
