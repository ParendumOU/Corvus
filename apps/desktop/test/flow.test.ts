import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): this {
      return this;
    }
    show(): void {}
  },
}));

import type { PageSnapshot } from "@corvus/shared";
import { labelForStep, resolveTargetRef, stepToToolCall, type FlowStep, type FlowTarget } from "../src/shared/flow";
import { classifyAction } from "../src/shared/agent-safety";
import { FlowStore } from "../src/main/flow-store";
import { FlowService, parseInteraction } from "../src/main/flow-service";
import type { AppContext } from "../src/main/context";
import type { ProfileRuntime } from "../src/main/profiles";
import type { BrowserWindowCtl } from "../src/main/window";
import type { CapturedInteraction } from "../src/shared/flow-ipc";

// ----------------------------------------------------------------- pure model

const els = [
  { ref: "e1", role: "button", name: "Buy now" },
  { ref: "e2", role: "link", name: "Reviews" },
  { ref: "e3", role: "textbox", name: "Search" },
  { ref: "e4", role: "link", name: "Reviews" },
];

describe("resolveTargetRef", () => {
  const t = (role: string, name: string, index = 0): FlowTarget => ({ role, name, index, tag: "", selector: "" });

  it("matches by exact role+name", () => {
    expect(resolveTargetRef(els, t("button", "Buy now"))).toBe("e1");
    expect(resolveTargetRef(els, t("textbox", "Search"))).toBe("e3");
  });

  it("disambiguates repeats by index and clamps out-of-range", () => {
    expect(resolveTargetRef(els, t("link", "Reviews", 0))).toBe("e2");
    expect(resolveTargetRef(els, t("link", "Reviews", 1))).toBe("e4");
    expect(resolveTargetRef(els, t("link", "Reviews", 9))).toBe("e4");
  });

  it("falls back to name-only when the role drifted", () => {
    expect(resolveTargetRef(els, t("menuitem", "Buy now"))).toBe("e1");
  });

  it("returns null when nothing matches", () => {
    expect(resolveTargetRef(els, t("button", "Nope"))).toBeNull();
  });
});

describe("stepToToolCall + classifyAction", () => {
  const target = (name: string): FlowTarget => ({ role: "button", name, index: 0, tag: "button", selector: "" });

  it("maps a navigate step", () => {
    const { tool, input } = stepToToolCall({ kind: "navigate", url: "https://x.test/", label: "" });
    expect(tool).toBe("navigate");
    expect(classifyAction(tool, input).risky).toBe(false);
  });

  it("flags a risky click by element name", () => {
    const step: FlowStep = { kind: "click", url: "u", label: "", target: target("Buy now") };
    const { tool, input, elementName } = stepToToolCall(step);
    expect(classifyAction(tool, input, elementName).risky).toBe(true);
  });

  it("treats a submit-type as risky and a plain type as safe", () => {
    const base: FlowStep = { kind: "type", url: "u", label: "", target: { role: "textbox", name: "Search", index: 0, tag: "input", selector: "" }, value: "hat" };
    const plain = stepToToolCall(base);
    expect(classifyAction(plain.tool, plain.input, plain.elementName).risky).toBe(false);
    const submit = stepToToolCall({ ...base, submit: true });
    expect(classifyAction(submit.tool, submit.input, submit.elementName).risky).toBe(true);
  });

  it("labels steps for display", () => {
    expect(labelForStep({ kind: "navigate", url: "https://shop.test/x" })).toContain("shop.test");
    expect(labelForStep({ kind: "type", url: "u", secret: true, target: { role: "textbox", name: "Password", index: 0, tag: "input", selector: "" } })).toMatch(/secret/i);
  });
});

describe("parseInteraction", () => {
  it("rejects junk and clamps fields", () => {
    expect(parseInteraction(null)).toBeNull();
    expect(parseInteraction({ kind: "nope" })).toBeNull();
    const ok = parseInteraction({ kind: "input", url: "https://a.test/", target: { role: "textbox", name: "Q", index: 2 }, value: "hi", secret: true });
    expect(ok).toEqual({ kind: "input", url: "https://a.test/", target: { role: "textbox", name: "Q", index: 2, tag: "", selector: "" }, value: "hi", secret: true });
  });
});

// ---------------------------------------------------------------------- store

