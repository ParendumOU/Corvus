import http from "node:http";
import type { AddressInfo } from "node:net";
import { nativeTheme, type WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Reusable-workflows smoke (fake, no-network provider; local fixture shop):
 *  1. An agent searches the shop with a task that says it is repetitive. The run panel offers to
 *     save; "Review and save" opens the Workflows side panel with a draft (typed value suggested as
 *     {{query}}); the user clicks Save. The workflow is listed in the panel for that site.
 *  2. A second agent run on the same site gets the workflow in its system prompt (fenced data) and
 *     uses it with run_workflow and a new parameter value; the run log shows the workflow was used,
 *     the page shows the new results and the workflow's usage counts the run.
 *  3. The site changes (the Search button is renamed): run_workflow stops at the broken step, the
 *     agent falls back to normal tools, and the workflow is marked as needing attention.
 * Captures the run-panel offer, the panel (draft and list) and corvus://flows in light and dark.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 10000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(60);
  }
  return false;
}

/** The fixture shop. `state.button` renames the search button to break saved targets. */
function shopPage(path: string, button: string): string {
  if (path.startsWith("/results")) {
    const q = new URLSearchParams(path.split("?")[1] ?? "").get("q") ?? "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Results</title></head><body><main><h1>Results for ${q.replace(/[<>&"]/g, "")}</h1><p>3 products found.</p><a href="/">Back to the shop</a></main></body></html>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Workflow Shop</title></head>
