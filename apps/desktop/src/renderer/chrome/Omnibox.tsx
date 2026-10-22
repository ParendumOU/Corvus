import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { CredentialMatch } from "../../shared/credentials";
import type { AutofillBarState } from "../../shared/credentials-ipc";
import type { TabView } from "../../shared/ipc";
import { isNewTabUrl } from "../../shared/internal-urls";
import { displayUrl, searchQueryOf } from "../../shared/omnibox";
import type { Suggestion } from "../../shared/suggest";
import { chromeApi } from "../common/api";
import { CorvusMark, IconBook, IconClock, IconGlobe, IconLock, IconSearch, IconSparkle, IconStar, IconWarning, IconZoom } from "../common/icons";
import { Favicon } from "../common/ui";

export interface OmniboxHandle {
  focus(selectAll: boolean): void;
  close(): void;
}

function editValue(url: string): string {
  if (isNewTabUrl(url) || url === "about:blank") return "";
  return searchQueryOf(url) ?? url;
}

function SecurityChip({ url, onOpen }: { url: string; onOpen: (rect: DOMRect) => void }) {
  const open = (e: MouseEvent<HTMLButtonElement>): void => onOpen(e.currentTarget.getBoundingClientRect());
  if (url.startsWith("corvus:")) {
    return (
      <span className="omni-chip internal" title="Corvus page">
        <CorvusMark size={14} />
      </span>
    );
  }
  if (url.startsWith("https:")) {
    return (
      <button className="omni-chip clickable site-chip" title="View site information" onClick={open}>
        <IconLock size={13} />
      </button>
    );
  }
  if (url.startsWith("http:")) {
    return (
      <button className="omni-chip clickable warn site-chip" title="Connection is not secure. View site information" onClick={open}>
        <IconWarning size={13} />
        <span>Not secure</span>
      </button>
    );
  }
  if (url.startsWith("file:")) {
    return (
      <button className="omni-chip clickable site-chip" title="View site information" onClick={open}>
        <IconGlobe size={13} />
      </button>
    );
  }
  return (
    <span className="omni-chip">
      <IconGlobe size={13} />
    </span>
  );
}

interface OmniboxProps {
  tab: TabView | undefined;
  bookmarked: boolean;
  zoomPercent: number;
  readerable: boolean;
  readerActive: boolean;
  autofill: AutofillBarState;
  onOpenChange: (open: boolean) => void;
  onSiteInfo: (rect: DOMRect) => void;
  onZoom: (rect: DOMRect) => void;
}