describe("FlowStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-flow-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const step: FlowStep = { kind: "click", url: "https://a.test/", label: "Click a thing", target: { role: "button", name: "Go", index: 0, tag: "button", selector: "" } };

  it("creates, renames and removes a flow", () => {
    const store = new FlowStore(dir);
    const flow = store.create("First", "https://a.test/", [step]);
    expect(flow).not.toBeNull();
    store.rename(flow!.id, "Renamed");
    expect(store.get(flow!.id)!.name).toBe("Renamed");
    store.remove(flow!.id);
    expect(store.list()).toHaveLength(0);
  });

  it("rejects empty and persists across reloads", () => {
    const store = new FlowStore(dir);
    expect(store.create("Empty", "u", [])).toBeNull();
    store.create("Keeps", "https://a.test/", [step]);
    store.flush();
    const reopened = new FlowStore(dir);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]!.name).toBe("Keeps");
  });

  it("drops a stored secret value on revive but keeps the step", () => {
    const store = new FlowStore(dir);
    const secretStep: FlowStep = { kind: "type", url: "u", label: "secret", secret: true, value: "hunter2", target: { role: "textbox", name: "Password", index: 0, tag: "input", selector: "" } };
    store.create("Login", "https://a.test/", [secretStep]);
    store.flush();
    const got = new FlowStore(dir).list()[0]!;
    expect(got.steps[0]!.secret).toBe(true);
    expect(got.steps[0]!.value).toBeUndefined();
  });
});

// -------------------------------------------------------------- service infra

const snap: PageSnapshot = {
  tabId: "flow1",
  url: "https://shop.test/item",
  title: "Item",
  text: "An item for 20 dollars.",
  elements: [
    { ref: "e1", role: "button", name: "Buy now" },
    { ref: "e2", role: "link", name: "Reviews" },
    { ref: "e3", role: "textbox", name: "Search" },
  ],
  truncated: false,
};

function mockController() {
  return {
    calls: [] as string[],
    async snapshot() {
      this.calls.push("snapshot");
      return snap;
    },
    async navigate(_id: string, url: string) {
      this.calls.push(`navigate:${url}`);
      return { id: "flow1", url };
    },
    async click(_id: string, ref: string) {
      this.calls.push(`click:${ref}`);
    },
    async type(_id: string, ref: string) {
      this.calls.push(`type:${ref}`);
    },
  };
}

function fakeWc() {
  return { isDestroyed: () => false, on: vi.fn(), off: vi.fn(), send: vi.fn(), getURL: () => "https://a.test/" };
}

function fakeWindow() {
  const wc = fakeWc();
  const tab = { id: "tab1", url: "https://a.test/", view: { webContents: wc } };
  const tabs = new Set<string>();
  const win = {
    profile: { profile: { id: "p1" } },
    activeTab: () => tab,
    listTabs: () => [{ id: "tab1", url: "https://a.test/" }],
    getTab: () => tab,
    activate: vi.fn(),
    createTab: () => {
      tabs.add("flow1");
      return { id: "flow1" };
    },
    hasTab: (id: string) => tabs.has(id),
    closeTab: (id: string) => tabs.delete(id),
    isDisposed: () => false,
    openSingleton: vi.fn(),
    notifyInternalPages: vi.fn(),
    win: { isDestroyed: () => false, focus: vi.fn() },
  };
  return win as unknown as BrowserWindowCtl;
}

