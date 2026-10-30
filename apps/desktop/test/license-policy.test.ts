import { describe, expect, it } from "vitest";
import { ACCEPTED_COPYLEFT, ALLOWED_LICENSES, SOURCE_URL, acceptedCopyleft, isAllowedLicense, licenseOf, packageRootOf } from "../scripts/license-policy.mjs";

describe("isAllowedLicense", () => {
  it("accepts every allowlisted licence, case-insensitively", () => {
    for (const id of ALLOWED_LICENSES) expect(isAllowedLicense(id)).toBe(true);
    expect(isAllowedLicense("mit")).toBe(true);
    expect(isAllowedLicense("Apache 2.0")).toBe(true);
    expect(isAllowedLicense("Python-2.0")).toBe(true);
    expect(isAllowedLicense("BlueOak-1.0.0")).toBe(true);
  });

  it("accepts OR expressions when one side is allowed and AND only when all are", () => {
    expect(isAllowedLicense("MIT OR Apache-2.0")).toBe(true);
    expect(isAllowedLicense("(MIT OR Apache-2.0)")).toBe(true);
    expect(isAllowedLicense("(GPL-3.0-only OR MIT)")).toBe(true);
    expect(isAllowedLicense("(MIT AND ISC)")).toBe(true);
    expect(isAllowedLicense("(MIT AND Zlib)")).toBe(false);
    expect(isAllowedLicense("Apache-2.0 WITH LLVM-exception")).toBe(true);
  });

  it("refuses copyleft, unknown, custom and malformed licences", () => {
    for (const bad of ["GPL-3.0-only", "AGPL-3.0", "LGPL-2.1", "SEE LICENSE IN LICENSE.md", "UNLICENSED", "CC-BY-4.0", "", "MIT OR", "(MIT", "AND MIT"]) {
      expect(isAllowedLicense(bad), bad).toBe(false);
    }
    expect(isAllowedLicense(undefined)).toBe(false);
  });
});

describe("licenseOf", () => {
  it("reads the license field in its old and new forms", () => {
    expect(licenseOf({ license: "MIT" })).toBe("MIT");
    expect(licenseOf({ license: { type: "ISC" } })).toBe("ISC");
    expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("(MIT OR Apache-2.0)");
    expect(licenseOf({})).toBe("");
  });
});

describe("acceptedCopyleft", () => {
  it("only covers the exact reviewed versions: electron-chrome-extensions under GPL-3.0, 7z-wasm and libheif-js under LGPL", () => {
    expect(acceptedCopyleft("electron-chrome-extensions", "4.9.0")?.license).toBe("GPL-3.0-only");
    expect(acceptedCopyleft("electron-chrome-extensions", "4.9.1")).toBeNull();
    expect(acceptedCopyleft("argparse", "2.0.1")).toBeNull();
    expect(acceptedCopyleft("7z-wasm", "1.2.0")?.license).toBe("LGPL-2.1-or-later");
    expect(acceptedCopyleft("7z-wasm", "1.2.1")).toBeNull();
    expect(acceptedCopyleft("libheif-js", "1.23.5")?.license).toBe("LGPL-3.0-only");
    expect(acceptedCopyleft("libheif-js", "1.23.6")).toBeNull();
    expect(Object.keys(ACCEPTED_COPYLEFT)).toEqual(["electron-chrome-extensions@4.9.0", "7z-wasm@1.2.0", "libheif-js@1.23.5"]);
    expect(SOURCE_URL).toBe("https://github.com/ParendumOU/Corvus");
  });
});

describe("packageRootOf", () => {
  it("finds the package directory of a bundled module, scoped or not, including pnpm paths", () => {
    expect(packageRootOf("/w/node_modules/.pnpm/react@18.3.1/node_modules/react/cjs/react.production.js")).toBe(
      "/w/node_modules/.pnpm/react@18.3.1/node_modules/react",
    );
    expect(packageRootOf("/w/node_modules/@scope/pkg/dist/index.js?commonjs-proxy")).toBe("/w/node_modules/@scope/pkg");
    expect(packageRootOf("\0/w/node_modules/a/node_modules/b/index.js")).toBe("/w/node_modules/a/node_modules/b");
    expect(packageRootOf("C:\\w\\node_modules\\qr\\decode.js")).toBe("C:/w/node_modules/qr");
    expect(packageRootOf("/w/apps/desktop/src/main/index.ts")).toBeNull();
  });
});
