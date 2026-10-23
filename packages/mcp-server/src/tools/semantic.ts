import type { PageSnapshot, SnapshotElement } from "@corvus/shared";
import { z } from "zod";
import { compactJson, truncate } from "../content.js";
import { defined, errorResult, need, OK, optionalTabId, ref, text, untrusted, type ToolContext } from "./types.js";
import { challengeNote } from "./visual.js";

const SNAPSHOT_DEFAULT_CHARS = 4000;
const SNAPSHOT_MAX_CHARS = 20000;
const SNAPSHOT_DEFAULT_ELEMENTS = 300;
const SNAPSHOT_MAX_ELEMENTS = 1000;
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 120_000;

/** One compact line per element: `e12 button "Save" [disabled] ="value" {a|b} @x,y,w,h`. */
export function renderElement(e: SnapshotElement): string {
  const role = e.level ? `${e.role}:${e.level}` : e.role;
  let line = `${e.ref} ${role} ${JSON.stringify(truncate(e.name, 100).text)}`;
  if (e.states?.length) line += ` [${e.states.join(",")}]`;
  if (e.value !== undefined) line += ` =${JSON.stringify(truncate(e.value, 100).text)}`;
  if (e.options?.length) line += ` {${e.options.map((o) => truncate(o, 40).text).join("|")}}`;
  if (e.bbox) line += ` @${e.bbox.join(",")}`;
  return line;
}

export function renderSnapshot(snap: PageSnapshot, maxChars: number, maxElements: number): string {
  const body = truncate(snap.text, maxChars);
  const elements = snap.elements.slice(0, maxElements).map(renderElement);
  const v = snap.viewport;
  const header = compactJson({
    tabId: snap.tabId,
    url: snap.url,
    title: snap.title,
    truncated: snap.truncated || body.truncated,
    viewport: v ? `${v.width}x${v.height}` : undefined,
    scrollY: v && v.scrollY > 0 ? Math.round(v.scrollY) : undefined,
    elementsOmitted: Math.max(0, snap.elements.length - maxElements) || undefined,
    dialog: snap.dialog ? { type: snap.dialog.type, message: snap.dialog.message } : undefined,
    challenge: snap.challenge ? { kind: snap.challenge.kind, detail: snap.challenge.detail, bbox: snap.challenge.bbox } : undefined,
  });
  const parts = [header];
  if (body.text) parts.push(body.text);
  if (elements.length) parts.push(`elements:\n${elements.join("\n")}`);
  return parts.join("\n");
}

function snapshotNotes(snap: PageSnapshot): string | undefined {
  const notes: string[] = [];
  if (snap.dialog) notes.push(`dialog_open: ${snap.dialog.type}. The page is blocked until you call handle_dialog.`);
  const challenge = challengeNote(snap.challenge);
  if (challenge) notes.push(challenge);
  return notes.length ? notes.join("\n") : undefined;
}

const fieldValue = z.union([z.string().max(10000), z.boolean(), z.array(z.string().max(1000)).max(100)]);

