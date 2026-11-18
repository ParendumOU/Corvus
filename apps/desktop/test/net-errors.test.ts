import { describe, expect, it } from "vitest";
import { isNoResponseError } from "../src/shared/net-errors";

describe("no-response net errors", () => {
  it("covers a server that never answered", () => {
    for (const code of [-105, -106, -102, -118, -101, -324, -137]) expect(isNoResponseError(code)).toBe(true);
  });

  it("leaves out aborts, blocked requests, bad addresses and certificate errors", () => {
    for (const code of [-3, -20, -27, -300, -301, -200, -202, 0]) expect(isNoResponseError(code)).toBe(false);
  });
});
