import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { AgentFileChoosers, canAnswerFileChooser } from "../src/main/agent-file-chooser";

function fakeTab() {
  const debuggerApi = Object.assign(new EventEmitter(), {
    attached: false,
    isAttached: () => debuggerApi.attached,
    attach: () => {
      debuggerApi.attached = true;
    },
    sendCommand: vi.fn(async () => ({})),
  });
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, debugger: debuggerApi });
  return { wc: wc as unknown as WebContents, dbg: debuggerApi };
}

const intercepts = (dbg: ReturnType<typeof fakeTab>["dbg"]): unknown[] =>
  dbg.sendCommand.mock.calls.filter((c) => (c as unknown[])[0] === "Page.setInterceptFileChooserDialog").map((c) => ((c as unknown[])[1] as { enabled: boolean }).enabled);

afterEach(() => {
  vi.useRealTimers();
});

describe("agent file choosers", () => {
  it("catches choosers only for a few seconds after the agent acts", async () => {
    vi.useFakeTimers();
    const { wc, dbg } = fakeTab();
    const choosers = new AgentFileChoosers();
    await choosers.arm(wc);
    await vi.advanceTimersByTimeAsync(5_000);
    await choosers.arm(wc);
    expect(intercepts(dbg)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(intercepts(dbg)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(intercepts(dbg)).toEqual([true, false]);
  });

  it("answers the input that opened the chooser, once", async () => {
    const { wc, dbg } = fakeTab();
    const choosers = new AgentFileChoosers();
    await choosers.arm(wc);
    expect(choosers.pending(wc)).toBeNull();
    dbg.emit("message", {}, "Page.fileChooserOpened", { mode: "selectMultiple", backendNodeId: 7 });
    const open = choosers.pending(wc)!;
    expect(open).toEqual({ backendNodeId: 7, multiple: true });
    await choosers.answer(wc, open, ["/tmp/a.txt"]);
    expect(dbg.sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", { files: ["/tmp/a.txt"], backendNodeId: 7 });
    expect(choosers.pending(wc)).toBeNull();
  });

  it("forgets a chooser when the page changes, but not when a frame does", async () => {
    const { wc, dbg } = fakeTab();
    const choosers = new AgentFileChoosers();
    await choosers.arm(wc);
    dbg.emit("message", {}, "Page.fileChooserOpened", { mode: "selectSingle" });
    expect(choosers.pending(wc)).toEqual({ backendNodeId: null, multiple: false });
    dbg.emit("message", {}, "Page.frameNavigated", { frame: { parentId: "main" } });
    expect(choosers.pending(wc)).not.toBeNull();
    dbg.emit("message", {}, "Page.frameNavigated", { frame: {} });
    expect(choosers.pending(wc)).toBeNull();
  });

  it("leaves the system's window to agents that could not answer", () => {
    const mcp = (accessLevel: "read" | "standard" | "full") => ({ mcp: { accessLevel, allowEvaluate: false } }) as Parameters<typeof canAnswerFileChooser>[0];
    expect(canAnswerFileChooser(mcp("standard"), "Corvus")).toBe(true);
    expect(canAnswerFileChooser(mcp("full"), "some-client")).toBe(true);
    expect(canAnswerFileChooser(mcp("standard"), "some-client")).toBe(false);
  });
});