export function registerSemanticTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "page_snapshot",
    {
      description: "Read a page: main text plus elements (refs, roles, names, values, states). Cheaper than screenshot.",
      inputSchema: {
        tabId: optionalTabId,
        maxChars: z.number().int().min(0).max(SNAPSHOT_MAX_CHARS).default(SNAPSHOT_DEFAULT_CHARS).describe("Text budget; 0 = elements only"),
        viewportOnly: z.boolean().optional().describe("Only elements currently on screen"),
        boxes: z.boolean().optional().describe("Add @x,y,w,h boxes (CSS px) for coordinate tools"),
        maxElements: z.number().int().min(1).max(SNAPSHOT_MAX_ELEMENTS).default(SNAPSHOT_DEFAULT_ELEMENTS),
      },
      readOnly: true,
    },
    async (a) => {
      const opts = defined({
        maxChars: Math.max(a.maxChars, 100),
        viewportOnly: a.viewportOnly,
        boxes: a.boxes,
        text: a.maxChars === 0 ? false : undefined,
        maxElements: a.maxElements === SNAPSHOT_DEFAULT_ELEMENTS ? undefined : a.maxElements,
      });
      const snap = await controller.snapshot(await resolveTab(a.tabId), opts);
      if (a.maxChars === 0) snap.text = "";
      return untrusted(snap.url, renderSnapshot(snap, a.maxChars, a.maxElements), snapshotNotes(snap));
    },
  );

  const elementAction = (name: string) => need(controller.elementAction?.bind(controller), name);

  register("hover", { description: "Hover an element (real mouse move to its center).", requires: "elementAction", inputSchema: { ref, tabId: optionalTabId } }, async (a) => {
    await elementAction("hover")(await resolveTab(a.tabId), a.ref, { type: "hover" });
    return OK;
  });

  register("focus", { description: "Focus an element.", requires: "elementAction", inputSchema: { ref, tabId: optionalTabId } }, async (a) => {
    await elementAction("focus")(await resolveTab(a.tabId), a.ref, { type: "focus" });
    return OK;
  });

  register(
    "check",
    { description: "Check or uncheck a checkbox, radio or switch.", requires: "elementAction", inputSchema: { ref, checked: z.boolean().default(true), tabId: optionalTabId } },
    async (a) => {
      await elementAction("check")(await resolveTab(a.tabId), a.ref, { type: "check", checked: a.checked });
      return OK;
    },
  );

  register(
    "select_option",
    {
      description: "Select option(s) of a <select> or listbox by value or visible label.",
      requires: "elementAction",
      inputSchema: { ref, values: z.array(z.string().max(1000)).min(1).max(100), tabId: optionalTabId },
    },
    async (a) => {
      await elementAction("select_option")(await resolveTab(a.tabId), a.ref, { type: "select", values: a.values });
      return OK;
    },
  );

  register(
    "fill_form",
    {
      description: "Fill many fields at once: text (string), checkbox/radio (boolean), select (string or string[]).",
      requires: "fill",
      inputSchema: {
        fields: z.array(z.object({ ref, value: fieldValue })).min(1).max(100),
        tabId: optionalTabId,
      },
    },
    async (a) => {
      const fill = need(controller.fill?.bind(controller), "fill_form");
      const id = await resolveTab(a.tabId);
      const failed: string[] = [];
      for (const f of a.fields) {
        try {
          await fill(id, f.ref, f.value);
        } catch (err) {
          failed.push(`${f.ref}: ${truncate(err instanceof Error ? err.message : String(err), 200).text}`);
        }
      }
      if (failed.length === a.fields.length) return errorResult(`fill_form failed:\n${failed.join("\n")}`);
      const done = `filled ${a.fields.length - failed.length}/${a.fields.length}`;
      return text(failed.length ? `${done}; failed:\n${failed.join("\n")}` : done);
    },
  );

  register(
    "find",
    {
      description: "Find elements by visible text, CSS selector and/or role; returns refs with boxes.",
      requires: "find",
      inputSchema: {
        text: z.string().min(1).max(500).optional(),
        selector: z.string().min(1).max(1000).optional(),
        role: z.string().min(1).max(50).optional(),
        exact: z.boolean().optional().describe("Exact text match instead of substring"),
        limit: z.number().int().min(1).max(100).default(10),
        tabId: optionalTabId,
      },
      readOnly: true,
    },
    async (a) => {
      if (!a.text && !a.selector && !a.role) throw new Error("Pass text, selector or role");
      const find = need(controller.find?.bind(controller), "find");
      const id = await resolveTab(a.tabId);
      const found = await find(id, defined({ text: a.text, selector: a.selector, role: a.role, exact: a.exact, limit: a.limit }));
      return untrusted(`find:${id}`, found.length ? found.map(renderElement).join("\n") : "no matches");
    },
  );

  register(
    "wait_for",
    {
      description: "Wait for text, an element state, a URL, page load or network idle (polls until timeout).",
      requires: "waitFor",
      inputSchema: {
        text: z.string().min(1).max(500).optional().describe("Text appears (case-insensitive)"),
        textGone: z.string().min(1).max(500).optional().describe("Text disappears"),
        ref: ref.optional(),
        selector: z.string().min(1).max(1000).optional(),
        state: z.enum(["visible", "hidden", "attached", "detached"]).optional().describe("For ref/selector; default visible"),
        url: z.string().min(1).max(2000).optional().describe("URL contains this, or glob with *"),
        load: z.boolean().optional().describe("Page finished loading"),
        networkIdle: z.boolean().optional().describe("No requests for 500 ms"),
        timeoutMs: z.number().int().min(100).max(WAIT_MAX_MS).default(WAIT_DEFAULT_MS),
        tabId: optionalTabId,
      },
      readOnly: true,
    },
    async (a, signal) => {
      const { tabId: _tab, ...condition } = a;
      if (!condition.text && !condition.textGone && !condition.ref && !condition.selector && !condition.url && !condition.load && !condition.networkIdle) {
        await new Promise((r) => setTimeout(r, Math.min(condition.timeoutMs, 30_000)));
        return text(`waited ${Math.min(condition.timeoutMs, 30_000)}ms`);
      }
      const wait = need(controller.waitFor?.bind(controller), "wait_for");
      const id = await resolveTab(a.tabId);
      const res = await wait(id, defined(condition), signal);
      if (!res.matched) return errorResult(`wait_for timed out after ${res.elapsedMs}ms${res.detail ? ` (${res.detail})` : ""}`);
      return untrusted(res.url, compactJson({ matched: true, elapsedMs: res.elapsedMs, url: res.url }));
    },
  );
}
