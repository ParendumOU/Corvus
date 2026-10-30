import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { CredentialMatch } from "../../shared/credentials";
import type { AutofillBarState } from "../../shared/credentials-ipc";
import { GROUP_COLOR_HEX, type TabView } from "../../shared/ipc";
import { isNewTabUrl } from "../../shared/internal-urls";
import { displayUrl, searchQueryOf } from "../../shared/omnibox";
import type { Suggestion } from "../../shared/suggest";
import { chromeApi } from "../common/api";
import { languageName, type TranslateBarState } from "../../shared/translate";
import { CorvusMark, IconBook, IconGlobe, IconLock, IconSearch, IconSparkle, IconStar, IconTranslate, IconWarning, IconZoom } from "../common/icons";
import { Favicon } from "../common/ui";
import { useHoverSelect } from "./hover-select";
import { SavePasswordPrompt } from "./SavePassword";
import { AutofillPanel } from "./AutofillPanel";

import { t } from "../common/i18n";
export interface OmniboxHandle {
  focus(selectAll: boolean): void;
  close(): void;
}

function editValue(url: string): string {
  if (isNewTabUrl(url) || url === "about:blank") return "";
  return searchQueryOf(url) ?? url;
}

/**
 * Selects the address for editing a frame later, unless the caret moved on meanwhile: Chromium's
 * select() also focuses, so it would pull the caret back from whatever took it (a group name).
 */
function selectIfFocused(input: HTMLInputElement | null): void {
  if (input && document.activeElement === input) input.select();
}

/** Drag data of a page (the site chip dragged out of the address bar): `{ url, title }` as JSON. */
export const PAGE_DRAG_MIME = "application/x-corvus-page";

/** Dragging the site chip carries the page, like Chrome: drop it on the bookmarks bar to save it. */
function dragPage(e: DragEvent<HTMLElement>, url: string, title: string): void {
  e.dataTransfer.setData(PAGE_DRAG_MIME, JSON.stringify({ url, title }));
  e.dataTransfer.setData("text/uri-list", url);
  e.dataTransfer.setData("text/plain", url);
  e.dataTransfer.effectAllowed = "copyLink";
  const ghost = document.createElement("div");
  ghost.className = "page-drag-ghost";
  ghost.textContent = title || url;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 14, 14);
  setTimeout(() => ghost.remove(), 0);
}

