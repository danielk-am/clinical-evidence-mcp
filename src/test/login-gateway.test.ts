import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import express from "express";
import test from "node:test";

import { SyndicatedLoginGateway } from "../login-gateway.js";

test("exchanges a fragment nonce once, protects assets with a cookie, and strips upstream cookies", async (context) => {
  const target = createServer((request, response) => {
    response.setHeader("Set-Cookie", "upstream=must-not-leak");
    response.end(request.url);
  });
  await listen(target);
  context.after(() => close(target));
  const targetPort = (target.address() as AddressInfo).port;

  const gateway = new SyndicatedLoginGateway(
    "http://gateway.test",
    `http://127.0.0.1:${targetPort}`,
  );
  const app = express();
  app.use(express.json());
  app.use("/oe-login", gateway.handler());
  const server = createServer(app);
  server.on("upgrade", (request, socket, head) => {
    if (!gateway.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await listen(server);
  context.after(() => close(server));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const activation = gateway.activate(
    "123e4567-e89b-42d3-a456-426614174000",
    new Date(Date.now() + 60_000).toISOString(),
  );
  const activationUrl = new URL(activation.url);
  assert.equal(activationUrl.pathname, "/oe-login/");
  assert.equal(activationUrl.search, "");
  assert.ok(activationUrl.hash.length > 40);

  const bootstrap = await fetch(`${baseUrl}/oe-login/`);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers.get("cache-control"), "no-store");
  assert.equal(bootstrap.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await bootstrap.text()).includes(activationUrl.hash.slice(1)), false);

  const exchanged = await fetch(`${baseUrl}/oe-login/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://gateway.test" },
    body: JSON.stringify({ token: activationUrl.hash.slice(1) }),
  });
  assert.equal(exchanged.status, 204);
  const cookie = exchanged.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/oe-login\//);

  const replay = await fetch(`${baseUrl}/oe-login/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://gateway.test" },
    body: JSON.stringify({ token: activationUrl.hash.slice(1) }),
  });
  assert.equal(replay.status, 401);

  const unauthorised = await fetch(`${baseUrl}/oe-login/app/test.js`);
  assert.equal(unauthorised.status, 401);

  const asset = await fetch(`${baseUrl}/oe-login/app/test.js?x=1`, {
    headers: { cookie: cookie.split(";", 1)[0] ?? "" },
  });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "/app/test.js?x=1");
  assert.equal(asset.headers.get("set-cookie"), null);

  gateway.invalidate();
  const revoked = await fetch(`${baseUrl}/oe-login/app/test.js`, {
    headers: { cookie: cookie.split(";", 1)[0] ?? "" },
  });
  assert.equal(revoked.status, 401);
});

test("authorises only the exact-origin cookie before relaying WebSocket upgrade", async (context) => {
  const target = createServer();
  const targetSockets = new Set<import("node:net").Socket>();
  target.on("connection", (socket) => {
    targetSockets.add(socket);
    socket.once("close", () => targetSockets.delete(socket));
  });
  target.on("upgrade", (request, socket) => {
    const key = String(request.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await listen(target);
  context.after(async () => {
    for (const socket of targetSockets) socket.destroy();
    await close(target);
  });

  const gateway = new SyndicatedLoginGateway(
    "http://gateway.test",
    `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
  );
  const app = express();
  app.use(express.json());
  app.use("/oe-login", gateway.handler());
  const server = createServer(app);
  server.on("upgrade", (request, socket, head) => {
    if (!gateway.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await listen(server);
  context.after(() => close(server));
  const port = (server.address() as AddressInfo).port;

  const activation = gateway.activate(
    "123e4567-e89b-42d3-a456-426614174000",
    new Date(Date.now() + 60_000).toISOString(),
  );
  const token = new URL(activation.url).hash.slice(1);
  const exchanged = await fetch(`http://127.0.0.1:${port}/oe-login/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://gateway.test" },
    body: JSON.stringify({ token }),
  });
  const cookie = (exchanged.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

  const rejected = await rawUpgrade(port, cookie, "http://wrong.test");
  assert.match(rejected, /^HTTP\/1\.1 401 /);

  const accepted = await rawUpgrade(port, cookie, "http://gateway.test");
  assert.match(accepted, /^HTTP\/1\.1 101 /);
  gateway.invalidate();
});

function rawUpgrade(port: number, cookie: string, origin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write([
        "GET /oe-login/ws HTTP/1.1",
        "Host: gateway.test",
        `Origin: ${origin}`,
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n\r\n")) {
        resolve(data);
        socket.destroy();
      }
    });
    setTimeout(() => {
      if (!data.includes("\r\n\r\n")) {
        socket.destroy();
        reject(new Error("upgrade timed out"));
      }
    }, 2_000).unref();
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
