import { describe, expect, it } from "vitest";
import { reviveHeldTempPaths } from "../src/shared/downloads";

describe("held download temporary files swept at startup", () => {
  it("keeps absolute paths to files named like a held download", () => {
    const paths = ["C:\\Users\\a\\Downloads\\Unconfirmed 123456.crdownload", "/home/a/Downloads/Unconfirmed 654321.crdownload"];
    expect(reviveHeldTempPaths(paths)).toEqual(paths);
  });

  it("drops anything else, so a changed file can never make it remove other files", () => {
    expect(
      reviveHeldTempPaths([
        "C:\\Users\\a\\Documents\\report.docx",
        "/home/a/Downloads/Unconfirmed 123456.crdownload/..",
        "/home/a/Downloads/Unconfirmed 12345.crdownload",
        "/home/a/Downloads/Unconfirmed 123456.crdownload.exe",
        "Unconfirmed 123456.crdownload",
        "../Unconfirmed 123456.crdownload",
        "/home/a/Downloads/",
        42,
        null,
      ]),
    ).toEqual([]);
    expect(reviveHeldTempPaths({ paths: ["/home/a/Downloads/Unconfirmed 123456.crdownload"] })).toEqual([]);
  });
});
