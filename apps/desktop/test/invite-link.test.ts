import { describe, expect, it } from "vitest";
import { inviteLink } from "../src/shared/invite-link";

describe("invite link", () => {
  it("points to the download site in Corvus's language", () => {
    expect(inviteLink("en")).toBe("https://corvus.parendum.com/");
    expect(inviteLink("es")).toBe("https://corvus.parendum.com/es");
  });
});
