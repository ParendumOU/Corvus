import { describe, expect, it } from "vitest";
import { httpAuthPrompt, mayAskSignIn, signInChoices } from "../src/shared/http-auth";

describe("httpAuthPrompt", () => {
  it("names the site with its port and says whether the sign-in travels encrypted", () => {
    expect(httpAuthPrompt("https://panel.example/", "Panel")).toEqual({ site: "panel.example", realm: "Panel", private: true });
    expect(httpAuthPrompt("http://192.168.0.42:8080/status", "ESP32")).toEqual({ site: "192.168.0.42:8080", realm: "ESP32", private: false });
  });

  it("tidies the realm the site sends", () => {
    expect(httpAuthPrompt("https://a.example/", undefined).realm).toBe("");
    expect(httpAuthPrompt("https://a.example/", "  Restricted \n area ").realm).toBe("Restricted area");
    const long = httpAuthPrompt("https://a.example/", "x".repeat(500)).realm;
    expect(long).toHaveLength(200);
    expect(long.endsWith("...")).toBe(true);
  });

  it("names no site for an address it cannot read", () => {
    expect(httpAuthPrompt("not a url", "Realm")).toEqual({ site: "", realm: "Realm", private: false });
  });
});

describe("mayAskSignIn", () => {
  const page = "https://intranet.example";
  it("lets a page or a frame being opened ask, from any site", () => {
    expect(mayAskSignIn({ navigation: true, origin: page, topOrigin: "https://other.example" })).toBe(true);
    expect(mayAskSignIn({ navigation: true, origin: "http://router.example", topOrigin: "" })).toBe(true);
  });

  it("lets a page's own requests ask, but not another site's script or image inside it", () => {
    expect(mayAskSignIn({ navigation: false, origin: page, topOrigin: page })).toBe(true);
    expect(mayAskSignIn({ navigation: false, origin: "https://ads.example", topOrigin: page })).toBe(false);
    expect(mayAskSignIn({ navigation: true, origin: "", topOrigin: page })).toBe(false);
  });
});

describe("signInChoices", () => {
  it("offers each username once, with a password, in the order given", () => {
    const records = [
      { id: "1", username: "alice", password: "a1" },
      { id: "2", username: "Alice ", password: "a2" },
      { id: "3", username: "bob", password: "" },
      { id: "4", username: "", password: "p" },
      { id: "5", username: "bob", password: "b2" },
    ];
    expect(signInChoices(records).map((r) => r.id)).toEqual(["1", "4", "5"]);
  });
});
