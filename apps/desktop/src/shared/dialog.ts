/**
 * Corvus's own dialogs: questions the browser asks the person (an AI agent wants to connect, a
 * payment to approve, a page's confirm()), shown as a modal in the window's UI with Corvus's look
 * instead of the system's message box.
 */

export type DialogTone = "info" | "question" | "warning" | "danger";

export interface DialogSpec {
  tone: DialogTone;
  title: string;
  message: string;
  detail?: string;
  /** In the order shown, left to right. */
  buttons: string[];
  /** The button Enter presses (and that has the focus first). */
  defaultId: number;
  /** The button Escape and closing the dialog choose. */
  cancelId: number;
  /** A button drawn as destructive (delete, deny a payment's opposite…). */
  dangerId?: number;
  checkbox?: { label: string; checked: boolean };
  /** A text field (a page's prompt()). */
  input?: { value: string; placeholder?: string };
  /** A data: URL picture (an extension's icon). */
  icon?: string;
  /** The page that asks, shown so the person knows a page and not Corvus is asking. */
  origin?: string;
  /**
   * Shown as a bar under the toolbar instead of a modal: the page stays usable (an AI agent asks the
   * person to do something in it).
   */
  bar?: boolean;
}

export interface DialogView extends DialogSpec {
  id: string;
}

export interface DialogAnswer {
  button: number;
  checked: boolean;
  value: string;
}

/** What an unanswered dialog resolves to (Escape, the window closed, the page went away). */
export function cancelAnswer(spec: DialogSpec): DialogAnswer {
  return { button: spec.cancelId, checked: spec.checkbox?.checked ?? false, value: spec.input?.value ?? "" };
}

/** The tone of an Electron message box type. */
export function toneOf(type: string | undefined): DialogTone {
  return type === "warning" ? "warning" : type === "error" ? "danger" : type === "question" ? "question" : "info";
}
