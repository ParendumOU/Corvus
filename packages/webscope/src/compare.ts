import type { CapturedResponse, HistoryEntry, ResponseComparison, ResponseDiffLine } from "./types.js";

/** Line-based LCS diff. Keeps output bounded by capping the number of lines compared. */
export function diffLines(a: string[], b: string[], maxLines = 4000): ResponseDiffLine[] {
  const aa = a.slice(0, maxLines);
  const bb = b.slice(0, maxLines);
  const n = aa.length;
  const m = bb.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = aa[i] === bb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: ResponseDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aa[i] === bb[j]) {
      out.push({ kind: "same", text: aa[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: aa[i]! });
      i++;
    } else {
      out.push({ kind: "added", text: bb[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "removed", text: aa[i++]! });
  while (j < m) out.push({ kind: "added", text: bb[j++]! });
  return out;
}

function bodyText(response: CapturedResponse | undefined): string {
  if (!response?.body) return "";
  return response.bodyBase64 ? `[binary ${response.size ?? 0} bytes]` : response.body;
}

function headerText(response: CapturedResponse | undefined): string[] {
  if (!response) return [];
  return response.headers.map((h) => `${h.name}: ${h.value}`).sort();
}

function side(entry: HistoryEntry): ResponseComparison["a"] {
  return {
    status: entry.response?.status ?? null,
    length: entry.response?.size ?? (entry.response?.body ? entry.response.body.length : 0),
    durationMs: entry.durationMs ?? null,
  };
}

/** Compare two captured/repeater exchanges field by field. */
export function compareResponses(a: HistoryEntry, b: HistoryEntry): ResponseComparison {
  return {
    statusChanged: (a.response?.status ?? null) !== (b.response?.status ?? null),
    a: side(a),
    b: side(b),
    headerDiff: diffLines(headerText(a.response), headerText(b.response)),
    bodyDiff: diffLines(bodyText(a.response).split("\n"), bodyText(b.response).split("\n")),
  };
}
