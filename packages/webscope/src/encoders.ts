import { createHash } from "node:crypto";
import type { EncoderOp, HashAlg, JwtParts } from "./types.js";

export type { EncoderOp, HashAlg, JwtParts } from "./types.js";

const HTML_ENCODE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const HTML_DECODE: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  "#x2f": "/",
  "#47": "/",
  nbsp: " ",
};

export function htmlEncode(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ENCODE[ch] ?? ch);
}

export function htmlDecode(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key in HTML_DECODE) return HTML_DECODE[key] as string;
    if (key.startsWith("#x")) return safeCodePoint(parseInt(key.slice(2), 16), match);
    if (key.startsWith("#")) return safeCodePoint(parseInt(key.slice(1), 10), match);
    return match;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** Apply an encoder/decoder. Throws on malformed input for decode operations. */
export function encode(op: EncoderOp, input: string): string {
  switch (op) {
    case "base64-encode":
      return Buffer.from(input, "utf8").toString("base64");
    case "base64-decode":
      return Buffer.from(input, "base64").toString("utf8");
    case "url-encode":
      return encodeURIComponent(input);
    case "url-decode":
      return decodeURIComponent(input.replace(/\+/g, " "));
    case "html-encode":
      return htmlEncode(input);
    case "html-decode":
      return htmlDecode(input);
    case "hex-encode":
      return Buffer.from(input, "utf8").toString("hex");
    case "hex-decode":
      return Buffer.from(input.replace(/\s+/g, ""), "hex").toString("utf8");
  }
}

export function hash(alg: HashAlg, input: string): string {
  return createHash(alg).update(input, "utf8").digest("hex");
}

/** Decode (not verify) a JWT into its header and payload. Throws when the token is malformed. */
export function jwtDecode(token: string): JwtParts {
  const parts = token.trim().split(".");
  if (parts.length < 2 || parts.length > 3) throw new Error("A JWT has two or three dot-separated parts");
  const decodeSegment = (segment: string): unknown => {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    try {
      return JSON.parse(json);
    } catch {
      throw new Error("JWT segment is not valid base64url JSON");
    }
  };
  return {
    header: decodeSegment(parts[0] as string),
    payload: decodeSegment(parts[1] as string),
    signature: parts[2] ?? "",
  };
}
