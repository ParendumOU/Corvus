import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { clipboard, type WebContents } from "electron";
import type { AgentModelProvider, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { NativeApproval } from "./approval-dialog";
import { openMcpSession, type McpSession } from "./smoke-agent";
import type { BrowserWindowCtl } from "./window";

interface DownloadAiSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The password-protected two-part RAR5 the unit tests use too (out/main -> apps/desktop/test). */
/** Archives the unit tests use too (smoke.sh runs from apps/desktop). */
const ARCHIVES = path.resolve(process.cwd(), "test/fixtures/archives");
const PAYLOAD_SHA256 = "3649d9bfc363a45a7f5834cdbf4fcfb2729d0f05df0e67631eeb76d1ff397cb1";
const sha256 = (file: string): string => (fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "");

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await sleep(150);
  }
  return undefined;
}

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

/** A model that queues the given files on its first turn and then says it is done. Records the task. */
function queueingProvider(input: Record<string, unknown>, seen: string[]): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req): AsyncGenerator<TurnEvent> {
      const first = req.messages[0];
      if (first) seen.push(first.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
      const issued = req.messages.filter((m) => m.role === "assistant").length;
      await sleep(30);
      if (issued === 0) {
        yield { type: "tool_use", id: "q1", name: "queue_downloads", input };
        yield { type: "usage", inputTokens: 200, outputTokens: 30, model: "claude-haiku-5-5" };
        yield { type: "end", stopReason: "tool_use" };
        return;
      }
      yield { type: "text", text: "Queued the files." };
      yield { type: "usage", inputTokens: 240, outputTokens: 8, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: "end_turn" };
    },
  };
}

/**
 * "Download with AI": a grabbed package of file-host links handed to Corvus's agent, whose files
 * (a two-part RAR and a program) reach the queue only after the person approves the list, without
 * the program; the copied-links chip's AI button; and the download_queue MCP tools behind the
 * browser's approval dialog. Files come from a local server.
 */
