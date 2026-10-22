import { describe, expect, it } from "vitest";
import {
  buildPdfMarkdown,
  capPagesForAi,
  isPdfUrl,
  isSupportedPdfSource,
  pdfExcerpt,
  pdfSrcFromViewer,
  pdfTitleFromSource,
  pdfViewerUrl,
  type PdfPageText,
} from "../src/shared/pdf-ipc";
import { readingItemToMarkdown, type ReadingItem } from "../src/shared/reading";

const pages: PdfPageText[] = [
  { page: 1, text: "Intro to ravens." },
  { page: 2, text: "Ravens are clever." },
];

describe("isPdfUrl", () => {
  it("matches .pdf paths on supported schemes, ignoring query/hash", () => {
    expect(isPdfUrl("https://example.org/a/report.pdf")).toBe(true);
    expect(isPdfUrl("https://example.org/report.PDF?x=1#p2")).toBe(true);
    expect(isPdfUrl("file:///home/user/doc.pdf")).toBe(true);
  });
  it("rejects non-pdf and unsupported schemes", () => {
    expect(isPdfUrl("https://example.org/report.html")).toBe(false);
    expect(isPdfUrl("https://example.org/pdf-viewer")).toBe(false);
    expect(isPdfUrl("data:application/pdf,abc")).toBe(false);
    expect(isPdfUrl("not a url")).toBe(false);
  });
});

describe("viewer url round-trip", () => {
  it("encodes and recovers the source, validating the scheme", () => {
    const src = "https://example.org/files/a b.pdf?token=1";
    const viewer = pdfViewerUrl(src);
    expect(viewer.startsWith("corvus://pdf/?src=")).toBe(true);
    expect(pdfSrcFromViewer(viewer)).toBe(src);
  });
  it("returns null for non-viewer or unsupported-source urls", () => {
    expect(pdfSrcFromViewer("corvus://reading/")).toBeNull();
    expect(pdfSrcFromViewer("https://example.org/")).toBeNull();
    expect(pdfSrcFromViewer(`corvus://pdf/?src=${encodeURIComponent("javascript:alert(1)")}`)).toBeNull();
  });
});

describe("isSupportedPdfSource", () => {
  it("allows http(s)/file, rejects others", () => {
    expect(isSupportedPdfSource("http://x/y.pdf")).toBe(true);
    expect(isSupportedPdfSource("file:///y.pdf")).toBe(true);
    expect(isSupportedPdfSource("corvus://pdf/")).toBe(false);
    expect(isSupportedPdfSource("ftp://x/y.pdf")).toBe(false);
  });
});

describe("pdfTitleFromSource", () => {
  it("uses the decoded filename, falling back to host", () => {
    expect(pdfTitleFromSource("https://ex.org/docs/Annual%20Report.pdf")).toBe("Annual Report.pdf");
    expect(pdfTitleFromSource("https://ex.org/")).toBe("ex.org");
  });
});

describe("capPagesForAi", () => {
  it("keeps contiguous leading pages within the budget", () => {
    const big: PdfPageText[] = [
      { page: 1, text: "a".repeat(60) },
      { page: 2, text: "b".repeat(60) },
      { page: 3, text: "c".repeat(60) },
    ];
    const capped = capPagesForAi(big, 130);
    expect(capped.map((p) => p.page)).toEqual([1, 2]);
  });
  it("always keeps at least the first page", () => {
    expect(capPagesForAi([{ page: 1, text: "x".repeat(999) }], 10)).toHaveLength(1);
  });
});

describe("buildPdfMarkdown", () => {
  const md = buildPdfMarkdown({ src: "https://ex.org/r.pdf", title: "Ravens", pageCount: 2 }, pages);

  it("emits the reading-library header marker and per-page sections", () => {
    expect(md).toContain("# Ravens");
    expect(md).toContain("<https://ex.org/r.pdf>");
    expect(md).toContain("## Page 1");
    expect(md).toContain("## Page 2");
  });

  it("is splittable by the reading library export (keeps header, key points, body)", () => {
    const item: ReadingItem = {
      id: "1",
      url: "https://ex.org/r.pdf",
      title: "Ravens",
      siteName: "PDF",
      byline: "",
      excerpt: "Intro",
      markdown: md,
      keyPoints: ["Ravens are clever [2]"],
      wordCount: 6,
      readingMinutes: 1,
      savedAt: 0,
    };
    const exported = readingItemToMarkdown(item);
    expect(exported).toContain("## Key points");
    expect(exported).toContain("## Page 1");
    expect(exported.indexOf("## Key points")).toBeLessThan(exported.indexOf("## Page 1"));
  });
});

describe("pdfExcerpt", () => {
  it("takes the first non-empty page and caps length", () => {
    expect(pdfExcerpt([{ page: 1, text: "   " }, { page: 2, text: "Hello world" }])).toBe("Hello world");
    expect(pdfExcerpt([{ page: 1, text: "x".repeat(400) }], 20).length).toBe(20);
  });
});
