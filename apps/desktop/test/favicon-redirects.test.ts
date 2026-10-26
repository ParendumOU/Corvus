import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FaviconCache, type IconFetch, type ProbedPage } from "../src/main/favicon-cache";
import { cachedFaviconUrl } from "../src/shared/favicon";
import {
  CLIENT_REDIRECT_AFTER_LOAD_MS,
  CLIENT_REDIRECT_MS,
  RedirectChain,
  bookmarkPageKeys,
  faviconPageKey,
  isPersonInput,
  pageIconLinks,
  redirectIcons,
} from "../src/shared/favicon-redirects";

describe("favicon page keys", () => {
  it("keeps web pages without their #fragment or trailing slash", () => {
    expect(faviconPageKey("https://Old.example/")).toBe("https://old.example");
    expect(faviconPageKey("https://old.example")).toBe("https://old.example");
    expect(faviconPageKey("https://old.example/go/x/#top")).toBe("https://old.example/go/x");
    expect(faviconPageKey("http://old.example:8080/a?b=1")).toBe("http://old.example:8080/a?b=1");
    expect(faviconPageKey("corvus://bookmarks/")).toBeNull();
    expect(faviconPageKey("javascript:alert(1)")).toBeNull();
    expect(faviconPageKey("not a url")).toBeNull();
  });

  it("collects the keys of bookmarks, not folders", () => {
    const keys = bookmarkPageKeys([
      { kind: "folder" },
      { kind: "bookmark", url: "https://old.example/" },
      { kind: "bookmark", url: "https://short.example/abc#x" },
      { kind: "bookmark", url: "corvus://history/" },
      { kind: "bookmark" },
    ]);
    expect([...keys]).toEqual(["https://old.example", "https://short.example/abc"]);
  });
});

describe("redirect icons", () => {
  it("points the pages on other sites at the final page's site", () => {
    expect(redirectIcons(["http://old.example/", "https://old.example/", "https://new.example/home", "https://new.example/welcome"])).toEqual({
      to: "https://new.example",
      from: ["http://old.example", "https://old.example"],
      same: ["https://new.example/home", "https://new.example/welcome"],
    });
  });

  it("has nothing to point elsewhere for a page that opens on its own site", () => {
    expect(redirectIcons(["https://a.example/x"])).toEqual({ to: "https://a.example", from: [], same: ["https://a.example/x"] });
    expect(redirectIcons(["https://a.example/#one", "https://a.example/"])).toEqual({ to: "https://a.example", from: [], same: ["https://a.example"] });
  });

  it("ignores navigations that do not end on a web page", () => {
    expect(redirectIcons([])).toBeNull();
    expect(redirectIcons(["https://a.example/", "corvus://newtab/"])).toBeNull();
    expect(redirectIcons(["about:blank", "https://b.example/"])).toEqual({ to: "https://b.example", from: [], same: ["https://b.example"] });
  });
});