export async function runDownloadAiSmoke(ctx: AppContext, h: DownloadAiSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const profile = win.profile;
  const server = http.createServer((req, res) => {
    const route = (req.url ?? "/").split("?")[0] ?? "/";
    const volume = /\/Secret\.part(\d)\.rar$/.exec(route)?.[1];
    if (route.startsWith("/dl/") && volume) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(fs.readFileSync(path.join(ARCHIVES, `Secret.part${volume}.rar`)));
      return;
    }
    if (route === "/dl/get") {
      // An address without a file name that turns out to be a program.
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="tool.exe"' });
      res.end("MZ not really a program");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runView = () => ctx.agentRunner.windowExtras(win).agentRun;
  const queued = (name: string) => ctx.queue.list(profile).packages.find((p) => p.name === name);
  const settingsBefore = ctx.settings.get().downloads;
  const mcpBefore = ctx.settings.get().mcp;
  const chrome = win.chrome.webContents;
  let session: McpSession | null = null;
  ctx.grabber.clear(profile);
  ctx.settings.update({ downloads: { extractArchives: true, deleteArchives: false, archivePasswords: [] } });

  try {
    // ------------------------------------------------------------------ grabber package -> agent
    ctx.grabber.addText(profile, "https://mega.nz/file/smokeAi#key https://rapidgator.net/file/abc/Secret.part1.rar.html Password: corvus-rar");
    const hosted = ctx.grabber.list(profile);
    const seen: string[] = [];
    ctx.agentRunner.setTestProvider(
      queueingProvider({ links: [`${base}/dl/a/Secret.part1.rar`, `${base}/dl/a/Secret.part2.rar`, `${base}/dl/a/setup.exe`], packageName: "AI pick", password: "corvus-rar" }, seen),
    );
    const started = hosted.length === 2 && ctx.grabber.downloadWithAi(win, hosted.map((p) => p.id));
    const asking = await waitFor(() => (runView()?.status === "awaiting-approval" ? runView() : undefined), 10_000);
    const askedInPanel = await poll(chrome, "(document.querySelector('.cmdbar .run-panel .run-approval')?.innerText || '').includes('AI pick')");
    await capture("download-ai-approval", chrome);
    check(
      "download with AI: the agent gets the package's file-host links and password, and its list waits for approval",
      started &&
        (seen[0] ?? "").includes("https://mega.nz/file/smokeAi#key\nhttps://rapidgator.net/file/abc/Secret.part1.rar.html") &&
        (seen[0] ?? "").includes("Archive password: corvus-rar") &&
        asking?.approval?.reason.startsWith('Downloads 3 files into "AI pick"') === true &&
        askedInPanel &&
        !queued("AI pick") &&
        ctx.grabber.list(profile).length === 0,
      { started, task: seen[0]?.slice(0, 300), approval: asking?.approval, askedInPanel },
    );
    ctx.agentRunner.approve(win, "approve");
    const pick = await waitFor(() => (queued("AI pick")?.extraction?.state === "done" ? queued("AI pick") : undefined), 30_000);
    const finished = await waitFor(() => (runView()?.status === "done" ? runView() : undefined), 10_000);
    check(
      "download with AI: once approved the files are queued as the agent's package, the program left out, and extracted",
      pick?.addedBy === "Corvus" &&
        pick.items.map((i) => i.filename).join() === "Secret.part1.rar,Secret.part2.rar" &&
        pick.extraction?.password === "corvus-rar" &&
        sha256(path.join(pick.dir, "payload.bin")) === PAYLOAD_SHA256 &&
        finished !== undefined,
      { pick: pick && { addedBy: pick.addedBy, items: pick.items.map((i) => `${i.filename} ${i.state}`), extraction: pick.extraction }, status: runView()?.status },
    );
    ctx.agentRunner.clear(win);

    // ------------------------------------------------------------------ copied links -> agent
    ctx.settings.update({ downloads: { watchClipboard: true } });
    clipboard.writeText("nothing yet");
    await ctx.grabber.pollClipboard();
    clipboard.writeText(`Both parts: ${base}/dl/c/Secret.part1.rar ${base}/dl/c/Secret.part2.rar`);
    await ctx.grabber.pollClipboard();
    const chip = await poll(chrome, "document.querySelector('.copied-links-ai') !== null");
    seen.length = 0;
    await chrome.executeJavaScript("document.querySelector('.copied-links-ai')?.click()");
    const chipRun = await waitFor(() => (runView()?.status === "awaiting-approval" ? runView() : undefined), 10_000);
    check(
      "download with AI: the copied-links chip hands the copied text to the agent",
      chip && chipRun !== undefined && (seen[0] ?? "").includes(`Copied text:\nBoth parts: ${base}/dl/c/Secret.part1.rar`) && ctx.grabber.copiedLinks() === 0,
      { chip, task: seen[0]?.slice(0, 300), status: runView()?.status },
    );
    ctx.agentRunner.stop(win);
    ctx.agentRunner.clear(win);
    ctx.settings.update({ downloads: { watchClipboard: false } });

    // ------------------------------------------------------------------ MCP download_queue tools
    const clientName = "corvus-smoke-queue";
    const prompts: NativeApproval[] = [];
    let allow = true;
    ctx.queue.setTestApprover((approval) => {
      prompts.push(approval);
      return allow;
    });
    ctx.settings.update({ mcp: { enabled: true, accessLevel: "full", approvedClients: [...mcpBefore.approvedClients.filter((c) => c !== clientName), clientName] } });
    await ctx.mcp.apply();
    const status = ctx.mcp.status();
    if (!status.running || !status.port || !status.token) {
      check("MCP download queue: server running", false, { running: status.running, error: status.error });
      return;
    }
    session = await openMcpSession(`http://127.0.0.1:${status.port}/mcp`, status.token, clientName);
    const tools = await session.tools();
    const added = await session.tool("download_queue_add", { links: [`${base}/dl/b/Secret.part1.rar`, `${base}/dl/b/Secret.part2.rar`], packageName: "MCP pick", password: "corvus-rar" });
    const mcpPick = await waitFor(() => (queued("MCP pick")?.extraction?.state === "done" ? queued("MCP pick") : undefined), 30_000);
    // An address without a file name that the server names as a program: it fails at once.
    const disguised = await session.tool("download_queue_add", { links: [`${base}/dl/get`], packageName: "MCP program" });
    const failed = await waitFor(() => queued("MCP program")?.items.find((i) => i.state === "failed"), 15_000);
    const listed = await session.tool("download_queue", {});
    check(
      "MCP download queue: download_queue_add asks the user, queues the files under the client's name, and a server-named program fails",
      ["download_queue", "download_queue_add", "download_queue_control"].every((t) => tools.includes(t)) &&
        !added.isError &&
        !disguised.isError &&
        prompts.length === 2 &&
        prompts[0]!.message === `Let “${clientName}” download 2 files into “MCP pick” with Corvus's download queue?` &&
        mcpPick?.addedBy === clientName &&
        sha256(path.join(mcpPick.dir, "payload.bin")) === PAYLOAD_SHA256 &&
        /tool\.exe is a program/.test(failed?.error ?? "") &&
        failed?.attempts === 1 &&
        listed.text.includes('"name":"MCP pick"'),
      { added, disguised, prompts: prompts.map((p) => p.message), extraction: mcpPick?.extraction, failed, listed: listed.text.slice(0, 300) },
    );

    allow = false;
    const denied = await session.tool("download_queue_add", { links: [`${base}/dl/d/Secret.part1.rar`] });
    const program = await session.tool("download_queue_add", { links: [`${base}/dl/setup.exe`] });
    const removed = mcpPick ? await session.tool("download_queue_control", { id: mcpPick.id, op: "remove" }) : null;
    check(
      "MCP download queue: a declined dialog and a program are refused, and control removes a package",
      denied.isError &&
        denied.text.includes("The user declined") &&
        program.isError &&
        program.text.includes("does not download programs") &&
        prompts.length === 3 &&
        removed?.isError === false &&
        !queued("MCP pick"),
      { denied, program, removed, prompts: prompts.length },
    );
  } finally {
    ctx.agentRunner.stop(win);
    ctx.agentRunner.clear(win);
    ctx.agentRunner.setTestProvider(undefined);
    ctx.queue.setTestApprover(null);
    await session?.close();
    ctx.settings.update({
      downloads: { watchClipboard: false, extractArchives: settingsBefore.extractArchives, deleteArchives: settingsBefore.deleteArchives, archivePasswords: settingsBefore.archivePasswords },
      mcp: { enabled: mcpBefore.enabled, accessLevel: mcpBefore.accessLevel, approvedClients: mcpBefore.approvedClients },
    });
    await ctx.mcp.apply();
    for (const p of ctx.queue.list(profile).packages) ctx.queue.act(profile, p.id, "remove");
    ctx.grabber.clear(profile);
    win.sendCommand({ type: "close-overlays" });
    server.close();
  }
}
