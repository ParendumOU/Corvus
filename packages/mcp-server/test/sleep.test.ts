import { describe, expect, it, vi } from "vitest";
import { sleep } from "../src/tools/types.js";

describe("sleep", () => {
  it("removes its abort listener when the time is up", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    for (let i = 0; i < 20; i++) await sleep(1, controller.signal);
    expect(remove).toHaveBeenCalledTimes(20);
  });

  it("ends early when the call is cancelled", async () => {
    const controller = new AbortController();
    const at = Date.now();
    const done = sleep(10_000, controller.signal);
    controller.abort();
    await done;
    expect(Date.now() - at).toBeLessThan(1000);
  });
});
