// Licence policy for third-party code shipped in the desktop app (see third-party-notices.mjs).
// Pure functions so they can be unit-tested (test/license-policy.test.ts).

/** Licences allowed in the packaged app. Corvus itself is MPL-2.0. */
export const ALLOWED_LICENSES = [
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "MPL-2.0",
  "0BSD",
  "Unlicense",
  "Python-2.0",
  "BlueOak-1.0.0",
];

/** Where the complete corresponding source of the packaged app lives. */
export const SOURCE_URL = "https://github.com/ParendumOU/Corvus";

/**
 * Copyleft accepted for the combined binary, by owner decision. The Corvus source stays MPL-2.0; the
 * installers and packaged app, as a combined work that includes these packages, are distributed
 * under the licence named here, with SOURCE_URL as the complete corresponding source. Pinned to the
 * exact version: an upgrade fails the build until the licence is reviewed again.
 */
export const ACCEPTED_COPYLEFT = {
  "electron-chrome-extensions@4.9.0": {
    license: "GPL-3.0-only",
    declared: "GPL-3.0-only OR LicenseRef-Patron",
    reason: "Dual licensed GPL-3.0 or the author's Patron License; Corvus uses it under GPL-3.0.",
  },
};

/** The accepted-copyleft entry for an exact package version, or null. */
export function acceptedCopyleft(name, version) {
  return ACCEPTED_COPYLEFT[`${name}@${version}`] ?? null;
}

const ALIASES = new Map([
  ["apache 2.0", "Apache-2.0"],
  ["apache-2", "Apache-2.0"],
  ["apache2", "Apache-2.0"],
  ["apache license 2.0", "Apache-2.0"],
  ["apache license, version 2.0", "Apache-2.0"],
  ["mit license", "MIT"],
  ["the mit license", "MIT"],
  ["isc license", "ISC"],
  ["bsd-2", "BSD-2-Clause"],
  ["bsd-3", "BSD-3-Clause"],
  ["mpl 2.0", "MPL-2.0"],
  ["the unlicense", "Unlicense"],
]);

/** The SPDX expression a package.json declares ("" when it declares none). */
export function licenseOf(pkg) {
  const value = pkg?.license ?? pkg?.licenses;
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.type === "string") return value.type.trim();
  if (Array.isArray(value)) {
    const types = value.map((l) => (typeof l === "string" ? l : l?.type)).filter((t) => typeof t === "string" && t.trim());
    return types.length > 1 ? `(${types.join(" OR ")})` : (types[0] ?? "").trim();
  }
  return "";
}

function normalizeId(id) {
  const plain = id.replace(/\+$/, "");
  const alias = ALIASES.get(plain.toLowerCase());
  if (alias) return alias;
  return ALLOWED_LICENSES.find((a) => a.toLowerCase() === plain.toLowerCase()) ?? plain;
}

function tokenize(expression) {
  return expression
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when an SPDX expression can be used under the allowlist: every AND part must be allowed and
 * at least one OR alternative must be ("MIT OR Apache-2.0", "(MIT AND ISC)"). "X WITH exception"
 * counts as X, since exceptions only add permissions. Unknown or empty expressions are not allowed.
 */
export function isAllowedLicense(expression, allowed = ALLOWED_LICENSES) {
  if (typeof expression !== "string" || !expression.trim()) return false;
  // Old-style names with spaces ("Apache 2.0", "MIT License") are whole-string aliases, not SPDX.
  const whole = ALIASES.get(expression.trim().toLowerCase());
  if (whole) return allowed.includes(whole);
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (t, op) => typeof t === "string" && t.toUpperCase() === op;

  function factor() {
    const t = next();
    if (t === undefined) throw new Error("unexpected end");
    if (t === "(") {
      const value = orExpr();
      if (next() !== ")") throw new Error("missing )");
      return value;
    }
    if (t === ")" || isOp(t, "AND") || isOp(t, "OR")) throw new Error(`unexpected ${t}`);
    const ok = allowed.includes(normalizeId(t));
    if (isOp(peek(), "WITH")) {
      next();
      if (next() === undefined) throw new Error("missing exception");
    }
    return ok;
  }
  function andExpr() {
    let value = factor();
    while (isOp(peek(), "AND")) {
      next();
      value = factor() && value;
    }
    return value;
  }
  function orExpr() {
    let value = andExpr();
    while (isOp(peek(), "OR")) {
      next();
      value = andExpr() || value;
    }
    return value;
  }

  try {
    const value = orExpr();
    return pos === tokens.length && value;
  } catch {
    return false;
  }
}

/** Splits a node_modules path into the package root it belongs to, or null outside node_modules. */
export function packageRootOf(id) {
  const clean = id.replace(/^\0/, "").replace(/\?.*$/, "").replace(/\\/g, "/");
  const marker = "/node_modules/";
  const at = clean.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = clean.slice(at + marker.length).split("/");
  if (!rest[0] || rest[0] === ".pnpm") return null;
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : rest[0];
  if (name.endsWith("/")) return null;
  return clean.slice(0, at + marker.length) + name;
}
