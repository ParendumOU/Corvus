import { describe, expect, it } from "vitest";
import { fetchFavicon } from "../src/favicon.js";

const publicLookup = async () => ["93.184.216.34"];
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("fetchFavicon", () => {
  it("returns a data URL for a small image", async () => {
    const seen: string[] = [];
    const url = await fetchFavicon("example.com", {
      lookup: publicLookup,
      fetch: async (u) => {
        seen.push(String(u));
        return new Response(png, { headers: { "content-type": "image/png" } });
      },
    });
    expect(seen).toEqual(["https://example.com/favicon.ico"]);
    expect(url).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  });

  it("follows redirects with the public-address check on every hop", async () => {
    const seen: string[] = [];
    const url = await fetchFavicon("example.com", {
      lookup: async (host) => (host === "evil.example" ? ["127.0.0.1"] : ["93.184.216.34"]),
      fetch: async (u) => {
        seen.push(String(u));
        return new Response(null, { status: 302, headers: { location: "https://evil.example/x.ico" } });
      },
    });
    expect(url).toBeNull();
    expect(seen).toEqual(["https://example.com/favicon.ico"]);
  });

  it("refuses non-images, oversized bodies, private hosts and bad domains", async () => {
    const html = async () => new Response("<html>", { headers: { "content-type": "text/html" } });
    expect(await fetchFavicon("example.com", { lookup: publicLookup, fetch: html })).toBeNull();
    const big = async () => new Response(new Uint8Array(40_000), { headers: { "content-type": "image/x-icon" } });
    expect(await fetchFavicon("example.com", { lookup: publicLookup, fetch: big })).toBeNull();
    let called = false;
    const spy = async () => {
      called = true;
      return new Response(png, { headers: { "content-type": "image/png" } });
    };
    expect(await fetchFavicon("intranet.example", { lookup: async () => ["10.0.0.5"], fetch: spy })).toBeNull();
    expect(await fetchFavicon("localhost", { lookup: publicLookup, fetch: spy })).toBeNull();
    expect(await fetchFavicon("a/b.com", { lookup: publicLookup, fetch: spy })).toBeNull();
    expect(called).toBe(false);
  });
});
