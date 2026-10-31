import { describe, expect, it } from "vitest";
import { isPasswordCsvHeader, parseCsv, parsePasswordCsv } from "../src/shared/password-import";

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
      skippedRows: [{ site: "not a url", username: "x", reason: "not-web" }],
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
    expect(parsePasswordCsv("foo,bar\n1,2\n3,4")).toEqual({ logins: [], skipped: 2, skippedRows: [] });
    expect(parsePasswordCsv("")).toEqual({ logins: [], skipped: 0, skippedRows: [] });
  });

  it("caps how many rows it reads", () => {
    const rows = ["url,username,password", ...Array.from({ length: 10 }, (_, i) => `https://s${i}.example/,u,p`)].join("\n");
    expect(parsePasswordCsv(rows, 4).logins).toHaveLength(4);
  });
});

describe("password exports with dates and app logins", () => {
  it("keeps Firefox's change date, falling back to the last use", () => {
    const csv = [
      '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"',
      '"https://a.example.org","ana","pw","","","{1}","1000","3000","2000"',
      '"https://b.example.org","bob","pw2","","","{2}","1000","3000","0"',
    ].join("\n");
    expect(parsePasswordCsv(csv).logins.map((l) => l.changedAt)).toEqual([2000, 3000]);
  });

  it("lists skipped rows by site and username with the reason", () => {
    const csv = ["name,url,username,password,note", "App,android://AAAA@app.example.org/,ana,pw,", "Empty,https://c.example.org/,cy,,"].join("\n");
    expect(parsePasswordCsv(csv).skippedRows).toEqual([
      { site: "app.example.org", username: "ana", reason: "android" },
      { site: "c.example.org", username: "cy", reason: "no-password" },
    ]);
  });

  it("recognises a password export by its header only", () => {
    expect(isPasswordCsvHeader("name,url,username,password,note\nX,https://x.example,u,p,")).toBe(true);
    expect(isPasswordCsvHeader('\uFEFF"url","username","password"')).toBe(true);
    expect(isPasswordCsvHeader("date,amount,description")).toBe(false);
    expect(isPasswordCsvHeader("")).toBe(false);
  });
});
