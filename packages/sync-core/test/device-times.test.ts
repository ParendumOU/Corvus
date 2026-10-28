import { describe, expect, it } from "vitest";
import { deviceTimesHere } from "../src/client.js";

const device = { id: "a", name: "PC", platform: "win32", lastSeen: 1_000_000 };

describe("deviceTimesHere", () => {
  it("moves lastSeen onto this device's clock when the server sends its time", () => {
    // The server's clock is 100 s behind this one: the device was seen 3 s before the answer.
    const [d] = deviceTimesHere({ devices: [device], serverTime: 1_003_000 }, 1_103_000);
    expect(d!.lastSeen).toBe(1_100_000);
  });

  it("keeps lastSeen as it came from an older server", () => {
    expect(deviceTimesHere({ devices: [device] }, 5_000_000)).toEqual([device]);
  });
});
