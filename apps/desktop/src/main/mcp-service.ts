import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialog } from "electron";
import type { AccessLevel, McpClientInfo, McpServerHandle } from "@corvus/shared";
import type { FlowRunner, StartMcpServerOptions } from "@corvus/mcp-server";
import type { McpActivity, McpStatus } from "../shared/ipc";
import { mcpAddCommand, resolveMcpAccessLevel } from "../shared/settings";
import type { AppContext } from "./context";
import { loadOptionalModule } from "./module-loader";

const MAX_ACTIVITY = 100;

/**
 * Runs @corvus/mcp-server on 127.0.0.1 when enabled in settings. New clients must be approved
 * by the user; approvals can be remembered per client name. No-op if the package is missing.
 */
export class McpService {
  private handle: McpServerHandle | null = null;
  private available = true;
  private error: string | null = null;
  private activity: McpActivity[] = [];
  private pendingApprovals = new Map<string, Promise<boolean>>();
  private applying: Promise<void> = Promise.resolve();
  private runningConfig = "";

  constructor(private readonly ctx: AppContext) {
    ctx.settings.onChange((next, prev) => {
      if (next === prev || JSON.stringify(next.mcp) !== JSON.stringify(prev.mcp)) this.apply();
    });
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  private desiredConfig(): string {
    const { host, port } = this.ctx.settings.get().mcp;
    return JSON.stringify({ host, port, accessLevel: this.accessLevel(), token: this.ctx.settings.mcpToken() });
  }

  private accessLevel(): AccessLevel {
    return resolveMcpAccessLevel(this.ctx.settings.get().mcp);
  }

  /** Reconcile the running server with settings. Calls are serialized. */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.reconcile()).catch((err: unknown) => {
      this.error = (err as Error).message;
      console.error("[corvus] MCP server:", err);
    });
    return this.applying;
  }

  private async reconcile(): Promise<void> {
    const { enabled } = this.ctx.settings.get().mcp;
    if (!enabled) {
      await this.stop();
      return;
    }
    const desired = this.desiredConfig();
    if (this.handle && desired === this.runningConfig) return;
    await this.stop();
    await this.start();
  }

  private async start(): Promise<void> {
    const mod = await loadOptionalModule<{ startMcpServer?: (opts: StartMcpServerOptions) => Promise<McpServerHandle> }>("@corvus/mcp-server", "mcp-server");
    if (!mod?.startMcpServer) {
      this.available = false;
      this.error = "The MCP server package (@corvus/mcp-server) is not installed or not built.";
      return;
    }
    this.available = true;
    const { host, port } = this.ctx.settings.get().mcp;
    const accessLevel = this.accessLevel();
    const token = this.ctx.settings.mcpToken();
    this.handle = await mod.startMcpServer({
      controller: this.ctx.controller,
      search: this.ctx.search.proxy,
      host,
      port: port || 0,
      token,
      accessLevel,
      webscope: () => this.ctx.webscope.activeEngine(),
      flows: () => this.flowRunner(),
      onClientConnect: (info) => this.approve(info),
      onToolCall: (event) => {
        this.record(event.client, event.tool, event.at);
        this.ctx.agents.toolCall(event);
      },
      onToolResult: (event) => this.ctx.agents.toolResult(event),
    });
    this.error = null;
    if (port === 0) {
      // Persist the random port so the `claude mcp add` command keeps working across restarts.
      this.runningConfig = JSON.stringify({ host, port: this.handle.port, accessLevel, token });
      this.ctx.settings.update({ mcp: { port: this.handle.port } });
    } else {
      this.runningConfig = JSON.stringify({ host, port, accessLevel, token });
    }
    // The local stdio bridge always connects over loopback, even when the server also listens on all interfaces.
    this.writeDiscovery(`http://127.0.0.1:${this.handle.port}/mcp`, token);
    this.ctx.windows.broadcastState();
  }

  async stop(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    this.runningConfig = "";
    this.removeDiscovery();
    if (handle) {
      await handle.close();
      this.ctx.windows.broadcastState();
    }
  }

  /** Path the stdio bridge / Claude Code plugin reads to find the running server. */
  private discoveryPath(): string {
    return path.join(process.env.CORVUS_HOME || path.join(os.homedir(), ".corvus"), "mcp.json");
  }

  /** Writes {url, token, pid} with owner-only permissions so the local plugin can auto-connect. */
  private writeDiscovery(url: string, token: string): void {
    try {
      const file = this.discoveryPath();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ url, token, pid: process.pid }), { mode: 0o600 });
    } catch {
      // Discovery is a convenience; a failure just means clients fall back to env vars.
    }
  }

  private removeDiscovery(): void {
    try {
      fs.rmSync(this.discoveryPath(), { force: true });
    } catch {
      // ignore
    }
  }

  regenerateToken(): void {
    this.ctx.settings.regenerateMcpToken();
  }

  /**
   * Exposes the focused profile's recorded flows to the MCP run_flow tool. `run` starts a replay
   * through FlowService, which keeps its own risky-step approval gate — this never bypasses it.
   */
  private flowRunner(): FlowRunner | null {
    const window = this.ctx.windows.focused() ?? this.ctx.windows.all()[0];
    if (!window) return null;
    const runtime = window.profile;
    return {
      list: () => this.ctx.flows.list(runtime).map((f) => ({ id: f.id, name: f.name, startUrl: f.startUrl, steps: f.steps.length })),
      run: (nameOrId) => {
        const match = nameOrId.toLowerCase();
        const flow = this.ctx.flows.list(runtime).find((f) => f.id === nameOrId || f.name.toLowerCase() === match);
        if (!flow) throw new Error(`No saved flow matches "${nameOrId}".`);
        const view = this.ctx.flows.replay(runtime, flow.id).find((f) => f.id === flow.id);
        if (!view?.replay) throw new Error("Another recorded flow is already replaying; stop it before starting a new one.");
        return { id: flow.id, name: flow.name, steps: flow.steps.length, status: view.replay.status };
      },
    };
  }

  private record(client: string, tool: string, at: number): void {
    this.activity = [{ client, tool, at }, ...this.activity].slice(0, MAX_ACTIVITY);
  }

  recentActivity(): McpActivity[] {
    return this.activity;
  }

  private approve(info: McpClientInfo): Promise<boolean> {
    if (this.ctx.settings.get().mcp.approvedClients.includes(info.name)) {
      this.ctx.agents.clientConnected(info.name, true);
      return Promise.resolve(true);
    }
    const pending = this.pendingApprovals.get(info.name);
    if (pending) return pending;
    const prompt = this.prompt(info).finally(() => this.pendingApprovals.delete(info.name));
    this.pendingApprovals.set(info.name, prompt);
    return prompt;
  }

  private async prompt(info: McpClientInfo): Promise<boolean> {
    const parent = this.ctx.windows.focused()?.win;
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Allow", "Deny"],
      defaultId: 1,
      cancelId: 1,
      title: "AI agent wants to control Corvus",
      message: `Allow “${info.name}” to control this browser?`,
      detail:
        `An MCP client (${info.name}${info.version ? ` ${info.version}` : ""}) connected from ${info.remoteAddress}.\n\n` +
        "It will be able to open and close tabs, read page content, click, type and take screenshots. " +
        "Tabs it drives are marked with an AI badge.",
      checkboxLabel: "Always allow this client",
      checkboxChecked: true,
    };
    const { response, checkboxChecked } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    const allowed = response === 0;
    if (allowed && checkboxChecked) {
      const approved = this.ctx.settings.get().mcp.approvedClients;
      if (!approved.includes(info.name)) this.ctx.settings.update({ mcp: { approvedClients: [...approved, info.name] } });
    }
    this.record(info.name, allowed ? "connected" : "rejected", Date.now());
    this.ctx.agents.clientConnected(info.name, allowed);
    return allowed;
  }

  /** Forget a client's approval (also the remembered one) and drop its sessions. */
  revokeClient(name: string): void {
    const approved = this.ctx.settings.get().mcp.approvedClients;
    if (approved.includes(name)) this.ctx.settings.update({ mcp: { approvedClients: approved.filter((c) => c !== name) } });
    this.handle?.revokeClient?.(name);
    this.record(name, "revoked", Date.now());
  }

  status(): McpStatus {
    const { enabled, host, port } = this.ctx.settings.get().mcp;
    const token = this.ctx.settings.mcpToken();
    const activePort = this.handle?.port ?? (port || null);
    const remote = host === "0.0.0.0";
    const lanAddress = remote ? lanIPv4() : null;
    const connectHost = remote ? (lanAddress ?? "0.0.0.0") : "127.0.0.1";
    return {
      available: this.available,
      enabled,
      running: this.handle !== null,
      port: activePort,
      url: activePort ? `http://${connectHost}:${activePort}/mcp` : null,
      token,
      command: activePort ? mcpAddCommand(activePort, token, connectHost) : null,
      error: this.error,
      accessLevel: this.accessLevel(),
      host,
      remote,
      lanAddress,
    };
  }
}

/** First non-internal IPv4 address of this machine, for the remote connect hint. */
function lanIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}
