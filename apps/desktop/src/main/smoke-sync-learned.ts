import type { WebContents } from "electron";
import type { SyncItem } from "@corvus/shared";
import type { CorvusSyncClient } from "@corvus/sync-core";
import type { FlowStep } from "../shared/flow";
import type { TrailEvent } from "../shared/site-memory";
import { markerRecord, parseSyncedSiteMemory } from "../shared/site-memory-sync";
import { parseSyncedWorkflow, workflowTombstone } from "../shared/workflow-sync";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

/**
 * Live sync of workflows and site memory (part of the CORVUS_SMOKE_SYNC_URL section). This app is
 * device A; `phone` is device B, a bare sync-core client on the same chain:
 *  1. A saves an agent workflow and learns a site (including a typed user name and a secret, which
 *     must not travel); B pulls and decrypts both.
 *  2. B forgets the site and deletes the workflow; after A syncs, both are gone on A too.
 *  3. Settings > Sync shows the two categories.
 */

interface Deps {
  profile: ProfileRuntime;
  phone: CorvusSyncClient;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

const HOST = "sync-shop.example";
const SECRET = "smoke-typed-secret-7781";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `expr` is true in the page (10 s). */
async function poll(wc: WebContents, expr: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(250);
  }
  return false;
}

export async function runSyncLearnedSmoke(ctx: AppContext, { profile, phone, win, check }: Deps): Promise<void> {
  const flows = ctx.flows.storeFor(profile);
  const memory = ctx.flows.memory.storeFor(profile);
  const status = await ctx.sync.status(profile);
  check("sync categories default on", status.syncWorkflows && status.syncSiteMemory, { syncWorkflows: status.syncWorkflows, syncSiteMemory: status.syncSiteMemory });

  const target = (role: string, name: string) => ({ role, name, index: 0, tag: "", selector: "" });
  const steps: FlowStep[] = [
    { kind: "navigate", url: `https://${HOST}/`, label: "" },
    { kind: "type", url: `https://${HOST}/`, label: "", target: target("searchbox", "Search products"), value: "{{query}}", submit: true, secret: false },
    { kind: "type", url: `https://${HOST}/login`, label: "", target: target("textbox", "Password"), secret: true, submit: false },
    { kind: "click", url: `https://${HOST}/s`, label: "", target: target("button", "Add to cart") },
  ];
  const wf = flows.create("Smoke sync workflow", `https://${HOST}/`, steps, {
    origin: "agent",
    sourceRunId: "smoke-sync-run",
    description: "Search and add to cart",
    params: [{ name: "query", label: "Query", default: "umbrella" }],
  });
  flows.recordRun(wf?.id ?? "", { status: "ok", by: "user" });
  const trail: TrailEvent[] = [
    { type: "action", ok: true, action: { kind: "navigate", url: `https://${HOST}/` } },
    { type: "action", ok: true, action: { kind: "click", url: `https://${HOST}/`, target: target("button", "Accept all") } },
    { type: "action", ok: true, action: { kind: "type", url: `https://${HOST}/`, target: target("textbox", "Username"), value: SECRET, submit: false, secret: false } },
    { type: "action", ok: true, action: { kind: "type", url: `https://${HOST}/`, target: target("textbox", "Password"), submit: true, secret: true } },
    { type: "action", ok: true, action: { kind: "type", url: `https://${HOST}/`, target: target("searchbox", "Search products"), value: "umbrella", submit: true, secret: false } },
    { type: "action", ok: true, action: { kind: "click", url: `https://${HOST}/`, target: target("button", "Add to cart") } },
  ];
  memory.learn(trail, true);
  check("sync smoke: A saved a workflow and learned a site", !!wf && !!memory.get(HOST), { workflow: wf?.id, hosts: memory.list().map((e) => e.host) });
  if (!wf) return;

  await ctx.sync.syncNow(profile);
  const pulled: SyncItem[] = await phone.pull();
  const wfItem = pulled.find((i) => i.collection === "workflows" && i.id === wf.id);
  const wfRecord = wfItem ? parseSyncedWorkflow(wfItem.payload, wf.id) : null;
  check(
    "sync workflow reaches device B (E2E)",
    wfRecord?.flow?.name === "Smoke sync workflow" && wfRecord.flow.origin === "agent" && Object.values(wfRecord.usage).some((u) => u.runs === 1),
    { name: wfRecord?.flow?.name, steps: wfRecord?.flow?.steps.length, usage: wfRecord?.usage },
  );
  const memItem = pulled.find((i) => i.collection === "site_memory" && i.id === HOST);
  const memRecord = memItem ? parseSyncedSiteMemory(memItem.payload, HOST) : null;
  check(
    "sync site memory reaches device B (E2E)",
    !!memRecord && memRecord.targets.some((t) => t.name === "Add to cart") && memRecord.obstacles.some((o) => o.kind === "cookie banner"),
    memRecord?.targets.map((t) => `${t.act}:${t.name}`),
  );
  const leaked = JSON.stringify(pulled.filter((i) => i.collection === "workflows" || i.collection === "site_memory"));
  check("sync learned data carries no typed secret or credential field", !leaked.includes(SECRET) && !/"name":"(Username|Password)","by"/.test(leaked) && !leaked.includes("hunter"), {
    bytes: leaked.length,
  });

  // Device B forgets the site and deletes the workflow.
  const now = Date.now();
  await phone.push([
    { collection: "site_memory", id: HOST, payload: markerRecord(HOST, { clearedAt: now, removed: {} }), deleted: false },
    { collection: "workflows", id: wf.id, payload: workflowTombstone(wf.id, now, wfRecord?.usage ?? {}), deleted: false },
  ]);
  await ctx.sync.syncNow(profile);
  check("forget this site on B removes it on A", memory.get(HOST) === undefined, memory.list().map((e) => e.host));
  check("deleting the workflow on B removes it on A", flows.get(wf.id) === undefined, flows.list().map((f) => f.name));
  const quiet = await phone.pull();
  check("A does not send forgotten data back", !quiet.some((i) => (i.collection === "site_memory" && i.id === HOST) || (i.collection === "workflows" && i.id === wf.id)), quiet.map((i) => `${i.collection}/${i.id}`));

  const settings = win.createTab("corvus://settings#sync");
  const switches = `["Sync workflows", "Sync site memory"].every((l) => document.querySelector('[role=switch][aria-label="' + l + '"]')?.getAttribute("aria-checked") === "true")`;
  check("settings show the workflows and site memory sync switches, on", await poll(settings.view.webContents, switches));
}
