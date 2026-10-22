import { describe, expect, it } from "vitest";
import { encode, hash, jwtDecode } from "../src/encoders.js";

describe("encoders round-trip", () => {
  const sample = "héllo <b>&</b> wörld/+ 1";
  it("base64", () => {
    expect(encode("base64-decode", encode("base64-encode", sample))).toBe(sample);
  });
  it("url", () => {
    expect(encode("url-decode", encode("url-encode", sample))).toBe(sample);
  });
  it("hex", () => {
    expect(encode("hex-decode", encode("hex-encode", sample))).toBe(sample);
  });
  it("html encodes and decodes entities", () => {
    expect(encode("html-encode", "<a>&\"'")).toBe("&lt;a&gt;&amp;&quot;&#39;");
    expect(encode("html-decode", "&lt;a&gt;&amp;&#x2f;")).toBe("<a>&/");
  });
});

describe("hash", () => {
  it("computes known digests", () => {
    expect(hash("sha256", "abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hash("md5", "")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });
});

describe("jwtDecode", () => {
  it("decodes header and payload without verifying", () => {
    const token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJuYW1lIjoiQSJ9.sig";
    const parts = jwtDecode(token);
    expect(parts.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(parts.payload).toEqual({ sub: "123", name: "A" });
    expect(parts.signature).toBe("sig");
  });
  it("throws on malformed tokens", () => {
    expect(() => jwtDecode("only-one-part")).toThrow();
  });
});
