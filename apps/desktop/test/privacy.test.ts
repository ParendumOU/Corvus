import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { farblingScript, fingerprintSeed, siteMatches } from "../src/shared/privacy";

/** A page's globals with just enough of the fingerprinting surface for the script to wrap. */
function fakePage(): Record<string, unknown> {
  function CanvasRenderingContext2D(): void {}
  CanvasRenderingContext2D.prototype.getImageData = function () {
    return { data: new Uint8ClampedArray(4 * 2000).fill(255) };
  };
  function Navigator(): void {}
  Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => 16, configurable: true });
  Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => 32, configurable: true });
  function WebGLRenderingContext(): void {}
  WebGLRenderingContext.prototype.getParameter = (p: number) => `real-${p}`;
  function AudioBuffer(this: { samples: Float32Array }): void {
    this.samples = new Float32Array(500).fill(0.25);
  }
  AudioBuffer.prototype.getChannelData = function (this: { samples: Float32Array }) {
    return this.samples;
  };
  function HTMLIFrameElement(this: { frame: unknown }, frame: unknown): void {
    this.frame = frame;
  }
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    get(this: { frame: unknown }) {
      return this.frame;
    },
    configurable: true,
  });
  const page: Record<string, unknown> = {
    CanvasRenderingContext2D,
    Navigator,
    navigator: new (Navigator as unknown as new () => object)(),
    WebGLRenderingContext,
    AudioBuffer,
    HTMLIFrameElement,
  };
  page.window = page;
  return page;
}

const run = (page: Record<string, unknown>, code: string): unknown => runInNewContext(code, page);

describe("site matching", () => {
  it("matches a site and its subdomains, never a look-alike", () => {
    expect(siteMatches("example.com", "example.com")).toBe(true);
    expect(siteMatches("www.example.com", "example.com")).toBe(true);
    expect(siteMatches("mail.example.com", "example.com")).toBe(true);
    expect(siteMatches("badexample.com", "example.com")).toBe(false);
    expect(siteMatches("example.com.evil.net", "example.com")).toBe(false);
    expect(siteMatches("example.com", "")).toBe(false);
  });
});

describe("fingerprinting protection", () => {
  it("seeds per session and per site, ignoring www", () => {
    expect(fingerprintSeed("k", "example.com")).toBe(fingerprintSeed("k", "www.example.com"));
    expect(fingerprintSeed("k", "example.com")).not.toBe(fingerprintSeed("k", "other.com"));
    expect(fingerprintSeed("k", "example.com")).not.toBe(fingerprintSeed("k2", "example.com"));
  });

  it("adds stable noise to canvas readbacks: same per site, different across sites", () => {
    const read = (seed: number): number[] => {
      const page = fakePage();
      run(page, farblingScript(seed));
      return Array.from(run(page, "new CanvasRenderingContext2D().getImageData(0, 0, 50, 40).data") as Uint8ClampedArray);
    };
    const a = read(fingerprintSeed("k", "a.com"));
    const changed = a.filter((v) => v !== 255).length;
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(200);
    expect(read(fingerprintSeed("k", "a.com"))).toEqual(a);
    expect(read(fingerprintSeed("k", "b.com"))).not.toEqual(a);
  });

  it("hides the GPU, caps the CPU count and rounds device memory", () => {
    const page = fakePage();
    run(page, farblingScript(fingerprintSeed("k", "a.com")));
    expect(run(page, "new WebGLRenderingContext().getParameter(37445)")).toBe("Google Inc.");
    expect(run(page, "new WebGLRenderingContext().getParameter(37446)")).toBe("ANGLE (Generic GPU)");
    expect(run(page, "new WebGLRenderingContext().getParameter(7938)")).toBe("real-7938");
    const cores = run(page, "navigator.hardwareConcurrency") as number;
    expect(cores).toBeGreaterThanOrEqual(2);
    expect(cores).toBeLessThanOrEqual(8);
    expect(run(page, "navigator.deviceMemory")).toBe(8);
  });

  it("perturbs audio samples once, so reading them twice agrees", () => {
    const page = fakePage();
    run(page, farblingScript(fingerprintSeed("k", "a.com")));
    const [first, second] = run(page, "var b = new AudioBuffer(); [Array.from(b.getChannelData(0)), Array.from(b.getChannelData(0))]") as number[][];
    expect(first!.some((v) => v !== 0.25)).toBe(true);
    expect(second).toEqual(first);
  });

  it("covers a same-origin frame the page reaches into", () => {
    const page = fakePage();
    const frame = fakePage();
    page.frame = frame;
    run(page, farblingScript(fingerprintSeed("k", "a.com")));
    const pristine = frame.CanvasRenderingContext2D as { prototype: { getImageData: unknown } };
    const before = pristine.prototype.getImageData;
    run(page, "new HTMLIFrameElement(frame).contentWindow");
    expect(pristine.prototype.getImageData).not.toBe(before);
    expect((frame as { __corvusFarbled?: boolean }).__corvusFarbled).toBe(true);
  });

  it("wraps a frame only once", () => {
    const page = fakePage();
    run(page, farblingScript(1));
    const wrapped = run(page, "CanvasRenderingContext2D.prototype.getImageData");
    run(page, farblingScript(2));
    expect(run(page, "CanvasRenderingContext2D.prototype.getImageData")).toBe(wrapped);
  });
});
