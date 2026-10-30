/**
 * Corvus's own dialogs: questions the browser asks the person (an AI agent wants to connect, a
 * payment to approve, a page's confirm()), shown as a modal in the window's UI with Corvus's look
 * instead of the system's message box.
 */
import type { TabId } from "@corvus/shared";

export type DialogTone = "info" | "question" | "warning" | "danger";

/** A labelled text field of a dialog that edits something (a bookmark's name and address). */
export interface DialogField {
  label: string;
  value: string;
  placeholder?: string;
  /**
   * The field may not be left empty: the message shown under it when it is, and the dialog stays
   * open (the cancel button still closes it).
   */
  required?: string;
  /** Typed text is hidden (a password), with a button to show it. */
  secret?: boolean;
}

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
  /** Labelled fields, answered in `values` in the same order; Enter presses the default button. */
  fields?: DialogField[];
  /**
   * Ready answers listed above the fields (the saved logins of a site): picking one answers the
   * dialog with its index in `choice`, without pressing a button.
   */
  choices?: DialogChoice[];
  /** A data: URL picture (an extension's icon). */
  icon?: string;
  /** The page that asks, shown so the person knows a page and not Corvus is asking. */
  origin?: string;
  /**
   * Shown as a bar under the toolbar instead of a modal: the page stays usable (an AI agent asks the
   * person to do something in it).
   */
  bar?: boolean;
  /** The tab a bar is about: while another tab is active, the bar offers to go to it (without answering). */
  tabId?: TabId;
}

/** One of a dialog's ready answers: what it is, and where it comes from. */
export interface DialogChoice {
  label: string;
  detail?: string;
}

export interface DialogView extends DialogSpec {
  id: string;
}

export interface DialogAnswer {
  button: number;
  checked: boolean;
  value: string;
  /** What the `fields` hold, in their order (only for a dialog with fields). */
  values?: string[];
  /** The ready answer picked (an index into `choices`), instead of a button. */
  choice?: number;
}

/** What a dialog's fields hold when nothing was typed in them. */
export function fieldValues(spec: DialogSpec): Pick<DialogAnswer, "values"> {
  return spec.fields ? { values: spec.fields.map((f) => f.value) } : {};
}

/** What an unanswered dialog resolves to (Escape, the window closed, the page went away). */
export function cancelAnswer(spec: DialogSpec): DialogAnswer {
  return { button: spec.cancelId, checked: spec.checkbox?.checked ?? false, value: spec.input?.value ?? "", ...fieldValues(spec) };
}

/** The tone of an Electron message box type. */
export function toneOf(type: string | undefined): DialogTone {
  return type === "warning" ? "warning" : type === "error" ? "danger" : type === "question" ? "question" : "info";
}
