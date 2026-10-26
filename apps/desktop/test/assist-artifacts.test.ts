import { describe, expect, it, vi } from "vitest";
import { ARTIFACTS_PROMPT, ASSIST_OUTPUT_TOKENS, buildAssistPrompt } from "@corvus/ai-engine";
import {
  ARTIFACT_LIMITS,
  answerAsText,
  artifactAsText,
  copyableText,
  formReply,
  parseArtifact,
  safeUrl,
  splitAnswer,
  type Artifact,
} from "../src/shared/assist-artifacts";
import { uiContextMenuItems, type UiMenuParams, type UiMenuTarget } from "../src/main/ui-context-menu";

const block = (o: unknown): string => "```artifact\n" + JSON.stringify(o) + "\n```";

describe("artifact blocks in Assist answers", () => {
  it("splits an answer into text and validated artifacts, in order", () => {
    const text = `Here are the options:\n${block({ type: "table", title: "Flights", columns: [{ key: "airline", label: "Airline" }, { key: "price", label: "Price", format: "currency", currency: "EUR" }], rows: [{ airline: "Vueling", price: 111 }, { airline: "TAP", price: 139.5 }] })}\nThe cheapest is Vueling [2].`;
    const parts = splitAnswer(text);
    expect(parts.map((p) => p.kind)).toEqual(["text", "artifact", "text"]);
    const table = parts[1]!.kind === "artifact" ? parts[1]!.artifact : null;
    expect(table).toMatchObject({ type: "table", title: "Flights", rows: [{ airline: "Vueling", price: 111 }, { airline: "TAP", price: 139.5 }] });
  });

  it("shows a block still being written as pending, and a finished bad one as its text", () => {
    expect(splitAnswer('Lead-in\n```artifact\n{"type":"table","col', true).map((p) => p.kind)).toEqual(["text", "pending"]);
    const bad = splitAnswer('```artifact\n{"type":"script","code":"alert(1)"}\n```');
    expect(bad).toEqual([{ kind: "invalid", raw: '{"type":"script","code":"alert(1)"}', error: expect.stringMatching(/type must be/) }]);
    expect(splitAnswer("```artifact\nnot json\n```")[0]).toMatchObject({ kind: "invalid", error: "the block is not valid JSON" });
  });

  it("draws at most a few artifacts per answer", () => {
    const one = block({ type: "cards", layout: "checklist", items: ["a"] });
    const parts = splitAnswer(Array.from({ length: ARTIFACT_LIMITS.perAnswer + 2 }, () => one).join("\n"));
    expect(parts.filter((p) => p.kind === "artifact")).toHaveLength(ARTIFACT_LIMITS.perAnswer);
    expect(parts.filter((p) => p.kind === "invalid")).toHaveLength(2);
  });

  it("validates each kind and drops what is not allowed", () => {
    const kpi = parseArtifact(JSON.stringify({ type: "cards", layout: "kpi", items: [{ label: "Price", value: "€39", tone: "good", extra: "<b>x</b>" }] }));
    expect(kpi).toEqual({ type: "cards", layout: "kpi", title: "", items: [{ label: "Price", value: "€39", tone: "good" }] });

    const links = parseArtifact(JSON.stringify({ type: "links", items: [{ title: "Ok", url: "https://example.com/a" }, { title: "Bad", url: "javascript:alert(1)" }, { title: "File", url: "file:///etc/passwd" }] }));
    expect(links).toEqual({ type: "links", title: "", items: [{ title: "Ok", url: "https://example.com/a" }] });
    expect(() => parseArtifact(JSON.stringify({ type: "links", items: [{ url: "javascript:alert(1)" }] }))).toThrow(/http/);

    const chart = parseArtifact(JSON.stringify({ type: "chart", kind: "line", labels: ["Mon", "Tue"], series: [{ label: "€", values: [1, 2.5] }], format: "currency", currency: "EUR" }));
    expect(chart).toMatchObject({ kind: "line", labels: ["Mon", "Tue"], series: [{ values: [1, 2.5] }], currency: "EUR" });
    expect(() => parseArtifact(JSON.stringify({ type: "chart", labels: ["a", "b"], series: [{ values: [1, "x"] }] }))).toThrow(/must be a number/);
    expect(() => parseArtifact(JSON.stringify({ type: "chart", kind: "pie", labels: ["a"], series: [{ values: [-1] }] }))).toThrow(/negative/);

    const form = parseArtifact(JSON.stringify({ type: "form", title: "Trip", fields: [{ key: "dates", label: "Dates", required: true }, { key: "class", label: "Class", type: "radio", options: ["Economy", "Business"] }, { key: "x", label: "X", type: "html" }] }));
    expect(form).toEqual({
      type: "form",
      title: "Trip",
      submitLabel: "",
      fields: [
        { key: "dates", label: "Dates", type: "text", required: true },
        { key: "class", label: "Class", type: "radio", options: ["Economy", "Business"], required: false },
        { key: "x", label: "X", type: "text", required: false },
      ],
    });
    expect(() => parseArtifact(JSON.stringify({ type: "form", fields: [{ key: "bad key", label: "x" }] }))).toThrow(/key/);
  });

  it("refuses repeated or invalid form keys and caps sizes", () => {
    expect(() => parseArtifact(JSON.stringify({ type: "form", fields: [{ key: "a", label: "A" }, { key: "a", label: "B" }] }))).toThrow(/repeated/);
    const rows = Array.from({ length: ARTIFACT_LIMITS.tableRows + 50 }, (_, i) => ({ n: i }));
    const t = parseArtifact(JSON.stringify({ type: "table", columns: [{ key: "n", label: "N", format: "number" }], rows }));
    expect(t.type === "table" && t.rows.length).toBe(ARTIFACT_LIMITS.tableRows);
    expect(() => parseArtifact("x".repeat(ARTIFACT_LIMITS.blockChars + 1))).toThrow(/too large/);
    // Control and bidi-override characters never reach the panel.
    const k = parseArtifact(JSON.stringify({ type: "cards", layout: "kpi", items: [{ label: "a‮b\u0007c", value: "1" }] }));
    expect(k.type === "cards" && k.layout === "kpi" && k.items[0]!.label).toBe("a b c");
  });

  it("only lets http(s) addresses through", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com/");
    expect(safeUrl("http://a.test/x?y=1")).toBe("http://a.test/x?y=1");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("corvus://settings/")).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });
});

