import type { HttpHeader, OutboundRequest, ResponseComparison } from "@corvus/webscope";

export function methodClass(method: string): string {
  return `badge m-${method.toLowerCase()}`;
}

export function statusClass(status: number | null): string {
  if (status === null) return "st-5";
  return `st-${Math.floor(status / 100)}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${n}`;
}

export function fmtMs(ms: number | null): string {
  return ms === null ? "—" : `${ms}ms`;
}

export function headersToText(headers: HttpHeader[]): string {
  return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
}

export function textToHeaders(text: string): HttpHeader[] {
  const out: HttpHeader[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    out.push({ name: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() });
  }
  return out;
}

export function newId(): string {
  return crypto.randomUUID();
}

export interface RequestDraft {
  method: string;
  url: string;
  headersText: string;
  body: string;
  useProfileCookies: boolean;
  followRedirects: boolean;
}

export function emptyDraft(): RequestDraft {
  return { method: "GET", url: "", headersText: "", body: "", useProfileCookies: false, followRedirects: false };
}

export function draftToRequest(d: RequestDraft): OutboundRequest {
  return {
    method: d.method,
    url: d.url.trim(),
    headers: textToHeaders(d.headersText),
    ...(d.body ? { body: d.body } : {}),
    ...(d.useProfileCookies ? { useProfileCookies: true } : {}),
    ...(d.followRedirects ? { followRedirects: true } : {}),
  };
}

export function MethodBadge({ method }: { method: string }) {
  return <span className={methodClass(method)}>{method.toUpperCase()}</span>;
}

export function DiffPane({ diff }: { diff: ResponseComparison }) {
  return (
    <div className="ws-pre">
      <div className="kvs" style={{ marginBottom: 8 }}>
        <span>
          A: {diff.a.status ?? "—"} · {fmtBytes(diff.a.length)} · {fmtMs(diff.a.durationMs)}
        </span>
        <span>
          B: {diff.b.status ?? "—"} · {fmtBytes(diff.b.length)} · {fmtMs(diff.b.durationMs)}
        </span>
        <span className={diff.statusChanged ? "hit" : ""}>{diff.statusChanged ? "status differs" : "status identical"}</span>
      </div>
      {diff.bodyDiff.map((line, i) =>
        line.kind === "same" ? (
          <span key={i}>{line.text}{"\n"}</span>
        ) : (
          <span key={i} className={line.kind === "added" ? "diff-add" : "diff-del"}>
            {line.kind === "added" ? "+ " : "- "}
            {line.text}
          </span>
        ),
      )}
    </div>
  );
}
