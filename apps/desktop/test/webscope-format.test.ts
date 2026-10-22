import { describe, expect, it } from "vitest";
import { expandPayloadSet, planRequests } from "../../../packages/webscope/src/fuzzer";
import {
  bodyBytes,
  countPositions,
  draftToRequest,
  emptyDraft,
  fmtBytes,
  fmtMs,
  headersToText,
  hexDump,
  payloadSetSize,
  plannedRequests,
  prettyBody,
  statusClass,
  textToHeaders,
  type AttackKind,
  type PayloadSetDraft,
} from "../src/renderer/pages/webscope-format";

describe("status and size formatting", () => {
  it("maps statuses to classes, null as an error", () => {
    expect(statusClass(204)).toBe("st-2");
    expect(statusClass(404)).toBe("st-4");
    expect(statusClass(null)).toBe("st-5");
  });
  it("formats bytes and durations", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 kB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(fmtMs(42)).toBe("42 ms");
    expect(fmtMs(null)).toBe("-");
  });
});

describe("headers and drafts", () => {
  it("round-trips headers and skips malformed lines", () => {
    const headers = textToHeaders("Accept: */*\n\nbroken line\n: no-name\nX-Test:  a:b  ");
    expect(headers).toEqual([
      { name: "Accept", value: "*/*" },
      { name: "X-Test", value: "a:b" },
    ]);
    expect(headersToText(headers)).toBe("Accept: */*\nX-Test: a:b");
  });
  it("omits empty body and unset flags from the outbound request", () => {
    expect(draftToRequest({ ...emptyDraft(), url: "  https://a.test/x  " })).toEqual({ method: "GET", url: "https://a.test/x", headers: [] });
    const full = draftToRequest({ ...emptyDraft(), method: "POST", url: "https://a.test", body: "x=1", useProfileCookies: true, followRedirects: true });
    expect(full).toMatchObject({ body: "x=1", useProfileCookies: true, followRedirects: true });
  });
});

describe("body views", () => {
  it("decodes base64 and UTF-8 bodies to bytes", () => {
    expect([...bodyBytes("AAH/", true)]).toEqual([0, 1, 255]);
    expect([...bodyBytes("é", false)]).toEqual([0xc3, 0xa9]);
    expect(bodyBytes(undefined, false).length).toBe(0);
  });
  it("renders a hex dump with offsets and ascii, and caps long bodies", () => {
    const dump = hexDump(new TextEncoder().encode("Hello, WebScope!!"));
    const [first, second] = dump.split("\n");
    expect(first).toMatch(/^00000000 {2}48 65 6c 6c 6f 2c 20 57 {2}65 62 53 63 6f 70 65 21 {2}Hello, WebScope!$/);
    expect(second).toMatch(/^00000010 {2}21/);
    expect(hexDump(new Uint8Array(40), 16).split("\n").pop()).toBe("… 24 more bytes");
  });
  it("pretty-prints JSON and falls back to raw when it is not JSON", () => {
    expect(prettyBody('{"a":1,"b":[2]}', "application/json", false).text).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(prettyBody("{not json", "application/json", false).text).toBe("{not json");
  });
  it("indents HTML structure", () => {
    const out = prettyBody("<html><body><p>hi</p><br></body></html>", "text/html", false).text;
    expect(out).toBe("<html>\n  <body>\n    <p>hi</p>\n    <br>\n  </body>\n</html>");
  });
  it("points binary bodies at the hex view and leaves huge bodies raw", () => {
    expect(prettyBody("AAAA", "image/png", true).note).toMatch(/Hex/);
    const big = "x".repeat(600 * 1024);
    const res = prettyBody(big, "application/json", false);
    expect(res.text).toBe(big);
    expect(res.note).toMatch(/too large/);
  });
});

describe("fuzzer planning preview", () => {
  it("counts § positions across url, headers and body", () => {
    expect(countPositions("https://a.test/§id§?q=§x§", "X: §h§", "")).toBe(3);
    expect(countPositions("https://a.test/", "", "")).toBe(0);
  });

  const sets: PayloadSetDraft[] = [
    { kind: "wordlist", text: "a\n b \n\nc", from: "0", to: "0", step: "1" },
    { kind: "numbers", text: "", from: "10", to: "1", step: "3" },
    { kind: "charset", text: "xy\nz", from: "0", to: "0", step: "1" },
  ];
  const toEngine = (d: PayloadSetDraft) =>
    d.kind === "wordlist"
      ? { kind: "wordlist" as const, values: d.text.split("\n").map((s) => s.trim()).filter(Boolean) }
      : d.kind === "charset"
        ? { kind: "charset" as const, charset: d.text.replace(/\n/g, "") }
        : { kind: "numbers" as const, from: Number(d.from), to: Number(d.to), step: Number(d.step) };

  it("sizes payload sets exactly like the engine expands them", () => {
    for (const s of sets) expect(payloadSetSize(s)).toBe(expandPayloadSet(toEngine(s)).length);
  });

  it("predicts the same request count as the engine for every attack type", () => {
    const templates = ["https://a.test/", "https://a.test/§a§", "https://a.test/§a§/§b§", "https://a.test/§a§/§b§/§c§/§d§"];
    const attacks: AttackKind[] = ["sniper", "cluster-bomb", "pitchfork"];
    for (const url of templates) {
      for (const attack of attacks) {
        for (const chosen of [sets.slice(0, 1), sets.slice(0, 2), sets]) {
          const engine = planRequests({
            template: { method: "GET", url, headers: [] },
            attack,
            payloadSets: chosen.map(toEngine),
            concurrency: 1,
            requestsPerSecond: 1,
          }).length;
          expect(plannedRequests(attack, countPositions(url), chosen.map(payloadSetSize)), `${attack} ${url} sets=${chosen.length}`).toBe(engine);
        }
      }
    }
  });
});
