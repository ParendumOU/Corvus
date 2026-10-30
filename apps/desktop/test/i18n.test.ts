import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ES } from "../src/shared/i18n-es";
import { setUiLanguage, t } from "../src/renderer/common/i18n";
import { WRITE_ACTIONS } from "../src/shared/inline-write";
import { PERMISSION_LABELS } from "../src/shared/permissions";
import { resolveUiLanguage } from "../src/shared/settings";

const PAGES = fileURLToPath(new URL("../src/renderer/pages", import.meta.url));
/** Pages whose own text is translated so far (the rest only get the shared menu and title). */
const TRANSLATED = readdirSync(PAGES).filter((f) => /^(settings|newtab).*\.tsx?$/.test(f) || f === "shell.tsx");
const source = (file: string): string => readFileSync(join(PAGES, file), "utf8");

/** The runtime value of a double-quoted JS string literal's body. */
const unquote = (body: string): string => JSON.parse(`"${body}"`) as string;

/** t("…") literals; files whose own variables are named `t` import it as `tx`. */
function tLiterals(src: string): string[] {
  return [...src.matchAll(/\b(?:t|tx)\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]!));
}

const sourcesIn = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourcesIn(join(dir, e.name), ext) : ext.test(e.name) ? [readFileSync(join(dir, e.name), "utf8")] : [],
  );
/** Every renderer source: the browser UI, Corvus's pages, Assist and the reader. */
const RENDERER = sourcesIn(fileURLToPath(new URL("../src/renderer", import.meta.url)), /\.tsx?$/);
/** Main-process sources (native menus and dialogs translate with tr("…")). */
const MAIN = sourcesIn(fileURLToPath(new URL("../src/main", import.meta.url)), /\.ts$/);
/** Agent step labels: templates the agent runner fills in Corvus's language (t is its translator). */
const STEP_LABELS = readFileSync(fileURLToPath(new URL("../src/shared/assist-agent.ts", import.meta.url)), "utf8");

const HTML = fileURLToPath(new URL("../src/renderer", import.meta.url));
/** The <title> of each internal page, which main/protocol.ts translates when it serves the page. */
const htmlTitles = (): string[] =>
  readdirSync(HTML)
    .filter((f) => f.endsWith(".html"))
    .flatMap((f) => [...readFileSync(join(HTML, f), "utf8").matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]!));

const MENUS = readFileSync(fileURLToPath(new URL("../src/main/menus.ts", import.meta.url)), "utf8");
const trLiterals = (src: string): string[] => [...src.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]!));
/** Labels the native menus translate with tr("…"), plus the inline-write actions they list. */
const menuLabels = (): string[] => [...trLiterals(MENUS), ...WRITE_ACTIONS.map((a) => a.label)];

describe("UI language", () => {
  afterEach(() => setUiLanguage("en"));

  it("follows the setting, or a Spanish system locale", () => {
    expect(resolveUiLanguage("system", "es-ES")).toBe("es");
    expect(resolveUiLanguage("system", "es")).toBe("es");
    expect(resolveUiLanguage("system", "en-US")).toBe("en");
    expect(resolveUiLanguage("system", "estonian")).toBe("en");
    expect(resolveUiLanguage("en", "es-ES")).toBe("en");
    expect(resolveUiLanguage("es", "de-DE")).toBe("es");
  });

  it("translates, fills placeholders and falls back to English", () => {
    expect(t("Theme")).toBe("Theme");
    setUiLanguage("es");
    expect(t("Theme")).toBe("Tema");
    expect(t("Running on port {port}", { port: 57150 })).toBe("En marcha en el puerto 57150");
    expect(t("Not a known string")).toBe("Not a known string");
  });

  it("has a Spanish string for every translated text on the settings pages and the page menu", () => {
    const missing = TRANSLATED.flatMap((file) => tLiterals(source(file)).filter((text) => !(text in ES)).map((text) => `${file}: ${text}`));
    expect(missing).toEqual([]);
  });

  it("has a Spanish string for every translated text in the browser UI, its pages and native dialogs", () => {
    const texts = [...RENDERER.flatMap(tLiterals), ...MAIN.flatMap(trLiterals), ...tLiterals(STEP_LABELS)];
    expect(texts.length).toBeGreaterThan(1500);
    expect([...new Set(texts)].filter((text) => !(text in ES))).toEqual([]);
  });

  it("has a Spanish string for every native menu label", () => {
    expect(menuLabels().length).toBeGreaterThan(90);
    expect(menuLabels().filter((text) => !(text in ES))).toEqual([]);
  });

  it("leaves no plain English label in the native menus", () => {
    expect([...MENUS.matchAll(/label: ["`][^"`]*["`]/g)].map((m) => m[0])).toEqual([]);
  });

  it("has Spanish page titles and permission names", () => {
    const titles = htmlTitles();
    expect(titles.length).toBeGreaterThan(20);
    const permissions = Object.values(PERMISSION_LABELS).flatMap((p) => [p.title, p.prompt]);
    expect([...titles, ...permissions].filter((text) => !(text in ES))).toEqual([]);
  });

  it("leaves no English text outside t() on the translated pages", () => {
    // Names and examples that read the same in every language.
    const KEEP = new Set(["Ctrl+Shift+B", "America/New_York, Asia/Tokyo", "JavaScript"]);
    const leftovers: string[] = [];
    // Markup in .ts files is widget content (templates), not Corvus's own interface.
    for (const file of TRANSLATED.filter((f) => f.endsWith(".tsx"))) {
      const lines = source(file).split("\n");
      lines.forEach((line, i) => {
        const where = `${file}:${i + 1}: ${line.trim()}`;
        for (const m of line.matchAll(/\b(?:label|hint|title|description|placeholder|aria-label)="([^"]*)"/g)) {
          if (/^[A-Z][a-z]/.test(m[1]!) && !KEEP.has(m[1]!)) leftovers.push(where);
        }
        if (/<[a-z][^>]*>\s*[A-Z][a-z]+ [a-z][^<{]*</.test(line)) leftovers.push(where);
        const text = line.trim();
        const previous = lines.slice(0, i).reverse().find((l) => l.trim()) ?? "";
        if (/^[A-Z][a-z]+(?: [A-Za-z’',.…()-]+)+$/.test(text) && previous.trim().endsWith(">")) leftovers.push(where);
      });
    }
    expect(leftovers).toEqual([]);
  });

  it("has no Spanish strings left behind by removed texts", () => {
    const used = new Set([...RENDERER.flatMap(tLiterals), ...MAIN.flatMap(trLiterals), ...tLiterals(STEP_LABELS), ...menuLabels()]);
    for (const title of htmlTitles()) used.add(title);
    for (const p of Object.values(PERMISSION_LABELS)) {
      used.add(p.title);
      used.add(p.prompt);
    }
    expect(Object.keys(ES).filter((key) => !used.has(key))).toEqual([]);
  });
});