export const Omnibox = forwardRef<OmniboxHandle, OmniboxProps>(
  function Omnibox({ tab, bookmarked, zoomPercent, readerable, readerActive, autofill, onOpenChange, onSiteInfo, onZoom }, ref) {
    const api = chromeApi();
    const inputRef = useRef<HTMLInputElement>(null);
    const [focused, setFocused] = useState(false);
    const [value, setValue] = useState("");
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [selected, setSelected] = useState(0);
    const [autofillOpen, setAutofillOpen] = useState(false);
    const [matches, setMatches] = useState<CredentialMatch[]>([]);
    const request = useRef(0);
    const url = tab?.url ?? "";
    const open = focused && suggestions.length > 0;
    const showAutofill = Boolean(tab) && !focused && (autofill.available || autofill.canSave);

    useEffect(() => {
      if (!showAutofill) setAutofillOpen(false);
    }, [showAutofill, tab?.id, autofill.canSave]);

    const openAutofill = (): void => {
      if (autofillOpen) {
        setAutofillOpen(false);
        return;
      }
      if (autofill.available) void api.call("autofill.suggestions").then(setMatches);
      setAutofillOpen(true);
    };

    const fill = (id: string): void => {
      void api.call("autofill.fill", id);
      setAutofillOpen(false);
    };
    const fillTotp = (id: string): void => {
      void api.call("autofill.fillTotp", id);
      setAutofillOpen(false);
    };
    const otpMatches = autofill.otpAvailable ? matches.filter((m) => m.hasTotp) : [];
    const loginMatches = autofill.matchCount > 0 ? matches : [];
    const sourceLabel = (m: CredentialMatch): string => (m.source === "keepass" ? `KeePass${m.sourceName ? `: ${m.sourceName}` : ""}` : "");
    const acceptSave = (): void => {
      void api.call("autofill.saveAccept");
      setAutofillOpen(false);
    };
    const dismissSave = (): void => {
      void api.call("autofill.saveDismiss");
      setAutofillOpen(false);
    };

    useEffect(() => {
      if (!focused) setValue(displayUrl(url));
    }, [url, focused]);

    useEffect(() => onOpenChange(open), [open, onOpenChange]);

    const reset = (): void => {
      request.current++;
      setSuggestions([]);
      setSelected(0);
    };

    useImperativeHandle(ref, () => ({
      focus(selectAll: boolean) {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        if (selectAll) input.select();
      },
      close() {
        reset();
        inputRef.current?.blur();
      },
    }));

    const updateSuggestions = (text: string): void => {
      const id = ++request.current;
      if (!text.trim()) {
        setSuggestions([]);
        return;
      }
      void api.call("omnibox.suggest", text).then((list) => {
        if (id !== request.current) return;
        setSuggestions(list);
        setSelected(0);
      });
    };

    const commit = (target: string): void => {
      if (!tab || !target.trim()) return;
      void api.call("tabs.navigate", tab.id, target);
      reset();
      inputRef.current?.blur();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === "ArrowDown" && suggestions.length > 0) {
        e.preventDefault();
        setSelected((s) => (s + 1) % suggestions.length);
      } else if (e.key === "ArrowUp" && suggestions.length > 0) {
        e.preventDefault();
        setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const choice = suggestions[selected];
        commit(choice && selected > 0 ? choice.url : value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (suggestions.length > 0) {
          reset();
          setValue(editValue(url));
        } else {
          setValue(displayUrl(url));
          inputRef.current?.blur();
          void api.call("ui.focusContent");
        }
      }
    };

    return (
      <div className={`omnibox ${focused ? "focused" : ""} ${open ? "open" : ""}`}>
        <div className="omni-field">
          {focused ? (
            <span className="omni-chip">
              <IconSearch size={14} />
            </span>
          ) : (
            <SecurityChip url={url} onOpen={onSiteInfo} />
          )}
          <input
            ref={inputRef}
            className="omni-input"
            value={value}
            spellCheck={false}
            placeholder="Ask Corvus AI or type a URL"
            onFocus={(e) => {
              setFocused(true);
              const v = editValue(url);
              setValue(v);
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={() => {
              setFocused(false);
              reset();
            }}
            onChange={(e) => {
              setValue(e.target.value);
              updateSuggestions(e.target.value);
            }}
            onKeyDown={onKeyDown}
          />
          {tab && !focused && (readerable || readerActive) && (
            <button
              className={`icon-btn omni-reader ${readerActive ? "on" : ""}`}
              title={readerActive ? "Exit reader mode (Esc)" : "Reader mode (Ctrl+Shift+R)"}
              aria-pressed={readerActive}
              onClick={() => void api.call("reader.toggle")}
            >
              <IconBook size={16} />
            </button>
          )}
          {showAutofill && (
            <button
              className={`icon-btn omni-autofill ${autofill.canSave ? "save" : ""}`}
              title={autofill.canSave ? "Save password" : autofill.otpAvailable && autofill.matchCount === 0 ? "Fill 2FA code" : "Fill password"}
              aria-pressed={autofillOpen}
              onClick={openAutofill}
            >
              <IconLock size={16} />
            </button>
          )}
          {tab && zoomPercent !== 100 && !focused && (
            <button
              className="icon-btn omni-zoom"
              title={`Zoom: ${zoomPercent}%`}
              onClick={(e) => onZoom(e.currentTarget.getBoundingClientRect())}
            >
              <IconZoom size={15} />
              <span>{zoomPercent}%</span>
            </button>
          )}
          {tab && !url.startsWith("corvus:") && url !== "about:blank" && !focused && (
            <button
              className={`icon-btn omni-star ${bookmarked ? "on" : ""}`}
              title={bookmarked ? "Remove bookmark" : "Bookmark this tab (Ctrl+D)"}
              onClick={() => void api.call("bookmarks.toggleActive")}
            >
              <IconStar size={16} filled={bookmarked} />
            </button>
          )}
        </div>
        {open && (
          <ul className="omni-suggestions" role="listbox">
            {suggestions.map((s, i) => (
              <li
                key={`${s.kind}-${s.url}`}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? "selected" : ""}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(i === 0 ? value : s.url);
                }}
              >
                <span className="sugg-icon">
                  {s.kind === "search" ? (
                    <IconSparkle size={16} />
                  ) : s.kind === "bookmark" ? (
                    <IconStar size={15} filled />
                  ) : (
                    <Favicon url={s.url} size={16} />
                  )}
                </span>
                <span className="sugg-title">{s.title}</span>
                {s.detail && <span className="sugg-detail">— {s.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        {autofillOpen && (
          <div className="omni-autofill-panel">
            {autofill.canSave ? (
              <div className="af-save">
                <div className="af-title">
                  {autofill.saveUpdates ? "Update password for " : "Save password for "}
                  {autofill.saveHost}?
                </div>
                <div className="af-row">
                  <button className="btn small primary" onMouseDown={(e) => { e.preventDefault(); acceptSave(); }}>
                    {autofill.saveUpdates ? "Update" : "Save"}
                  </button>
                  <button className="btn small ghost" onMouseDown={(e) => { e.preventDefault(); dismissSave(); }}>
                    Not now
                  </button>
                </div>
              </div>
            ) : (
              <div className="af-list">
                {otpMatches.length === 0 && loginMatches.length === 0 ? (
                  <div className="af-empty">No saved logins for this site.</div>
                ) : (
                  <>
                    {otpMatches.map((m) => (
                      <button key={`otp-${m.id}`} className="af-item af-otp" onMouseDown={(e) => { e.preventDefault(); fillTotp(m.id); }}>
                        <IconClock size={14} />
                        <span>2FA code for {m.username || "(no username)"}</span>
                        {sourceLabel(m) && <span className="af-source">{sourceLabel(m)}</span>}
                      </button>
                    ))}
                    {loginMatches.map((m) => (
                      <button key={m.id} className="af-item" onMouseDown={(e) => { e.preventDefault(); fill(m.id); }}>
                        <IconLock size={14} />
                        <span>{m.username || "(no username)"}</span>
                        {sourceLabel(m) && <span className="af-source">{sourceLabel(m)}</span>}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
            <button className="af-manage" onMouseDown={(e) => { e.preventDefault(); void api.call("autofill.openManager"); setAutofillOpen(false); }}>
              Manage passwords
            </button>
          </div>
        )}
      </div>
    );
  },
);
