import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchPublicText, nasaImageOfTheDay, parseFeed } from "../src/main/newtab-data";
import { titleCount } from "../src/main/newtab-page-source";
import { NewTabService } from "../src/main/newtab-service";
import { widgetDocument } from "../src/main/newtab-widget-doc";
import type { AppContext } from "../src/main/context";
import type { ProfileRuntime } from "../src/main/profiles";
import { defaultConfig, type WidgetConfigs } from "../src/shared/newtab";

describe("feeds", () => {
  it("reads RSS 2.0 with CDATA, entities and relative links", () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Example &amp; Co</title>
      <item><title><![CDATA[First <b>post</b>]]></title><link>/a</link><pubDate>Tue, 21 Oct 2026 10:00:00 GMT</pubDate></item>
      <item><title>Caf&#233; &quot;news&quot;</title><link>https://other.example/b</link></item>
      <item><title>No link</title></item></channel></rss>`;
    expect(parseFeed(xml, "https://example.com/feed.xml")).toEqual([
      { title: "First post", url: "https://example.com/a", source: "Example & Co", at: Date.parse("Tue, 21 Oct 2026 10:00:00 GMT") },
      { title: 'Café "news"', url: "https://other.example/b", source: "Example & Co", at: null },
    ]);
  });

  it("reads Atom entries and their href links", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
      <entry><title>Hello</title><link rel="alternate" href="https://blog.example/hello"/><updated>2026-10-20T08:00:00Z</updated></entry></feed>`;
    expect(parseFeed(xml, "https://blog.example/atom")).toEqual([{ title: "Hello", url: "https://blog.example/hello", source: "Blog", at: Date.parse("2026-10-20T08:00:00Z") }]);
  });
});

describe("public reads", () => {
  const lookup = async (host: string): Promise<string[]> => (host === "lan.example" ? ["192.168.1.1"] : ["203.0.113.7"]);
  const redirecting = (hops: Record<string, string>) => {
    const asked: string[] = [];
    const fetcher = async (url: string): Promise<Response> => {
      asked.push(url);
      return hops[url] ? new Response(null, { status: 302, headers: { location: hops[url]! } }) : new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    return { asked, fetcher };
  };

  it("follows redirects that stay on public addresses", async () => {
    const { asked, fetcher } = redirecting({ "https://a.example/": "/b" });
    await expect(fetchPublicText("https://a.example/", fetcher, lookup)).resolves.toMatchObject({ text: "ok" });
    expect(asked).toEqual(["https://a.example/", "https://a.example/b"]);
  });

  it("never follows a redirect into the LAN or loopback", async () => {
    for (const target of ["http://127.0.0.1:9229/json", "http://lan.example/", "http://localhost/"]) {
      const { asked, fetcher } = redirecting({ "https://a.example/": target });
      await expect(fetchPublicText("https://a.example/", fetcher, lookup)).rejects.toThrow(/public/);
      expect(asked).toEqual(["https://a.example/"]);
    }
  });

  it("gives up after a few redirects", async () => {
    const { fetcher } = redirecting(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`https://a.example/${i}`, `/${i + 1}`])));
    await expect(fetchPublicText("https://a.example/0", fetcher, lookup)).rejects.toThrow(/redirects/);
  });
});

describe("wallpapers", () => {
  it("takes NASA's newest image of the day at a wallpaper size", () => {
    const xml = `<rss><channel><title>NASA Image of the Day</title>
      <item><title>Launch video</title><link>https://www.nasa.gov/video/</link><enclosure url="https://www.nasa.gov/a.mp4" type="video/mp4" /></item>
      <item><title>Spiral&#039;s Edge</title><link>https://www.nasa.gov/image-detail/ngc1827/</link>
        <enclosure url="https://www.nasa.gov/wp-content/uploads/2026/10/ngc1827.jpg" length="7154055" type="image/jpeg" /></item>
      <item><title>Older</title><enclosure url="https://www.nasa.gov/old.jpg" type="image/jpeg" /></item></channel></rss>`;
    expect(nasaImageOfTheDay(xml)).toEqual({
      url: "https://www.nasa.gov/wp-content/uploads/2026/10/ngc1827.jpg?w=2560",
      credit: "Spiral's Edge",
      link: "https://www.nasa.gov/image-detail/ngc1827/",
    });
    expect(nasaImageOfTheDay("<rss><channel></channel></rss>")).toBeNull();
  });
});

