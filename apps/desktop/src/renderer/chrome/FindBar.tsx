import { useEffect, useRef, useState } from "react";
import type { FindState } from "../../shared/browser-ipc";
import { chromeApi } from "../common/api";
import { IconChevronDown, IconChevronUp, IconClose } from "../common/icons";

import { t } from "../common/i18n";
/**
 * Find-in-page bar for the active tab. Lives inside the chrome bar (so it never covers the page);
 * `focusToken` changes whenever Ctrl+F asks for focus.
 */
export function FindBar({ find, focusToken, focusHandled }: { find: FindState; focusToken: number; focusHandled: { current: number } }) {
  const api = chromeApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(find.text);

  useEffect(() => {
    if (focusToken === focusHandled.current) return;
    focusHandled.current = focusToken;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken, focusHandled]);

  const count = find.matches > 0 ? `${find.active}/${find.matches}` : text ? "0/0" : "";

  return (
    <div className="find-bar" role="search">
      <div className={`find-box ${text && find.matches === 0 ? "none" : ""}`}>
        <input
          ref={inputRef}
          className="find-input"
          value={text}
          placeholder={t("Find in page")}
          spellCheck={false}
          aria-label={t("Find in page")}
          onChange={(e) => {
            setText(e.target.value);
            void api.call("find.query", e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void api.call("find.step", !e.shiftKey);
            } else if (e.key === "Escape") {
              e.preventDefault();
              void api.call("find.close");
            }
          }}
        />
        <span className="find-count">{count}</span>
        <span className="find-sep" />
        <button className="icon-btn" title={t("Previous (Shift+Enter)")} disabled={find.matches === 0} onClick={() => void api.call("find.step", false)}>
          <IconChevronUp size={16} />
        </button>
        <button className="icon-btn" title={t("Next (Enter)")} disabled={find.matches === 0} onClick={() => void api.call("find.step", true)}>
          <IconChevronDown size={16} />
        </button>
        <button className="icon-btn" title={t("Close (Esc)")} onClick={() => void api.call("find.close")}>
          <IconClose size={15} />
        </button>
      </div>
    </div>
  );
}
