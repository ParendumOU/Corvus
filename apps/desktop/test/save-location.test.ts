import { describe, expect, it } from "vitest";
import { SAVE_LOCATION_MODES, saveLocationMode, saveLocationSettings } from "../src/shared/downloads";
import { defaultSettings } from "../src/shared/settings";

describe("save location mode", () => {
  it("saves to the downloads folder by default", () => {
    expect(saveLocationMode(defaultSettings().downloads)).toBe("downloads");
  });

  it("the save dialog wins over the prompt", () => {
    expect(saveLocationMode({ askWhereToSave: true, promptDestination: true })).toBe("choose");
    expect(saveLocationMode({ askWhereToSave: false, promptDestination: false })).toBe("downloads");
  });

  it("round-trips every mode", () => {
    for (const mode of SAVE_LOCATION_MODES) expect(saveLocationMode(saveLocationSettings(mode))).toBe(mode);
  });
});
