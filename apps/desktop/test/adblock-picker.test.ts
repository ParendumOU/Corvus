import { afterEach, describe, expect, it } from "vitest";
import { elementPickerScript } from "../src/main/adblock-picker";
import { setMenuLanguage } from "../src/main/menu-i18n";

describe("the element picker", () => {
  afterEach(() => setMenuLanguage(() => "en"));

  it("is a valid script whose bar speaks Corvus's language", () => {
    setMenuLanguage(() => "es");
    const script = elementPickerScript({ x: 1, y: 2 });
    expect(() => new Function(`return ${script}`)).not.toThrow();
    expect(script).toContain("Haz clic en un elemento para ocultarlo");
    expect(script).toContain('"confirmBefore":"¿Ocultar "');
    expect(script).not.toContain("Click an element to hide it");
  });
});
