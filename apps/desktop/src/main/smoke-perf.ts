import { app, webContents } from "electron";
import type { AppContext } from "./context";

/**
 * Memory probe (CORVUS_PERF=1): opens many tabs of a local page, measures every process and the
 * main process heap, closes them and repeats. Logs one "[perf]" line per measure; it fails when
 * closed tabs leave web contents behind or the main heap keeps growing from cycle to cycle.
 */

const TABS = 30;
const CYCLES = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function measure(label: string): { label: string; workingSetMB: number; mainHeapMB: number; webContents: number; processes: number } {
  const metrics = app.getAppMetrics();
  const workingSetKB = metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0);
  return {
    label,
    workingSetMB: Math.round(workingSetKB / 1024),
    mainHeapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    webContents: webContents.getAllWebContents().length,
    processes: metrics.length,
  };
}

export async function runPerfProbe(ctx: AppContext, url: string, log: (msg: string, detail?: unknown) => void, check: (name: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  const win = ctx.windows.target();
  await sleep(1500);
  const baseline = measure("baseline");
  log("[perf]", baseline);
  const heaps: number[] = [];
  const leftovers: number[] = [];
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const ids: string[] = [];
    for (let i = 0; i < TABS; i++) ids.push(win.createTab(`${url}?perf=${cycle}-${i}`, { activate: i === TABS - 1 }).id);
    await sleep(4000);
    log("[perf]", { ...measure(`cycle ${cycle}: ${TABS} tabs open`), perTabMB: Math.round((measure("x").workingSetMB - baseline.workingSetMB) / TABS) });
    for (const id of ids) if (win.hasTab(id)) win.closeTab(id);
    await sleep(3000);
    const after = measure(`cycle ${cycle}: closed`);
    log("[perf]", after);
    heaps.push(after.mainHeapMB);
    leftovers.push(after.webContents - baseline.webContents);
  }
  // A leak shows as web contents left behind, or a main heap that climbs every cycle by a lot.
  const climbing = heaps.length >= 3 && heaps[2]! - heaps[0]! > 25;
  check("perf: closed tabs leave no web contents behind", leftovers.every((n) => n <= 0), { leftovers });
  check("perf: the main process heap settles across cycles", !climbing, { heaps });
}
