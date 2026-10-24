import { describe, expect, it } from "vitest";
import { parseCsv, parsePasswordCsv } from "../src/shared/password-import";

describe("CSV parsing", () => {
  it("handles quotes, escaped quotes, commas and newlines inside fields", () => {
    const text = 'a,b,c\r\n1,"two, 2","line\none""two"\n,,\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1", "two, 2", 'line\none"two'],
      ["", "", ""],
    ]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("solo")).toEqual([["solo"]]);
  });

  it("drops a leading byte-order mark", () => {
    expect(parseCsv("﻿name,url")[0]).toEqual(["name", "url"]);
  });
});

describe("password CSV import", () => {
  it("reads a Chrome/Edge export (name,url,username,password,note)", () => {
    const csv = ["name,url,username,password,note", 'Example,https://example.com/login,ana,"p,w1",hi', "Shop,http://shop.example:8080/,bob,secret,", "Bad,not a url,x,y,"].join("\n");
    expect(parsePasswordCsv(csv)).toEqual({
      logins: [
        { origin: "https://example.com", username: "ana", password: "p,w1" },
        { origin: "http://shop.example:8080", username: "bob", password: "secret" },
      ],
      skipped: 1,
    });
  });

  it("reads a Firefox export and a bare host, and skips rows with no password", () => {
    const csv = ["url,username,password,httpRealm,formActionOrigin,guid", "https://a.example/,ana,pw,,,", "mail.example,bob,,,,", "https://c.example/,,pw2,,,"].join("\n");
    const result = parsePasswordCsv(csv);
    expect(result.logins).toEqual([
      { origin: "https://a.example", username: "ana", password: "pw" },
      { origin: "https://c.example", username: "", password: "pw2" },
    ]);
    expect(result.skipped).toBe(1);
  });

  it("skips everything when the header has no url or password column", () => {
    expect(parsePasswordCsv("foo,bar\n1,2\n3,4")).toEqual({ logins: [], skipped: 2 });
    expect(parsePasswordCsv("")).toEqual({ logins: [], skipped: 0 });
  });

  it("caps how many rows it reads", () => {
    const rows = ["url,username,password", ...Array.from({ length: 10 }, (_, i) => `https://s${i}.example/,u,p`)].join("\n");
    expect(parsePasswordCsv(rows, 4).logins).toHaveLength(4);
  });
});
