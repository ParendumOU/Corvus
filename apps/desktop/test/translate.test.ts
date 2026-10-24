import { describe, expect, it } from "vitest";
import { languageName, primaryLanguage, shouldOfferTranslation, translationTarget } from "../src/shared/translate";
import { defaultSettings, mergeSettings } from "../src/shared/settings";

describe("page translation rules", () => {
  it("reads the primary language of a tag", () => {
    expect(primaryLanguage("en-US")).toBe("en");
    expect(primaryLanguage(" pt_BR ")).toBe("pt");
    expect(primaryLanguage("ES")).toBe("es");
    expect(primaryLanguage("")).toBe("");
    expect(primaryLanguage("not a language")).toBe("");
  });

  it("translates into the setting, else the Corvus language, else the system's", () => {
    expect(translationTarget("fr", "es", "en-US")).toBe("fr");
    expect(translationTarget("", "es", "en-US")).toBe("es");
    expect(translationTarget("", "", "de-DE")).toBe("de");
    expect(translationTarget("", "", "")).toBe("en");
  });

  it("offers translation only for a page that declares another language", () => {
    expect(shouldOfferTranslation("en-GB", "es")).toBe(true);
    expect(shouldOfferTranslation("es-MX", "es")).toBe(false);
    expect(shouldOfferTranslation("", "es")).toBe(false);
  });

  it("names languages in the display language", () => {
    expect(languageName("es", "en")).toBe("Spanish");
    expect(languageName("en-US", "es")).toBe("Inglés");
    expect(languageName("", "en")).toBe("");
  });

  it("keeps a valid target language setting and drops a malformed one", () => {
    const base = defaultSettings();
    expect(base.translate).toEqual({ offer: true, targetLanguage: "" });
    expect(mergeSettings(base, { translate: { targetLanguage: "pt-BR", offer: false } }).translate).toEqual({ offer: false, targetLanguage: "pt-BR" });
    expect(mergeSettings(base, { translate: { targetLanguage: "<script>" } }).translate.targetLanguage).toBe("");
  });
});