function fakeContext(controller: ReturnType<typeof mockController>, win: BrowserWindowCtl) {
  return {
    controller,
    windows: { forProfile: () => [win], open: () => win },
  } as unknown as AppContext;
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

function target(role: string, name: string): FlowTarget {
  return { role, name, index: 0, tag: "", selector: "" };
}

describe("FlowService recording", () => {
  let dir: string;
  let runtime: ProfileRuntime;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-flowsvc-"));
    runtime = { profile: { id: "p1" }, dataDir: dir } as unknown as ProfileRuntime;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("coalesces captured interactions into robust steps and saves them", () => {
    const controller = mockController();
    const win = fakeWindow();
    const svc = new FlowService(fakeContext(controller, win));
    svc.attach(runtime);
    svc.startRecording(win);

    const cap = (i: CapturedInteraction): void => svc.onCaptured("tab1", "p1", i);
    cap({ kind: "click", url: "https://a.test/", target: target("link", "Catalog") });
    cap({ kind: "input", url: "https://a.test/", target: target("textbox", "Search"), value: "ha" });
    cap({ kind: "input", url: "https://a.test/", target: target("textbox", "Search"), value: "hat" });
    cap({ kind: "submit", url: "https://a.test/", target: target("button", "Go") });

    const rec = svc.recordingView("p1");
    expect(rec.phase).toBe("recording");
    // Two input events on the same field collapse to one type step holding the final value.
    expect(rec.steps.map((s) => s.kind)).toEqual(["click", "type", "click"]);
    expect(rec.steps[1]!.value).toBe("hat");

    svc.stopRecording(win);
    expect(svc.recordingView("p1").phase).toBe("review");
    const flows = svc.saveRecording(runtime, "Shop search");
    expect(flows).toHaveLength(1);
    expect(flows[0]!.steps).toHaveLength(3);
    expect(svc.recordingView("p1").phase).toBe("idle");
  });

  it("records a secret field without its value", () => {
    const win = fakeWindow();
    const svc = new FlowService(fakeContext(mockController(), win));
    svc.attach(runtime);
    svc.startRecording(win);
    svc.onCaptured("tab1", "p1", { kind: "input", url: "https://a.test/", target: target("textbox", "Password"), value: "", secret: true });
    const rec = svc.recordingView("p1");
    expect(rec.steps[0]!.secret).toBe(true);
    expect(rec.steps[0]!.value).toBeUndefined();
  });
});

describe("FlowService replay", () => {
  let dir: string;
  let runtime: ProfileRuntime;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-flowrep-"));
    runtime = { profile: { id: "p1" }, dataDir: dir } as unknown as ProfileRuntime;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function seed(svc: FlowService, steps: FlowStep[]): string {
    return svc.storeFor(runtime).create("Flow", "https://shop.test/item", steps)!.id;
  }
  const only = (svc: FlowService): import("../src/shared/flow-ipc").FlowView => svc.list(runtime)[0]!;

  it("replays steps through the action primitives, gating risky and secret steps", async () => {
    const controller = mockController();
    const win = fakeWindow();
    const svc = new FlowService(fakeContext(controller, win));
    svc.attach(runtime);
    const id = seed(svc, [
      { kind: "navigate", url: "https://shop.test/item", label: "go" },
      { kind: "type", url: "u", label: "search", target: target("textbox", "Search"), value: "hat" },
      { kind: "click", url: "u", label: "reviews", target: target("link", "Reviews") },
      { kind: "click", url: "u", label: "buy", target: target("button", "Buy now") },
      { kind: "type", url: "u", label: "password", secret: true, target: target("textbox", "Password") },
    ]);

    svc.replay(runtime, id);

    // Pauses at the risky "Buy now" click without having clicked it.
    await waitFor(() => only(svc).replay?.approval?.kind === "risky");
    expect(only(svc).replay!.approval!.reason).toContain("Buy now");
    expect(controller.calls).toEqual(["navigate:https://shop.test/item", "snapshot", "type:e3", "snapshot", "click:e2"]);
    svc.approve(runtime, id, "approve");

    // Then pauses on the secret field as a handoff and never types it.
    await waitFor(() => only(svc).replay?.approval?.kind === "handoff");
    svc.approve(runtime, id, "approve");

    await waitFor(() => only(svc).replay === null);
    expect(controller.calls).toEqual(["navigate:https://shop.test/item", "snapshot", "type:e3", "snapshot", "click:e2", "snapshot", "click:e1"]);
    const stored = only(svc);
    expect(stored.replay).toBeNull();
  });

  it("pauses with an error when a step's target cannot be found, and skips on request", async () => {
    const controller = mockController();
    const win = fakeWindow();
    const svc = new FlowService(fakeContext(controller, win));
    svc.attach(runtime);
    const id = seed(svc, [{ kind: "click", url: "u", label: "ghost", target: target("button", "Ghost") }]);
    svc.replay(runtime, id);
    await waitFor(() => only(svc).replay?.approval?.kind === "error", 8000);
    expect(only(svc).replay!.approval!.reason).toMatch(/find/i);
    svc.approve(runtime, id, "skip");
    await waitFor(() => only(svc).replay === null);
  });

  it("stops a replay from the controls", async () => {
    const controller = mockController();
    const win = fakeWindow();
    const svc = new FlowService(fakeContext(controller, win));
    svc.attach(runtime);
    const id = seed(svc, [{ kind: "click", url: "u", label: "buy", target: target("button", "Buy now") }]);
    svc.replay(runtime, id);
    await waitFor(() => only(svc).replay?.status === "awaiting-approval");
    svc.stopReplay(runtime, id);
    await waitFor(() => only(svc).replay === null);
    expect(controller.calls).toEqual([]);
  });
});
