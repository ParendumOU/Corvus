import { describe, expect, it } from "vitest";
import { PDF_BESIDE_INPUT_MS, claimPdfBeside, pdfKeepsPage, pdfOpensBesidePage } from "../src/main/pdf-intercept";
import type { TabRuntime } from "../src/main/window";

const now = 1_000_000;
const page = "https://example.com/reports";

describe("pdfKeepsPage", () => {
  it("is a page of the tab's own, not a tab opened for the PDF or a Corvus page", () => {
    expect(pdfKeepsPage({ committedUrl: page })).toBe(true);
    expect(pdfKeepsPage({ committedUrl: undefined })).toBe(false);
    expect(pdfKeepsPage({ committedUrl: "about:blank" })).toBe(false);
    expect(pdfKeepsPage({ committedUrl: "corvus://settings" })).toBe(false);
  });
});

describe("pdfOpensBesidePage", () => {
  it("needs the person's recent click or key press in the tab", () => {
    expect(pdfOpensBesidePage({ committedUrl: page }, now)).toBe(false);
    expect(pdfOpensBesidePage({ committedUrl: page, personInputAt: now - 200 }, now)).toBe(true);
    expect(pdfOpensBesidePage({ committedUrl: page, personInputAt: now - PDF_BESIDE_INPUT_MS - 1 }, now)).toBe(false);
  });

  it("never for a tab without a page of its own", () => {
    expect(pdfOpensBesidePage({ committedUrl: "about:blank", personInputAt: now - 200 }, now)).toBe(false);
    expect(pdfOpensBesidePage({ committedUrl: "corvus://newtab", personInputAt: now - 200 }, now)).toBe(false);
  });
});

describe("claimPdfBeside", () => {
  it("lets one input open one tab, so a page's scripts cannot open tab after tab", () => {
    const tab = { committedUrl: page, personInputAt: now - 200 } as TabRuntime;
    expect(claimPdfBeside(tab, now)).toBe(true);
    expect(claimPdfBeside(tab, now + 300)).toBe(false);
    tab.personInputAt = now + 1000;
    expect(claimPdfBeside(tab, now + 1100)).toBe(true);
  });
});
