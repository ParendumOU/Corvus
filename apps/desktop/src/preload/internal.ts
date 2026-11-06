// Preload attached to every tab. It exposes window.corvusInternal only on corvus:// pages, so
// regular web content never sees an IPC surface. The main process re-validates every call.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ANNOTATION_COLORS, ANNOTATION_COLOR_HEX, MAX_QUOTE_CHARS, buildAnchor, locateAnchor, type AnnotationColor } from "../shared/annotations";
import { ANNOTATION_AGENT_CHANNEL, ANNOTATION_APPLY_CHANNEL, ANNOTATION_CREATE_CHANNEL, ANNOTATION_DELETE_CHANNEL, ANNOTATION_UPDATE_CHANNEL, type AnnotationApplyMessage, type AnnotationLabels } from "../shared/annotations-ipc";
import { AUTOFILL_ADDRESS_CAPTURE_CHANNEL, AUTOFILL_CAPTURE_CHANNEL, AUTOFILL_CARD_CAPTURE_CHANNEL, AUTOFILL_DROPDOWN_CHANNEL, AUTOFILL_DROPDOWN_DONE_CHANNEL, AUTOFILL_FIELD_CHANNEL, AUTOFILL_IDENTIFIER_CHANNEL, type AutofillFieldKind } from "../shared/credentials-ipc";
import { identifierFieldFacts, isIdentifierFacts } from "../shared/identifier-field";
import { addressFieldFacts, classifyAddressField, isAddressForm, matchOption, planAddressFill } from "../shared/address-fields";
import { cardFieldFacts, classifyCardField, isCardForm, matchCardOption, planCardFill } from "../shared/card-fields";
import { isCardDataField, isCardDataForm } from "../shared/card-data-fields";
import { AUTOFILL_FRAME_FILL_CHANNEL, AUTOFILL_FRAME_FILLED_CHANNEL, fieldShown, parseFrameFillRequest, type FrameFillRequest } from "../shared/frame-fill";
import { isOtpFacts, otpFieldFacts } from "../shared/otp-field";
import { passwordFieldFacts, passwordRoles } from "../shared/password-fields";
import { probePattern, type PasswordFieldClick } from "../shared/password-rules";
import { FLOW_CAPTURE_CHANNEL, FLOW_RECORD_SET_CHANNEL } from "../shared/flow-ipc";
import { INTERNAL_EVENT, INTERNAL_RPC, type InternalBridge, type InternalEvent } from "../shared/ipc";
import { PAGE_COMMAND_CHANNEL, commandForInput, isPageFirst } from "../shared/shortcuts";

// The preload is type-checked with the Node project (no DOM lib); declare the globals it reads.
declare const location: { protocol: string; origin: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const document: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: { top: unknown; addEventListener(type: string, listener: (e: any) => void, capture: boolean): void };

if (location.protocol === "corvus:" && window.top === window) {
  const bridge: InternalBridge = {
    call: ((method: string, ...args: unknown[]) => ipcRenderer.invoke(INTERNAL_RPC, method, args)) as InternalBridge["call"],
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, message: InternalEvent): void => listener(message);
      ipcRenderer.on(INTERNAL_EVENT, handler);
      return () => ipcRenderer.off(INTERNAL_EVENT, handler);
    },
  };
  contextBridge.exposeInMainWorld("corvusInternal", bridge);
}

// Shortcuts the page gets first (shared/shortcuts.ts isPageFirst): once every handler in the page had
// the key press and none used it (an editor's Ctrl+U underlines), the browser runs the command. On
// the window, in the capture phase: first in line, so the page cannot stop it from being seen.
window.addEventListener(
  "keydown",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e: any) => {
    if (!e.isTrusted || e.isComposing) return;
    const command = commandForInput({ type: "keyDown", key: String(e.key), code: String(e.code), control: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }, process.platform);
    if (!command || !isPageFirst(command)) return;
    setTimeout(() => {
      if (!e.defaultPrevented) ipcRenderer.send(PAGE_COMMAND_CHANNEL, command.type);
    }, 0);
  },
  true,
);

// Card and address forms, in the page and in its frames (a payment provider's card fields live in a
// cross-origin iframe). Only roles and boxes are read to tell a field's kind; values only on submit, and
// never a card's security code.
const FORM_FIELDS = "input:not([type=hidden]), select, textarea";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const formFieldsOf = (scope: any): any[] => Array.prototype.slice.call(scope.querySelectorAll(FORM_FIELDS), 0, 200);
// A field of a card form (shared/card-fields.ts, as the fill decides): the form has a card number field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isCardField = (el: any): boolean => {
  if (classifyCardField(cardFieldFacts(el)) === null) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return isCardForm(formFieldsOf(el.form || document).map((f: any) => classifyCardField(cardFieldFacts(f))));
};
// A field that takes card data, password fields included (a CVV box often is one): never a login field,
// never recorded (shared/card-data-fields.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isCardData = (el: any): boolean => isCardDataField(cardFieldFacts(el));
// A text field of an address form (shared/address-fields.ts, as the fill script decides). A select is
// never the one clicked: its own list opens there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isAddressField = (el: any): boolean => {
  if (classifyAddressField(addressFieldFacts(el)) === null) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return isAddressForm(formFieldsOf(el.form || document).map((f: any) => classifyAddressField(addressFieldFacts(f))));
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const usableField = (el: any): boolean => Boolean(el) && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.disabled && !el.readOnly;