function SecurityChip({ url, title, certError, onOpen }: { url: string; title: string; certError: string | undefined; onOpen: (rect: DOMRect) => void }) {
  const open = (e: MouseEvent<HTMLButtonElement>): void => onOpen(e.currentTarget.getBoundingClientRect());
  const drag = { draggable: true, onDragStart: (e: DragEvent<HTMLElement>) => dragPage(e, url, title) };
  // Never the lock for a site whose certificate failed, even once the person went on anyway.
  if (certError) {
    return (
      <button className="omni-chip clickable warn cert site-chip" title={t("Your connection to this site is not private. View site information")} onClick={open} {...drag}>
        <IconWarning size={13} />
        <span>{t("Not secure")}</span>
      </button>
    );
  }
  if (url.startsWith("corvus:")) {
    return (
      <span className="omni-chip internal" title={t("Corvus page")}>
        <CorvusMark size={14} />
      </span>
    );
  }
  if (url.startsWith("https:")) {
    return (
      <button className="omni-chip clickable site-chip" title={t("View site information")} onClick={open} {...drag}>
        <IconLock size={13} />
      </button>
    );
  }
  if (url.startsWith("http:")) {
    return (
      <button className="omni-chip clickable warn site-chip" title={t("Connection is not secure. View site information")} onClick={open} {...drag}>
        <IconWarning size={13} />
        <span>{t("Not secure")}</span>
      </button>
    );
  }
  if (url.startsWith("file:")) {
    return (
      <button className="omni-chip clickable site-chip" title={t("View site information")} onClick={open} {...drag}>
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

/** Translate (offered or failed), stop (translating), or show the original (translated). */
function TranslateButton({ state, onClick }: { state: TranslateBarState; onClick: () => void }) {
  const target = languageName(state.target, "en");
  const from = state.pageLang ? languageName(state.pageLang, "en") : "";
  const title =
    state.state === "translating"
      ? t("Translating to {target}… ({translated} done) · click to stop", { target, translated: state.translated })
      : state.state === "translated"
        ? t("Translated to {target} · show original", { target })
        : state.state === "error"
          ? t("Translation failed: {error} · try again", { error: state.error ?? t("unknown error") })
          : (from ? t("Translate this page from {from} to {target}", { from, target }) : t("Translate this page to {target}", { target }));
  return (
    <button className={`icon-btn omni-translate ${state.state}`} title={title} aria-pressed={state.state === "translated"} onClick={onClick}>
      {state.state === "translating" ? <span className="spinner small" /> : <IconTranslate size={16} />}
    </button>
  );
}

interface OmniboxProps {
  tab: TabView | undefined;
  /** The active tab's translate button, or null when it is hidden. */
  translate: TranslateBarState | null;
  bookmarked: boolean;
  zoomPercent: number;
  readerable: boolean;
  readerActive: boolean;
  autofill: AutofillBarState;
  /** No other popover or dialog is open: the save-password prompt may open by itself. */
  autoOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSiteInfo: (rect: DOMRect) => void;
  onZoom: (rect: DOMRect) => void;
}

export const Omnibox = forwardRef<OmniboxHandle, OmniboxProps>(
  function Omnibox({ tab, translate, bookmarked, zoomPercent, readerable, readerActive, autofill, autoOpen, onOpenChange, onSiteInfo, onZoom }, ref) {
    const api = chromeApi();
    const inputRef = useRef<HTMLInputElement>(null);
    const [focused, setFocused] = useState(false);
    const [value, setValue] = useState("");
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [selected, setSelected] = useState(0);
    const hoverSelect = useHoverSelect(setSelected);
    const [autofillOpen, setAutofillOpen] = useState(false);
    // The save prompt was opened from the key button (it takes the keyboard), not by itself.
    const [saveFocus, setSaveFocus] = useState(false);
    const [matches, setMatches] = useState<CredentialMatch[]>([]);
    const request = useRef(0);
    const typed = useRef(false);
    const url = tab?.url ?? "";
    const open = focused && suggestions.length > 0;
    const showAutofill = Boolean(tab) && !focused && (autofill.available || autofill.canSave);
    const promptSave = showAutofill && autofill.savePrompt && autoOpen;

    // The panel belongs to the tab, and to the pending save, it was opened for.
    useEffect(() => setAutofillOpen(false), [tab?.id, autofill.saveId]);
    useEffect(() => {
      if (!showAutofill) setAutofillOpen(false);
    }, [showAutofill]);
    // A submitted login opens the save prompt by itself, once per save, like Chrome and Brave. It leaves
    // the keyboard on the page; after that the key button still reaches it until it is answered.
    useEffect(() => {
      if (!promptSave) return;
      // The address bar may still hold the caret it had when the page took the keyboard: Chromium puts
      // it back as soon as a click focuses this view, which would close the prompt under the click.
      if (document.activeElement === inputRef.current) inputRef.current?.blur();
      setSaveFocus(false);
      setAutofillOpen(true);
    }, [promptSave, autofill.saveId]);

    const openAutofill = (): void => {
      if (autofillOpen) {
        setAutofillOpen(false);
        return;
      }
      if (autofill.available) void api.call("autofill.suggestions").then(setMatches);
      setSaveFocus(true);
      setAutofillOpen(true);
    };
    // A click elsewhere, or the save prompt closing while it had the keyboard, gives it back to the page.
    const closeAutofill = (refocusPage: boolean): void => {
      setAutofillOpen(false);
      if (refocusPage) void api.call("ui.focusContent");
    };

    useEffect(() => {
      if (!focused) setValue(displayUrl(url));
    }, [url, focused]);

    // Focused for a tab that just became active (Ctrl+T focuses before the new tab's state arrives):
    // show that tab's value unless the user already started typing.
    useEffect(() => {
      if (!focused || typed.current) return;
      setValue(editValue(url));
      requestAnimationFrame(() => selectIfFocused(inputRef.current));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab?.id]);

    // The autofill panel also hangs below the toolbar, over the page: it needs the overlay too.
    useEffect(() => onOpenChange(open || autofillOpen), [open, autofillOpen, onOpenChange]);

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
        setAutofillOpen(false);
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
            <SecurityChip url={url} title={tab?.title ?? ""} certError={tab?.certError} onOpen={onSiteInfo} />
          )}
          <input
            ref={inputRef}
            className="omni-input"
            value={value}
            spellCheck={false}
            placeholder={t("Ask Corvus AI or type a URL")}
            onFocus={(e) => {
              typed.current = false;
              setFocused(true);
              const v = editValue(url);
              setValue(v);
              const input = e.target;
              requestAnimationFrame(() => selectIfFocused(input));
            }}
            onBlur={(e) => {
              setFocused(false);
              reset();
              // Corvus's UI lost the keyboard with the caret still here. When the page (or another part of
              // this window) took it, let go of the caret, as Chrome's address bar does: Chromium would
              // put it back here on the next click anywhere in Corvus's UI, and the address bar would
              // take that click (the key button's panel, the star...). Switching to another app keeps it.
              const input = e.currentTarget;
              if (document.activeElement !== input) return;
              void api.call("ui.keyboardElsewhere").then((elsewhere) => {
                if (elsewhere && document.activeElement === input && !document.hasFocus()) input.blur();
              });
            }}
            onChange={(e) => {
              typed.current = true;
              setValue(e.target.value);
              updateSuggestions(e.target.value);
            }}
            onKeyDown={onKeyDown}
          />
          {tab && !focused && translate && <TranslateButton state={translate} onClick={() => void api.call("translate.toggle")} />}
          {tab && !focused && (readerable || readerActive) && (
            <button
              className={`icon-btn omni-reader ${readerActive ? "on" : ""}`}
              title={readerActive ? t("Exit reader mode (Esc)") : t("Reader mode (Ctrl+Shift+R)")}
              aria-pressed={readerActive}
              onClick={() => void api.call("reader.toggle")}
            >
              <IconBook size={16} />
            </button>
          )}
          {showAutofill && (
            <button
              className={`icon-btn omni-autofill ${autofill.canSave ? "save" : ""}`}
              title={autofill.canSave ? t("Save password") : autofill.otpAvailable && autofill.matchCount === 0 ? t("Fill 2FA code") : t("Fill password")}
              aria-pressed={autofillOpen}
              onClick={openAutofill}
            >
              <IconLock size={16} />
            </button>
          )}
          {tab?.container && !focused && (
            <span
              className="omni-container"
              title={t("This tab is in the “{name}” container: its own cookies and site data", { name: tab.container.name })}
              style={{ "--c-light": GROUP_COLOR_HEX[tab.container.color].light, "--c-dark": GROUP_COLOR_HEX[tab.container.color].dark } as CSSProperties}
            >
              {tab.container.name}
            </span>
          )}
          {tab && zoomPercent !== 100 && !focused && (
            <button
              className="icon-btn omni-zoom"
              title={t("Zoom: {zoomPercent}%", { zoomPercent })}
              onClick={(e) => onZoom(e.currentTarget.getBoundingClientRect())}
            >
              <IconZoom size={15} />
              <span>{zoomPercent}%</span>
            </button>
          )}
          {tab && !url.startsWith("corvus:") && url !== "about:blank" && !focused && (
            <button
              className={`icon-btn omni-star ${bookmarked ? "on" : ""}`}
              title={bookmarked ? t("Remove bookmark") : t("Bookmark this tab (Ctrl+D)")}
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
                onMouseMove={hoverSelect(i)}
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
        {autofillOpen && <div className="omni-panel-backdrop" onMouseDown={() => closeAutofill(true)} />}
        {autofillOpen && autofill.canSave && <SavePasswordPrompt key={autofill.saveId} takeFocus={saveFocus} onClose={closeAutofill} />}
        {autofillOpen && !autofill.canSave && <AutofillPanel autofill={autofill} matches={matches} url={url} onDone={() => setAutofillOpen(false)} />}
      </div>
    );
  },
);
