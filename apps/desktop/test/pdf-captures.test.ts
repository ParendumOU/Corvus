import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PdfCaptures } from "../src/main/pdf-captures";

/** A download that writes `body` where it is told to and then ends as `state`. */
class FakeDownload extends EventEmitter {
  savePath = "";
  getFilename(): string {
    return "cert.pdf";
  }
  setSavePath(p: string): void {
    this.savePath = p;
  }
  finish(state: "completed" | "cancelled" | "interrupted", body = "%PDF-1.7 smoke"): void {
    if (state === "completed") fs.writeFileSync(this.savePath, body);
    this.emit("done", {}, state);
  }
}

describe("PdfCaptures", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-captures-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("hands the viewer the downloaded bytes and removes the temporary file", async () => {
    const captures = new PdfCaptures(dir);
    const item = new FakeDownload();
    const id = captures.capture(item, "p1", "https://bank.example/cert.aspx?k=1");
    expect(path.dirname(item.savePath)).toBe(dir);
    const bytes = captures.get(id, "p1", "https://bank.example/cert.aspx?k=1");
    item.finish("completed");
    expect(bytes?.filename).toBe("cert.pdf");
    expect(Buffer.from(await bytes!.bytes).toString()).toBe("%PDF-1.7 smoke");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("only to the same profile and source", () => {
    const captures = new PdfCaptures(dir);
    const id = captures.capture(new FakeDownload(), "p1", "https://bank.example/a");
    expect(captures.get(id, "p2", "https://bank.example/a")).toBeNull();
    expect(captures.get(id, "p1", "https://bank.example/b")).toBeNull();
    expect(captures.get("0f8fad5b-d9cb-469f-a165-70867728950e", "p1", "https://bank.example/a")).toBeNull();
  });

  it("says so when the download did not finish", async () => {
    const captures = new PdfCaptures(dir);
    const item = new FakeDownload();
    const id = captures.capture(item, "p1", "https://bank.example/a");
    item.finish("cancelled");
    await expect(captures.get(id, "p1", "https://bank.example/a")!.bytes).rejects.toThrow("did not finish");
  });

  it("keeps only the latest few", () => {
    const captures = new PdfCaptures(dir, 2);
    const ids = ["a", "b", "c"].map((s) => captures.capture(new FakeDownload(), "p1", `https://example.com/${s}`));
    expect(captures.get(ids[0]!, "p1", "https://example.com/a")).toBeNull();
    expect(captures.get(ids[2]!, "p1", "https://example.com/c")).not.toBeNull();
  });
});
