import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  READER_FONT_MAX,
  READER_FONT_MIN,
  READER_TOOLS,
  READER_WIDTH_MAX,
  READER_WIDTH_MIN,
  type ReaderBridge,
  type ReaderDoc,
  type ReaderSettings,
  type ReaderState,
  type ReaderToolKind,
  type ReaderToolMessage,
} from "../../shared/reader-ipc";
import { splitSentences } from "../../shared/reading";
import {
  IconClose,
  IconDownload,
  IconFolder,
  IconMinus,
  IconPause,
  IconPlay,
  IconPlus,
  IconSparkle,
  IconStar,
  IconTrash,
  IconVolume,
} from "../common/icons";

import { t as tx } from "../common/i18n";
declare global {
  interface Window {
    corvusReader?: ReaderBridge;
  }
}

const api = (): ReaderBridge => {
  if (!window.corvusReader) throw new Error(tx("Reader bridge is not available"));
  return window.corvusReader;
};

function langName(tag: string): string {
  try {
    const base = tag.split("-")[0] ?? tag;
    return new Intl.DisplayNames([tag || "en"], { type: "language" }).of(base) ?? tag;
  } catch {
    return tag;
  }
}

export function App() {
  const [state, setState] = useState<ReaderState | null>(null);

  useEffect(() => {
    void api().call("state.get").then(setState);
    return api().onEvent((e) => setState(e.state));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") void api().call("reader.close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state) return null;
  const theme = state.settings.theme;
  const rootStyle = {
    "--fs": `${state.settings.fontSize}px`,
    "--measure": `${state.settings.lineWidth}ch`,
  } as CSSProperties;

  return (
    <div className={`reader-root font-${state.settings.font}`} data-theme={theme} style={rootStyle}>
      <Toolbar state={state} />
      <div className="reader-body">
        {state.loading ? (
          <div className="reader-scroll">
            <div className="reader-note">
              <div className="spinner" />{tx("Reading the page…")}</div>
          </div>
        ) : state.error || !state.doc ? (
          <div className="reader-scroll">
            <div className="reader-note">{state.error ?? tx("No article to show.")}</div>
          </div>
        ) : (
          <Article doc={state.doc} />
        )}
        <ToolStrip state={state} />
      </div>
    </div>
  );
}

function Toolbar({ state }: { state: ReaderState }) {
  const s = state.settings;
  const set = (patch: Partial<ReaderSettings>): void => void api().call("reader.setSettings", patch);
  const aloud = useReadAloud();

  return (
    <div className="reader-bar">
      <button className="rbtn icon" title={tx("Close reader (Esc)")} onClick={() => void api().call("reader.close")}>
        <IconClose size={16} />
      </button>
      <span className="reader-title-mini">{state.doc?.siteName || state.doc?.title || tx("Reader")}</span>
      <span className="grow" />

      <button className="rbtn icon" title={tx("Smaller text")} disabled={s.fontSize <= READER_FONT_MIN} onClick={() => set({ fontSize: s.fontSize - 1 })}>
        <IconMinus size={15} />
      </button>
      <span className="reader-title-mini" style={{ width: 26, textAlign: "center" }}>
        {s.fontSize}
      </span>
      <button className="rbtn icon" title={tx("Larger text")} disabled={s.fontSize >= READER_FONT_MAX} onClick={() => set({ fontSize: s.fontSize + 1 })}>
        <IconPlus size={15} />
      </button>

      <div className="sep" />
      <button className="rbtn icon" title={tx("Narrower")} disabled={s.lineWidth <= READER_WIDTH_MIN} onClick={() => set({ lineWidth: s.lineWidth - 6 })}>
        <span style={{ fontSize: 13 }}>&#8596;&#8722;</span>
      </button>
      <button className="rbtn icon" title={tx("Wider")} disabled={s.lineWidth >= READER_WIDTH_MAX} onClick={() => set({ lineWidth: s.lineWidth + 6 })}>
        <span style={{ fontSize: 13 }}>&#8596;&#43;</span>
      </button>

      <div className="sep" />
      <div className="seg" role="group" aria-label={tx("Theme")}>
        {(["light", "sepia", "dark"] as const).map((t) => (
          <button key={t} className={s.theme === t ? "on" : ""} title={tx("{name} theme", { name: t[0]!.toUpperCase() + t.slice(1) })} onClick={() => set({ theme: t })}>
            <span className={`theme-dot ${t}`} />
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label={tx("Typeface")}>
        <button className={s.font === "serif" ? "on" : ""} style={{ fontFamily: "Georgia, serif" }} onClick={() => set({ font: "serif" })}>{tx("Serif")}</button>
        <button className={s.font === "sans" ? "on" : ""} style={{ fontFamily: "system-ui, sans-serif" }} onClick={() => set({ font: "sans" })}>{tx("Sans")}</button>
      </div>

      <div className="sep" />
      <button className={`rbtn ${aloud.playing ? "on" : ""}`} title={tx("Read aloud")} onClick={aloud.toggle} disabled={!state.doc}>
        {aloud.playing ? <IconPause size={15} /> : <IconVolume size={15} />}
        <span>{aloud.playing ? tx("Pause") : tx("Listen")}</span>
      </button>
      {aloud.playing || aloud.active ? (
        <>
          <select
            className="rbtn"
            aria-label={tx("Reading speed")}
            value={String(aloud.rate)}
            onChange={(e) => aloud.setRate(Number(e.target.value))}
            style={{ padding: "0 4px" }}
          >
            {[0.75, 1, 1.25, 1.5, 2].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
          <button className="rbtn icon" title={tx("Stop")} onClick={aloud.stop}>
            <IconClose size={14} />
          </button>
        </>
      ) : null}

      <div className="sep" />
      <button className={`rbtn ${state.saved ? "on" : ""}`} title={tx("Save to reading list")} onClick={() => void api().call("reader.save")} disabled={!state.doc}>
        <IconStar size={15} filled={state.saved} />
        <span>{state.saved ? tx("Saved") : tx("Save")}</span>
      </button>
      <button className="rbtn icon" title={tx("Reading list")} onClick={() => void api().call("reader.openReadingList")}>
        <IconFolder size={15} />
      </button>
    </div>
  );
}

function Article({ doc }: { doc: ReaderDoc }) {
  const ref = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    ref.current?.parentElement?.parentElement?.scrollTo({ top: 0 });
  }, [doc.url]);

  const onMouseUp = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!text || !ref.current || !selection || selection.rangeCount === 0) {
      setSel(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setSel({ x: rect.left + rect.width / 2, y: rect.top - 8, text: text.slice(0, 600) });
  }, []);

  const onClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (anchor) {
      e.preventDefault();
      const href = anchor.getAttribute("href");
      if (href) void api().call("reader.openLink", href);
    }
  }, []);

  const runSel = (kind: ReaderToolKind): void => {
    if (sel) void api().call("reader.tool", kind, sel.text);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className="reader-scroll">
      <article className="reader-article" dir={doc.dir || undefined} lang={doc.lang || undefined}>
        <h1 className="doc-title">{doc.title}</h1>
        <div className="reader-meta">
          {doc.byline && <span>{doc.byline}</span>}
          {doc.siteName && <span>{doc.siteName}</span>}
          <span>{doc.readingMinutes}{" "}{tx("min read")}</span>
          <span>{doc.wordCount.toLocaleString()}{" "}{tx("words")}</span>
        </div>
        <div className="reader-content" ref={ref} onMouseUp={onMouseUp} onClick={onClick} dangerouslySetInnerHTML={{ __html: doc.content }} />
      </article>
      {sel && (
        <div className="sel-pop" style={{ left: sel.x, top: sel.y }} onMouseDown={(e) => e.preventDefault()}>
          <button onClick={() => runSel("define")}>{tx("Define")}</button>
          <button onClick={() => runSel("explain")}>{tx("Explain")}</button>
          <button onClick={() => runSel("translate")}>{tx("Translate")}</button>
        </div>
      )}
    </div>
  );
}