describe("page sources", () => {
  it("reads the unread count sites put in their title", () => {
    expect(titleCount("(3) Home / X")).toBe(3);
    expect(titleCount("Inbox (12) - Gmail")).toBe(12);
    expect(titleCount("(99+) Instagram")).toBe(99);
    expect(titleCount("YouTube")).toBeNull();
  });
});

describe("custom widget documents", () => {
  const config = (patch: Partial<WidgetConfigs["custom"]>): WidgetConfigs["custom"] => ({ ...defaultConfig("custom"), ...patch });

  it("allow only inline code and no network; private data cannot load web images", () => {
    const open = widgetDocument(config({ sources: [{ name: "a", kind: "fetch", url: "https://api.example/", select: "", everyMinutes: 5 }] }), "en");
    expect(open.csp).toContain("default-src 'none'");
    expect(open.csp).toContain("img-src https: data:");
    expect(open.csp).not.toContain("connect-src");
    const priv = widgetDocument(config({ sources: [{ name: "w", kind: "corvus", url: "watches", select: "", everyMinutes: 5 }] }), "es");
    expect(priv.csp).toContain("img-src data:");
    expect(priv.csp).not.toContain("https:");
    expect(priv.html).toContain('<html lang="es">');
  });

  it("keeps the widget's code from closing Corvus's elements early", () => {
    const doc = widgetDocument(config({ script: "x = '</script><img src=x>';", css: "a{}</style><b>" }), "en");
    expect(doc.html).not.toContain("'</script>");
    expect(doc.html).toContain("<\\/script>");
    expect(doc.html).toContain("<\\/style>");
  });
});

