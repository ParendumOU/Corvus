import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  PDF_AI_TOOLS,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  buildPdfMarkdown,
  pdfSrcFromViewer,
  pdfTitleFromSource,
  type PdfAiKind,
  type PdfAiResult,
  type PdfDocMeta,
  type PdfPageText,
} from "../../shared/pdf-ipc";
import { splitSentences } from "../../shared/reading";
import { errorMessage, internalApi } from "../common/api";
import {
  IconBook,
  IconClose,
  IconDownload,
  IconMinus,
  IconPlus,
  IconSearch,
  IconSparkle,
  IconVolume,
  IconWarning,
} from "../common/icons";
import "../common/theme.css";
import "./pdf.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_STEP = 0.2;

interface BaseSize {
  w: number;
  h: number;
}

// --------------------------------------------------------------------- page

function PageView({
  doc,
  pageNumber,
  scale,
  defaultSize,
  query,
  activePage,
  registerEl,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  defaultSize: BaseSize | null;
  query: string;
  activePage: number;
  registerEl: (page: number, el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(pageNumber === 1);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root: null, rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    let textLayer: { cancel: () => void } | null = null;
    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      const textDiv = textRef.current;
      if (!wrap || !canvas || !textDiv) return;
      wrap.style.width = `${Math.floor(viewport.width)}px`;
      wrap.style.height = `${Math.floor(viewport.height)}px`;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const task = page.render({ canvas, canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      renderTask = task;
      try {
        await task.promise;
      } catch {
        return; // cancelled
      }
      if (cancelled) return;
      textDiv.textContent = "";
      textDiv.style.setProperty("--scale-factor", String(scale));
      const textContent = await page.getTextContent();
      if (cancelled) return;
      const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textDiv, viewport });
      textLayer = tl;
      await tl.render();
      if (cancelled) return;
      setRenderTick((t) => t + 1);
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, pageNumber, scale, visible]);

  // Re-apply search highlight without re-rendering the page.
  useEffect(() => {
    const textDiv = textRef.current;
    if (!textDiv) return;
    const q = query.trim().toLowerCase();
    const spans = textDiv.querySelectorAll("span");
    let first: Element | null = null;
    spans.forEach((span) => {
      span.classList.remove("hl", "hl-active");
      if (q && (span.textContent ?? "").toLowerCase().includes(q)) {
        span.classList.add("hl");
        if (!first) first = span;
      }
    });
    if (first && pageNumber === activePage) {
      (first as Element).classList.add("hl-active");
      (first as Element).scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [query, activePage, pageNumber, renderTick]);

  const placeholderHeight = defaultSize ? Math.floor(defaultSize.h * scale) : 600;
  return (
    <div
      className="pdf-page"
      ref={(el) => {
        wrapRef.current = el;
        registerEl(pageNumber, el);
      }}
      style={visible ? undefined : { width: defaultSize ? Math.floor(defaultSize.w * scale) : "70%", height: placeholderHeight }}
    >
      {visible ? (
        <>
          <canvas ref={canvasRef} />
          <div className="pdf-text-layer" ref={textRef} />
        </>
      ) : (
        <div className="pdf-placeholder" style={{ height: placeholderHeight }}>
          Page {pageNumber}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- AI output

function CitedText({ text, pageCount, onJump }: { text: string; pageCount: number; onJump: (page: number) => void }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[(\d+)\]$/.exec(part);
        if (m) {
          const page = Number(m[1]);
          if (page >= 1 && page <= pageCount) {
            return (
              <span key={i} className="pdf-cite" onClick={() => onJump(page)}>
                p.{page}
              </span>
            );
          }
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

interface AiMessage {
  id: string;
  kind: PdfAiKind;
  label: string;
  input: string;
  status: "loading" | "done" | "error";
  text: string;
  points?: PdfAiResult["points"];
  error?: string;
}

// -------------------------------------------------------------------- viewer

function PdfApp() {
  const api = internalApi();
  const src = pdfSrcFromViewer(window.location.href);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [meta, setMeta] = useState<PdfDocMeta>({ src: src ?? "", title: src ? pdfTitleFromSource(src) : "PDF", pageCount: 0 });
  const [baseSize, setBaseSize] = useState<BaseSize | null>(null);
  const [scale, setScale] = useState(1.1);
  const [currentPage, setCurrentPage] = useState(1);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchPages, setMatchPages] = useState<number[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);

  const [aiOpen, setAiOpen] = useState(false);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [saved, setSaved] = useState(false);
  const [askInput, setAskInput] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageEls = useRef<Array<HTMLDivElement | null>>([]);
  const pagesText = useRef<PdfPageText[]>([]);
  const textReady = useRef(false);
  const currentPageRef = useRef(1);
  currentPageRef.current = currentPage;

  const registerEl = useCallback((page: number, el: HTMLDivElement | null) => {
    pageEls.current[page - 1] = el;
  }, []);

  useEffect(() => {
    if (!src) {
      setStatus("error");
      setError("No PDF to display.");
      return;
    }
    let disposed = false;
    let loadedTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    void (async () => {
      try {
        const fetched = await api.call("pdf.fetch", src);
        if (disposed) return;
        const task = pdfjsLib.getDocument({ data: fetched.data });
        loadedTask = task;
        const pdf = await task.promise;
        if (disposed) {
          void task.destroy();
          return;
        }
        let title = pdfTitleFromSource(src);
        try {
          const info = (await pdf.getMetadata()).info as { Title?: unknown };
          if (typeof info.Title === "string" && info.Title.trim()) title = info.Title.trim();
        } catch {
          // metadata is optional
        }
        const firstViewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (disposed) return;
        setBaseSize({ w: firstViewport.width, h: firstViewport.height });
        setMeta({ src, title, pageCount: pdf.numPages });
        setDoc(pdf);
        setStatus("ready");
        void api.call("pdf.isSaved", src).then((v) => !disposed && setSaved(v === true));
      } catch (err) {
        if (!disposed) {
          setStatus("error");
          setError(errorMessage(err));
        }
      }
    })();
    return () => {
      disposed = true;
      window.speechSynthesis.cancel();
      if (loadedTask) void loadedTask.destroy();
    };
  }, [src, api]);

  // Track the top-most visible page for the page indicator.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !doc) return;
    let raf = 0;
    const onScroll = (): void => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const top = scroll.getBoundingClientRect().top + 120;
        let page = 1;
        for (let i = 0; i < pageEls.current.length; i++) {
          const el = pageEls.current[i];
          if (el && el.getBoundingClientRect().top <= top) page = i + 1;
        }
        setCurrentPage(page);
      });
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, [doc]);

  const jumpToPage = useCallback((page: number) => {
    const total = pageEls.current.length;
    const target = Math.max(1, Math.min(total || 1, Math.round(page)));
    const el = pageEls.current[target - 1];
    const scroll = scrollRef.current;
    if (el && scroll) scroll.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
    setCurrentPage(target);
  }, []);

  const ensureText = useCallback(async (): Promise<PdfPageText[]> => {
    if (textReady.current || !doc) return pagesText.current;
    const out: PdfPageText[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/[ \t ]+/g, " ")
        .trim();
      out.push({ page: i, text });
    }
    pagesText.current = out;
    textReady.current = true;
    return out;
  }, [doc]);

  const runFind = useCallback(
    (value: string) => {
      setQuery(value);
      const q = value.trim().toLowerCase();
      if (!q) {
        setMatchPages([]);
        setMatchIndex(0);
        return;
      }
      void ensureText().then((pages) => {
        const hits = pages.filter((p) => p.text.toLowerCase().includes(q)).map((p) => p.page);
        setMatchPages(hits);
        setMatchIndex(0);
        if (hits.length > 0) jumpToPage(hits[0]!);
      });
    },
    [ensureText, jumpToPage],
  );

  const stepFind = useCallback(
    (dir: number) => {
      if (matchPages.length === 0) return;
      const next = (matchIndex + dir + matchPages.length) % matchPages.length;
      setMatchIndex(next);
      jumpToPage(matchPages[next]!);
    },
    [matchPages, matchIndex, jumpToPage],
  );

  const runAi = useCallback(
    (kind: PdfAiKind, input = "") => {
      const label = kind === "ask" ? "Ask" : kind === "explain" ? "Explain" : PDF_AI_TOOLS.find((t) => t.kind === kind)?.label ?? kind;
      const id = window.crypto.randomUUID();
      const message: AiMessage = { id, kind, label, input, status: "loading", text: "" };
      setAiOpen(true);
      setMessages((prev) => [...prev, message].slice(-30));
      const patch = (p: Partial<AiMessage>): void => setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...p } : m)));
      void (async () => {
        try {
          const pages = await ensureText();
          const res = await api.call("pdf.ai", { kind, doc: meta, pages, ...(input ? { input } : {}) });
          patch({ status: "done", text: res.text, points: res.points });
        } catch (err) {
          patch({ status: "error", error: errorMessage(err) });
        }
      })();
    },
    [api, ensureText, meta],
  );

  const save = useCallback(() => {
    void (async () => {
      const pages = await ensureText();
      const keyPoints =
        [...messages]
          .reverse()
          .find((m) => m.kind === "key-points" && m.status === "done" && m.points && m.points.length > 0)
          ?.points?.map((p) => p.text) ?? [];
      try {
        await api.call("pdf.save", { doc: meta, pages, keyPoints });
        setSaved(true);
      } catch {
        // surfaced by the disabled state staying off
      }
    })();
  }, [api, ensureText, messages, meta]);

  const toggleListen = useCallback(() => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    void ensureText().then((pages) => {
      const from = currentPageRef.current;
      const text = pages
        .filter((p) => p.page >= from)
        .map((p) => p.text)
        .join("\n")
        .slice(0, 40000);
      const sentences = splitSentences(text).slice(0, 400);
      if (sentences.length === 0) return;
      window.speechSynthesis.cancel();
      const utterances = sentences.map((s) => new SpeechSynthesisUtterance(s));
      utterances[utterances.length - 1]!.onend = () => setSpeaking(false);
      for (const u of utterances) window.speechSynthesis.speak(u);
      setSpeaking(true);
    });
  }, [speaking, ensureText]);

  // Selection -> floating ask-AI toolbar.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onUp = (): void => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      if (!text || text.length < 2 || !selection) {
        setSel(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSel(null);
        return;
      }
      setSel({ text: text.slice(0, 4000), x: rect.left + rect.width / 2, y: rect.top });
    };
    scroll.addEventListener("mouseup", onUp);
    return () => scroll.removeEventListener("mouseup", onUp);
  }, [doc]);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement)?.closest?.(".pdf-sel-pop")) setSel(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  if (status === "error") {
    return (
      <div className="pdf-app">
        <div className="pdf-state">
          <IconWarning size={28} />
          <div>{error}</div>
          {src && (
            <a className="pdf-btn" href={src}>
              Open the source URL
            </a>
          )}
        </div>
      </div>
    );
  }

  const pages = doc ? Array.from({ length: doc.numPages }, (_v, i) => i + 1) : [];

  return (
    <div className="pdf-app">
      <div className="pdf-toolbar">
        <IconBook size={18} />
        <span className="pdf-title" title={meta.src}>
          {meta.title}
        </span>
        <span className="spacer" />
        <button className="pdf-btn" disabled={currentPage <= 1} title="Previous page" onClick={() => jumpToPage(currentPage - 1)}>
          ‹
        </button>
        <input
          className="pdf-page-input"
          value={currentPage}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^\d]/g, ""));
            if (Number.isFinite(n)) setCurrentPage(n);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") jumpToPage(currentPage);
          }}
        />
        <span className="pdf-muted">/ {meta.pageCount}</span>
        <button className="pdf-btn" disabled={currentPage >= meta.pageCount} title="Next page" onClick={() => jumpToPage(currentPage + 1)}>
          ›
        </button>
        <span className="spacer" />
        <button className="pdf-btn" title="Zoom out" disabled={scale <= PDF_ZOOM_MIN} onClick={() => setScale((s) => Math.max(PDF_ZOOM_MIN, Math.round((s - ZOOM_STEP) * 100) / 100))}>
          <IconMinus size={15} />
        </button>
        <button className="pdf-btn" title="Reset zoom" onClick={() => setScale(1.1)}>
          {Math.round(scale * 100)}%
        </button>
        <button className="pdf-btn" title="Zoom in" disabled={scale >= PDF_ZOOM_MAX} onClick={() => setScale((s) => Math.min(PDF_ZOOM_MAX, Math.round((s + ZOOM_STEP) * 100) / 100))}>
          <IconPlus size={15} />
        </button>
        <span className="spacer" />
        <button className={`pdf-btn ${findOpen ? "active" : ""}`} title="Find in PDF" onClick={() => setFindOpen((v) => !v)}>
          <IconSearch size={15} />
        </button>
        <button className={`pdf-btn ${speaking ? "active" : ""}`} title="Read aloud" onClick={toggleListen}>
          <IconVolume size={15} />
        </button>
        <button className="pdf-btn" disabled={saved} title="Save to reading list" onClick={save}>
          <IconDownload size={15} /> {saved ? "Saved" : "Save"}
        </button>
        <button className={`pdf-btn ${aiOpen ? "active" : ""}`} title="AI reading tools" onClick={() => setAiOpen((v) => !v)}>
          <IconSparkle size={15} /> AI
        </button>
      </div>

      {findOpen && (
        <div className="pdf-find">
          <IconSearch size={14} />
          <input
            autoFocus
            placeholder="Find in document"
            value={query}
            onChange={(e) => runFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") stepFind(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") setFindOpen(false);
            }}
          />
          <span className="count">{query.trim() ? `${matchPages.length === 0 ? 0 : matchIndex + 1} / ${matchPages.length} pages` : ""}</span>
          <button className="pdf-btn" disabled={matchPages.length === 0} onClick={() => stepFind(-1)}>
            ‹
          </button>
          <button className="pdf-btn" disabled={matchPages.length === 0} onClick={() => stepFind(1)}>
            ›
          </button>
          <button className="pdf-btn" onClick={() => setFindOpen(false)}>
            <IconClose size={14} />
          </button>
        </div>
      )}

      <div className="pdf-body">
        <div className="pdf-scroll" ref={scrollRef}>
          {status === "loading" && <div className="pdf-state">Loading PDF…</div>}
          {doc &&
            pages.map((n) => (
              <PageView
                key={n}
                doc={doc}
                pageNumber={n}
                scale={scale}
                defaultSize={baseSize}
                query={query}
                activePage={matchPages[matchIndex] ?? -1}
                registerEl={registerEl}
              />
            ))}
        </div>

        {aiOpen && (
          <div className="pdf-ai">
            <div className="pdf-ai-head">
              {PDF_AI_TOOLS.map((t) => (
                <button key={t.kind} className="pdf-btn" onClick={() => runAi(t.kind)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="pdf-ai-msgs">
              {messages.length === 0 && <div className="pdf-muted">Pick a tool above, ask a question, or select text in the PDF to ask about it. Citations point to the page they came from.</div>}
              {messages.map((m) => (
                <div key={m.id} className="pdf-msg">
                  <div className="pdf-msg-head">
                    <span>{m.label}</span>
                    {m.input && <span className="pdf-muted" style={{ fontWeight: 400 }}>“{m.input.slice(0, 60)}”</span>}
                    <span className="spacer" />
                    {m.status === "loading" && <span className="pdf-muted">…</span>}
                  </div>
                  {m.status === "error" ? (
                    <div className="pdf-msg-error">{m.error}</div>
                  ) : m.kind === "key-points" && m.points ? (
                    <ul>
                      {m.points.map((p, i) => (
                        <li key={i}>
                          {p.text}
                          {p.pages.map((pg) => (
                            <span key={pg} className="pdf-cite" onClick={() => jumpToPage(pg)}>
                              p.{pg}
                            </span>
                          ))}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="pdf-msg-body">
                      <CitedText text={m.text} pageCount={meta.pageCount} onJump={jumpToPage} />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="pdf-ask">
              <input
                placeholder="Ask about this PDF…"
                value={askInput}
                onChange={(e) => setAskInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && askInput.trim()) {
                    runAi("ask", askInput.trim());
                    setAskInput("");
                  }
                }}
              />
              <button
                className="pdf-btn primary"
                disabled={!askInput.trim()}
                onClick={() => {
                  runAi("ask", askInput.trim());
                  setAskInput("");
                }}
              >
                Ask
              </button>
            </div>
          </div>
        )}
      </div>

      {sel && (
        <div className="pdf-sel-pop" style={{ left: Math.max(8, sel.x - 70), top: Math.max(8, sel.y - 44) }}>
          <button
            className="pdf-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              runAi("explain", sel.text);
              setSel(null);
            }}
          >
            <IconSparkle size={13} /> Explain
          </button>
          <button
            className="pdf-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              runAi("ask", sel.text);
              setSel(null);
            }}
          >
            Ask about this
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<PdfApp />);
