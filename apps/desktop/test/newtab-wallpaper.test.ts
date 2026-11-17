import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@corvus/ai-engine", async (original) => ({ ...(await original<typeof import("@corvus/ai-engine")>()), resolvesToPublic: async () => true }));

const { clearNewTabCache, wallpaper } = await import("../src/main/newtab-data");

const json = (body: unknown) => async (): Promise<Response> => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("wallpaper credit links", () => {
  beforeEach(() => clearNewTabCache());

  it("keeps a feed's https credit link", async () => {
    const view = await wallpaper("bing", json({ images: [{ url: "/th?id=a.jpg", copyright: "A bay", copyrightlink: "https://www.bing.com/search?q=bay" }] }));
    expect(view?.link).toBe("https://www.bing.com/search?q=bay");
  });

  it("replaces a credit link that is not https with the source's own page", async () => {
    const bing = await wallpaper("bing", json({ images: [{ url: "/th?id=a.jpg", copyrightlink: "javascript:alert(1)" }] }));
    expect(bing?.link).toBe("https://www.bing.com/");
    const wiki = await wallpaper("wikimedia", json({ image: { image: { source: "https://upload.wikimedia.org/a.jpg" }, file_page: "http://commons.wikimedia.org/wiki/File:A.jpg" } }));
    expect(wiki?.link).toBe("https://commons.wikimedia.org/");
  });
});
