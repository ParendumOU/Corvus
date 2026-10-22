import { afterEach, describe, expect, it } from "vitest";
import { requiredLevel } from "../src/access.js";
import { MockBrowserController } from "../src/testing/index.js";
import { call, startHarness, textOf, untrustedJson, type Harness } from "./helpers.js";

function controller(): MockBrowserController {
  return new MockBrowserController({ initialTabs: ["https://files.example/"] });
}

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

describe("download access gating", () => {
  it("is full level", () => {
    expect(requiredLevel("download")).toBe("full");
  });

  it("is hidden below full, present at full", async () => {
    harness = await startHarness({ accessLevel: "standard" }, controller());
    expect((await (await harness.connect()).listTools()).tools.map((t) => t.name)).not.toContain("download");
    await harness.close();
    harness = await startHarness({ accessLevel: "full" }, controller());
    expect((await (await harness.connect()).listTools()).tools.map((t) => t.name)).toContain("download");
  });
});

describe("download behavior", () => {
  it("fetches a URL and returns the download entry", async () => {
    const c = controller();
    harness = await startHarness({ accessLevel: "full" }, c);
    const res = await call(await harness.connect(), "download", { url: "https://files.example/report.pdf" });
    expect(res.isError).toBeFalsy();
    const entry = untrustedJson<{ url: string; filename: string; state: string }>(res);
    expect(entry).toMatchObject({ url: "https://files.example/report.pdf", filename: "report.pdf", state: "completed" });
    const dl = c.calls.find((x) => x.method === "download");
    expect(dl?.args[1]).toBe("https://files.example/report.pdf");
  });

  it("caps the size via maxBytes", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const entry = untrustedJson<{ totalBytes: number }>(await call(await harness.connect(), "download", { url: "https://files.example/big.bin", maxBytes: 10 }));
    expect(entry.totalBytes).toBe(10);
  });

  it("refuses non-http(s) schemes", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const res = await call(await harness.connect(), "download", { url: "file:///etc/passwd" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Blocked URL scheme|Invalid URL/);
  });
});