const isWeb = location.protocol === "https:" || location.protocol === "http:";

// A sent card form: number, name and expiry, so the main process can offer to save the card. The
// security code field is recognised by its attributes only, and its value is never read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const captureCard = (scope: any): void => {
  try {
    const els = formFieldsOf(scope);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = els.map((el: any) => classifyCardField(cardFieldFacts(el)));
    if (!isCardForm(roles)) return;
    const fields: { role: string; value: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    els.forEach((el: any, i: number) => {
      const role = roles[i];
      if (!role || role === "csc") return;
      const value = el.tagName === "SELECT" ? (el.selectedIndex >= 0 ? String(el.options[el.selectedIndex]?.value || "") : "") : String(el.value || "");
      if (value.trim()) fields.push({ role, value: value.slice(0, 200) });
    });
    if (fields.some((f) => f.role === "number")) ipcRenderer.send(AUTOFILL_CARD_CAPTURE_CHANNEL, { origin: location.origin, fields });
  } catch {
    // never let autofill break a page's own submit
  }
};

// The fill the person picked in Corvus (a card with the CVV they just typed in Corvus's prompt, or an
// address), sent by the main process to this frame only. Done in this isolated world; the values are
// written to the form of the field at the box and kept nowhere. Answers with how many fields it wrote.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setFieldValue = (el: any, value: string): void => {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new (document.defaultView.Event)("input", { bubbles: true }));
  el.dispatchEvent(new (document.defaultView.Event)("change", { bubbles: true }));
  el.blur();
};
const fillFrame = (req: FrameFillRequest): number => {
  if (location.origin !== req.origin) return 0;
  const active = document.activeElement;
  const isText = (el: unknown): boolean => usableField(el);
  const anchor = isText(active) ? active : document.elementFromPoint(req.box.x + req.box.width / 2, req.box.y + req.box.height / 2);
  if (!isText(anchor)) return 0;
  // Besides the clicked field, only fields the person can see: a page must not collect what it hides.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields = formFieldsOf(anchor.form || document).filter((el: any) => el === anchor || (!el.disabled && !el.readOnly && fieldShown(el, document.defaultView)));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const valueOf = (el: any): string => (el.tagName === "SELECT" ? (el.selectedIndex > 0 ? String(el.value || "") : "") : String(el.value || ""));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const facts = (el: any) => ({ value: valueOf(el), anchor: el === anchor });
  const plan =
    req.kind === "card"
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        planCardFill(fields.map((el: any) => ({ facts: cardFieldFacts(el), ...facts(el) })), req.card, req.cvv)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        planAddressFill(fields.map((el: any) => ({ facts: addressFieldFacts(el), ...facts(el) })), req.address);
  let filled = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields.forEach((el: any, i: number) => {
    const value = plan[i];
    if (value === null || value === undefined) return;
    if (el.tagName === "SELECT") {
      const options = Array.prototype.map.call(el.options, (o: { value: string; text: string }) => ({ value: o.value, text: o.text })) as { value: string; text: string }[];
      const option = req.kind === "card" ? matchCardOption(options, value) : matchOption(options, value);
      if (option === null) return;
      setFieldValue(el, option);
    } else {
      // Agents' page snapshots and the workflow recorder (on the change event the fill fires) never
      // report what Corvus filled from a saved card.
      if (req.kind === "card") el.setAttribute("data-corvus-secret", "1");
      setFieldValue(el, value);
    }
    filled++;
  });
  return filled;
};
if (isWeb) {
  ipcRenderer.on(AUTOFILL_FRAME_FILL_CHANNEL, (_event: IpcRendererEvent, raw: unknown) => {
    const req = parseFrameFillRequest(raw);
    if (!req) return;
    let filled = 0;
    try {
      filled = fillFrame(req);
    } catch {
      filled = 0;
    }
    ipcRenderer.send(AUTOFILL_FRAME_FILLED_CHANNEL, { token: req.token, filled });
  });
}

// In a page's subframes (a payment provider's iframe), only a click in a card or address field is
// reported, with the field's box in the frame; login and 2FA fields are left to the top frame. Typing
// or scrolling there afterwards closes the dropdown.
if (isWeb && window.top !== window) {
  let reported = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reportSub = (el: any): void => {
    if (!usableField(el)) return;
    const kind: AutofillFieldKind | null = isCardField(el) ? "card" : isAddressField(el) ? "address" : null;
    if (!kind) return;
    const r = el.getBoundingClientRect();
    reported = true;
    ipcRenderer.send(AUTOFILL_FIELD_CHANNEL, { kind, x: r.left, y: r.top, width: r.width, height: r.height });
  };
  document.addEventListener(
    "click",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      try {
        if (e.isTrusted && e.button === 0) reportSub(e.target);
      } catch {
        // never let autofill break a page's own click handling
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      try {
        if (e.isTrusted && e.key === "ArrowDown" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) reportSub(e.target);
      } catch {
        // never let autofill break a page's own keys
      }
    },
    true,
  );
  const subDone = (): void => {
    if (!reported) return;
    reported = false;
    ipcRenderer.send(AUTOFILL_DROPDOWN_DONE_CHANNEL);
  };
  document.addEventListener("input", subDone, true);
  document.addEventListener("scroll", subDone, { capture: true, passive: true });
}

