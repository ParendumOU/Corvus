import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { holdMediaInPage } from "../src/shared/media-hold";

interface Media {
  id: string;
  play(): Promise<undefined>;
  pause(): void;
}

/**
 * holdMediaInPage as the tab preload runs it: from its source, in a page of its own (a fresh realm
 * with an HTMLMediaElement whose native play and pause are recorded), so it must be self-contained.
 */
function page(): { calls: string[]; media: (id: string) => Media; proto: { play: unknown; pause: unknown }; native: { play: unknown; pause: unknown }; release: () => void } {
  const calls: string[] = [];
  const context: Record<string, unknown> = { calls, DOMException };
  runInNewContext(
    `class HTMLMediaElement {
      constructor(id) { this.id = id; }
      play() { calls.push("play " + this.id); return Promise.resolve(undefined); }
      pause() { calls.push("pause " + this.id); }
    }
    globalThis.HTMLMediaElement = HTMLMediaElement;
    globalThis.native = { play: HTMLMediaElement.prototype.play, pause: HTMLMediaElement.prototype.pause };`,
    context,
  );
  let release: (() => void) | null = null;
  context.register = (r: () => void) => (release = r);
  runInNewContext(`(${holdMediaInPage.toString()})(register)`, context);
  const ctor = context.HTMLMediaElement as { new (id: string): Media; prototype: { play: unknown; pause: unknown } };
  return {
    calls,
    media: (id) => new ctor(id),
    proto: ctor.prototype,
    native: context.native as { play: unknown; pause: unknown },
    release: () => release?.(),
  };
}

const settled = (p: Promise<unknown>): Promise<string> =>
  Promise.race([p.then(() => "resolved", (e: { name?: string }) => `rejected ${e?.name}`), new Promise<string>((r) => setTimeout(() => r("pending"), 20))]);

describe("media held in a background tab until it is first shown", () => {
  it("a play() waits, then starts at the release and settles with the real start", async () => {
    const p = page();
    const video = p.media("v");
    const started = video.play();
    expect(await settled(started)).toBe("pending");
    expect(p.calls).toEqual([]);
    p.release();
    expect(p.calls).toEqual(["play v"]);
    expect(await settled(started)).toBe("resolved");
  });

  it("each element starts once however many times it asked", async () => {
    const p = page();
    const a = p.media("a");
    const b = p.media("b");
    const first = [a.play(), a.play(), b.play()];
    p.release();
    expect(p.calls).toEqual(["play a", "play b"]);
    expect(await Promise.all(first.map(settled))).toEqual(["resolved", "resolved", "resolved"]);
  });

  it("a pause() before the release cancels the start, as it would one still loading", async () => {
    const p = page();
    const audio = p.media("a");
    const started = audio.play();
    audio.pause();
    expect(await settled(started)).toBe("rejected AbortError");
    p.release();
    expect(p.calls).toEqual(["pause a"]);
  });

  it("the release leaves the page's own play and pause, named as before", () => {
    const p = page();
    expect((p.proto.play as { name: string }).name).toBe("play");
    expect(p.proto.play).not.toBe(p.native.play);
    p.release();
    expect(p.proto.play).toBe(p.native.play);
    expect(p.proto.pause).toBe(p.native.pause);
    void p.media("x").play();
    expect(p.calls).toEqual(["play x"]);
  });
});
