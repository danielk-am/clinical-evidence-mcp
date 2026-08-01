import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { NextFunction, Request, Response } from "express";

const PATH_PREFIX = "/oe-login";
const COOKIE_NAME = "__Secure-clinical_evidence_login";
const NONCE_TTL_MS = 120_000;
const MAX_SESSION_TTL_MS = 20 * 60_000;

interface ActiveSession {
  sessionId: string;
  nonceDigest: Buffer | null;
  nonceExpiresAt: number;
  cookieDigest: Buffer | null;
  expiresAt: number;
  timer: NodeJS.Timeout;
  sockets: Set<Duplex>;
}

export interface LoginGatewayActivation {
  url: string;
  expiresAt: string;
}

export class SyndicatedLoginGateway {
  private readonly publicOrigin: string;
  private readonly target: URL;
  private active: ActiveSession | null = null;

  constructor(publicUrl: string, targetUrl: string) {
    this.publicOrigin = new URL(publicUrl).origin;
    this.target = new URL(targetUrl);
  }

  activate(sessionId: string, expiresAt: string): LoginGatewayActivation {
    this.invalidate();
    const expiry = Date.parse(expiresAt);
    const now = Date.now();
    if (!Number.isFinite(expiry) || expiry <= now + 15_000 || expiry > now + MAX_SESSION_TTL_MS) {
      throw new Error("Private login session returned an invalid expiry.");
    }

    const nonce = randomBytes(32).toString("base64url");
    const timer = setTimeout(() => this.invalidate(sessionId), expiry - now);
    timer.unref();
    this.active = {
      sessionId,
      nonceDigest: digest(nonce),
      nonceExpiresAt: Math.min(expiry, now + NONCE_TTL_MS),
      cookieDigest: null,
      expiresAt: expiry,
      timer,
      sockets: new Set(),
    };

    return {
      url: `${this.publicOrigin}${PATH_PREFIX}/#${nonce}`,
      expiresAt: new Date(expiry).toISOString(),
    };
  }

  invalidate(sessionId?: string): void {
    const active = this.active;
    if (!active || (sessionId && active.sessionId !== sessionId)) return;
    this.active = null;
    clearTimeout(active.timer);
    for (const socket of active.sockets) socket.destroy();
    active.sockets.clear();
  }

