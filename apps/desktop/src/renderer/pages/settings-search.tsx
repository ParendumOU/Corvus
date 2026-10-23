import { useEffect, useRef, useState } from "react";
import { t } from "../common/i18n";
import { IconClose, IconSearch } from "../common/icons";
import { matchSection, normalizeQuery, findRanges, type SectionIndexEntry } from "./settings-search-lib";
import "./settings-search.css";

const HIGHLIGHT = "settings-search";
const HIDDEN = "data-search-hidden";
const FLASH = "data-search-flash";

interface IndexedRow {
  el: HTMLElement;
  labelEl: HTMLElement | null;
  hintEl: HTMLElement | null;
}
interface IndexedSection {
  el: HTMLElement;
  titleEl: HTMLElement | null;
  descEl: HTMLElement | null;
  rows: IndexedRow[];
  entry: SectionIndexEntry;
}

type HighlightLike = { add(range: Range): void };
type HighlightCtor = new () => HighlightLike;
type HighlightRegistryLike = { set(name: string, h: HighlightLike): void; delete(name: string): void };

function highlightApi(): { make: () => HighlightLike; registry: HighlightRegistryLike } | null {
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  if (!Ctor || !registry) return null;
  return { make: () => new Ctor(), registry };
}

function buildIndex(root: HTMLElement): IndexedSection[] {
  return Array.from(root.querySelectorAll<HTMLElement>(":scope > .card")).map((el) => {
    const titleEl = el.querySelector<HTMLElement>(".card-head h2");
    const descEl = el.querySelector<HTMLElement>(".card-head p");
    const rows: IndexedRow[] = Array.from(el.querySelectorAll<HTMLElement>(".row")).map((r) => ({
      el: r,
      labelEl: r.querySelector<HTMLElement>(".row-label > div:first-child"),
      hintEl: r.querySelector<HTMLElement>(".row-label > .muted.small"),
    }));
    return {
      el,
      titleEl,
      descEl,
      rows,
      entry: {
        title: titleEl?.textContent ?? "",
        description: descEl?.textContent ?? "",
        rows: rows.map((r) => ({ label: r.labelEl?.textContent ?? "", hint: r.hintEl?.textContent ?? "" })),
      },
    };
  });
}

function setHidden(el: HTMLElement, hidden: boolean): void {
  if (hidden) el.setAttribute(HIDDEN, "");
  else el.removeAttribute(HIDDEN);
}

function collectRanges(hl: HighlightLike, el: HTMLElement | null, nq: string): void {
  if (!el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    for (const [start, end] of findRanges(node.textContent ?? "", nq)) {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      hl.add(range);
    }
    node = walker.nextNode();
  }
}

/** Mutates the DOM to show/hide sections + rows for the query and highlights matches. Returns the ids of visible sections. */
function applyFilter(index: IndexedSection[], raw: string): Set<string> {
  const nq = normalizeQuery(raw);
  const api = highlightApi();
  const hl = nq && api ? api.make() : null;
  const visibleIds = new Set<string>();

  for (const sec of index) {
    const m = matchSection(sec.entry, nq);
    setHidden(sec.el, !m.visible);
    if (m.visible && sec.el.id) visibleIds.add(sec.el.id);
    sec.rows.forEach((row, i) => {
      const hideRow = m.visible && !m.sectionHit && !m.rowVisible[i];
      setHidden(row.el, hideRow);
      if (hl && m.visible && !hideRow) {
        collectRanges(hl, row.labelEl, nq);
        collectRanges(hl, row.hintEl, nq);
      }
    });
    if (hl && m.visible) {
      collectRanges(hl, sec.titleEl, nq);
      collectRanges(hl, sec.descEl, nq);
    }
  }

  if (api) {
    if (nq && hl) api.registry.set(HIGHLIGHT, hl);
    else api.registry.delete(HIGHLIGHT);
  }
  return visibleIds;
}

function syncSidebar(visibleIds: Set<string>, filtering: boolean): void {
  const groups = document.querySelectorAll<HTMLElement>(".side-extra .nav-group");
  for (const group of groups) {
    let anyVisible = false;
    for (const link of group.querySelectorAll<HTMLElement>("a[data-nav-id]")) {
      const id = link.getAttribute("data-nav-id") ?? "";
      const show = !filtering || visibleIds.has(id);
      setHidden(link, !show);
      if (show) anyVisible = true;
    }
    setHidden(group, filtering && !anyVisible);
  }
}

function flash(el: HTMLElement): void {
  el.removeAttribute(FLASH);
  void el.offsetWidth;
  el.setAttribute(FLASH, "");
  window.setTimeout(() => el.removeAttribute(FLASH), 1300);
}

export function SettingsSearch() {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const indexRef = useRef<IndexedSection[]>([]);
  const queryRef = useRef("");

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".page-main");
    if (!root) return;

    const run = (): void => {
      indexRef.current = buildIndex(root);
      const nq = normalizeQuery(queryRef.current);
      const visibleIds = applyFilter(indexRef.current, queryRef.current);
      syncSidebar(visibleIds, nq.length > 0);
      setCount(nq ? visibleIds.size : -1);
    };

    run();

    let scheduled = 0;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = window.requestAnimationFrame(() => {
        scheduled = 0;
        run();
      });
    });
    observer.observe(root, { childList: true, subtree: true });

    inputRef.current?.focus();

    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);

    const onHash = (): void => {
      const id = location.hash.slice(1);
      if (!id) return;
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: "start" });
        flash(el);
      }
    };
    window.addEventListener("hashchange", onHash);

    return () => {
      if (scheduled) window.cancelAnimationFrame(scheduled);
      observer.disconnect();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onHash);
      const api = highlightApi();
      api?.registry.delete(HIGHLIGHT);
    };
  }, []);

  useEffect(() => {
    const nq = normalizeQuery(query);
    const visibleIds = applyFilter(indexRef.current, query);
    syncSidebar(visibleIds, nq.length > 0);
    setCount(nq ? visibleIds.size : -1);
  }, [query]);

  const jumpToFirst = (): void => {
    const nq = normalizeQuery(queryRef.current);
    if (!nq) return;
    for (const sec of indexRef.current) {
      if (sec.el.hasAttribute(HIDDEN)) continue;
      const row = sec.rows.find((r) => !r.el.hasAttribute(HIDDEN));
      const target = row?.el ?? sec.el;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      flash(target);
      return;
    }
  };

  const clear = (): void => {
    setQuery("");
    inputRef.current?.focus();
  };

  return (
    <div className="settings-search">
      <div className="search-box">
        <IconSearch size={17} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={t("Search settings…")}
          spellCheck={false}
          aria-label={t("Search settings")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              jumpToFirst();
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (query) clear();
              else inputRef.current?.blur();
            }
          }}
        />
        {query ? (
          <button className="clear-btn" title={t("Clear (Esc)")} aria-label={t("Clear search")} onClick={clear}>
            <IconClose size={14} />
          </button>
        ) : (
          <span className="search-kbd">/</span>
        )}
      </div>
      {count === 0 && <div className="no-results">{t("No settings match “{query}”.", { query: query.trim() })}</div>}
    </div>
  );
}
