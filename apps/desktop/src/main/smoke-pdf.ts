import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AnswerProvider, ProviderEvent } from "@corvus/ai-engine";
import { pdfViewerUrl } from "../shared/pdf-ipc";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Smoke for the in-app PDF viewer (corvus://pdf): serves a generated two-page PDF, opens it in the
 * viewer, checks it renders (canvas + selectable text + page count), then drives the reused AI
 * reading tools with a fake provider and checks a Key-points result with PAGE citations, plus
 * save-to-reading-list.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pdfFakeProvider(): AnswerProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *answer(req): AsyncGenerator<ProviderEvent> {
      const system = req.prompt.system;
      const reply = /key points/i.test(system)
        ? "- Ravens are clever birds [1]\n- The smoke PDF has two pages [2]"
        : /Answer the user's question/i.test(system)
          ? "The document is about ravens [1]."
          : "The document is about ravens.";
      yield { type: "delta", text: reply };
      yield { type: "usage", inputTokens: 30, outputTokens: 14, model: "claude-haiku-5-5" };
    },
  };
}

function escapePdf(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** Minimal, valid multi-page PDF with a correct xref table so pdfjs parses it without recovery. */
function makeSmokePdf(pageLines: string[][]): Buffer {
  const objects: string[] = [];
  objects[1] = "<</Type/Catalog/Pages 2 0 R>>";
  const pageNums = pageLines.map((_l, i) => 4 + i * 2);
  objects[2] = `<</Type/Pages/Kids[${pageNums.map((n) => `${n} 0 R`).join(" ")}]/Count ${pageLines.length}>>`;
  objects[3] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  pageLines.forEach((lines, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    const content = `BT /F1 16 Tf 40 250 Td 18 TL ${lines.map((l) => `(${escapePdf(l)}) Tj T*`).join(" ")} ET`;
    objects[pageNum] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Contents ${contentNum} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`;
    objects[contentNum] = `<</Length ${Buffer.byteLength(content, "latin1")}>>\nstream\n${content}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  const maxObj = objects.length - 1;
  for (let i = 1; i <= maxObj; i++) {
    const obj = objects[i];
    if (!obj) continue;
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${obj}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) {
    xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<</Size ${maxObj + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body + xref + trailer, "latin1");
}

async function poll(wc: WebContents, expr: string, timeoutMs = 10000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(150);
  }
  return false;
}

const clickByText = (selector: string, text: string): string =>
  `(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)})); if (b) { b.click(); return true; } return false; })()`;

export async function runPdfSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const pdf = makeSmokePdf([
    ["Hello from the smoke PDF.", "The common raven is a large passerine bird."],
    ["Second page about ravens.", "Ravens are clever and playful."],
  ]);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/pdf" });
    res.end(pdf);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const src = `http://127.0.0.1:${(server.address() as AddressInfo).port}/doc.pdf`;

  ctx.assist.setTestProvider(pdfFakeProvider());
  const before = win.profile.reading.list().length;

  try {
    // Navigating straight to a PDF (which would otherwise download) is intercepted into the viewer.
    const navTab = win.createTab(src, { activate: true });
    let redirected = false;
    for (let i = 0; i < 50 && !redirected; i++) {
      redirected = navTab.view.webContents.getURL().startsWith("corvus://pdf/");
      await sleep(150);
    }
    check("navigating to a PDF is intercepted into corvus://pdf", redirected, navTab.view.webContents.getURL());
    win.closeTab(navTab.id);

    const tab = win.createTab(pdfViewerUrl(src), { activate: true });
    const wc = tab.view.webContents;

    const rendered = await poll(wc, "document.querySelector('.pdf-page canvas') && document.querySelector('.pdf-text-layer span')");
    check("corvus://pdf renders the PDF (canvas + text layer)", rendered, rendered ? undefined : await wc.executeJavaScript("document.body.innerText.slice(0,200)").catch(() => "n/a"));

    const pageCount = await wc.executeJavaScript("document.querySelector('.pdf-muted')?.textContent ?? ''").catch(() => "");
    check("PDF page count shown", String(pageCount).includes("2"), pageCount);
    await capture("pdf", wc);

    // Open the AI panel and run the reused "Key points" reading tool.
    await wc.executeJavaScript(clickByText(".pdf-btn", "AI")).catch(() => false);
    await sleep(200);
    const toolClicked = await wc.executeJavaScript(clickByText(".pdf-ai-head .pdf-btn", "Key points")).catch(() => false);
    check("PDF AI panel exposes the reading tools", toolClicked === true);

    const gotPoints = await poll(wc, "document.querySelector('.pdf-msg ul li') && document.querySelector('.pdf-msg .pdf-cite')");
    check("PDF Key points returns points with PAGE citations", gotPoints, gotPoints ? undefined : await wc.executeJavaScript("document.querySelector('.pdf-msg')?.innerText?.slice(0,200)").catch(() => "n/a"));
    const citeText = await wc.executeJavaScript("document.querySelector('.pdf-msg .pdf-cite')?.textContent ?? ''").catch(() => "");
    check("PDF citation labels a page (p.N)", /^p\.\d+$/.test(String(citeText).trim()), citeText);
    await capture("pdf-ai", wc);

    // Save to the reading library (reused store).
    await wc.executeJavaScript(clickByText(".pdf-toolbar .pdf-btn", "Save")).catch(() => false);
    const saved = await poll(wc, "[...document.querySelectorAll('.pdf-toolbar .pdf-btn')].some((b) => b.textContent.includes('Saved'))", 4000);
    const inLibrary = win.profile.reading.list().some((it) => it.url === src);
    check("PDF saved to the reading library", saved && inLibrary && win.profile.reading.list().length === before + 1, { saved, inLibrary });

    win.closeTab(tab.id);
    const stored = win.profile.reading.list().find((it) => it.url === src);
    if (stored) win.profile.reading.remove(stored.id);
  } finally {
    ctx.assist.setTestProvider(undefined);
    server.close();
  }
}
