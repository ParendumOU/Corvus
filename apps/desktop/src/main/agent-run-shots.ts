import fs from "node:fs";
import path from "node:path";

const ID_RE = /^[\w-]{1,128}$/;

/**
 * Small captures of the page after an agent run's steps, so the run history shows what the agent saw
 * and did: one JPEG per step in agent-run-shots/<run>/<step>.jpg. They go with their run (deleted
 * with it, or when the history is cleared or the run falls out of it).
 */
export class AgentRunShots {
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.join(dir, "agent-run-shots");
  }

  private runDir(runId: string): string | null {
    return ID_RE.test(runId) ? path.join(this.root, runId) : null;
  }

  save(runId: string, stepId: string, jpeg: Buffer): void {
    const dir = this.runDir(runId);
    if (!dir || !ID_RE.test(stepId)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stepId}.jpg`), jpeg);
  }

  /** The run's captures by step id, as data: URLs. */
  list(runId: string): Record<string, string> {
    const dir = this.runDir(runId);
    const out: Record<string, string> = {};
    if (!dir || !fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jpg")) continue;
      out[name.slice(0, -4)] = `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, name)).toString("base64")}`;
    }
    return out;
  }

  remove(runId: string): void {
    const dir = this.runDir(runId);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Drops the captures of runs no longer in the history. */
  keepOnly(runIds: ReadonlySet<string>): void {
    if (!fs.existsSync(this.root)) return;
    for (const name of fs.readdirSync(this.root)) if (!runIds.has(name)) this.remove(name);
  }

  clear(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