describe("answers as text", () => {
  const table: Artifact = { type: "table", title: "Flights", columns: [{ key: "a", label: "Airline", format: "text" }, { key: "p", label: "Price", format: "currency", currency: "EUR" }], rows: [{ a: "Vueling", p: 111 }] };

  it("writes artifacts out as Markdown and drops citations", () => {
    expect(artifactAsText(table, "en")).toBe("Flights\n\n| Airline | Price |\n| --- | --- |\n| Vueling | €111.00 |");
    const text = `Vueling is cheapest [2][3].\n${block({ type: "cards", layout: "checklist", items: [{ text: "Book", done: true }, "Pack"] })}`;
    expect(answerAsText(text, "en")).toBe("Vueling is cheapest.\n\n- [x] Book\n- [ ] Pack");
  });

  it("copies summaries as TL;DR and points, and written text as is", () => {
    expect(copyableText({ kind: "summarize", text: "TLDR: raw", summary: { tldr: "Short.", points: [{ text: "One", sections: [1] }] } }, "en")).toBe("Short.\n\n- One");
    expect(copyableText({ kind: "write", text: "Hi [1]" }, "en")).toBe("Hi [1]");
    expect(copyableText({ kind: "ask", text: "Answer [1]." }, "en")).toBe("Answer.");
  });

  it("turns a filled-in form into the person's next message", () => {
    const form = parseArtifact(JSON.stringify({ type: "form", title: "Trip", fields: [{ key: "dates", label: "Dates" }, { key: "bags", label: "Checked bag", type: "checkbox" }, { key: "note", label: "Note" }] }));
    if (form.type !== "form") throw new Error("form");
    expect(formReply(form, { dates: " 3-5 May ", bags: true, note: "" }, { yes: "sí", no: "no" })).toBe("«Trip»:\n- Dates: 3-5 May\n- Checked bag: sí\n- Note: —");
  });
});

describe("Assist prompts", () => {
  it("tell the question answerer about artifacts and leave it room for them", () => {
    const p = buildAssistPrompt({ kind: "ask", page: { url: "https://a.test/", title: "A", sections: [] }, lang: "en", question: "q", history: [] });
    expect(p.system).toContain(ARTIFACTS_PROMPT);
    expect(ASSIST_OUTPUT_TOKENS.ask).toBeGreaterThanOrEqual(1000);
  });
});

describe("right-click menu in Corvus's own UI", () => {
  const params = (p: Partial<UiMenuParams>): UiMenuParams => ({
    isEditable: false,
    editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false },
    selectionText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    ...p,
  });
  const target = (): UiMenuTarget & { calls: string[] } => {
    const calls: string[] = [];
    const fn = (name: string) => () => void calls.push(name);
    return {
      calls,
      undo: fn("undo"),
      redo: fn("redo"),
      cut: fn("cut"),
      copy: fn("copy"),
      paste: fn("paste"),
      pasteAndMatchStyle: fn("pasteAndMatchStyle"),
      selectAll: fn("selectAll"),
      replaceMisspelling: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn(() => true) },
    } as unknown as UiMenuTarget & { calls: string[] };
  };

  it("offers paste in a text field and runs it on that page", () => {
    const wc = target();
    const items = uiContextMenuItems(wc, params({ isEditable: true }));
    const paste = items.find((i) => i.label === "Paste");
    expect(paste?.enabled).toBe(true);
    expect(items.find((i) => i.label === "Cut")?.enabled).toBe(false);
    (paste!.click as () => void)();
    expect(wc.calls).toEqual(["paste"]);
  });

  it("offers spelling fixes, Copy for selected text, and nothing elsewhere", () => {
    const wc = target();
    const spelling = uiContextMenuItems(wc, params({ isEditable: true, misspelledWord: "helo", dictionarySuggestions: ["hello", "help"] }));
    expect(spelling.slice(0, 2).map((i) => i.label)).toEqual(["hello", "help"]);
    expect(uiContextMenuItems(wc, params({ selectionText: "some answer" })).map((i) => i.label)).toEqual(["Copy", "Select all"]);
    expect(uiContextMenuItems(wc, params({}))).toEqual([]);
  });
});
