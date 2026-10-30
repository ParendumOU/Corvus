import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FieldDropdownState, FieldMenuBridge } from "../../shared/credentials-ipc";
import { dropdownEntries, dropdownLabel, dropdownLines, dropdownTwoFaOnly } from "../../shared/field-dropdown";
import { setUiLanguage, t } from "../common/i18n";
import { IconChevronDown, IconChevronRight, IconClock, IconLock } from "../common/icons";
import "../common/theme.css";
import "../common/account-rows.css";
import "./field-menu.css";

declare global {
  interface Window {
    corvusFieldMenu?: FieldMenuBridge;
  }
}

/**
 * The account dropdown under a login or code field (see main/field-dropdown.ts): the rows of the key
 * panel, drawn as the main process says. It never takes the keyboard (the page keeps it): a press
 * picks on mouse down, and the arrows reach it through the main process.
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

  if (!state) return null;
  const words = { noUsername: t("(no username)"), twoFaOnly: t("2FA only"), codeFor: t("2FA code for") };
  const entries = dropdownEntries(state);
  // "Manage passwords" is last, under the list (which scrolls when long).
  const manage = entries.length - 1;
  const press = (index: number) => ({
    className: state.highlight === index ? "active" : "",
    onMouseMove: () => state.highlight !== index && bridge.send({ type: "hover", token: state.token, index }),
    onMouseDown: (e: { preventDefault(): void; button: number }) => {
      e.preventDefault();
      if (e.button === 0) bridge.send({ type: "activate", token: state.token, index });
    },
  });

  return (
    <div className="fd-menu" ref={menu} role="listbox" aria-label={state.kind === "otp" ? t("2FA code") : t("Passwords")} style={{ width: state.maxWidth }}>
      {state.kind === "otp" && <div className="fd-head">{t("2FA code")}</div>}
      <div className="af-list">
        {entries.slice(0, manage).map((entry, index) => {
          const p = press(index);
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
      <div role="option" aria-selected={state.highlight === manage} {...press(manage)} className={`af-manage ${press(manage).className}`}>
        {t("Manage passwords")}
      </div>
    </div>
  );
}

const bridge = window.corvusFieldMenu;
if (bridge) createRoot(document.getElementById("root") as HTMLElement).render(<FieldMenu bridge={bridge} />);
