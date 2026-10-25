import { describe, expect, it } from "vitest";
import { registerCommandApis } from "../src/main/extension-apis";
import type { RouterCallback } from "../src/main/extensions";
import { activeShortcuts, manifestCommands, matchesShortcut, parseShortcut, shortcutInput } from "../src/shared/extension-commands";

const manifest = {
  commands: {
    "toggle-feature": { suggested_key: { default: "Ctrl+Shift+Y", mac: "MacCtrl+Shift+Y" }, description: "Toggle" },
    _execute_action: { suggested_key: "Alt+Shift+O" },
    "steals-new-tab": { suggested_key: { default: "Ctrl+T" }, description: "Clashes with Corvus" },
    everywhere: { suggested_key: { default: "Ctrl+Shift+9" }, global: true },
    "no-key": { description: "Set by the person" },
    broken: { suggested_key: { default: "Shift+Q" } },
  },
};

describe("extension shortcuts", () => {
  it("reads Chrome's notation per platform: Ctrl is Command on macOS, MacCtrl is Control there", () => {
    expect(parseShortcut("Ctrl+Shift+Y", "win32")).toEqual({ ctrl: true, alt: false, shift: true, meta: false, code: "KeyY" });
    expect(parseShortcut("Ctrl+Shift+Y", "darwin")).toEqual({ ctrl: false, alt: false, shift: true, meta: true, code: "KeyY" });
    expect(parseShortcut("MacCtrl+Comma", "darwin")).toEqual({ ctrl: true, alt: false, shift: false, meta: false, code: "Comma" });
    expect(parseShortcut("Alt+Up", "linux")!.code).toBe("ArrowUp");
    expect(parseShortcut("Shift+Q", "win32")).toBeNull();
    expect(parseShortcut("Command+K", "win32")).toBeNull();
    expect(parseShortcut("Ctrl+F13", "win32")).toBeNull();
  });

  it("lists the manifest's commands with this platform's suggestion, never global ones", () => {
    const list = manifestCommands(manifest, "darwin");
    expect(list.find((c) => c.name === "toggle-feature")!.shortcut).toBe("MacCtrl+Shift+Y");
    expect(list.find((c) => c.name === "everywhere")!.shortcut).toBe("");
    expect(list.find((c) => c.name === "no-key")).toEqual({ name: "no-key", description: "Set by the person", shortcut: "" });
    expect(manifestCommands({}, "win32")).toEqual([]);
  });

  it("keeps Corvus's own shortcuts for Corvus and matches key presses", () => {
    const names = activeShortcuts(manifest, "win32").map((c) => c.name);
    expect(names).toEqual(["toggle-feature", "_execute_action"]);
    const [toggle] = activeShortcuts(manifest, "win32");
    expect(matchesShortcut({ type: "keyDown", key: "Y", code: "KeyY", control: true, shift: true, alt: false, meta: false }, toggle!.shortcut)).toBe(true);
    expect(matchesShortcut({ type: "keyDown", key: "Y", code: "KeyY", control: true, shift: false, alt: false, meta: false }, toggle!.shortcut)).toBe(false);
    expect(matchesShortcut({ type: "keyUp", key: "Y", code: "KeyY", control: true, shift: true, alt: false, meta: false }, toggle!.shortcut)).toBe(false);
    expect(shortcutInput(parseShortcut("Ctrl+T", "win32")!)).toMatchObject({ key: "t", control: true });
  });

  it("commands.getAll reports the shortcut that really works here", async () => {
    let getAll: RouterCallback = () => [];
    registerCommandApis({ intercept: (name, wrap) => void (name === "commands.getAll" && (getAll = wrap(getAll))) }, "win32");
    const list = (await getAll({ type: "frame", extension: { manifest } as unknown as Electron.Extension })) as Array<{ name: string; shortcut: string }>;
    expect(Object.fromEntries(list.map((c) => [c.name, c.shortcut]))).toEqual({
      "toggle-feature": "Ctrl+Shift+Y",
      _execute_action: "Alt+Shift+O",
      "steals-new-tab": "",
      everywhere: "",
      "no-key": "",
      broken: "",
    });
  });
});
