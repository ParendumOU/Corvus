import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendRequest } from "../src/http-client.js";

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, host: req.headers.host, cookie: req.headers.cookie ?? null, body: Buffer.concat(chunks).toString() }));
      } else if (req.url === "/redir") {
        res.writeHead(302, { location: "/echo" });
        res.end();
      } else {
        res.writeHead(404);
        res.end("nope");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("sendRequest", () => {
  it("issues a request and captures the response body", async () => {
    const { response } = await sendRequest({ method: "POST", url: `http://127.0.0.1:${port}/echo`, headers: [{ name: "content-type", value: "text/plain" }], body: "ping" });
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body ?? "{}");
    expect(parsed.method).toBe("POST");
    expect(parsed.body).toBe("ping");
  });

  it("injects the cookie header only when supplied", async () => {
    const { response } = await sendRequest({ method: "GET", url: `http://127.0.0.1:${port}/echo`, headers: [] }, { cookieHeader: "sid=xyz" });
    expect(JSON.parse(response.body ?? "{}").cookie).toBe("sid=xyz");
  });

  it("keeps the original Host header when a host override redirects the connection", async () => {
    const { response } = await sendRequest(
      { method: "GET", url: `http://scope-target.test:${port}/echo`, headers: [] },
      { override: { id: "o", enabled: true, host: "scope-target.test", address: "127.0.0.1" } },
    );
    // Connected to 127.0.0.1 but the Host header still says the scoped name.
    expect(JSON.parse(response.body ?? "{}").host).toBe(`scope-target.test:${port}`);
  });

  it("does not follow redirects by default", async () => {
    const { response } = await sendRequest({ method: "GET", url: `http://127.0.0.1:${port}/redir`, headers: [] });
    expect(response.status).toBe(302);
    const followed = await sendRequest({ method: "GET", url: `http://127.0.0.1:${port}/redir`, headers: [], followRedirects: true });
    expect(followed.response.status).toBe(200);
  });
});
