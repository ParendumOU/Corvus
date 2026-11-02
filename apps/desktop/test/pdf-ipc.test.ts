import { describe, expect, it } from "vitest";
import {
  buildPdfMarkdown,
  capPagesForAi,
  isAttachmentDisposition,
  isPdfUrl,
  isSupportedPdfSource,
  pdfCaptureFromViewer,
  pdfFileName,
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

describe("isAttachmentDisposition", () => {
  it("is true only when the site asks to save the file", () => {
    expect(isAttachmentDisposition('attachment; filename="invoice.pdf"')).toBe(true);
    expect(isAttachmentDisposition("Attachment")).toBe(true);
    expect(isAttachmentDisposition(" attachment ;filename*=UTF-8''a.pdf")).toBe(true);
    expect(isAttachmentDisposition('inline; filename="attachment.pdf"')).toBe(false);
    expect(isAttachmentDisposition("attachments")).toBe(false);
    expect(isAttachmentDisposition("")).toBe(false);
  });
});

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

describe("captured downloads", () => {
  it("carry the capture id in the viewer url, next to the source", () => {
    const src = "https://bank.example/Certificado.aspx?k=123";
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const viewer = pdfViewerUrl(src, id);
    expect(pdfSrcFromViewer(viewer)).toBe(src);
    expect(pdfCaptureFromViewer(viewer)).toBe(id);
    expect(pdfCaptureFromViewer(pdfViewerUrl(src))).toBeNull();
    expect(pdfCaptureFromViewer(`${pdfViewerUrl(src)}&capture=../../etc`)).toBeNull();
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

describe("pdfFileName", () => {
  it("saves under the server's or the source's name, as a .pdf a file system accepts", () => {
    expect(pdfFileName("cert.pdf")).toBe("cert.pdf");
    expect(pdfFileName("WELE200M_CertificadoTitularidad_Res.aspx")).toBe("WELE200M_CertificadoTitularidad_Res.pdf");
    expect(pdfFileName('a/b:c*?"<>|.pdf')).toBe("a b c.pdf");
    expect(pdfFileName("")).toBe("document.pdf");
  });
});