function jumpToSection(index: number): void {
  const el = document.querySelector(`[data-corvus-section="${index}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  else document.querySelector(".reader-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
}

function ToolStrip({ state }: { state: ReaderState }) {
  const ready = state.providerReady;
  const run = (kind: ReaderToolKind): void => void api().call("reader.tool", kind);

  return (
    <aside className="reader-strip">
      <div className="strip-head">
        <IconSparkle size={16} />
        <h2>{tx("Reading tools")}</h2>
        {state.busy ? (
          <button className="rbtn icon" title={tx("Stop")} onClick={() => void api().call("reader.cancel")}>
            <IconClose size={14} />
          </button>
        ) : state.messages.length > 0 ? (
          <button className="rbtn icon" title={tx("Clear")} onClick={() => void api().call("reader.clear")}>
            <IconTrash size={14} />
          </button>
        ) : null}
      </div>
      {ready ? (
        <div className="strip-tools">
          {READER_TOOLS.map((t) => (
            <button key={t.kind} className="rbtn" disabled={!state.doc || state.busy} onClick={() => run(t.kind)}>
              {t.kind === "translate" ? tx("Translate → {translateLanguage}", { translateLanguage: langName(state.translateLanguage) }) : t.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="setup-banner">
          {state.setupReason ?? tx("Add an AI provider in Settings to use the reading tools.")}
          <div>
            <button className="rbtn on" onClick={() => void api().call("reader.openReadingList")} style={{ display: "none" }} />
          </div>
        </div>
      )}
      <div className="strip-scroll">
        {state.messages.length === 0 && ready && (
          <div className="strip-empty">{tx("Ask AI to pull out the key points, give a quick TL;DR, simplify the writing, explain it simply or translate it. Select text in the article to define or explain a term.")}</div>
        )}
        {state.messages.map((m) => (
          <Message key={m.id} msg={m} headings={state.doc?.sectionHeadings ?? []} />
        ))}
      </div>
    </aside>
  );
}

function Message({ msg, headings }: { msg: ReaderToolMessage; headings: string[] }) {
  const streaming = msg.status === "streaming";
  return (
    <div className={`msg ${msg.status === "error" ? "error" : ""}`}>
      <div className="msg-head">
        <span className="label">
          {msg.label}
          {msg.prompt ? <small> · “{msg.prompt.length > 40 ? `${msg.prompt.slice(0, 40)}…` : msg.prompt}”</small> : null}
        </span>
        {streaming && <span className="spin-mini" />}
      </div>
      {msg.status === "error" ? (
        <div className="text">{msg.error}</div>
      ) : msg.kind === "key-points" && msg.points && msg.points.length > 0 ? (
        <ul className="points">
          {msg.points.map((p, i) => (
            <li key={i}>
              {p.text}
              {p.sections.map((s) => (
                <button key={s} className="cite" title={headings[s] ? tx("Jump to “{v}”", { v: headings[s] }) : tx("Jump to section")} onClick={() => jumpToSection(s)}>
                  §{s + 1}
                </button>
              ))}
            </li>
          ))}
        </ul>
      ) : msg.text ? (
        <div className="text">{msg.text}</div>
      ) : streaming ? (
        <div className="text muted">
          <span className="dots" />
        </div>
      ) : null}
      {msg.usage && (
        <div className="usage">
          {msg.usage.cached ? "cached" : tx("{inputTokens} tokens", { inputTokens: msg.usage.inputTokens + msg.usage.outputTokens })} · {(msg.usage.ms / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  );
}

interface AloudControls {
  playing: boolean;
  active: boolean;
  rate: number;
  toggle: () => void;
  stop: () => void;
  setRate: (rate: number) => void;
}

/** Web Speech read-aloud: speaks the article sentence by sentence and highlights the current one. */
function useReadAloud(): AloudControls {
  const [playing, setPlaying] = useState(false);
  const [active, setActive] = useState(false);
  const [rate, setRateState] = useState(1);
  const spans = useRef<HTMLElement[]>([]);
  const restore = useRef<(() => void) | null>(null);
  const index = useRef(0);
  const rateRef = useRef(1);

  const clearHighlight = (): void => {
    for (const s of spans.current) s.classList.remove("active");
  };

  const stop = useCallback(() => {
    window.speechSynthesis?.cancel();
    clearHighlight();
    restore.current?.();
    restore.current = null;
    spans.current = [];
    index.current = 0;
    setPlaying(false);
    setActive(false);
  }, []);

  useEffect(() => stop, [stop]);

  const prepare = (): boolean => {
    const content = document.querySelector(".reader-content");
    if (!content) return false;
    const blocks = content.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, figcaption");
    const built: HTMLElement[] = [];
    const originals: Array<[HTMLElement, string]> = [];
    blocks.forEach((block) => {
      const text = block.textContent?.trim() ?? "";
      if (!text) return;
      const sentences = splitSentences(text);
      if (sentences.length === 0) return;
      originals.push([block, block.innerHTML]);
      block.textContent = "";
      sentences.forEach((sentence, i) => {
        const span = document.createElement("span");
        span.className = "tts-s";
        span.textContent = (i > 0 ? " " : "") + sentence;
        block.appendChild(span);
        built.push(span);
      });
    });
    if (built.length === 0) return false;
    spans.current = built;
    restore.current = () => originals.forEach(([b, html]) => (b.innerHTML = html));
    return true;
  };

  const speakFrom = useCallback((i: number) => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (i >= spans.current.length) {
      clearHighlight();
      restore.current?.();
      restore.current = null;
      spans.current = [];
      setPlaying(false);
      setActive(false);
      return;
    }
    index.current = i;
    clearHighlight();
    const span = spans.current[i]!;
    span.classList.add("active");
    span.scrollIntoView({ behavior: "smooth", block: "center" });
    const utter = new SpeechSynthesisUtterance(span.textContent ?? "");
    utter.rate = rateRef.current;
    utter.onend = () => {
      if (window.speechSynthesis && !window.speechSynthesis.paused) speakFrom(i + 1);
    };
    synth.speak(utter);
  }, []);

  const toggle = useCallback(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (playing) {
      synth.pause();
      setPlaying(false);
      return;
    }
    if (active && synth.paused) {
      synth.resume();
      setPlaying(true);
      return;
    }
    if (!prepare()) return;
    setActive(true);
    setPlaying(true);
    speakFrom(0);
  }, [playing, active, speakFrom]);

  const setRate = useCallback(
    (r: number) => {
      rateRef.current = r;
      setRateState(r);
      if (playing && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        speakFrom(index.current);
      }
    },
    [playing, speakFrom],
  );

  return { playing, active, rate, toggle, stop, setRate };
}
