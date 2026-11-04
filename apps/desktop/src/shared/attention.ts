import type { DialogSpec } from "./dialog";

/** What a system notification about a question shows (see DialogSpec.notify). */
export interface AttentionNotice {
  title: string;
  body: string;
  /** The question's buttons, in order, when it can be answered from the notification; else none. */
  buttons: string[];
}

/** Notification buttons Corvus offers at most (Windows shows up to five, short ones fit three). */
const MAX_BUTTONS = 3;

/**
 * The notification for a question an agent waits on, or null when it asks for none. Buttons only
 * for a plain choice: what has fields, a text box or a list to pick from is answered in Corvus.
 */
export function attentionNotice(spec: DialogSpec): AttentionNotice | null {
  if (!spec.notify) return null;
  const plain = !spec.fields?.length && !spec.input && !spec.choices?.length && spec.buttons.length <= MAX_BUTTONS;
  return {
    title: spec.title.slice(0, 120),
    body: spec.message.slice(0, 200),
    buttons: spec.notify === "buttons" && plain ? [...spec.buttons] : [],
  };
}