describe("redirect chain of a tab", () => {
  it("follows server redirects to the page that opens", () => {
    const chain = new RedirectChain();
    chain.start("http://old.example/", false, 0);
    chain.redirect("https://old.example/");
    chain.redirect("https://new.example/");
    expect(chain.commit("https://new.example/", 10)).toEqual(["http://old.example/", "https://old.example/", "https://new.example/"]);
  });

  it("counts a page that sends the tab on by itself right after it opened (meta refresh, script)", () => {
    const chain = new RedirectChain();
    chain.start("https://short.example/abc", false, 0);
    chain.commit("https://short.example/abc", 100);
    chain.start("https://new.example/", true, 200);
    expect(chain.commit("https://new.example/", 300)).toEqual(["https://short.example/abc", "https://new.example/"]);
  });

  it("starts over for a navigation the person or Corvus started", () => {
    const chain = new RedirectChain();
    chain.start("https://a.example/", false, 0);
    chain.commit("https://a.example/", 100);
    // Corvus: an address typed, a bookmark opened, Back.
    chain.start("https://b.example/", false, 200);
    expect(chain.commit("https://b.example/", 300)).toEqual(["https://b.example/"]);
    // A click in the page.
    chain.interrupt();
    chain.start("https://c.example/", true, 400);
    expect(chain.commit("https://c.example/", 500)).toEqual(["https://c.example/"]);
  });

  it("starts over when the page moves on long after it opened or loaded", () => {
    const chain = new RedirectChain();
    chain.start("https://a.example/", false, 0);
    chain.commit("https://a.example/", 0);
    chain.start("https://b.example/", true, CLIENT_REDIRECT_MS + 1);
    expect(chain.commit("https://b.example/", CLIENT_REDIRECT_MS + 2)).toEqual(["https://b.example/"]);

    const loaded = new RedirectChain();
    loaded.start("https://a.example/", false, 0);
    loaded.commit("https://a.example/", 0);
    loaded.loaded(100);
    loaded.start("https://b.example/", true, 100 + CLIENT_REDIRECT_AFTER_LOAD_MS + 1);
    expect(loaded.commit("https://b.example/", 5000)).toEqual(["https://b.example/"]);

    const quick = new RedirectChain();
    quick.start("https://a.example/", false, 0);
    quick.commit("https://a.example/", 0);
    quick.loaded(100);
    quick.start("https://b.example/", true, 100 + CLIENT_REDIRECT_AFTER_LOAD_MS);
    expect(quick.commit("https://b.example/", 5000)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("does not take a page that opened without its start being seen for a redirect", () => {
    const chain = new RedirectChain();
    chain.start("https://a.example/", false, 0);
    expect(chain.commit("https://elsewhere.example/", 10)).toEqual(["https://elsewhere.example/"]);
    const fresh = new RedirectChain();
    fresh.redirect("https://b.example/");
    expect(fresh.commit("https://b.example/", 0)).toEqual(["https://b.example/"]);
  });

  it("keeps at most the last 20 pages of a redirect loop", () => {
    const chain = new RedirectChain();
    chain.start("https://a.example/0", false, 0);
    for (let i = 1; i < 30; i++) chain.redirect(`https://a.example/${i}`);
    const pages = chain.commit("https://a.example/29", 0);
    expect(pages).toHaveLength(20);
    expect(pages[19]).toBe("https://a.example/29");
  });

  it("takes clicks and key presses, not mouse moves, for the person's input", () => {
    expect(isPersonInput("mouseDown")).toBe(true);
    expect(isPersonInput("keyDown")).toBe(true);
    expect(isPersonInput("rawKeyDown")).toBe(true);
    expect(isPersonInput("mouseMove")).toBe(false);
    expect(isPersonInput("mouseWheel")).toBe(false);
  });
});

describe("icons a page names", () => {
  it("reads <link rel=icon> in order, resolved against the page", () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/s.css">
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="mask-icon" href="/mask.svg">
      <LINK REL="Shortcut Icon" HREF="/favicon-32.png">
      <link href='icons/a.svg' rel='icon' type='image/svg+xml'>
      <link rel=icon href=//cdn.example/i.ico>
      <link rel="icon" href="/favicon-32.png">
      </head><body></body></html>`;
    expect(pageIconLinks(html, "https://new.example/app/page")).toEqual([
      "https://new.example/favicon-32.png",
      "https://new.example/app/icons/a.svg",
      "https://cdn.example/i.ico",
    ]);
  });

  it("follows <base href> and decodes entities", () => {
    const html = `<head><base href="https://static.example/v2/"><link rel="icon" href="i.png?a=1&amp;b=2"></head>`;
    expect(pageIconLinks(html, "https://new.example/")).toEqual(["https://static.example/v2/i.png?a=1&b=2"]);
  });

  it("skips links in comments and scripts, and addresses that are not images on the web", () => {
    const html = `<head>
      <!-- <link rel="icon" href="/old.ico"> -->
      <script>document.write('<link rel="icon" href="/script.ico">')</script>
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="file:///etc/passwd">
      <link rel="icon">
      <link rel="icon" href="data:image/svg+xml,%3Csvg%2F%3E">
      </head>`;
    expect(pageIconLinks(html, "https://new.example/")).toEqual(["data:image/svg+xml,%3Csvg%2F%3E"]);
    expect(pageIconLinks("", "https://new.example/")).toEqual([]);
    expect(pageIconLinks("<html><body>no icons</body></html>", "https://new.example/")).toEqual([]);
  });
});

describe("cached favicon address", () => {
  it("names the revision only once it changed", () => {
    expect(cachedFaviconUrl("https://a.example/", "p1")).toBe("corvus://favicon/?url=https%3A%2F%2Fa.example%2F&profile=p1");
    expect(cachedFaviconUrl("https://a.example/", "p1", undefined, 3)).toBe("corvus://favicon/?url=https%3A%2F%2Fa.example%2F&profile=p1&v=3");
    expect(cachedFaviconUrl("https://a.example/", undefined, "k", 0)).toBe("corvus://favicon/?url=https%3A%2F%2Fa.example%2F&key=k");
  });
});

// Image files only need the right first bytes; the last byte tells them apart.
const png = (id: number): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, id]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>');

interface Net {
  fetcher: IconFetch;
  fetched: string[];
}

function net(files: Record<string, Buffer>): Net {
  const fetched: string[] = [];
  const fetcher: IconFetch = async (url) => {
    fetched.push(url);
    const body = files[url];
    return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("missing", { status: 404 });
  };
  return { fetcher, fetched };
}

describe("favicon cache and redirects", () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-favicons-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const bookmarks = (...urls: string[]): ((key: string) => boolean) => {
    const keys = bookmarkPageKeys(urls.map((url) => ({ kind: "bookmark", url })));
    return (key) => keys.has(key);
  };

  it("shows a visited bookmark the icon of the page it redirected to", async () => {
    const dir = tempDir();
    const { fetcher } = net({ "https://new.example/icon.png": png(1), "https://old.example/favicon.ico": png(9) });
    const cache = new FaviconCache(dir, fetcher);
    const changes: number[] = [];
    cache.onChange(() => changes.push(cache.revision));
    cache.navigated(["https://old.example/", "https://new.example/home"], bookmarks("https://old.example"));
    cache.remember("https://new.example/home", "https://new.example/icon.png");
    expect((await cache.icon("https://new.example/home"))?.body).toEqual(png(1));
    expect((await cache.icon("https://old.example"))?.body).toEqual(png(1));
    expect((await cache.icon("https://old.example/#top"))?.body).toEqual(png(1));
    // Other pages of the old site are not bookmarks that redirected: they keep their own site's icon.
    expect((await cache.icon("https://old.example/other"))?.body).toEqual(png(9));
    expect(changes).toEqual([1]);
    // The same redirect seen again changes nothing.
    cache.navigated(["https://old.example/", "https://new.example/home"], bookmarks("https://old.example"));
    expect(changes).toEqual([1]);

    // Kept on disk for the next run.
    const next = new FaviconCache(dir, net({}).fetcher);
    expect((await next.icon("https://old.example/"))?.body).toEqual(png(1));
  });

  it("remembers only bookmarks, and lets a bookmark that stopped redirecting show its own icon again", async () => {
    const dir = tempDir();
    const { fetcher } = net({ "https://old.example/favicon.ico": png(2), "https://new.example/favicon.ico": png(3) });
    const cache = new FaviconCache(dir, fetcher);
    cache.navigated(["https://t.example/xyz", "https://old.example/", "https://new.example/"], bookmarks("https://old.example/"));
    expect((await cache.icon("https://t.example/xyz"))).toBeNull();
    expect((await cache.icon("https://old.example/"))?.body).toEqual(png(3));
    cache.navigated(["https://old.example/"], bookmarks("https://old.example/"));
    expect(cache.revision).toBe(2);
    expect((await cache.icon("https://old.example/"))?.body).toEqual(png(2));
    expect(fs.readFileSync(path.join(dir, "redirects.json"), "utf8")).toBe("{}");
  });

  it("keeps no address in plain text", () => {
    const dir = tempDir();
    const cache = new FaviconCache(dir, net({}).fetcher);
    cache.navigated(["https://old.example/secret-path", "https://new.example/"], bookmarks("https://old.example/secret-path"));
    const saved = fs.readFileSync(path.join(dir, "redirects.json"), "utf8");
    expect(saved).not.toContain("old.example");
    expect(saved).toContain('"to":"https://new.example"');
  });

  it("follows a bookmark never opened to the page it ends on, for the icon that page names", async () => {
    const dir = tempDir();
    const { fetcher, fetched } = net({ "https://new.example/static/icon.svg": svg });
    const probed: string[] = [];
    const cache = new FaviconCache(dir, fetcher, {
      probe: async (url): Promise<ProbedPage> => {
        probed.push(url);
        return { url: "https://new.example/welcome", html: '<head><link rel="icon" href="/static/icon.svg"></head>' };
      },
      probes: (url) => url === "https://old.example/",
    });
    const icon = await cache.icon("https://old.example/");
    expect(icon).toEqual({ type: "image/svg+xml", body: svg });
    expect(probed).toEqual(["https://old.example/"]);
    expect(fetched).toEqual(["https://new.example/static/icon.svg"]);
    // Kept for the bookmark and for the site it leads to; no second fetch.
    expect(await cache.icon("https://old.example/")).toEqual(icon);
    expect(await cache.icon("https://new.example/")).toEqual(icon);
    expect(probed).toHaveLength(1);
    const next = new FaviconCache(dir, net({}).fetcher);
    expect(await next.icon("https://old.example")).toEqual({ type: "image/svg+xml", body: svg });
  });

  it("fetches only bookmarks' pages, and falls back to the site's /favicon.ico", async () => {
    const dir = tempDir();
    const { fetcher, fetched } = net({ "https://typed.example/favicon.ico": png(4), "https://down.example/favicon.ico": png(5), "https://plain.example/favicon.ico": png(6) });
    const probed: string[] = [];
    const cache = new FaviconCache(dir, fetcher, {
      probe: async (url) => {
        probed.push(url);
        if (url.startsWith("https://down.example")) throw new Error("offline");
        return { url, html: null };
      },
      probes: (url) => !url.startsWith("https://typed.example"),
    });
    expect((await cache.icon("https://typed.example/page"))?.body).toEqual(png(4));
    expect((await cache.icon("https://down.example/"))?.body).toEqual(png(5));
    // A bookmark that does not redirect and names no icon: its site's /favicon.ico.
    expect((await cache.icon("https://plain.example/a"))?.body).toEqual(png(6));
    expect(probed).toEqual(["https://down.example/", "https://plain.example/a"]);
    expect(fetched).toEqual(["https://typed.example/favicon.ico", "https://down.example/favicon.ico", "https://plain.example/favicon.ico"]);
  });

  it("tells the UI when a bookmark that had no icon gets one", async () => {
    const dir = tempDir();
    const files: Record<string, Buffer> = {};
    const cache = new FaviconCache(dir, net(files).fetcher, { probes: (url) => url.startsWith("https://mark.example") });
    expect(await cache.icon("https://mark.example/")).toBeNull();
    expect(await cache.icon("https://other.example/")).toBeNull();
    expect(cache.revision).toBe(0);
    files["https://other.example/i.png"] = png(7);
    cache.remember("https://other.example/", "https://other.example/i.png");
    await cache.icon("https://other.example/");
    expect(cache.revision).toBe(0);
    files["https://mark.example/i.png"] = png(8);
    cache.remember("https://mark.example/x", "https://mark.example/i.png");
    expect((await cache.icon("https://mark.example/"))?.body).toEqual(png(8));
    expect(cache.revision).toBe(1);
  });
});