  handler() {
    return (request: Request, response: Response, _next: NextFunction): void => {
      applyBrowserHeaders(response);
      const url = new URL(request.originalUrl, this.publicOrigin);

      if (request.method === "GET" && (url.pathname === PATH_PREFIX || url.pathname === `${PATH_PREFIX}/`)) {
        if (this.hasValidCookie(request.headers.cookie)) {
          response.redirect(302, `${PATH_PREFIX}/vnc.html?autoconnect=1&resize=scale&path=oe-login%2Fws`);
          return;
        }
        this.sendBootstrap(response);
        return;
      }

      if (request.method === "POST" && url.pathname === `${PATH_PREFIX}/session`) {
        this.exchangeNonce(request, response);
        return;
      }

      if (url.pathname === `${PATH_PREFIX}/ws`) {
        response.status(426).json({ error: "upgrade_required" });
        return;
      }

      if (!this.hasValidCookie(request.headers.cookie)) {
        response.status(401).json({ error: "login_session_unauthorised" });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        response.status(405).end();
        return;
      }
      this.proxyHttp(request, response, url);
    };
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? "/", this.publicOrigin);
    if (url.pathname !== `${PATH_PREFIX}/ws`) return false;
    if (
      request.headers.origin !== this.publicOrigin ||
      !this.hasValidCookie(request.headers.cookie)
    ) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return true;
    }

    const active = this.active;
    if (!active) {
      rejectUpgrade(socket, 410, "Gone");
      return true;
    }
    active.sockets.add(socket);
    socket.once("close", () => active.sockets.delete(socket));

    const headers: Record<string, string> = {
      host: this.target.host,
      connection: "Upgrade",
      upgrade: "websocket",
      origin: this.publicOrigin,
    };
    for (const name of [
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-protocol",
      "sec-websocket-extensions",
    ]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }

    const proxyRequest = httpRequest({
      protocol: this.target.protocol,
      hostname: this.target.hostname,
      port: this.target.port,
      method: "GET",
      path: `${this.target.pathname || ""}/websockify`.replace(/\/+/g, "/"),
      headers,
    });
    proxyRequest.once("upgrade", (proxyResponse, proxySocket, proxyHead) => {
      if (!this.isCurrent(active)) {
        proxySocket.destroy();
        socket.destroy();
        return;
      }
      socket.write(`HTTP/1.1 ${proxyResponse.statusCode ?? 101} Switching Protocols\r\n`);
      for (let index = 0; index < proxyResponse.rawHeaders.length; index += 2) {
        const name = proxyResponse.rawHeaders[index];
        const value = proxyResponse.rawHeaders[index + 1];
        if (name && value && name.toLowerCase() !== "set-cookie") {
          socket.write(`${name}: ${value}\r\n`);
        }
      }
      socket.write("\r\n");
      if (proxyHead.length > 0) socket.write(proxyHead);
      if (head.length > 0) proxySocket.write(head);
      proxySocket.once("error", () => socket.destroy());
      socket.once("error", () => proxySocket.destroy());
      proxySocket.pipe(socket).pipe(proxySocket);
    });
    proxyRequest.once("response", (proxyResponse) => {
      proxyResponse.resume();
      rejectUpgrade(socket, 502, "Bad Gateway");
    });
    proxyRequest.once("error", () => rejectUpgrade(socket, 502, "Bad Gateway"));
    proxyRequest.end();
    return true;
  }

  private exchangeNonce(request: Request, response: Response): void {
    if (request.headers.origin !== this.publicOrigin) {
      response.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    const token = isRecord(request.body) && typeof request.body.token === "string"
      ? request.body.token
      : "";
    const active = this.active;
    if (
      !active ||
      !active.nonceDigest ||
      Date.now() >= active.nonceExpiresAt ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !safeDigestEqual(active.nonceDigest, token)
    ) {
      response.status(401).json({ error: "login_session_unauthorised" });
      return;
    }

    const cookie = randomBytes(32).toString("base64url");
    active.nonceDigest = null;
    active.cookieDigest = digest(cookie);
    const maxAge = Math.max(1, Math.floor((active.expiresAt - Date.now()) / 1_000));
    response.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${cookie}; Max-Age=${maxAge}; Path=${PATH_PREFIX}/; HttpOnly; Secure; SameSite=Strict`,
    );
    response.status(204).end();
  }

  private hasValidCookie(cookieHeader: string | undefined): boolean {
    const active = this.active;
    if (!active || !active.cookieDigest || Date.now() >= active.expiresAt) return false;
    const value = parseCookie(cookieHeader, COOKIE_NAME);
    return Boolean(
      value && /^[A-Za-z0-9_-]{43}$/.test(value) && safeDigestEqual(active.cookieDigest, value),
    );
  }

  private sendBootstrap(response: Response): void {
    const nonce = randomBytes(18).toString("base64url");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clinical Evidence sign-in</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:42rem;margin:12vh auto;padding:0 1.5rem;color:#171717}p{line-height:1.5}</style></head>
<body><h1>Secure sign-in</h1><p id="status">Opening private browser session...</p>
<script nonce="${nonce}">const status=document.getElementById("status");const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);if(!token){status.textContent="This sign-in link is missing, expired, or already used.";}else{fetch("${PATH_PREFIX}/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})}).then(response=>{if(!response.ok)throw new Error();location.replace("${PATH_PREFIX}/vnc.html?autoconnect=1&resize=scale&path=oe-login%2Fws");}).catch(()=>{status.textContent="This sign-in link is expired or already used.";});}</script></body></html>`);
  }

  private proxyHttp(request: Request, response: Response, requestUrl: URL): void {
    const relativePath = requestUrl.pathname.slice(PATH_PREFIX.length) || "/";
    const targetPath = `${this.target.pathname}${relativePath}`.replace(/\/+/g, "/") + requestUrl.search;
    const proxyRequest = httpRequest({
      protocol: this.target.protocol,
      hostname: this.target.hostname,
      port: this.target.port,
      method: request.method,
      path: targetPath,
      headers: copySafeRequestHeaders(request, this.target.host),
      signal: AbortSignal.timeout(15_000),
    });
    proxyRequest.once("response", (proxyResponse) => {
      response.statusCode = proxyResponse.statusCode ?? 502;
      copySafeResponseHeaders(proxyResponse, response);
      applyBrowserHeaders(response);
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
      );
      proxyResponse.pipe(response);
    });
    proxyRequest.once("error", () => {
      if (!response.headersSent) response.status(502).json({ error: "login_browser_unavailable" });
      else response.destroy();
    });
    proxyRequest.end();
  }

  private isCurrent(session: ActiveSession): boolean {
    return this.active === session && Date.now() < session.expiresAt;
  }
}

function applyBrowserHeaders(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function copySafeRequestHeaders(request: Request, targetHost: string): Record<string, string> {
  const headers: Record<string, string> = { host: targetHost };
  for (const name of ["accept", "accept-encoding", "accept-language", "range", "user-agent"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function copySafeResponseHeaders(source: IncomingMessage, response: Response): void {
  const blocked = new Set(["connection", "keep-alive", "set-cookie", "transfer-encoding"]);
  for (let index = 0; index < source.rawHeaders.length; index += 2) {
    const name = source.rawHeaders[index];
    const value = source.rawHeaders[index + 1];
    if (name && value && !blocked.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

function parseCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeDigestEqual(expected: Buffer, value: string): boolean {
  const provided = digest(value);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
