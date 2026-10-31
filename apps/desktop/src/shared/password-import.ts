/**
 * Parses a password CSV the person exported from another browser's password manager (Chrome, Edge,
 * Brave: "name,url,username,password,note"; Firefox: "url,username,password,..."; others with the
 * same columns under different names). The file is plain text the person chose to export and pick;
 * Corvus only reads what they hand it. Pure, so the parsing is unit tested.
 */
import { originKeyOf } from "./credentials";

export interface ImportedLogin {
  origin: string;
  username: string;
  password: string;
  /** ms the password last changed, when the export says (Firefox's timePasswordChanged). */
  changedAt?: number;
}

/** A row left out of an export, by site and username (never its password), with why. */
export interface SkippedCsvRow {
  site: string;
  username: string;
  reason: "android" | "not-web" | "no-password";
}

export interface PasswordCsvResult {
  logins: ImportedLogin[];
  /** Rows skipped because they had no usable site or no password. */
  skipped: number;
  skippedRows: SkippedCsvRow[];
}

/** Splits CSV text into rows of fields, honouring quotes, escaped quotes and newlines in quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };
  // A leading byte-order mark would otherwise become part of the first header.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    started = true;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n") {
      endRow();
    } else if (c === "\r") {
      // Swallow CR; the LF (or end of input) closes the row.
    } else {
      field += c;
    }
  }
  if (started || field) endRow();
  return rows;
}

const URL_HEADERS = ["url", "login_uri", "website", "web site", "hostname", "origin"];
const USER_HEADERS = ["username", "login_username", "user", "login", "email"];
const PASS_HEADERS = ["password", "login_password", "pass"];
/** Firefox's export dates (ms): the change, else the last use, else the creation. */
const TIME_HEADERS = ["timepasswordchanged", "timelastused", "timecreated"];

function pick(header: string[], names: readonly string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const at = lower.indexOf(name);
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * The logins in an exported CSV: its header names the url, username and password columns. A row with
 * no usable http(s) site or no password is counted as skipped. Capped so a huge file cannot hang.
 */
export function parsePasswordCsv(text: string, max = 50_000): PasswordCsvResult {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) return { logins: [], skipped: 0, skippedRows: [] };
  const urlAt = pick(header, URL_HEADERS);
  const userAt = pick(header, USER_HEADERS);
  const passAt = pick(header, PASS_HEADERS);
  if (urlAt < 0 || passAt < 0) return { logins: [], skipped: rows.length, skippedRows: [] };
  const timeAts = TIME_HEADERS.map((name) => pick(header, [name])).filter((at) => at >= 0);
  const logins: ImportedLogin[] = [];
  const skippedRows: SkippedCsvRow[] = [];
  for (const row of rows.slice(0, max)) {
    if (row.length === 1 && row[0]!.trim() === "") continue;
    const rawUrl = (row[urlAt] ?? "").trim();
    const username = userAt >= 0 ? (row[userAt] ?? "").trim() : "";
    const password = row[passAt] ?? "";
    const app = /^android:\/\/[^@]*@([^/]+)/i.exec(rawUrl);
    const origin = app ? "" : originKeyOf(rawUrl) || originKeyOf(`https://${rawUrl.replace(/^\/+/, "")}`);
    if (!origin || password === "") {
      skippedRows.push({ site: app ? app[1]! : (origin ? new URL(origin).host : rawUrl.slice(0, 200)), username, reason: app ? "android" : !origin ? "not-web" : "no-password" });
      continue;
    }
    const changedAt = timeAts.map((at) => Number(row[at])).find((ms) => Number.isFinite(ms) && ms > 0);
    logins.push({ origin, username, password, ...(changedAt ? { changedAt } : {}) });
  }
  return { logins, skipped: skippedRows.length, skippedRows };
}

/** True when `text` starts with the header of a password export (a site column and a password column). */
export function isPasswordCsvHeader(text: string): boolean {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const header = parseCsv(firstLine)[0];
  return Boolean(header && pick(header, URL_HEADERS) >= 0 && pick(header, PASS_HEADERS) >= 0);
}
