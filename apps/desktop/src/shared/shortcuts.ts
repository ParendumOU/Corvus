/** Keyboard shortcut mapping, kept pure so it can be tested without Electron. */

export type BrowserCommand =
  | { type: "new-tab" }
  | { type: "new-window" }
  | { type: "close-tab" }
  | { type: "reopen-closed-tab" }
  | { type: "focus-omnibox" }
  | { type: "next-tab" }
  | { type: "prev-tab" }
  | { type: "select-tab"; n: number }
  | { type: "reload"; hard: boolean }
  | { type: "stop" }
  | { type: "back" }
  | { type: "forward" }
  | { type: "home" }
  | { type: "bookmark-page" }
  | { type: "open-history" }
  | { type: "open-bookmarks" }
  | { type: "toggle-bookmarks-bar" }
  | { type: "devtools" }
  | { type: "zoom"; delta: 1 | -1 | 0 }
  | { type: "find" }
  | { type: "find-next"; forward: boolean }
  | { type: "open-downloads" }
  | { type: "toggle-assist" }
  | { type: "command-palette" }
  | { type: "organize-tabs" };

export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export function commandForInput(input: KeyInput, platform: string): BrowserCommand | null {
  if (input.type !== "keyDown") return null;
  const mac = platform === "darwin";
  const mod = mac ? input.meta : input.control;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;

  if (key === "F5") return { type: "reload", hard: input.control || input.shift };
  if (key === "F6") return { type: "focus-omnibox" };
  if (key === "F12") return { type: "devtools" };
  if (key === "F3") return { type: "find-next", forward: !input.shift };
  if (key === "BrowserBack") return { type: "back" };
  if (key === "BrowserForward") return { type: "forward" };

  if (input.alt && !mod && !input.shift && key === "Home") return { type: "home" };
  if (input.alt && !mod && !mac) {
    if (key === "ArrowLeft") return { type: "back" };
    if (key === "ArrowRight") return { type: "forward" };
    if (key === "d") return { type: "focus-omnibox" };
  }

  // Ctrl+Tab cycles tabs on every platform (also on macOS, like Chrome).
  if (input.control && key === "Tab") return { type: input.shift ? "prev-tab" : "next-tab" };
  if (input.control && !mac && key === "PageDown") return { type: "next-tab" };
  if (input.control && !mac && key === "PageUp") return { type: "prev-tab" };

  if (!mod) return null;

  if (input.shift) {
    switch (key) {
      case "t":
        return { type: "reopen-closed-tab" };
      case "b":
        return { type: "toggle-bookmarks-bar" };
      case "o":
        return { type: "organize-tabs" };
      case "a":
        return { type: "toggle-assist" };
      case "i":
        return mac && !input.alt ? null : { type: "devtools" };
      case "r":
        return { type: "reload", hard: true };
      case "g":
        return { type: "find-next", forward: false };
      case "j":
        return mac ? { type: "open-downloads" } : null;
      case "[":
      case "{":
        return { type: "prev-tab" };
      case "]":
      case "}":
        return { type: "next-tab" };
      default:
        return null;
    }
  }

  if (mac && input.alt && key === "i") return { type: "devtools" };
  if (mac && input.alt && key === "ArrowLeft") return { type: "prev-tab" };
  if (mac && input.alt && key === "ArrowRight") return { type: "next-tab" };
  if (mac && key === "[") return { type: "back" };
  if (mac && key === "]") return { type: "forward" };
  if (mac && key === "y") return { type: "open-history" };

  switch (key) {
    case "k":
      return { type: "command-palette" };
    case "t":
      return { type: "new-tab" };
    case "n":
      return { type: "new-window" };
    case "w":
    case "F4":
      return { type: "close-tab" };
    case "l":
      return { type: "focus-omnibox" };
    case "r":
      return { type: "reload", hard: false };
    case "d":
      return { type: "bookmark-page" };
    case "f":
      return { type: "find" };
    case "g":
      return { type: "find-next", forward: true };
    case "j":
      return mac ? null : { type: "open-downloads" };
    case "h":
      return mac ? null : { type: "open-history" };
    case "=":
    case "+":
      return { type: "zoom", delta: 1 };
    case "-":
      return { type: "zoom", delta: -1 };
    case "0":
      return { type: "zoom", delta: 0 };
    default:
      break;
  }
  if (/^[1-9]$/.test(key)) return { type: "select-tab", n: Number(key) };
  return null;
}
