import { describe, expect, it } from "vitest";
import { PAGE_BASE, pageBaseColor } from "../src/shared/page-base";

describe("pageBaseColor", () => {
  it("paints web content on white whatever the UI theme", () => {
    for (const url of ["https://www.boe.es/", "http://127.0.0.1:8080/", "file:///C:/doc.html", "about:blank", "chrome-extension://abc/options.html", "data:text/html,hi"]) {
      expect(pageBaseColor(url, true)).toBe(PAGE_BASE.light);
      expect(pageBaseColor(url, false)).toBe(PAGE_BASE.light);
    }
  });

  it("follows the theme for Corvus pages, including a new tab's blank pre-paint", () => {
    for (const url of ["corvus://newtab/", "corvus://settings/#agents", "corvus://pdf/?url=x", "corvus://crash/?reason=oom"]) {
      expect(pageBaseColor(url, true)).toBe(PAGE_BASE.dark);
      expect(pageBaseColor(url, false)).toBe(PAGE_BASE.light);
    }
  });
});