// On web pages, capture a submitted login synchronously (before navigation) so the main process can
// offer to save it. Runs in the preload's isolated world: it reads the DOM but exposes nothing to the
// page. The main process re-validates the sender and only ever stores it after an explicit user action.
if ((location.protocol === "https:" || location.protocol === "http:") && window.top === window) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usernameLikely = (el: any): boolean => {
    const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""} ${el.getAttribute("type") || ""}`.toLowerCase();
    return /email|user|login|account|phone|tel/.test(hint);
  };
  // The password fields of a form that matter (the one at hand always does) and the part of each:
  // current password, new one or confirmation, as the autofill scripts decide (shared/password-fields.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const passwordFieldsOf = (scope: any, anchor: unknown): { fields: any[]; roles: string[] } => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fields = Array.prototype.slice.call(scope.querySelectorAll("input[type=password]")).filter((el: any) => {
      if (el === anchor) return true;
      const r = el.getBoundingClientRect();
      const s = document.defaultView.getComputedStyle(el);
      return !el.disabled && !el.readOnly && r.width >= 1 && r.height >= 1 && s.visibility !== "hidden" && s.display !== "none" && !isOtpFacts(otpFieldFacts(el)) && !isCardData(el);
    });
    return { fields, roles: passwordRoles(fields.map(passwordFieldFacts)) };
  };
  // A two-step sign-in's username field (shared/identifier-field.ts, as the autofill scripts decide).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isIdentifier = (el: any): boolean =>
    Boolean(el) && el.tagName === "INPUT" && !el.disabled && !el.readOnly && ["text", "email", "tel"].includes(String(el.getAttribute("type") || "text").toLowerCase()) && !isOtpFacts(otpFieldFacts(el)) && !isCardData(el) && isIdentifierFacts(identifierFieldFacts(el));
  // The username typed on such a step, as it is sent (the form's submit, Enter) or left changed: the
  // next step may ask only for the password, and the save prompt then needs it. Only the username.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reportIdentifier = (el: any): void => {
    if (isIdentifier(el) && el.value) ipcRenderer.send(AUTOFILL_IDENTIFIER_CHANNEL, { origin: location.origin, username: String(el.value) });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captureFrom = (scope: any): void => {
    try {
      // A card form gives no login to save: its security code is no password.
      if (isCardDataForm(formFieldsOf(scope).map(cardFieldFacts))) return;
      // A sign-up or change form sets its new password (never its current one); a sign-in, its only one.
      const { fields: passwords, roles } = passwordFieldsOf(scope, null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pass = passwords.find((p: any, i: number) => p.value && roles[i] === "new") || Array.prototype.slice.call(scope.querySelectorAll("input[type=password]")).find((p: any) => p.value && !isCardData(p));
      if (!pass) {
        Array.prototype.slice.call(scope.querySelectorAll("input")).forEach(reportIdentifier);
        return;
      }
      const fields = Array.prototype.slice
        .call((pass.form || scope).querySelectorAll("input[type=text], input[type=email], input[type=tel], input:not([type])"))
        .filter((el: any) => el !== pass && el.value && !isCardData(el));
      const user = fields.filter(usernameLikely).pop() || fields.pop() || null;
      ipcRenderer.send(AUTOFILL_CAPTURE_CHANNEL, {
        origin: location.origin,
        username: user ? String(user.value || "") : "",
        password: String(pass.value),
      });
    } catch {
      // never let autofill break a page's own submit
    }
  };
  // A sent address form: each address field's role and value (a select's chosen option text), so the
  // main process can offer to save it. Password, card and hidden fields are never classified, never sent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captureAddress = (scope: any): void => {
    try {
      const els = Array.prototype.slice.call(scope.querySelectorAll("input:not([type=hidden]), select, textarea"), 0, 200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const roles = els.map((el: any) => classifyAddressField(addressFieldFacts(el)));
      if (!isAddressForm(roles)) return;
      const fields: { role: string; value: string }[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      els.forEach((el: any, i: number) => {
        const role = roles[i];
        if (!role) return;
        const value = el.tagName === "SELECT" ? (el.selectedIndex > 0 ? String(el.options[el.selectedIndex]?.text || "") : "") : String(el.value || "");
        if (value.trim()) fields.push({ role, value: value.slice(0, 500) });
      });
      if (fields.length) ipcRenderer.send(AUTOFILL_ADDRESS_CAPTURE_CHANNEL, { origin: location.origin, fields });
    } catch {
      // never let autofill break a page's own submit
    }
  };
  document.addEventListener(
    "submit",
    (e: { target: unknown }) => {
      captureFrom(e.target || document);
      captureAddress(e.target || document);
      captureCard(e.target || document);
    },
    true,
  );
  document.addEventListener(
    "change",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      try {
        if (e.isTrusted) reportIdentifier(e.target);
      } catch {
        // never let autofill break a page's own fields
      }
    },
    true,
  );

  // A click in a login field (a password field, or a text field of a form that has one) or in a
  // one-time-code field reports which kind it is and the field's box, so the main process can list the
  // saved accounts right under it. Only the kind and the box are sent.
  const TEXT_TYPES = ["text", "email", "tel", "password"];
  // A box of a row of 6 to 8 one-character boxes (one digit each).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isCodeBox = (el: any): boolean => {
    if (el.maxLength !== 1) return false;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const boxes = Array.prototype.filter.call(node.querySelectorAll("input"), (i: { maxLength: number }) => i.maxLength === 1).length;
      if (boxes >= 6) return boxes <= 8;
    }
    return false;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loginKind = (el: any): AutofillFieldKind | null => {
    const type = String(el.getAttribute("type") || "text").toLowerCase();
    if (isOtpFacts(otpFieldFacts(el)) || (["text", "tel", "number"].includes(type) && isCodeBox(el))) return "otp";
    if (!TEXT_TYPES.includes(type)) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loginPassword = Array.prototype.some.call((el.form || document).querySelectorAll("input[type=password]"), (p: any) => !isCardData(p));
    return type === "password" || loginPassword || isIdentifier(el) ? "login" : null;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fieldKind = (el: any): AutofillFieldKind | null => {
    if (!usableField(el)) return null;
    // A card field first: a security code box looks like a one-time-code box. Card fields are never
    // password, e-mail or one-time-code fields, so logins keep theirs; card data the card fill does not
    // write (a CVV in a password field) is no login field either.
    if (isCardField(el)) return "card";
    return (el.tagName === "INPUT" && !isCardData(el) ? loginKind(el) : null) ?? (isAddressField(el) ? "address" : null);
  };
  // A password field: its part in its form, whether it holds something (never what) and what it takes.
  // Its pattern is probed here, with the page's own pattern matching (on a detached copy of the field),
  // so a pattern that takes ages to match only slows this page.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const passwordFacts = (el: any): PasswordFieldClick => {
    const { fields, roles } = passwordFieldsOf(el.form || document, el);
    let pattern: PasswordFieldClick["rules"]["pattern"] = null;
    if (el.getAttribute("pattern")) {
      const probe = document.createElement("input");
      probe.setAttribute("pattern", el.getAttribute("pattern"));
      pattern = probePattern((value) => {
        probe.value = value;
        return !probe.validity.patternMismatch;
      }) ?? "none";
    }
    return {
      role: (roles[fields.indexOf(el)] ?? "current") as PasswordFieldClick["role"],
      fields: fields.length,
      filled: Boolean(el.value),
      rules: {
        minLength: el.minLength > 0 ? el.minLength : 0,
        maxLength: el.maxLength > 0 ? el.maxLength : 0,
        numeric: ["numeric", "decimal", "tel"].includes(String(el.getAttribute("inputmode") || "").toLowerCase()),
        pattern,
      },
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report = (el: any): void => {
    const kind = fieldKind(el);
    if (!kind) return;
    const r = el.getBoundingClientRect();
    const password = kind === "login" && String(el.getAttribute("type") || "").toLowerCase() === "password" ? passwordFacts(el) : undefined;
    ipcRenderer.send(AUTOFILL_FIELD_CHANNEL, { kind, x: r.left, y: r.top, width: r.width, height: r.height, password });
  };
  document.addEventListener(
    "click",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      try {
        if (e.isTrusted && e.button === 0) report(e.target);
      } catch {
        // never let autofill break a page's own click handling
      }
    },
    true,
  );
  // The down arrow in such a field opens the accounts too, as in Chrome (while they are open, the main
  // process takes the arrows before the page sees them).
  document.addEventListener(
    "keydown",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      try {
        if (e.isTrusted && e.key === "ArrowDown" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) report(e.target);
        else if (e.isTrusted && e.key === "Enter") reportIdentifier(e.target);
      } catch {
        // never let autofill break a page's own keys
      }
    },
    true,
  );
  // While the accounts are open under a field, typing or pasting, the keyboard moving to another part
  // of the page, or a scroll closes them (only that it happened is sent).
  let dropdownOpen = false;
  ipcRenderer.on(AUTOFILL_DROPDOWN_CHANNEL, (_event: IpcRendererEvent, open: unknown) => {
    dropdownOpen = open === true;
  });
  const done = (): void => {
    if (!dropdownOpen) return;
    dropdownOpen = false;
    ipcRenderer.send(AUTOFILL_DROPDOWN_DONE_CHANNEL);
  };
  document.addEventListener("input", done, true);
  document.addEventListener("scroll", done, { capture: true, passive: true });
  // Focus that leaves the page altogether (to the dropdown itself, or another app) is not the page's to
  // report: the page has lost it by the time its field hears of it.
  document.addEventListener("focusout", () => document.hasFocus() && done(), true);
}

// Flow recorder: while recording is enabled for this tab, report the user's clicks, field edits and
// submits as robust targets (role + accessible name + nth-of-kind, computed exactly as page_snapshot
// does, so replay re-matches them). Secret fields report no value. Runs in the preload's isolated
// world; exposes nothing to the page. The main process re-validates the sender and gates every action.
if ((location.protocol === "https:" || location.protocol === "http:") && window.top === window) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc: any = location;
  let recording = false;
  ipcRenderer.on(FLOW_RECORD_SET_CHANNEL, (_e: IpcRendererEvent, on: unknown) => {
    recording = on === true;
  });

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=option]", "[role=switch]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
    "[contenteditable='']", "[contenteditable=true]",
  ].join(",");
  const SECRET = /password|passcode|\bpin\b|cvv|cvc|card|credit|security\s?code|otp|2fa/i;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clean = (s: any): string => (s || "").replace(/\s+/g, " ").trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visible = (el: any): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = w.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roleOf = (el: any): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return tag;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nameOf = (el: any): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const label = labelledBy.split(/\s+/).map((id: string) => d.getElementById(id)).filter(Boolean).map((n: any) => n.innerText).join(" ");
      if (clean(label)) return clean(label);
    }
    if (el.labels && el.labels.length > 0) return clean(el.labels[0].innerText);
    const own = clean(el.innerText || el.value || "");
    if (own && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") return own;
    const img = el.querySelector && el.querySelector("img[alt]");
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || (img && img.getAttribute("alt")) || el.getAttribute("name") || own);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cssPath = (el: any): string => {
    try {
      const parts: string[] = [];
      let node = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`${part}#${node.id}`);
          break;
        }
        const parent = node.parentElement;
        if (parent) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sibs = Array.prototype.filter.call(parent.children, (c: any) => c.tagName === node.tagName);
          if (sibs.length > 1) part += `:nth-of-type(${Array.prototype.indexOf.call(sibs, node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ").slice(0, 400);
    } catch {
      return "";
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const descriptorFor = (start: any): { role: string; name: string; index: number; tag: string; selector: string } | undefined => {
    let node = start;
    while (node && node.nodeType === 1 && !(node.matches && node.matches(SELECTOR))) node = node.parentElement;
    const target = node && node.nodeType === 1 && node.matches && node.matches(SELECTOR) ? node : null;
    if (!target) return undefined;
    const role = roleOf(target);
    const name = nameOf(target).slice(0, 80);
    let index = 0;
    const all = d.querySelectorAll(SELECTOR);
    for (let k = 0; k < all.length; k++) {
      const cand = all[k];
      if (cand === target) break;
      if (cand.disabled || !visible(cand) || (cand.closest && cand.closest("[aria-hidden=true]"))) continue;
      if (roleOf(cand) === role && nameOf(cand).slice(0, 80) === name) index++;
    }
    return { role, name, index, tag: target.tagName.toLowerCase(), selector: cssPath(target) };
  };
  const send = (kind: string, target: unknown, value?: string, secret?: boolean): void => {
    ipcRenderer.send(FLOW_CAPTURE_CHANNEL, { kind, url: loc.href, target, value, secret });
  };

  d.addEventListener(
    "click",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      if (!recording) return;
      try {
        const desc = descriptorFor(e.target);
        if (!desc) return;
        // Focusing a text field is not an action; its value is captured on change.
        if (desc.role === "textbox" || desc.role === "searchbox") return;
        send("click", desc);
      } catch {
        // never let recording break the page
      }
    },
    true,
  );

  const SKIP_INPUT = ["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image", "hidden"];
  // A text field's current value as an "input" capture; false when the element is not a text field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendValue = (el: any): boolean => {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    const type = (el.getAttribute && (el.getAttribute("type") || "")).toLowerCase();
    const textLike = (tag === "INPUT" && !SKIP_INPUT.includes(type)) || tag === "TEXTAREA" || el.isContentEditable;
    if (!textLike) return false;
    const desc = descriptorFor(el);
    if (!desc) return false;
    const hint = `${el.name || ""} ${el.id || ""} ${(el.getAttribute && el.getAttribute("autocomplete")) || ""} ${desc.name}`;
    // Card fields too (Spanish labels and cc- tokens included), whether typed or filled by Corvus.
    const secret = type === "password" || SECRET.test(hint) || el.hasAttribute("data-corvus-secret") || isCardData(el);
    const value = secret ? "" : String(el.isContentEditable ? el.innerText || "" : el.value || "").slice(0, 2000);
    send("input", desc, value, secret);
    return true;
  };

  d.addEventListener(
    "change",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      if (!recording) return;
      try {
        sendValue(e.target);
      } catch {
        // never let recording break the page
      }
    },
    true,
  );

  // Enter in a single-line field: record the value before the page reacts (tag and combobox inputs such as
  // react-select turn it into a chip and clear the field, so no change event ever carries it), then mark
  // the step as submitted so replay presses Enter too.
  d.addEventListener(
    "keydown",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      if (!recording || e.key !== "Enter" || e.isComposing || e.shiftKey) return;
      try {
        const el = e.target;
        if (!el || el.tagName !== "INPUT" || !el.value) return;
        if (sendValue(el)) send("submit", undefined);
      } catch {
        // never let recording break the page
      }
    },
    true,
  );

  d.addEventListener(
    "submit",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      if (!recording) return;
      try {
        const form = e.target;
        const btn = form && form.querySelector && form.querySelector("button[type=submit], input[type=submit], button:not([type])");
        send("submit", btn ? descriptorFor(btn) : undefined);
      } catch {
        // never let recording break the page
      }
    },
    true,
  );
}

// Page annotations: let the user highlight a selection (color + optional note) and re-apply saved
// highlights on revisit. Runs in the preload's isolated world (DOM access + ipcRenderer, but invisible
// to the page). DOM work stays here; the main process owns persistence and re-validates every change.
// Highlights render through the CSS Custom Highlight API so the page DOM is never mutated.
if ((location.protocol === "https:" || location.protocol === "http:") && window.top === window) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc: any = location;
  const supported = typeof w.CSS !== "undefined" && w.CSS && w.CSS.highlights && typeof w.Highlight !== "undefined";
  const MAX_TEXT = 3_000_000;
  const UI_ATTR = "data-corvus-annotations";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Applied { id: string; color: string; note: string; range: any }
  let applied: Applied[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = new Map<any, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acceptText = (node: any): boolean => {
    const parent = node.parentNode;
    if (!parent || !parent.tagName) return false;
    const tag = parent.tagName.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return false;
    if (parent.closest && parent.closest(`[${UI_ATTR}]`)) return false;
    return typeof node.data === "string" && node.data.length > 0;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeWalker = (): any =>
    d.createTreeWalker(d.body, 4 /* SHOW_TEXT */, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      acceptNode: (node: any) => (acceptText(node) ? 1 /* ACCEPT */ : 2 /* REJECT */),
    });

  // Concatenate accepted text nodes in document order; record each node's start offset for mapping back.
  const buildText = (): string => {
    base.clear();
    let text = "";
    const walker = makeWalker();
    let node = walker.nextNode();
    while (node) {
      base.set(node, text.length);
      text += node.data;
      if (text.length > MAX_TEXT) break;
      node = walker.nextNode();
    }
    return text;
  };

  // Character index (within the concatenated text) of a DOM boundary point.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const indexOfPoint = (container: any, offset: number): number | null => {
    if (!d.body) return null;
    const probe = d.createRange();
    probe.setStart(d.body, 0);
    try {
      probe.setEnd(container, offset);
    } catch {
      return null;
    }
    let len = 0;
    const walker = makeWalker();
    let n = walker.nextNode();
    while (n) {
      if (probe.comparePoint(n, 0) > 0) break;
      if (probe.comparePoint(n, n.data.length) <= 0) {
        len += n.data.length;
      } else {
        if (container === n) len += offset;
        else {
          let k = 0;
          while (k < n.data.length && probe.comparePoint(n, k + 1) <= 0) k++;
          len += k;
        }
        break;
      }
      n = walker.nextNode();
    }
    return len;
  };

  // Map a character index back to a {node, offset} DOM position (base is in document order).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locate = (index: number): { node: any; offset: number } | null => {
    for (const [node, start] of base) {
      if (index >= start && index <= start + node.data.length) return { node, offset: index - start };
    }
    return null;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rangeFromIndices = (start: number, end: number): any => {
    const s = locate(start);
    const e = locate(end);
    if (!s || !e) return null;
    try {
      const range = d.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      return range;
    } catch {
      return null;
    }
  };

  // ---- UI host (shadow DOM, immune to and invisible to the page) ----
  const host = d.createElement("div");
  host.setAttribute(UI_ATTR, "");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0";
  const shadow = host.attachShadow({ mode: "closed" });
  // Constructed style sheets: a page's Content-Security-Policy (style-src 'self') blocks a <style>
  // element added to it, which left the toolbar unstyled, but not these.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adopt = (root: any, css: string): void => {
    try {
      const sheet = new w.CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      const style = d.createElement("style");
      style.textContent = css;
      (root === d ? d.head || d.documentElement : root).appendChild(style);
    }
  };
  adopt(
    shadow,
    `
    .bar,.pop{position:fixed;display:none;box-sizing:border-box;font:500 12.5px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d2230;background:#fff;border:1px solid rgba(15,20,30,.12);border-radius:12px;box-shadow:0 10px 28px rgba(15,20,30,.16),0 1px 3px rgba(15,20,30,.08);padding:5px;gap:2px;align-items:center;animation:corvus-in .12s ease-out}
    @keyframes corvus-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    .bar{flex-flow:row wrap;max-width:300px}
    .pop{flex-direction:column;align-items:stretch;width:264px;padding:10px;gap:10px}
    .sw{appearance:none;flex:none;width:20px;height:20px;margin:4px;border:0;border-radius:50%;padding:0;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.16);transition:transform .1s ease-out}
    .sw:hover{transform:scale(1.18)}
    .sw.on{box-shadow:inset 0 0 0 1px rgba(0,0,0,.16),0 0 0 2px #fff,0 0 0 4px #3b6cf6}
    .sep{flex:none;width:1px;height:20px;margin:0 3px;background:rgba(15,20,30,.12)}
    .btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
    .btn:hover{background:rgba(15,20,30,.07)}
    .btn.primary{background:#3b6cf6;color:#fff}
    .btn.primary:hover{background:#2f5ad8}
    .btn.danger{color:#c62828}
    .btn svg{flex:none;width:14px;height:14px;fill:currentColor}
    .sw:focus-visible,.btn:focus-visible{outline:2px solid #3b6cf6;outline-offset:2px}
    .row{display:flex;gap:4px;align-items:center}
    .end{justify-content:flex-end}
    .compose{display:none;flex:1 0 100%;flex-direction:column;gap:6px;padding:4px 2px 2px}
    textarea{box-sizing:border-box;width:100%;min-height:64px;resize:vertical;margin:0;border:1px solid rgba(15,20,30,.18);border-radius:8px;background:#fff;color:inherit;padding:7px 9px;font:400 13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;outline:none}
    textarea:focus{border-color:#3b6cf6;box-shadow:0 0 0 3px rgba(59,108,246,.2)}
    .note{font-weight:400;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}
    .note.empty{color:rgba(29,34,48,.55)}
    @media (prefers-color-scheme:dark){
      .bar,.pop{color:#e8ebf1;background:#23272f;border-color:rgba(255,255,255,.1);box-shadow:0 10px 28px rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.3)}
      .sep{background:rgba(255,255,255,.14)}
      .btn:hover{background:rgba(255,255,255,.09)}
      .btn.danger{color:#ff8a80}
      .sw{box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}
      .sw.on{box-shadow:inset 0 0 0 1px rgba(255,255,255,.2),0 0 0 2px #23272f,0 0 0 4px #7aa2ff}
      textarea{background:#181b21;border-color:rgba(255,255,255,.16)}
      .note.empty{color:rgba(232,235,241,.55)}
    }
  `,
  );
  const appendUi = (): void => {
    if (!host.isConnected && d.documentElement) d.documentElement.appendChild(host);
  };

  // Its text arrives with the page's annotations, in Corvus's language (English until then).
  let labels: AnnotationLabels = {
    toolbar: "Highlight",
    colors: { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", orange: "Orange" },
    note: "Note",
    notePlaceholder: "Add a note…",
    saveHighlight: "Save highlight",
    noNote: "No note",
    editNote: "Edit note",
    save: "Save",
    delete: "Delete",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = (tag: string, className: string, text?: string): any => {
    const node = d.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // A pencil, drawn with DOM calls (a page's Trusted Types policy refuses innerHTML).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pencil = (): any => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = d.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = d.createElementNS(ns, "path");
    path.setAttribute("d", "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z");
    svg.appendChild(path);
    return svg;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const swatch = (color: AnnotationColor, onPick: () => void, current = false): any => {
    const sw = el("button", current ? "sw on" : "sw");
    sw.style.background = ANNOTATION_COLOR_HEX[color];
    sw.title = labels.colors[color];
    sw.setAttribute("aria-label", labels.colors[color]);
    if (current) sw.setAttribute("aria-pressed", "true");
    sw.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      onPick();
    });
    return sw;
  };

  // Selection toolbar: the colors, then a note. Built again when it opens, in the current language.
  const bar = el("div", "bar");
  bar.setAttribute("role", "toolbar");
  bar.style.display = "none";
  shadow.appendChild(bar);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let noteBox: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let noteArea: any = null;

  // Existing-highlight popover
  const pop = el("div", "pop");
  pop.setAttribute("role", "dialog");
  pop.style.display = "none";
  shadow.appendChild(pop);

  let pendingAnchor: { start: number; end: number } | null = null;
  const composing = (): boolean => noteBox !== null && noteBox.style.display !== "none";

  const hideBar = (): void => {
    bar.style.display = "none";
    if (noteBox) noteBox.style.display = "none";
    if (noteArea) noteArea.value = "";
    pendingAnchor = null;
  };
  const hidePop = (): void => {
    pop.style.display = "none";
  };

  const sendCreate = (color: AnnotationColor, note: string): void => {
    if (!pendingAnchor) return;
    const text = buildText();
    const anchor = buildAnchor(text, pendingAnchor.start, pendingAnchor.end);
    if (anchor.quote.length === 0 || anchor.quote.length > MAX_QUOTE_CHARS) {
      hideBar();
      return;
    }
    ipcRenderer.send(ANNOTATION_CREATE_CHANNEL, { url: loc.href, pageTitle: d.title || loc.href, color, note, anchor });
    hideBar();
    const sel = w.getSelection && w.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  };

  const buildBar = (): void => {
    bar.textContent = "";
    bar.setAttribute("aria-label", labels.toolbar);
    for (const color of ANNOTATION_COLORS) bar.appendChild(swatch(color, () => sendCreate(color, "")));
    bar.appendChild(el("span", "sep"));
    const noteBtn = el("button", "btn");
    noteBtn.appendChild(pencil());
    noteBtn.appendChild(d.createTextNode(labels.note));
    noteBtn.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      const open = !composing();
      noteBox.style.display = open ? "flex" : "none";
      if (open) noteArea.focus();
    });
    bar.appendChild(noteBtn);
    noteBox = el("div", "compose");
    noteBox.style.display = "none";
    noteArea = el("textarea", "");
    noteArea.placeholder = labels.notePlaceholder;
    const actions = el("div", "row end");
    const noteSave = el("button", "btn primary", labels.saveHighlight);
    noteSave.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      sendCreate(ANNOTATION_COLORS[0], noteArea.value);
    });
    actions.appendChild(noteSave);
    noteBox.appendChild(noteArea);
    noteBox.appendChild(actions);
    bar.appendChild(noteBox);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const placeAt = (node: any, rect: { left: number; top: number; bottom: number }): void => {
    appendUi();
    node.style.display = "flex";
    const vw = w.innerWidth || 1024;
    const top = rect.top > 56 ? rect.top - (node.offsetHeight || 40) - 8 : rect.bottom + 8;
    const left = Math.max(8, Math.min(rect.left, vw - (node.offsetWidth || 200) - 8));
    node.style.left = `${left}px`;
    node.style.top = `${Math.max(8, top)}px`;
  };

  // An AI agent's clicks and selections are not the person's: no toolbar for them.
  const AGENT_QUIET_MS = 2000;
  let agentActedAt = 0;
  const agentActing = (): boolean => Date.now() - agentActedAt < AGENT_QUIET_MS;
  ipcRenderer.on(ANNOTATION_AGENT_CHANNEL, () => {
    agentActedAt = Date.now();
    if (!composing()) hideBar();
    hidePop();
  });

  const onSelect = (): void => {
    const sel = w.getSelection && w.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (!composing()) hideBar();
      return;
    }
    const range = sel.getRangeAt(0);
    if (host.contains && host.contains(range.commonAncestorContainer)) return;
    if (!d.body || !d.body.contains(range.commonAncestorContainer)) return;
    buildText();
    const start = indexOfPoint(range.startContainer, range.startOffset);
    const end = indexOfPoint(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start || end - start > MAX_QUOTE_CHARS) {
      hideBar();
      return;
    }
    pendingAnchor = { start, end };
    const rect = range.getBoundingClientRect();
    hidePop();
    if (!composing()) buildBar();
    placeAt(bar, rect);
  };

  // ---- rendering saved annotations ----
  // The highlight colors, added to the page once (a constructed sheet, so its CSP lets them through).
  let highlightStyled = false;
  const ensureStyle = (): void => {
    if (highlightStyled) return;
    highlightStyled = true;
    adopt(d, ANNOTATION_COLORS.map((c) => `::highlight(corvus-anno-${c}){background-color:${ANNOTATION_COLOR_HEX[c]};color:inherit}`).join(""));
  };

  const render = (msg: AnnotationApplyMessage): void => {
    if (!supported) return;
    const text = buildText();
    applied = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byColor: Record<string, any[]> = {};
    for (const a of msg.annotations) {
      const found = locateAnchor(text, a.anchor);
      if (!found) continue;
      const range = rangeFromIndices(found.start, found.end);
      if (!range) continue;
      applied.push({ id: a.id, color: a.color, note: a.note, range });
      (byColor[a.color] = byColor[a.color] || []).push(range);
    }
    for (const c of ANNOTATION_COLORS) {
      const ranges = byColor[c];
      if (ranges && ranges.length) {
        const hl = new w.Highlight(...ranges);
        w.CSS.highlights.set(`corvus-anno-${c}`, hl);
      } else {
        w.CSS.highlights.delete(`corvus-anno-${c}`);
      }
    }
    if (applied.length) ensureStyle();
    // Shared-DOM marker (visible across worlds) so the main process / smoke can observe re-anchoring.
    if (d.documentElement) d.documentElement.setAttribute("data-corvus-annotated", String(applied.length));
    if (msg.scrollToId) {
      const target = applied.find((a) => a.id === msg.scrollToId);
      if (target) {
        const rect = target.range.getBoundingClientRect();
        w.scrollTo({ top: rect.top + (w.pageYOffset || 0) - 120, behavior: "smooth" });
      }
    }
  };

  // ---- popover for an existing highlight ----
  const openPopover = (a: Applied, x: number, y: number): void => {
    pop.textContent = "";
    pop.setAttribute("aria-label", labels.toolbar);
    pop.appendChild(el("div", a.note ? "note" : "note empty", a.note || labels.noNote));
    const swRow = el("div", "row");
    for (const color of ANNOTATION_COLORS) {
      swRow.appendChild(
        swatch(
          color,
          () => {
            ipcRenderer.send(ANNOTATION_UPDATE_CHANNEL, { id: a.id, color });
            hidePop();
          },
          color === a.color,
        ),
      );
    }
    pop.appendChild(swRow);
    const actions = el("div", "row end");
    const edit = el("button", "btn");
    edit.appendChild(pencil());
    edit.appendChild(d.createTextNode(labels.editNote));
    edit.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      const area = el("textarea", "");
      area.value = a.note;
      area.placeholder = labels.notePlaceholder;
      const row = el("div", "row end");
      const save = el("button", "btn primary", labels.save);
      save.addEventListener("mousedown", (ev: any) => {
        ev.preventDefault();
        ipcRenderer.send(ANNOTATION_UPDATE_CHANNEL, { id: a.id, note: area.value });
        hidePop();
      });
      row.appendChild(save);
      pop.textContent = "";
      pop.appendChild(area);
      pop.appendChild(row);
      area.focus();
    });
    const del = el("button", "btn danger", labels.delete);
    del.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      ipcRenderer.send(ANNOTATION_DELETE_CHANNEL, { id: a.id });
      hidePop();
    });
    actions.appendChild(edit);
    actions.appendChild(del);
    pop.appendChild(actions);
    placeAt(pop, { left: x, top: y, bottom: y });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hitTest = (x: number, y: number): Applied | null => {
    const caret = d.caretRangeFromPoint ? d.caretRangeFromPoint(x, y) : null;
    if (!caret) return null;
    for (const a of applied) {
      try {
        if (a.range.isPointInRange(caret.startContainer, caret.startOffset)) return a;
      } catch {
        // range may have been invalidated by DOM changes
      }
    }
    return null;
  };

  d.addEventListener(
    "mouseup",
    (e: any) => {
      if (host.contains && host.contains(e.target)) return;
      // A page's own synthetic events and an agent's clicks open nothing.
      if (!e.isTrusted || agentActing()) return;
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        hideBar();
        openPopover(hit, e.clientX, e.clientY);
        return;
      }
      hidePop();
      setTimeout(onSelect, 0);
    },
    true,
  );
  d.addEventListener(
    "mousedown",
    (e: any) => {
      if (host.contains && host.contains(e.target)) return;
      hidePop();
      if (!composing()) hideBar();
    },
    true,
  );

  ipcRenderer.on(ANNOTATION_APPLY_CHANNEL, (_e: IpcRendererEvent, msg: AnnotationApplyMessage) => {
    try {
      labels = msg.labels;
      appendUi();
      render(msg);
    } catch {
      // never let annotations break the page
    }
  });
}