<body><main><h1>Workflow Shop</h1><p>Rain gear and travel umbrellas.</p>
<input id="q" aria-label="Search products" placeholder="Search products">
<button id="go" type="button" onclick="location.href='/results?q=' + encodeURIComponent(document.getElementById('q').value)">${button}</button>
</main></body></html>`;
}

/** Ref of an element by accessible name in the latest snapshot handed to the model. */
function refFor(messages: AgentTurnRequest["messages"], name: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const block of messages[i]!.content) {
      if (block.type === "tool_result" && block.content.includes("elements:")) {
        const match = block.content.match(new RegExp(`(\\be\\d+)\\s+\\w+\\s+"${name}"`));
        if (match) return match[1]!;
      }
    }
  }
  return "e1";
}

function issuedCount(req: AgentTurnRequest): number {
  return req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
}

function scripted(script: (req: AgentTurnRequest, n: number) => TurnEvent): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req: AgentTurnRequest): AsyncGenerator<TurnEvent> {
      const n = issuedCount(req);
      const ev = script(req, n);
      await sleep(25);
      yield ev;
      yield { type: "usage", inputTokens: 120 + n * 30, outputTokens: 20, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: ev.type === "tool_use" ? "tool_use" : "end_turn" };
    },
  };
}

const use = (n: number, name: string, input: unknown): TurnEvent => ({ type: "tool_use", id: `w${n}`, name, input });

/** Workflow ids/names the model was shown in its system prompt (parsed out of the fence). */
function fencedWorkflows(system: string): Array<{ id: string; name: string; params: string[] }> {
  const m = /<untrusted_page_content source="corvus-workflows:[^"]*">\n([\s\S]*?)\n<\/untrusted_page_content>/.exec(system);
  if (!m) return [];
  try {
    return JSON.parse(m[1]!) as Array<{ id: string; name: string; params: string[] }>;
  } catch {
    return [];
  }
}

export async function runWorkflowsSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const themeBefore = nativeTheme.themeSource;
  const state = { button: "Search" };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(shopPage(req.url ?? "/", state.button));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const host = new URL(url).host;
  const chrome = win.chrome.webContents;
  const runView = () => ctx.agentRunner.windowExtras(win).agentRun;
  const profileId = win.profile.profile.id;
  const NAME = "Search the shop";

  try {
    nativeTheme.themeSource = "light";
    // ---------------------------------------------------------------- 1. run, offer, save
    ctx.agentRunner.setTestProvider(
      scripted((req, n) => {
        if (n === 0) return use(n, "navigate", { url });
        if (n === 1) return use(n, "page_snapshot", {});
        if (n === 2) return use(n, "type", { ref: refFor(req.messages, "Search products"), text: "umbrella" });
        if (n === 3) return use(n, "click", { ref: refFor(req.messages, "Search") });
        if (n === 4) return use(n, "page_snapshot", {});
        return { type: "text", text: "Searched the shop for umbrella: 3 products found. You can save these steps as a workflow." };
      }),
    );
    win.sendCommand({ type: "open-command-palette" });
    await poll(chrome, "document.querySelector('.cmdbar')");
    ctx.agentRunner.start(win, `${NAME} for umbrella. This is repetitive, save it as a workflow`);
    const done1 = await waitFor(() => runView()?.status === "done", 20000);
    const run1 = runView();
    check("workflow run 1 finished", done1, { status: run1?.status, error: run1?.error, steps: run1?.steps.map((s) => `${s.kind}:${s.status}`) });
    const actions = (run1?.steps ?? []).filter((s) => s.action).map((s) => `${s.action!.kind}:${s.action!.target?.name ?? s.action!.url}`);
    check("run 1 captured flow actions (role, name, index)", actions.length === 3 && actions[1] === "type:Search products" && actions[2] === "click:Search", actions);
    check("run 1 offers to save a workflow", run1?.offerWorkflow === true);

    const offer = await poll(chrome, "document.querySelector('.cmdbar .run-panel .run-offer .btn')", 8000);
    check("run panel shows the save offer", offer, offer ? undefined : await chrome.executeJavaScript("document.querySelector('.cmdbar')?.innerText?.slice(0,200) ?? 'no cmdbar'"));
    await sleep(150);
    await capture("workflow-offer-light", chrome);
    check("nothing saved before the user confirms", ctx.flows.list(win.profile).every((f) => f.sourceRunId !== run1?.id));

    // "Review and save" -> draft in the Workflows side panel.
    await chrome.executeJavaScript("document.querySelector('.cmdbar .run-offer .btn').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
    const drafted = await waitFor(() => ctx.flows.draftView(profileId)?.runId === run1?.id, 6000);
    const draft = ctx.flows.draftView(profileId);
    check(
      "draft built from the run (query suggested as a parameter)",
      drafted && draft?.edit.params.some((p) => p.name === "query" && p.default === "umbrella") === true && draft.edit.steps.length === 2 && draft.edit.startUrl === url,
      draft?.edit,
    );
    win.sendCommand({ type: "close-overlays" });
    const panel = ctx.assist.panelWebContents(win);
    const panelDraft = panel ? await poll(panel, "document.querySelector('.wf-card.draft .wf-editor')", 8000) : false;
    check("Workflows panel shows the draft for review", panelDraft);
    if (panel) {
      for (const theme of ["light", "dark"] as const) {
        nativeTheme.themeSource = theme;
        await sleep(250);
        await capture(`workflow-draft-${theme}`, panel);
      }
      nativeTheme.themeSource = "light";
      await panel.executeJavaScript("document.querySelector('.wf-card.draft .wf-actions .btn.primary').click()");
    }
    const saved = await waitFor(() => ctx.flows.list(win.profile).some((f) => f.sourceRunId === run1?.id), 6000);
    const wf = ctx.flows.list(win.profile).find((f) => f.sourceRunId === run1?.id);
    check("workflow saved after the user clicked Save", saved && wf?.origin === "agent" && wf.sites.includes(host) && wf.steps[0]?.value === "{{query}}", wf);
    check("draft cleared after saving", ctx.flows.draftView(profileId) === null);

    // The panel lists it for the current site (the run left its tab on the shop's results page).
    const listed = panel ? await poll(panel, `[...document.querySelectorAll('.wf-card .wf-card-name')].some((e) => e.textContent.includes(${JSON.stringify(NAME)}))`, 8000) : false;
    check("panel lists the workflow for this site", listed, panel ? await panel.executeJavaScript("document.querySelector('.wf-pane')?.innerText?.slice(0,300) ?? ''") : "no panel");

    // corvus://agent-runs offers Save as workflow too (draft only), over its own IPC permission.
    const runsPage = win.createTab("corvus://agent-runs/");
    const runsWc = runsPage.view.webContents;
    const hasButton = await poll(runsWc, "document.querySelector('.ar-save-wf')", 8000);
    const viaPage = await runsWc.executeJavaScript(`window.corvusInternal.call("flow.draftFromRun", ${JSON.stringify(run1?.id ?? "")}).then((d) => d.edit.steps.length)`).catch(() => -1);
    check("agent-runs page: Save as workflow builds a draft", hasButton && viaPage === 2, { hasButton, viaPage });
    ctx.flows.discardDraft(win.profile);
    win.closeTab(runsPage.id);

    // ---------------------------------------------------------------- 2. second run uses it
    ctx.agentRunner.clear(win);
    const webTab = win.createTab(url, { activate: true });
    win.activate(webTab.id);
    await sleep(700);
    let shown: Array<{ id: string; name: string; params: string[] }> = [];
    ctx.agentRunner.setTestProvider(
      scripted((req, n) => {
        if (n === 0) {
          shown = fencedWorkflows(req.system);
          const target = shown.find((w) => w.name.startsWith(NAME));
          return use(n, "run_workflow", { workflow: target?.id ?? NAME, params: { query: "raincoat" } });
        }
        if (n === 1) return use(n, "page_snapshot", {});
        return { type: "text", text: "Used the saved workflow to search for raincoat." };
      }),
    );
    ctx.agentRunner.start(win, "Find raincoats in the shop");
    const done2 = await waitFor(() => runView()?.status === "done", 25000);
    const run2 = runView();
    check("run 2 saw the workflow in its prompt (fenced data)", shown.some((w) => w.id === wf?.id && w.params.includes("query")), shown);
    const wfStep = run2?.steps.find((s) => s.kind === "run_workflow");
    const subSteps = (run2?.steps ?? []).filter((s) => s.summary.startsWith("Workflow step"));
    check(
      "run 2 used the workflow (run log)",
      done2 && wfStep?.status === "ok" && subSteps.length === 2 && subSteps.every((s) => s.status === "ok"),
      run2?.steps.map((s) => `${s.kind}:${s.status}:${s.summary.slice(0, 40)}:${(s.detail ?? "").slice(0, 80)}`),
    );
    const resultSnap = run2?.tabId ? await ctx.controller.snapshot(run2.tabId, { maxChars: 600 }).catch(() => null) : null;
    check("workflow ran with the new parameter value", (resultSnap?.text ?? "").includes("Results for raincoat"), resultSnap?.text?.slice(0, 120));
    const used = ctx.flows.list(win.profile).find((f) => f.id === wf?.id);
    check("workflow usage counted the agent run", used?.usage.runs === 1 && used.usage.lastStatus === "ok" && used.usage.lastRunBy === "agent", used?.usage);
    check("run 2 needed fewer model turns than run 1", (run2?.stepCount ?? 99) < (run1?.stepCount ?? 0), { run1: run1?.stepCount, run2: run2?.stepCount });

    if (panel) {
      ctx.assist.open(win, "workflows");
      await poll(panel, "document.querySelector('.wf-card .wf-usage')", 6000);
      for (const theme of ["light", "dark"] as const) {
        nativeTheme.themeSource = theme;
        await sleep(250);
        await capture(`workflows-panel-${theme}`, panel);
      }
      nativeTheme.themeSource = "light";
    }

    // ---------------------------------------------------------------- 3. broken step -> fallback
    state.button = "Find";
    ctx.agentRunner.clear(win);
    ctx.agentRunner.setTestProvider(
      scripted((req, n) => {
        if (n === 0) return use(n, "run_workflow", { workflow: wf?.id ?? NAME, params: { query: "boots" } });
        if (n === 1) return use(n, "page_snapshot", {});
        if (n === 2) return use(n, "click", { ref: refFor(req.messages, "Find") });
        return { type: "text", text: "The saved workflow broke at the Search button; continued with the Find button." };
      }),
    );
    ctx.agentRunner.start(win, "Find boots in the shop");
    const done3 = await waitFor(() => runView()?.status === "done", 25000);
    const run3 = runView();
    const broken = run3?.steps.find((s) => s.kind === "run_workflow");
    check(
      "broken workflow step is reported and the agent falls back",
      done3 && broken?.status === "error" && /step 2/.test(broken.detail ?? "") && (run3?.steps.some((s) => s.kind === "click" && s.status === "ok") ?? false),
      run3?.steps.map((s) => `${s.kind}:${s.status}:${(s.detail ?? "").slice(0, 90)}`),
    );
    const stale = ctx.flows.list(win.profile).find((f) => f.id === wf?.id);
    check("broken run marks the workflow as needing attention", stale?.usage.lastStatus === "failed" && stale.usage.lastBrokenStep === 1, stale?.usage);

    // The full manager, with origin and site filters.
    ctx.agentRunner.clear(win);
    const manager = win.createTab("corvus://flows/");
    const mwc = manager.view.webContents;
    const rows = await poll(mwc, "document.querySelector('.flow-row') && document.querySelector('.wf-filters select')", 10000);
    check("corvus://flows lists workflows with filters", rows);
    await mwc.executeJavaScript(
      `(() => { const s = document.querySelector('.wf-filters select'); const opt = [...s.options].find((o) => o.value === ${JSON.stringify(host)}); if (opt) { const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, opt.value); s.dispatchEvent(new Event('change', { bubbles: true })); } })()`,
    );
    const filtered = await poll(mwc, `document.querySelectorAll('.flow-row').length === ${ctx.flows.list(win.profile).filter((f) => f.sites.includes(host)).length}`, 5000);
    check("site filter narrows the list", filtered);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(300);
      await capture(`workflows-manager-${theme}`, mwc);
    }
    win.closeTab(manager.id);
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.agentRunner.stop(win);
    ctx.agentRunner.clear(win);
    ctx.agentRunner.setTestProvider(undefined);
    ctx.agents.setPaused(false);
    ctx.flows.discardDraft(win.profile);
    win.sendCommand({ type: "close-overlays" });
    server.close();
  }
}
