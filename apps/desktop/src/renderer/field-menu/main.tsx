import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FieldDropdownState, FieldMenuBridge, GeneratorState } from "../../shared/credentials-ipc";
import { dropdownEntries, dropdownLabel, dropdownLines, dropdownTwoFaOnly } from "../../shared/field-dropdown";
import { PASSWORD_CHARSETS, PASSWORD_CLASSES, type GeneratorNote, type PasswordClass } from "../../shared/password-rules";
import { setUiLanguage, t } from "../common/i18n";
import { IconCheck, IconChevronDown, IconChevronRight, IconClock, IconCopy, IconLock, IconReload, IconSparkle } from "../common/icons";
import "../common/theme.css";
import "../common/account-rows.css";
import "./field-menu.css";

declare global {
  interface Window {
    corvusFieldMenu?: FieldMenuBridge;
  }
}

/** The generator's length box and slider: a press there keeps the keyboard in the dropdown (the person types the length). */
const KEYBOARD_CONTROL = ".fd-gen-len, .fd-gen-slider";
/** How long the length box waits after the last key before it takes the length. */
const LENGTH_IDLE_MS = 600;

const CLASS_SAMPLES: Record<PasswordClass, string> = { lowercase: "a-z", uppercase: "A-Z", digits: "0-9", symbols: "!@#" };

const classLabel = (c: PasswordClass): string => ({ lowercase: t("Lowercase"), uppercase: t("Uppercase"), digits: t("Digits"), symbols: t("Symbols") })[c];

function noteText(note: GeneratorNote): string {
  switch (note.type) {
    case "max":
      return t("This site takes at most {length} characters.", { length: note.length });
    case "min":
      return t("This site asks for at least {length} characters.", { length: note.length });
    case "symbols":
      return t("Only the symbols this site takes: {symbols}", { symbols: note.symbols });
    case "without":
      return {
        lowercase: t("Without lowercase letters: this site does not take them."),
        uppercase: t("Without uppercase letters: this site does not take them."),
        digits: t("Without digits: this site does not take them."),
        symbols: t("Without symbols: this site does not take them."),
      }[note.option];
    case "with":
      return {
        lowercase: t("With lowercase letters: this site asks for them."),
        uppercase: t("With uppercase letters: this site asks for them."),
        digits: t("With digits: this site asks for them."),
        symbols: t("With symbols: this site asks for them."),
      }[note.option];
  }
}

/** A password with its digits and symbols tinted, so it reads character by character. */
function Tinted({ password }: { password: string }) {
  return (
    <>
      {[...password].map((ch, i) => (
        <span key={i} className={PASSWORD_CHARSETS.digits.includes(ch) ? "d" : /[a-z]/i.test(ch) ? undefined : "s"}>
          {ch}
        </span>
      ))}
    </>
  );
}

/**
 * The strong password generator, in the dropdown's place: the password, its length (a box to type it
 * in and a slider), the character classes, what the field made it change, Regenerate, Copy and Use.
 * The main process makes every password; this only draws them and reports the person's choices.
 */
