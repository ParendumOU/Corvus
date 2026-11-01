import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dpapiSession, systemKeyProviders, type DpapiChild } from "../src/main/browser-keys";

/** A stand-in for the worker: answers with its blob reversed, or behaves as `mode` says. */
class FakeChild extends EventEmitter {
  killed = false;
  posted: Array<{ id: number; blob: Uint8Array }> = [];

  constructor(private readonly mode: "answer" | "crash" | "hang" | "refuse") {
    super();
    setTimeout(() => this.emit("spawn"), 0);
  }

  postMessage(message: unknown): void {
    const request = message as { id: number; blob: Uint8Array };
    this.posted.push(request);
    if (this.mode === "crash") setTimeout(() => this.emit("exit", 134), 0);
    if (this.mode === "answer") setTimeout(() => this.emit("message", { id: request.id, data: Uint8Array.from(request.blob).reverse() }), 0);
    if (this.mode === "refuse") setTimeout(() => this.emit("message", { id: request.id, data: null }), 0);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const forkOf = (mode: "answer" | "crash" | "hang" | "refuse") => {
  const children: FakeChild[] = [];
  return {
    children,
    fork: (): DpapiChild => {
      const child = new FakeChild(mode);
      children.push(child);
      return child;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the DPAPI worker session", () => {
  it("uses one child for the whole import and kills it at the end", async () => {
    const { children, fork } = forkOf("answer");
    const session = dpapiSession(fork);
    expect(children).toHaveLength(0); // nothing starts until something needs it
    expect((await session.unprotect(Buffer.from([1, 2, 3])))?.equals(Buffer.from([3, 2, 1]))).toBe(true);
    expect((await session.unprotect(Buffer.from([4, 5])))?.equals(Buffer.from([5, 4]))).toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(false);
    session.close();
    expect(children[0]!.killed).toBe(true);
    expect(await session.unprotect(Buffer.from([1]))).toBeNull();
    expect(children).toHaveLength(1);
  });

  it("answers null for this request only when the worker refuses a blob", async () => {
    const { children, fork } = forkOf("refuse");
    const session = dpapiSession(fork);
    expect(await session.unprotect(Buffer.from([1]))).toBeNull();
    expect(await session.unprotect(Buffer.from([2]))).toBeNull();
    expect(children[0]!.posted).toHaveLength(2);
    session.close();
  });

  it("a crash answers null, kills nothing twice, and later requests never start another child", async () => {
    const { children, fork } = forkOf("crash");
    const session = dpapiSession(fork);
    expect(await session.unprotect(Buffer.from([1]))).toBeNull();
    expect(await session.unprotect(Buffer.from([2]))).toBeNull();
    expect(children).toHaveLength(1);
    session.close();
  });

  it("a hang answers null after the timeout, kills the child, and costs one timeout at most", async () => {
    vi.useFakeTimers();
    const { children, fork } = forkOf("hang");
    const session = dpapiSession(fork, 1000);
    const first = session.unprotect(Buffer.from([1]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBeNull();
    expect(children[0]!.killed).toBe(true);
    expect(await session.unprotect(Buffer.from([2]))).toBeNull();
    expect(children).toHaveLength(1);
  });

  it("a child that exits before it started answers null", async () => {
    const child = new EventEmitter() as EventEmitter & { postMessage: () => void; kill: () => boolean };
    child.postMessage = () => {};
    child.kill = () => true;
    const session = dpapiSession(() => child as unknown as DpapiChild);
    const answer = session.unprotect(Buffer.from([1]));
    child.emit("exit", 1);
    expect(await answer).toBeNull();
  });

  it("a worker that cannot start answers null", async () => {
    const session = dpapiSession(() => {
      throw new Error("no utility process");
    });
    expect(await session.unprotect(Buffer.from([1]))).toBeNull();
  });

  it("close while waiting answers null", async () => {
    const { fork } = forkOf("hang");
    const session = dpapiSession(fork);
    const answer = session.unprotect(Buffer.from([1]));
    session.close();
    expect(await answer).toBeNull();
  });

  it("copies the answer and wipes what came over the channel", async () => {
    const data = Uint8Array.from([7, 8, 9]);
    const child = new EventEmitter() as EventEmitter & { postMessage: (m: { id: number }) => void; kill: () => boolean };
    child.postMessage = ({ id }) => void child.emit("message", { id, data });
    child.kill = () => true;
    const session = dpapiSession(() => child as unknown as DpapiChild);
    const answer = session.unprotect(Buffer.from([1]));
    child.emit("spawn");
    expect((await answer)?.equals(Buffer.from([7, 8, 9]))).toBe(true);
    expect([...data]).toEqual([0, 0, 0]);
    session.close();
  });
});

describe("the system's key sources", () => {
  it("Windows goes through the worker it is given, or has no DPAPI; other systems never start it", () => {
    const { children, fork } = forkOf("answer");
    expect(systemKeyProviders("win32").dpapi).toBeUndefined();
    expect(systemKeyProviders("win32", fork).dpapi).toBeTypeOf("function");
    expect(systemKeyProviders("darwin", fork).dpapi).toBeUndefined();
    expect(systemKeyProviders("linux", fork).dpapi).toBeUndefined();
    expect(children).toHaveLength(0);
  });
});
