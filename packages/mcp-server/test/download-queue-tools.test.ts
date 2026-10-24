import { afterEach, describe, expect, it } from "vitest";
import { requiredLevel } from "../src/access.js";
import { MockBrowserController } from "../src/testing/index.js";
import { call, startHarness, textOf, untrustedJson, type Harness } from "./helpers.js";

const TOOLS = ["download_queue", "download_queue_add", "download_queue_control"];

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

describe("download queue tools", () => {
  it("are full level only", async () => {
    for (const tool of TOOLS) expect(requiredLevel(tool)).toBe("full");
    harness = await startHarness({ accessLevel: "standard" }, new MockBrowserController());
    const standard = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    for (const tool of TOOLS) expect(standard).not.toContain(tool);
    await harness.close();
    harness = await startHarness({ accessLevel: "full" }, new MockBrowserController());
    const full = (await (await harness.connect()).listTools()).tools.map((t) => t.name);
    for (const tool of TOOLS) expect(full).toContain(tool);
  });

  it("lists, adds and controls through the browser with the client's name", async () => {
    const controller = new MockBrowserController();
    harness = await startHarness({ accessLevel: "full" }, controller);
    const client = await harness.connect({ name: "queue-agent" });

    const listed = untrustedJson<Array<{ id: string; name: string }>>(await call(client, "download_queue"));
    expect(listed[0]).toMatchObject({ id: "p1", name: "Movie" });

    const links = ["https://files.example/Movie.part1.rar", "https://files.example/Movie.part2.rar"];
    const added = untrustedJson<{ packages: Array<{ name: string; files: number }> }>(await call(client, "download_queue_add", { links, packageName: "Movie", password: "pw" }));
    expect(added.packages).toEqual([{ id: "p1", name: "Movie", files: 2 }]);

    await call(client, "download_queue_control", { id: "p1", op: "extract", password: "pw" });
    expect(controller.downloadQueueRequests).toEqual([
      { request: { action: "list" }, client: "queue-agent" },
      { request: { action: "add", links, packageName: "Movie", password: "pw" }, client: "queue-agent" },
      { request: { action: "control", id: "p1", op: "extract", password: "pw" }, client: "queue-agent" },
    ]);
  });

  it("reports the browser's refusal as a tool error", async () => {
    harness = await startHarness({ accessLevel: "full" }, new MockBrowserController());
    const res = await call(await harness.connect(), "download_queue_control", { id: "missing", op: "pause" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("No package or file");
  });

  it("checks the input before asking the browser", async () => {
    harness = await startHarness({ accessLevel: "full" }, new MockBrowserController());
    const client = await harness.connect();
    const empty = await call(client, "download_queue_add", { links: [] });
    expect(empty.isError).toBe(true);
    const badOp = await call(client, "download_queue_control", { id: "p1", op: "delete-everything" });
    expect(badOp.isError).toBe(true);
  });
});
