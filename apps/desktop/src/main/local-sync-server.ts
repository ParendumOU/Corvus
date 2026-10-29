import { utilityProcess } from "electron";
import { paths } from "./paths";

export type LocalServerRequest = { type: "start"; dbPath: string; remembered: number | null } | { type: "stop" };
export type LocalServerReply = { type: "listening"; port: number } | { type: "failed"; error: string } | { type: "client"; address: string; at: number };

/** The parts of an Electron UtilityProcess the server needs (a fake in tests). */
export interface ServerProcess {
  postMessage(msg: LocalServerRequest): void;
  on(event: "message", listener: (msg: LocalServerReply) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface LocalServerStatus {
  running: boolean;
  port: number | null;
  error: string | null;
  /** The last other device that reached this server (its network address), if any since it started. */
  lastClient: { address: string; at: number } | null;
}

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;

const forkWorker = (): ServerProcess => utilityProcess.fork(paths.syncServerWorker, [], { serviceName: "Corvus sync server", stdio: "ignore" }) as unknown as ServerProcess;

/**
 * The sync server built into Corvus for one profile ("This computer"): services/sync-server's code
 * in a utility process, its database in the profile's folder. It listens on the computer's network
 * so the profile's phone and other computers can sync with it, and answers only private networks.
 */
export class LocalSyncServer {
  private child: ServerProcess | null = null;
  private starting: Promise<number> | null = null;
  private current: LocalServerStatus = { running: false, port: null, error: null, lastClient: null };

  constructor(
    private readonly dbPath: string,
    private readonly fork: () => ServerProcess = forkWorker,
    private readonly startTimeoutMs = START_TIMEOUT_MS,
  ) {}

  get status(): LocalServerStatus {
    return this.current;
  }

  /** Starts the server (once; later calls share it) and resolves to its port. `remembered` is tried first. */
  start(remembered: number | null): Promise<number> {
    if (this.current.running && this.current.port !== null) return Promise.resolve(this.current.port);
    this.starting ??= this.spawn(remembered).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawn(remembered: number | null): Promise<number> {
    const child = this.fork();
    this.child = child;
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const fail = (error: string): void => {
        this.current = { ...this.current, running: false, port: null, error };
        if (this.child === child) this.child = null;
        if (!settled) {
          settled = true;
          reject(new Error(error));
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        fail("The sync server did not start in time");
      }, this.startTimeoutMs);
      child.on("message", (msg) => {
        if (msg.type === "client") {
          this.current = { ...this.current, lastClient: { address: msg.address, at: msg.at } };
          return;
        }
        // Stopped meanwhile: what it says now is about a server that is going away (its exit settles the start).
        if (this.child !== child) return;
        clearTimeout(timer);
        if (msg.type === "listening") {
          this.current = { ...this.current, running: true, port: msg.port, error: null };
          settled = true;
          resolve(msg.port);
        } else {
          child.kill();
          fail(msg.error);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (this.child === child) fail(settled ? `The sync server stopped (code ${code})` : `The sync server could not start (code ${code})`);
        else if (!settled) {
          settled = true;
          reject(new Error("The sync server was stopped while it started"));
        }
      });
      child.postMessage({ type: "start", dbPath: this.dbPath, remembered });
    });
  }

  /** Stops listening (the database stays). */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.current = { ...this.current, running: false, port: null, error: null };
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, STOP_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: "stop" });
    });
  }
}