describe("New Tab service", () => {
  let dir = "";
  let service: NewTabService;
  let runtime: ProfileRuntime;
  const notified: string[] = [];
  const opened: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "newtab-"));
    runtime = {
      dataDir: dir,
      profile: { id: "p1", name: "Personal" },
      history: { top: () => [{ url: "https://mail.example/", title: "Mail" }] },
    } as unknown as ProfileRuntime;
    const window = { profile: runtime, notifyInternalPages: () => notified.push("newtab"), openUrl: (u: string) => opened.push(u) };
    const ctx = {
      windows: { all: () => [window] },
      mcp: { isRunning: () => true },
      monitor: { storeFor: () => ({ list: () => [{ url: "https://watched.example/page", title: "Watched", lastChangedAt: 1, changeSummary: "Price dropped", unseen: true }] }) },
    } as unknown as AppContext;
    service = new NewTabService(ctx);
    notified.length = 0;
    opened.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const agent = (request: Record<string, unknown>) => JSON.parse(service.agent(runtime, request, "claude-code")) as { widgets: Array<{ id: string; type: string; config: Record<string, unknown> }>; waitingForConsent?: string[] };

  it("starts from today's page and tells open New Tab pages about changes", () => {
    expect(service.view(runtime)).toMatchObject({ profileName: "Personal", mcpRunning: true, canUndo: false, topSites: [{ url: "https://mail.example/" }] });
    agent({ action: "add", type: "clock" });
    expect(notified).toEqual(["newtab"]);
    expect(service.view(runtime).canUndo).toBe(true);
  });

  it("lets agents add, change and remove widgets, and undo", () => {
    let res = agent({ action: "add", type: "notes", config: { text: "hi" } });
    expect(res.widgets.find((w) => w.id === "notes-1")?.config).toEqual({ text: "hi" });
    res = agent({ action: "update", id: "notes-1", config: { text: "bye" }, x: 0, y: 0 });
    expect(res.widgets.find((w) => w.id === "notes-1")?.config).toEqual({ text: "bye" });
    res = agent({ action: "remove", id: "notes-1" });
    expect(res.widgets.some((w) => w.id === "notes-1")).toBe(false);
    res = agent({ action: "undo" });
    expect(res.widgets.some((w) => w.id === "notes-1")).toBe(true);
    expect(() => agent({ action: "add", type: "custom" })).toThrow(/newtab_custom_widget/);
    expect(() => agent({ action: "remove", id: "nope" })).toThrow(/No widget/);
  });

  it("never takes consent from an agent, and drops it when an agent changes what a widget reads", () => {
    const page = { name: "x", kind: "page", url: "https://x.com/home", everyMinutes: 15 };
    let res = agent({ action: "custom", config: { title: "X", html: "<b>x</b>", sources: [page], consent: ["x.com"] } });
    const id = res.widgets.find((w) => w.type === "custom")!.id;
    expect(res.widgets.find((w) => w.id === id)?.config).toMatchObject({ author: "claude-code", consent: [] });
    expect(res.waitingForConsent).toEqual([`${id}: x.com`]);

    service.consent(runtime, id, ["x.com", "evil.example"]);
    expect((service.layout(runtime).widgets.find((w) => w.id === id)!.config as WidgetConfigs["custom"]).consent).toEqual(["x.com"]);

    // Same sources: consent stays. Other sources: it is gone.
    res = agent({ action: "update", id, config: { title: "X timeline" } });
    expect(res.widgets.find((w) => w.id === id)?.config).toMatchObject({ consent: ["x.com"] });
    res = agent({ action: "update", id, config: { sources: [{ ...page, select: "main" }] } });
    expect(res.widgets.find((w) => w.id === id)?.config).toMatchObject({ consent: [] });
  });

  it("never brings back consent the person took away when an agent undoes", () => {
    const res = agent({ action: "custom", config: { title: "X", sources: [{ name: "x", kind: "page", url: "https://x.com/home" }] } });
    const id = res.widgets.find((w) => w.type === "custom")!.id;
    const consentOf = () => (service.layout(runtime).widgets.find((w) => w.id === id)!.config as WidgetConfigs["custom"]).consent;
    service.consent(runtime, id, ["x.com"]);
    service.consent(runtime, id, []);
    agent({ action: "undo" });
    expect(consentOf()).toEqual([]);
    // The person's own Undo on the page restores their earlier choice.
    service.consent(runtime, id, ["x.com"]);
    service.consent(runtime, id, []);
    service.undo(runtime);
    expect(consentOf()).toEqual(["x.com"]);
  });

  it("keeps consent out of page saves", () => {
    const res = agent({ action: "custom", config: { title: "X", sources: [{ name: "x", kind: "page", url: "https://x.com/home" }] } });
    const id = res.widgets.find((w) => w.type === "custom")!.id;
    const layout = structuredClone(service.layout(runtime));
    (layout.widgets.find((w) => w.id === id)!.config as WidgetConfigs["custom"]).consent = ["x.com"];
    service.save(runtime, layout);
    expect((service.layout(runtime).widgets.find((w) => w.id === id)!.config as WidgetConfigs["custom"]).consent).toEqual([]);
  });

  it("opens links only on hosts a widget declared, or what its private data points at", async () => {
    let res = agent({ action: "custom", config: { title: "Prices", sources: [{ name: "p", kind: "fetch", url: "https://api.example/prices" }], links: ["www.example.com"] } });
    const open = res.widgets.find((w) => w.type === "custom")!.id;
    res = agent({ action: "custom", config: { title: "Watched", sources: [{ name: "w", kind: "corvus", url: "watches" }], links: ["attacker.example"] } });
    const priv = res.widgets.filter((w) => w.type === "custom")[1]!.id;
    const win = { openUrl: (u: string) => opened.push(u) } as never;

    expect(await service.openFromWidget(runtime, win, open, "https://www.example.com/x")).toBe(true);
    expect(await service.openFromWidget(runtime, win, open, "https://api.example/other")).toBe(true);
    expect(await service.openFromWidget(runtime, win, open, "https://elsewhere.example/")).toBe(false);
    expect(await service.openFromWidget(runtime, win, open, "javascript:alert(1)")).toBe(false);
    expect(await service.openFromWidget(runtime, win, priv, "https://watched.example/page")).toBe(true);
    expect(await service.openFromWidget(runtime, win, priv, "https://attacker.example/?leak=1")).toBe(false);
    expect(opened).toEqual(["https://www.example.com/x", "https://api.example/other", "https://watched.example/page"]);
  });

  it("hands Corvus data to widgets and waits for consent before reading with the session", async () => {
    const res = agent({
      action: "custom",
      config: { title: "Mine", sources: [{ name: "w", kind: "corvus", url: "watches" }, { name: "x", kind: "page", url: "https://x.com/home" }] },
    });
    const id = res.widgets.find((w) => w.type === "custom")!.id;
    const data = await service.customData(runtime, id);
    expect(data.w).toEqual([{ url: "https://watched.example/page", title: "Watched", changedAt: 1, summary: "Price dropped", unseen: true }]);
    expect(data.x).toMatchObject({ consent: "x.com" });
  });
});
