/**
 * Corvus's own dialogs: questions the browser asks the person (an AI agent wants to connect, a
 * payment to approve, a page's confirm()), shown as a modal in the window's UI with Corvus's look
 * instead of the system's message box.
 */
import type { TabId, UserActionBlock } from "@corvus/shared";

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
  /** What a bar shows under its question (long text, steps, values to copy, a form); answered in `values`, one per form block. */
  blocks?: UserActionBlock[];
  /** The tab a bar is about: while another tab is active, the bar offers to go to it (without answering). */
  tabId?: TabId;
  /**
   * An AI agent waits on the answer: while the person is not in the window (another app, or Corvus in
   * the notification area), a system notification says so and opens it on a click. "buttons" also
   * answers from the notification's own buttons, so the agent goes on without Corvus being opened.
   * Never for what a page asks: a page could then show notifications in Corvus's name.
   */
  notify?: "buttons" | "open";
  /**
   * A line under the question that tells the person where to change this behaviour, with a link that
   * opens that settings section (corvus://settings/#<section>) in a new tab. The dialog stays open.
   */
  settingsHint?: { text: string; section: string };
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

export type FormBlock = Extract<UserActionBlock, { name: string }>;

/** The blocks the person fills in, in order. */
export function formBlocks(blocks: UserActionBlock[] | undefined): FormBlock[] {
  return (blocks ?? []).filter((b): b is FormBlock => "name" in b);
}

/** A form block's value before the person touches it (a checkbox as "true" or "false"). */
export function formBlockValue(block: FormBlock): string {
  if (block.kind === "checkbox") return block.checked ? "true" : "false";
  return block.value ?? "";
}

/** What came back for a form, held to what each block can answer. */
export function formValues(blocks: UserActionBlock[] | undefined, typed: unknown[]): string[] {
  return formBlocks(blocks).map((block, i) => {
    const value = typed[i];
    if (typeof value !== "string") return formBlockValue(block);
    if (block.kind === "checkbox") return value === "true" ? "true" : "false";
    if (block.kind === "select") return block.options.includes(value) ? value : formBlockValue(block);
    return value.slice(0, 10_000);
  });
}

/** A form's answer as the agent gets it: by field name, checkboxes as booleans. */
export function namedFormValues(blocks: UserActionBlock[] | undefined, values: string[]): Record<string, string | boolean> {
  return Object.fromEntries(formBlocks(blocks).map((block, i) => [block.name, block.kind === "checkbox" ? values[i] === "true" : (values[i] ?? "")]));
}

/** What a dialog's fields hold when nothing was typed in them. */
export function fieldValues(spec: DialogSpec): Pick<DialogAnswer, "values"> {
  if (spec.fields) return { values: spec.fields.map((f) => f.value) };
  return formBlocks(spec.blocks).length ? { values: formBlocks(spec.blocks).map(formBlockValue) } : {};
}

/** What an unanswered dialog resolves to (Escape, the window closed, the page went away). */
export function cancelAnswer(spec: DialogSpec): DialogAnswer {
  return { button: spec.cancelId, checked: spec.checkbox?.checked ?? false, value: spec.input?.value ?? "", ...fieldValues(spec) };
}

/** The tone of an Electron message box type. */
export function toneOf(type: string | undefined): DialogTone {
  return type === "warning" ? "warning" : type === "error" ? "danger" : type === "question" ? "question" : "info";
}

/**
 * A page's prompt(), from the tab preload to the main process over synchronous IPC (Electron's own
 * prompt() throws): args (message, defaultText), the reply is the text or null.
 */
export const PAGE_PROMPT_CHANNEL = "corvus:page-prompt";
