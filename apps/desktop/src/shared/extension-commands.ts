import { commandForInput, type KeyInput } from "./shortcuts";

/**
 * chrome.commands: the keyboard shortcuts an extension's manifest suggests, as Chrome reads them
 * ("Ctrl" is Command on macOS, "MacCtrl" the Control key there; Ctrl or Alt is required, Shift is
 * optional), matched against a key press. Pure, for the main process and the tests.
 */
export interface ExtensionCommand {
  name: string;
  description: string;
  /** The suggested shortcut as written for this platform ("" when none applies). */
  shortcut: string;
}

export interface Shortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** macOS: the Command key ("Ctrl" or "Command" in the manifest). */
  meta: boolean;
  /** KeyboardEvent.code of the key ("KeyY", "Digit1", "Comma", "ArrowUp"). */
  code: string;
}

const PLATFORM_KEY: Record<string, string> = { win32: "windows", darwin: "mac", linux: "linux" };

const NAMED_KEYS: Record<string, string> = {
  Comma: "Comma",
  Period: "Period",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Space: "Space",
  Insert: "Insert",
  Delete: "Delete",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

/** A manifest shortcut ("Ctrl+Shift+Y") as keys on this platform; null when it is not a valid one. */
export function parseShortcut(text: string, platform: string): Shortcut | null {
  const parts = text.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mac = platform === "darwin";
  const s: Shortcut = { ctrl: false, alt: false, shift: false, meta: false, code: "" };
  for (const m of parts) {
    if (m === "Ctrl") {
      if (mac) s.meta = true;
      else s.ctrl = true;
    } else if (m === "Command") {
      if (!mac) return null;
      s.meta = true;
    } else if (m === "MacCtrl") {
      if (!mac) return null;
      s.ctrl = true;
    } else if (m === "Alt") s.alt = true;
    else if (m === "Shift") s.shift = true;
    else return null;
  }
  if (!s.ctrl && !s.alt && !s.meta) return null;
  if (/^[A-Z]$/.test(key)) s.code = `Key${key}`;
  else if (/^[0-9]$/.test(key)) s.code = `Digit${key}`;
  else if (NAMED_KEYS[key]) s.code = NAMED_KEYS[key]!;
  else return null;
  return s;
}

/** The commands a manifest declares, with the shortcut it suggests for this platform. */
export function manifestCommands(manifest: unknown, platform: string): ExtensionCommand[] {
  const commands = (manifest as { commands?: unknown } | null)?.commands;
  if (!commands || typeof commands !== "object") return [];
  return Object.entries(commands as Record<string, unknown>).map(([name, raw]) => {
    const c = (raw ?? {}) as { description?: unknown; suggested_key?: unknown; global?: unknown };
    const keys = c.suggested_key;
    const suggestion =
      typeof keys === "string" ? keys : keys && typeof keys === "object" ? ((keys as Record<string, unknown>)[PLATFORM_KEY[platform] ?? "default"] ?? (keys as Record<string, unknown>).default) : undefined;
    return {
      name,
      description: typeof c.description === "string" ? c.description : "",
      // Global shortcuts (outside Corvus) are not offered.
      shortcut: typeof suggestion === "string" && c.global !== true && parseShortcut(suggestion, platform) ? suggestion : "",
    };
  });
}

/** Whether a key press is this shortcut. */
export function matchesShortcut(input: KeyInput & { code?: string }, s: Shortcut): boolean {
  return (
    input.type === "keyDown" &&
    input.code === s.code &&
    input.control === s.ctrl &&
    input.alt === s.alt &&
    input.shift === s.shift &&
    input.meta === s.meta
  );
}

/** The names that open the extension's toolbar button instead of reaching onCommand. */
export const ACTION_COMMANDS: ReadonlySet<string> = new Set(["_execute_action", "_execute_browser_action", "_execute_page_action"]);

const KEY_FOR_CODE: Record<string, string> = { Comma: ",", Period: ".", Space: " " };

/** The key press a shortcut is (to check it against Corvus's own shortcuts). */
export function shortcutInput(s: Shortcut): KeyInput & { code: string } {
  const key = s.code.startsWith("Key") ? s.code.slice(3).toLowerCase() : s.code.startsWith("Digit") ? s.code.slice(5) : (KEY_FOR_CODE[s.code] ?? s.code);
  return { type: "keyDown", key, code: s.code, control: s.ctrl, meta: s.meta, shift: s.shift, alt: s.alt };
}

/** The commands whose shortcut works here: valid for this platform and not one of Corvus's own. */
export function activeShortcuts(manifest: unknown, platform: string): Array<{ name: string; shortcut: Shortcut }> {
  return manifestCommands(manifest, platform).flatMap((c) => {
    const s = c.shortcut ? parseShortcut(c.shortcut, platform) : null;
    return s && !commandForInput(shortcutInput(s), platform) ? [{ name: c.name, shortcut: s }] : [];
  });
}
