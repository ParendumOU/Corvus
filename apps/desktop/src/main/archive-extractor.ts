import { utilityProcess, type UtilityProcess } from "electron";
import { isWrongPassword, parseListing, sevenZipError, type ArchiveSet } from "../shared/archives";
import { paths } from "./paths";
import type { SevenZipResult } from "./sevenzip";

/** Runs one 7-Zip command in the package folder. */
export type SevenZipRun = (args: string[]) => Promise<SevenZipResult>;

export type ExtractOutcome =
  | { status: "done"; files: number; password: string | null }
  | { status: "password" }
  | { status: "failed"; error: string };

/** Passed when the archive needs no password: 7-Zip asks on its console without one. */
const NO_PASSWORD = "-pcorvus-no-password";

/** Quiet progress, messages and errors on stdout, never a question, no wildcards in names. */
const SWITCHES = ["-bsp0", "-bso1", "-bse1", "-y", "-spd"];

const passwordSwitch = (password: string | null): string => (password === null ? NO_PASSWORD : `-p${password}`);

/**
 * Extracts one archive (every volume in the folder) into `out`, trying the candidate passwords in
 * order when it is encrypted. A password is checked cheaply first: by listing an archive whose file
 * names are encrypted too, or by testing its smallest encrypted file.
 */
export async function extractArchive(run: SevenZipRun, set: ArchiveSet, candidates: readonly string[], out = "."): Promise<ExtractOutcome> {
  const list = (password: string | null): Promise<SevenZipResult> => run(["l", "-slt", ...SWITCHES, passwordSwitch(password), "--", set.entry]);
  // A wrong password on a .7z archive makes the WebAssembly build throw instead of saying so.
  const refused = (r: SevenZipResult): boolean => isWrongPassword(r.lines) || (set.kind === "7z" && r.crashed === true);
  const first = await list(null);
  let password: string | null = null;
  let entries = first.code === 0 ? parseListing(first.lines) : [];
  if (first.code !== 0 && !refused(first)) return { status: "failed", error: sevenZipError(first.lines, first.code) };
  const namesEncrypted = first.code !== 0;
  const probe = entries.filter((e) => e.encrypted && !e.folder).sort((a, b) => a.size - b.size)[0];
  if (namesEncrypted || probe) {
    let found = false;
    for (const candidate of candidates) {
      const check = namesEncrypted ? await list(candidate) : await run(["t", ...SWITCHES, passwordSwitch(candidate), "--", set.entry, probe!.path]);
      if (check.code === 0) {
        password = candidate;
        if (namesEncrypted) entries = parseListing(check.lines);
        found = true;
        break;
      }
      if (!refused(check)) return { status: "failed", error: sevenZipError(check.lines, check.code) };
    }
    if (!found) return { status: "password" };
  }
  // The package folder is Corvus's own: extracting again overwrites what a stopped run left behind.
  const result = await run(["x", ...SWITCHES, "-aoa", passwordSwitch(password), `-o${out}`, "--", set.entry]);
  if (result.code > 1) return { status: "failed", error: sevenZipError(result.lines, result.code) };
  return { status: "done", files: entries.filter((e) => !e.folder).length, password };
}

/** 7-Zip in a utility process of its own, working in one folder until closed. */
export class SevenZipProcess {
  private readonly child: UtilityProcess;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, { resolve: (r: SevenZipResult) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private exited = false;

  constructor(private readonly root: string) {
    this.child = utilityProcess.fork(paths.archiveWorker, [], { serviceName: "Corvus archive extractor", stdio: "ignore" });
    this.ready = new Promise((resolve, reject) => {
      this.child.once("spawn", () => resolve());
      this.child.once("exit", (code) => reject(new Error(`The extractor exited with code ${code}`)));
    });
    this.ready.catch(() => undefined);
    this.child.on("message", (msg: { id: number } & SevenZipResult) => {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      waiter?.resolve({ code: msg.code, lines: msg.lines });
    });
    this.child.once("exit", (code) => {
      this.exited = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error(`The extractor stopped (code ${code})`));
      this.pending.clear();
    });
  }

  readonly run: SevenZipRun = async (args) => {
    await this.ready;
    if (this.exited) throw new Error("The extractor stopped");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.postMessage({ id, root: this.root, args });
    });
  };

  close(): void {
    if (!this.exited) this.child.kill();
  }
}