function Generator({ bridge, token, gen }: { bridge: FieldMenuBridge; token: number; gen: GeneratorState }) {
  const [draft, setDraft] = useState<string | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout>>();
  // A new password came: the box shows its length again.
  useEffect(() => setDraft(null), [gen.password, gen.options.length]);
  useEffect(() => () => clearTimeout(idle.current), []);
  const commit = (value: string | null): void => {
    clearTimeout(idle.current);
    const length = Number.parseInt(value ?? "", 10);
    if (Number.isFinite(length) && length > 0) bridge.send({ type: "length", token, length: Math.min(length, 1000) });
    else setDraft(null);
  };
  const fixedLength = gen.minLength === gen.maxLength;
  const button = (type: "regenerate" | "copy" | "use") => ({
    onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
    onClick: () => bridge.send({ type, token }),
  });
  return (
    <div className="fd-gen">
      <div className="fd-gen-head">
        <IconSparkle size={14} />
        {t("Strong password")}
      </div>
      <div className="fd-gen-pw" aria-label={t("Suggested password")}>
        <Tinted password={gen.password} />
      </div>
      <div className="fd-gen-length">
        <span className="fd-gen-label">{t("Length")}</span>
        <input
          className="input fd-gen-len"
          type="number"
          aria-label={t("Length")}
          min={gen.minLength}
          max={gen.maxLength}
          disabled={fixedLength}
          value={draft ?? String(gen.options.length)}
          onChange={(e) => {
            const value = e.target.value;
            setDraft(value);
            clearTimeout(idle.current);
            idle.current = setTimeout(() => commit(value), LENGTH_IDLE_MS);
          }}
          onBlur={() => draft !== null && commit(draft)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            e.stopPropagation();
            commit(draft ?? String(gen.options.length));
          }}
        />
        <input
          className="fd-gen-slider"
          type="range"
          aria-label={t("Length")}
          min={gen.minLength}
          max={gen.maxLength}
          disabled={fixedLength}
          value={Number(draft ?? gen.options.length) || gen.options.length}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
        />
      </div>
      <div className="fd-gen-classes">
        {PASSWORD_CLASSES.map((c) => (
          <button
            key={c}
            role="checkbox"
            aria-checked={gen.options[c]}
            disabled={gen.fixed[c]}
            className={`fd-check ${gen.options[c] ? "on" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bridge.send({ type: "toggle", token, option: c })}
          >
            <span className="fd-box">{gen.options[c] && <IconCheck size={11} />}</span>
            {classLabel(c)}
            <span className="fd-sample">{CLASS_SAMPLES[c]}</span>
          </button>
        ))}
      </div>
      {gen.notes.length > 0 && (
        <ul className="fd-gen-notes">
          {gen.notes.map((note, i) => (
            <li key={i}>{noteText(note)}</li>
          ))}
        </ul>
      )}
      <div className="fd-gen-actions">
        <button className="btn small ghost" {...button("regenerate")}>
          <IconReload size={13} />
          {t("Regenerate")}
        </button>
        <button className={`btn small ghost fd-gen-copy ${gen.copied ? "copied" : ""}`} aria-live="polite" {...button("copy")}>
          {gen.copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          <span className="af-swap">
            <span className={gen.copied ? "off" : ""}>{t("Copy")}</span>
            <span className={gen.copied ? "" : "off"}>{t("Copied")}</span>
          </span>
        </button>
        <button className="btn small primary fd-gen-use" {...button("use")}>
          {t("Use password")}
        </button>
      </div>
    </div>
  );
}

/**
 * The account dropdown under a login or code field (see main/field-dropdown.ts): the rows of the key
 * panel, drawn as the main process says, and under a password field "Copy password" and a suggested
 * strong password with its generator. It never takes the keyboard (the page keeps it), except in the
 * generator's length: a press picks on mouse down, and the arrows reach it through the main process.
 */
function FieldMenu({ bridge }: { bridge: FieldMenuBridge }) {
  const [state, setState] = useState<FieldDropdownState | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      bridge.onState((next) => {
        if (next) setUiLanguage(next.language);
        setState(next);
      }),
    [bridge],
  );

  // The view takes the dropdown's size (it is exactly its box), for each state drawn.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!state || !el) return;
    const r = el.getBoundingClientRect();
    bridge.send({ type: "size", token: state.token, width: Math.ceil(r.width), height: Math.ceil(r.height) });
  }, [bridge, state]);

  useEffect(() => {
    menu.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [state?.highlight]);

  // While the dropdown has the keyboard (the person typed the length): Escape closes it, Enter uses the password.
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault();
      bridge.send(e.key === "Escape" ? { type: "escape", token: state.token } : { type: "use", token: state.token });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge, state]);

  if (!state) return null;
  const words = { noUsername: t("(no username)"), twoFaOnly: t("2FA only"), codeFor: t("2FA code for") };
  const entries = dropdownEntries(state);
  // A click keeps the keyboard here only in the generator's length; anywhere else the page gets it back.
  const onPress = (e: { target: EventTarget | null }) =>
    bridge.send({ type: "press", token: state.token, keyboard: e.target instanceof Element && Boolean(e.target.closest(KEYBOARD_CONTROL)) });
  const press = (index: number) => ({
    className: state.highlight === index ? "active" : "",
    onMouseMove: () => state.highlight !== index && bridge.send({ type: "hover", token: state.token, index }),
    onMouseDown: (e: { preventDefault(): void; button: number }) => {
      e.preventDefault();
      if (e.button === 0) bridge.send({ type: "activate", token: state.token, index });
    },
  });
  // All it offers is "Copy password": a small button under the field.
  const compact = entries.length === 1 && entries[0]?.type === "copy";
  const manage = entries.findIndex((e) => e.type === "manage");
  const listed = manage < 0 ? entries.length : manage;

  if (state.generator?.open) {
    return (
      <div className="fd-menu" ref={menu} onMouseDownCapture={onPress} style={{ width: state.maxWidth }}>
        <Generator bridge={bridge} token={state.token} gen={state.generator} />
      </div>
    );
  }
  return (
    <div
      className={`fd-menu ${compact ? "compact" : ""}`}
      ref={menu}
      role="listbox"
      aria-label={state.kind === "otp" ? t("2FA code") : t("Passwords")}
      onMouseDownCapture={onPress}
      style={compact ? undefined : { width: state.maxWidth }}
    >
      {state.kind === "otp" && <div className="fd-head">{t("2FA code")}</div>}
      <div className="af-list">
        {entries.slice(0, listed).map((entry, index) => {
          const p = press(index);
          if (entry.type === "copy") {
            const copied = state.copy === "copied";
            return (
              <div key="copy" role="option" aria-selected={state.highlight === index} {...p} className={`af-row fd-copy ${copied ? "copied" : ""} ${p.className}`}>
                <span className="af-fill">
                  <span className="af-icon">{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</span>
                  <span className="af-user" aria-live="polite">
                    {copied ? t("Copied") : t("Copy password")}
                  </span>
                </span>
              </div>
            );
          }
          if (entry.type === "suggest" && state.generator) {
            return (
              <div key="suggest" role="option" aria-selected={state.highlight === index} title={t("Suggest a strong password")} {...p} className={`af-row fd-suggest ${p.className}`}>
                <span className="af-fill">
                  <span className="af-icon">
                    <IconSparkle size={14} />
                  </span>
                  <span className="af-text">
                    <span className="af-user">{t("Suggest a strong password")}</span>
                    <span className="af-site fd-preview">{state.generator.password}</span>
                  </span>
                </span>
              </div>
            );
          }
          if (entry.type === "others") {
            return (
              <div key="others" role="option" aria-selected={state.highlight === index} aria-expanded={state.othersOpen} {...p} className={`af-others ${p.className}`}>
                {state.othersOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                <span className="af-others-title">{t("Other {domain} accounts", { domain: state.domain })}</span>
                <span className="af-count">{state.others.length}</span>
              </div>
            );
          }
          if (entry.type !== "account") return null;
          const m = entry.account;
          const { user, details } = dropdownLines(m, words);
          const twoFaOnly = dropdownTwoFaOnly(m, state.kind);
          return (
            <div key={m.id} role="option" aria-selected={state.highlight === index} title={dropdownLabel(m, state.kind, words)} {...p} className={`af-row ${p.className}`}>
              <span className="af-fill">
                <span className="af-icon">{state.kind === "login" && m.hasPassword ? <IconLock size={14} /> : <IconClock size={14} />}</span>
                <span className="af-text">
                  <span className="af-user-line">
                    <span className="af-user">{user}</span>
                    {twoFaOnly && <span className="af-tag">{words.twoFaOnly}</span>}
                  </span>
                  {details && <span className="af-site">{details}</span>}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      {manage >= 0 && (
        <div role="option" aria-selected={state.highlight === manage} {...press(manage)} className={`af-manage ${press(manage).className}`}>
          {t("Manage passwords")}
        </div>
      )}
    </div>
  );
}

const bridge = window.corvusFieldMenu;
if (bridge) createRoot(document.getElementById("root") as HTMLElement).render(<FieldMenu bridge={bridge} />);
