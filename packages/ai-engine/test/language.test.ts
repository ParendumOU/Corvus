import { describe, expect, it } from "vitest";
import { detectLanguage, normalizeLocale, resolveLanguage } from "../src/language.js";

describe("detectLanguage", () => {
  it.each([
    ["what is the capital of australia", "en"],
    ["how to bake sourdough bread", "en"],
    ["best pizza near me", "en"],
    ["como hacer una tortilla de patatas", "es"],
    ["qué es la fotosíntesis", "es"],
    ["mejores portátiles 2026", "es"],
    ["meilleur restaurant à paris ce soir", "fr"],
    ["wie funktioniert eine wärmepumpe", "de"],
    ["cos'è la fotosintesi", "it"],
    ["previsão do tempo em lisboa amanhã", "pt"],
    ["jak zrobić pierogi ruskie", "pl"],
    ["погода в москве", "ru"],
    ["яка погода у києві", "uk"],
    ["東京の天気", "ja"],
    ["北京天气", "zh"],
    ["서울 날씨", "ko"],
    ["Η πρωτεύουσα της Ελλάδας", "el"],
  ])("%s -> %s", (query, lang) => {
    expect(detectLanguage(query)?.lang).toBe(lang);
  });

  // Ambiguous queries must fall through to the UI locale rather than guess wrong.
  it.each(["rust async", "iphone 16 pro", "receta paella", "javascript array sort", "", "1234"])(
    "is unsure about short/ambiguous %j",
    (query) => {
      expect(detectLanguage(query)).toBeUndefined();
    },
  );

  it("never misdetects English text whose trigrams look French", () => {
    expect(detectLanguage("climate change effects on oceans")?.lang ?? "en").toBe("en");
  });

  it("detects longer text from trigrams alone", () => {
    expect(detectLanguage("İstanbul'daki en iyi kahvaltı mekanları hangileri")?.lang).toBe("tr");
  });

  it("returns a confidence in 0..1", () => {
    const d = detectLanguage("what is the capital of australia");
    expect(d!.confidence).toBeGreaterThan(0);
    expect(d!.confidence).toBeLessThanOrEqual(1);
  });
});

describe("resolveLanguage", () => {
  it("explicit > detected > UI locale > en", () => {
    expect(resolveLanguage("como hacer una tortilla de patatas", "fr", "de-DE")).toBe("fr");
    expect(resolveLanguage("como hacer una tortilla de patatas", undefined, "de-DE")).toBe("es");
    expect(resolveLanguage("rust async", undefined, "de_DE")).toBe("de-DE");
    expect(resolveLanguage("rust async")).toBe("en");
  });

  it("keeps the UI region when the detected base language matches", () => {
    expect(resolveLanguage("previsão do tempo em lisboa amanhã", undefined, "pt-br")).toBe("pt-BR");
  });

  it("normalizes locales", () => {
    expect(normalizeLocale("es_es")).toBe("es-ES");
    expect(normalizeLocale("zh-hant-tw")).toBe("zh-Hant-TW");
    expect(normalizeLocale("C")).toBeUndefined();
    expect(normalizeLocale(undefined)).toBeUndefined();
  });
});
