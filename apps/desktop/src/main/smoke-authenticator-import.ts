import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialog, nativeImage, nativeTheme, type WebContents } from "electron";
import type { AuthenticatorPreview, PhotoReport } from "../shared/authenticator-import";
import { encodeMigrationPayload, migrationUri, type MigrationOtpInput } from "../shared/authenticator-migration";
import { base32Encode, totpCode, type TotpConfig } from "../shared/totp";
import { addPhotos, authenticatorPreview, discardAuthenticatorImport, readAuthenticatorPhoto } from "./authenticator-import";
import type { AppContext } from "./context";
import { createKdbx, openKdbx } from "./keepass-format";
import { dropdownDriver } from "./smoke-otp-fill";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  /** The smoke server (its /login and /2fa pages). */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(120);
  }
  return false;
}

const js = <T>(wc: WebContents, expr: string): Promise<T | null> => (wc.isDestroyed() ? Promise.resolve(null) : (wc.executeJavaScript(expr, true) as Promise<T>).catch(() => null));

/** A made-up 20-byte secret per seed below 256 (seeds 256 apart give the same one): no real account's. */
const fakeSecret = (seed: number): Uint8Array => Uint8Array.from({ length: 20 }, (_, i) => (seed * 53 + i * 29 + 7) & 0xff);

const config = (secret: Uint8Array, algorithm: TotpConfig["algorithm"] = "SHA1", digits = 6): TotpConfig => ({ secret: base32Encode(secret), algorithm, digits, period: 30 });

const CODES = 12;
const FILLER = 108;

/** The accounts of the fake export: special cases first (QR 1), then filler accounts on made-up domains. */
function exportAccounts(): MigrationOtpInput[] {
  const special: MigrationOtpInput[] = [
    { secret: fakeSecret(1), name: "GitHub:octo-smoke", issuer: "GitHub" },
    { secret: fakeSecret(2), name: "conflict-smoke@example.com", issuer: "Google" },
    { secret: fakeSecret(3), name: "Some One#1234", issuer: "Discord" },
    { secret: fakeSecret(4), name: "GitLab:same-smoke", issuer: "GitLab" },
    { secret: fakeSecret(5), name: "ops", issuer: "Acme Intranet" },
    { secret: fakeSecret(6), name: "Bank:counter", issuer: "Bank", type: 1, counter: 4 },
    { secret: fakeSecret(7), name: "Proton:smoke@example.org", issuer: "Proton", algorithm: 2, digits: 2 },
    // "Issuer - address" labels: the address is the account (it matches a login), the rest the issuer.
    { secret: fakeSecret(8), name: "Bitbucket - bit-smoke@example.com" },
    // Already in the vault from an import before that parsing: a 2FA-only login under the whole label.
    { secret: fakeSecret(9), name: "Portal Org - portal-smoke@example.org" },
    { secret: fakeSecret(10), name: "Team Wiki | wiki-smoke@example.org" },
  ];
  const filler = Array.from({ length: FILLER }, (_, n) => ({ secret: fakeSecret(100 + n), name: `user${n}@example.com`, issuer: `svc${n}.example` }));
  return [...special, ...filler];
}

// ------------------------------------------------------------------ photos of a screen, synthesized

/** Projective map of the unit square onto a quad (tl, tr, br, bl), inverted: image point -> square. */
function quadToSquare(q: Array<[number, number]>): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q as [[number, number], [number, number], [number, number], [number, number]];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det, h = (dx1 * sy - sx * dy1) / det;
  const [a, b, c, d, e, f, i] = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, 1];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const n = a * A + b * B + c * C;
  return [A / n, -(b * i - c * h) / n, (b * f - c * e) / n, B / n, (a * i - c * g) / n, -(a * f - c * d) / n, C / n, -(a * h - b * g) / n, (a * e - b * d) / n];
}

interface PhotoLook {
  seed: number;
  /** Share of the shorter side the code (with its quiet zone) covers. */
  size: number;
  /** Keystone: how much wider the bottom edge is than the top one. */
  tilt: number;
  rotate: number;
  glare: number;
  noise: number;
  /** A dark theme: light modules on a dark screen. */
  dark?: boolean;
}

/**
 * A JPEG like a phone photo of a screen showing `text` as a QR code: tilted in perspective, turned,
 * with a glare spot, sensor noise and a soft edge, on a dark bezel (or all negative, for a dark theme).
 * Null text: the screen without a code.
 */
async function writePhoto(dir: string, name: string, text: string | null, look: PhotoLook, width = 3264, height = 2448): Promise<string> {
  const { default: encodeQR } = await import("qr");
  const modules = text ? encodeQR(text, "raw", { ecc: "low" }) : [];
  let s = look.seed >>> 0;
  const rand = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const n = modules.length, quiet = 4, total = n + quiet * 2;
  const cx = width / 2 + (rand() - 0.5) * width * 0.08, cy = height / 2 + (rand() - 0.5) * height * 0.08;
  const half = (Math.min(width, height) * look.size) / 2;
  const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([u, v], k): [number, number] => {
    const x = u * half * (1 + (k < 2 ? -look.tilt : look.tilt) / 2), y = v * half;
    return [cx + x * Math.cos(look.rotate) - y * Math.sin(look.rotate), cy + x * Math.sin(look.rotate) + y * Math.cos(look.rotate)];
  });
  const m = quadToSquare(corners);
  const gx = width * (0.3 + rand() * 0.4), gy = height * (0.3 + rand() * 0.4), gr = Math.min(width, height) * 0.35;
  const screenHalf = half * 1.25;
  const bgra = Buffer.alloc(width * height * 4);
  let prev = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = m[6]! * x + m[7]! * y + m[8]!;
      const u = (m[0]! * x + m[1]! * y + m[2]!) / w, v = (m[3]! * x + m[4]! * y + m[5]!) / w;
      let lum: number;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) {
        const mx = Math.floor(u * total) - quiet, my = Math.floor(v * total) - quiet;
        lum = mx >= 0 && my >= 0 && mx < n && my < n && modules[my]![mx] ? 38 : 228;
      } else {
        lum = Math.abs(x - cx) < screenHalf * 1.4 && Math.abs(y - cy) < screenHalf ? 222 : 55 + (30 * y) / height;
      }
      const d = Math.hypot(x - gx, y - gy) / gr;
      lum += look.glare * 90 * Math.max(0, 1 - d * d);
      // A one-pixel smear along the row stands in for lens softness.
      const soft = (lum + prev) / 2;
      prev = lum;
      const lit = Math.max(0, Math.min(255, soft + (rand() - 0.5) * 2 * look.noise));
      const value = look.dark ? 255 - lit : lit;
      const o = (y * width + x) * 4;
      bgra[o] = Math.min(255, value * 1.04);
      bgra[o + 1] = value;
      bgra[o + 2] = value * 0.97;
      bgra[o + 3] = 255;
    }
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width, height }).toJPEG(88));
  return file;
}

/** A clean screenshot of a site's setup QR code (PNG). */
async function writeSetupPng(dir: string, text: string): Promise<string> {
  const { default: encodeQR } = await import("qr");
  const modules = encodeQR(text, "raw");
  const scale = 6, quiet = 4, size = (modules.length + quiet * 2) * scale;
  const bgra = Buffer.alloc(size * size * 4, 255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) bgra.writeUInt32LE(0xff000000, (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4);
    }),
  );
  const file = path.join(dir, "setup-screenshot.png");
  fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width: size, height: size }).toPNG());
  return file;
}

/** Codes valid around now for a config (previous, current, next window), to tolerate a rollover. */
async function nearbyCodes(c: TotpConfig): Promise<string[]> {
  const now = Date.now();
  return Promise.all([-30_000, 0, 30_000].map(async (o) => (await totpCode(c, now + o)).code));
}

/**
 * Import from Google Authenticator, end to end: twelve phone-like photos of a 115-account export (plus
 * a photo taken twice, one without a code and a setup screenshot) go through the Passwords page with
 * the file picker stubbed; the preview, the import and the vault's 2FA generators are checked.
 */
export async function runAuthenticatorImportSmoke(ctx: AppContext, { url, win, check, capture }: Helpers): Promise<void> {
  const vault = win.profile.credentials;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-ga-"));
  const accounts = exportAccounts();
  const perCode = Math.ceil(accounts.length / CODES);
  const texts = Array.from({ length: CODES }, (_, i) => migrationUri(encodeMigrationPayload(accounts.slice(i * perCode, (i + 1) * perCode), { batchSize: CODES, batchIndex: i, batchId: -987_654_321 })));
  const started = Date.now();
  const files: string[] = [];
  for (const [i, text] of texts.entries()) {
    files.push(await writePhoto(dir, `IMG_${2040 + i}.jpg`, text, { seed: 40 + i, size: 0.5 + (i % 4) * 0.06, tilt: (i % 3) * 0.06, rotate: ((i % 5) - 2) * 0.06, glare: (i % 4) * 0.2, noise: 8 + (i % 3) * 4, dark: i === 9 }));
  }
  const again = path.join(dir, "IMG_2043 (copy).jpg");
  fs.copyFileSync(files[3]!, again);
  const blank = await writePhoto(dir, "IMG_2099.jpg", null, { seed: 99, size: 0.5, tilt: 0, rotate: 0, glare: 0.5, noise: 10 });
  const setupConfig = config(fakeSecret(250));
  const setup = await writeSetupPng(dir, `otpauth://totp/Fastmail:setup-smoke@example.com?secret=${setupConfig.secret}&issuer=Fastmail`);
  const picked = [...files, again, blank, setup];
  check("authenticator smoke photos written", picked.every((f) => fs.statSync(f).size > 1000), { photos: picked.length, ms: Date.now() - started });

  // Logins the accounts should find: by username, the only login of a site, a conflict, an equal 2FA.
  const github = vault.add({ origin: "https://github.com", username: "octo-smoke", password: "pw-github" });
  const google = vault.add({ origin: "https://accounts.google.com", username: "conflict-smoke@example.com", password: "pw-google", totp: config(fakeSecret(222)) });
  const discord = vault.add({ origin: "https://discord.com", username: "someone@example.com", password: "pw-discord" });
  const gitlab = vault.add({ origin: "https://gitlab.com", username: "same-smoke", password: "pw-gitlab", totp: config(fakeSecret(4)) });
  const bitbucket = vault.add({ origin: "https://bitbucket.org", username: "bit-smoke@example.com", password: "pw-bitbucket" });
  // What an import before the label parsing made of two of the accounts (sites the person typed then).
  const portal = vault.add({ origin: "https://portal.example.org", username: "portal-smoke@example.org", password: "pw-portal" });
  const portalOld = vault.add({ origin: "https://portal.example.org", username: "Portal Org - portal-smoke@example.org", password: "", totp: config(fakeSecret(9)) });
  const wikiOld = vault.add({ origin: "https://wiki.example.net", username: "Team Wiki | wiki-smoke@example.org", password: "", totp: config(fakeSecret(10)) });

  // The main-process side alone: what the page receives carries no secret.
  const profileId = win.profile.profile.id;
  const direct = addPhotos(profileId, null, [files[0]!, files[1]!]);
  const firstReport = await readAuthenticatorPhoto(profileId, direct.importId, 0);
  await readAuthenticatorPhoto(profileId, direct.importId, 1);
  const directPreview: AuthenticatorPreview = authenticatorPreview(profileId, direct.importId, { vault }, {});
  const payload = JSON.stringify([firstReport, directPreview]);
  const secrets = accounts.map((a) => base32Encode(a.secret));
  check("authenticator preview never carries a secret", directPreview.rows.length > 10 && !secrets.some((sec) => payload.includes(sec)), { rows: directPreview.rows.length });
  check("authenticator preview reports missing QR codes", directPreview.missing[0]?.missing.length === CODES - 2, directPreview.missing);
  discardAuthenticatorImport(direct.importId);

  // The page, with the file picker answering with the photos.
  const showOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: picked })) as typeof dialog.showOpenDialog;
  try {
    const tab = win.createTab("corvus://passwords");
    const wc = tab.view.webContents;
    await until(() => js<boolean>(wc, "Boolean(window.corvusInternal && document.querySelector('.page-toolbar .btn'))").then(Boolean));
    const opened = await js<boolean>(wc, `(() => { const b = [...document.querySelectorAll('.page-toolbar .btn')].find((x) => x.textContent.includes('Google Authenticator')); b?.click(); return Boolean(b); })()`);
    await until(() => js<boolean>(wc, "Boolean(document.querySelector('.ga-import .ga-steps'))").then(Boolean));
    check("authenticator import opens from the Passwords toolbar", opened === true);
    await capture("authenticator-import-start", wc);

    const readStart = Date.now();
    await js(wc, `document.querySelector('.ga-import .btn.primary').click()`);
    const sawProgress = await until(() => js<boolean>(wc, "/Reading photo \\d+ of 15/.test(document.querySelector('.ga-reading')?.textContent ?? '')").then(Boolean), 10_000);
    await until(() => js<boolean>(wc, "/Reading photo (\\d{2}|[5-9]) of 15/.test(document.querySelector('.ga-reading')?.textContent ?? '')").then(Boolean), 5000);
    await capture("authenticator-import-reading", wc);
    const previewShown = await until(() => js<boolean>(wc, "Boolean(document.querySelector('.ga-table'))").then(Boolean), 120_000);
    check("authenticator import reads the photos one by one with progress", sawProgress && previewShown, { ms: Date.now() - readStart });

    const photoLines = (await js<Array<{ name: string; status: string; cls: string }>>(wc, `[...document.querySelectorAll('.ga-photo-list li')].map((li) => ({ name: li.querySelector('.ga-photo-name').textContent, status: li.querySelector('.ga-photo-status').textContent, cls: li.className }))`)) ?? [];
    const batches = photoLines.filter((l) => /^QR \d+ of 12: \d+ accounts$/.test(l.status));
    check("authenticator import reads all 12 export photos", batches.length === CODES, photoLines);
    check(
      "authenticator import flags the photo taken twice, the photo without a code and the setup code",
      photoLines.some((l) => l.name.includes("(copy)") && /QR 4 of 12: already read, ignored/.test(l.status)) &&
        photoLines.some((l) => l.name === "IMG_2099.jpg" && l.cls === "bad" && /No QR code found/.test(l.status)) &&
        photoLines.some((l) => l.name === "setup-screenshot.png" && /Setup code for Fastmail: setup-smoke@example.com/.test(l.status)),
      photoLines.slice(-4),
    );

    const rowsOf = (): Promise<Array<{ issuer: string; account: string; site: string; what: string; cls: string; checked: boolean; disabled: boolean; readOnly: boolean }> | null> =>
      js(wc, `[...document.querySelectorAll('.ga-row:not(.ga-head)')].map((r) => ({ issuer: r.querySelector('.ga-account strong').textContent, account: r.querySelector('.ga-account .muted').textContent, site: r.querySelector('.ga-site').value, what: r.querySelector('.ga-what').textContent, cls: r.className, checked: r.querySelector('input[type=checkbox]').checked, disabled: r.querySelector('input[type=checkbox]').disabled, readOnly: r.querySelector('.ga-site').readOnly }))`);
    const rows = (await rowsOf()) ?? [];
    const row = (issuer: string) => rows.find((r) => r.issuer === issuer);
    check("authenticator preview lists every importable account", rows.length === accounts.length - 1 + 1, { rows: rows.length });
    check("authenticator preview matches a login by username", /Adds 2FA to your login octo-smoke on github\.com/.test(row("GitHub")?.what ?? "") && row("GitHub")?.checked === true, row("GitHub"));
    check("authenticator preview uses the only login of a site", /Adds 2FA to your login someone@example\.com on discord\.com/.test(row("Discord")?.what ?? "") && row("Discord")?.checked === true, row("Discord"));
    check("authenticator preview marks a different 2FA as a conflict, off", (row("Google")?.cls ?? "").includes("replace") && row("Google")?.checked === false, row("Google"));
    check("authenticator preview knows an equal 2FA is already there", (row("GitLab")?.cls ?? "").includes("same") && row("GitLab")?.disabled === true, row("GitLab"));
    check("authenticator preview asks for the site of an unknown issuer", (row("Acme Intranet")?.cls ?? "").includes("needs-site") && row("Acme Intranet")?.disabled === true, row("Acme Intranet"));
    check("authenticator preview creates 2FA-only logins on the issuer's site", row("Proton")?.site === "https://account.proton.me" && /New login \(2FA only\)/.test(row("Proton")?.what ?? ""), row("Proton"));
    check(
      "authenticator preview reads an 'Issuer - address' label and matches the login of the address",
      row("Bitbucket")?.account === "bit-smoke@example.com" && /Adds 2FA to your login bit-smoke@example\.com on bitbucket\.org/.test(row("Bitbucket")?.what ?? "") && row("Bitbucket")?.checked === true,
      row("Bitbucket"),
    );
    const portalRow = row("Portal Org");
    check(
      "authenticator preview moves a 2FA an earlier import kept under the whole label to the login, on the site typed then",
      (portalRow?.cls ?? "").includes("move") && portalRow?.checked === true && portalRow.readOnly && portalRow.site === "https://portal.example.org" &&
        /Moves the 2FA from the earlier import to your login portal-smoke@example\.org on portal\.example\.org and removes that entry/.test(portalRow.what),
      portalRow,
    );
    const wikiRow = row("Team Wiki");
    check(
      "authenticator preview fixes the name of an earlier 2FA-only login in place",
      (wikiRow?.cls ?? "").includes("fix") && wikiRow?.checked === true && wikiRow.readOnly && wikiRow.site === "https://wiki.example.net" &&
        /Fixes the 2FA-only login from the earlier import: it becomes wiki-smoke@example\.org on wiki\.example\.net/.test(wikiRow.what),
      wikiRow,
    );
    const counts = await js<string>(wc, `[...document.querySelectorAll('.ga-chip')].map((c) => c.textContent).join(' | ')`);
    const skipped = await js<string>(wc, `document.querySelector('.ga-skipped summary')?.textContent ?? ''`);
    check(
      "authenticator preview counts rows and lists skipped HOTP accounts",
      /All 118/.test(counts ?? "") && /Matched 3/.test(counts ?? "") && /Repairs 2/.test(counts ?? "") && /Conflicts 1/.test(counts ?? "") && /1 account cannot be imported/.test(skipped ?? ""),
      { counts, skipped },
    );
    const text = (await js<string>(wc, "document.body.innerText")) ?? "";
    check("authenticator page shows no secret", !secrets.some((sec) => text.includes(sec)));

    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await js(wc, "window.scrollTo(0, 0)");
      await sleep(400);
      await capture(`authenticator-import-preview-${theme}`, wc);
      await js(wc, "document.querySelector('.ga-toolbar').scrollIntoView()");
      await sleep(400);
      await capture(`authenticator-import-rows-${theme}`, wc);
    }
    await js(wc, "window.scrollTo(0, 0)");
    nativeTheme.themeSource = "system";

    // The person types the intranet's site, ticks the conflict, filters, and imports.
    await js(wc, `(() => {
      const input = [...document.querySelectorAll('.ga-row')].find((r) => r.querySelector('.ga-account strong')?.textContent === 'Acme Intranet').querySelector('.ga-site');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'intranet.acme.example');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const typed = await until(async () => {
      const r = ((await rowsOf()) ?? []).find((x) => x.issuer === "Acme Intranet");
      return Boolean(r && r.cls.includes("create") && r.checked);
    });
    check("authenticator preview re-plans a row when its site is typed", typed, ((await rowsOf()) ?? []).find((x) => x.issuer === "Acme Intranet"));
    await js(wc, `[...document.querySelectorAll('.ga-row')].find((r) => r.querySelector('.ga-account strong')?.textContent === 'Google').querySelector('input[type=checkbox]').click()`);
    await js(wc, `(() => { const f = document.querySelector('.ga-filter'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, 'svc1'); f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(200);
    const filtered = ((await rowsOf()) ?? []).length;
    // Every account (the setup code too) but the HOTP one and the equal 2FA, the conflict ticked by hand.
    const importable = accounts.length - 1 + 1 - 1;
    await js(wc, `[...document.querySelectorAll('.ga-toolbar .btn')].find((b) => b.textContent === 'Select none').click()`);
    await sleep(100);
    const label = await js<string>(wc, `document.querySelector('.ga-foot .btn.primary').textContent`);
    check("authenticator preview filters rows and selects none of the shown ones", filtered > 5 && filtered < 30 && label === `Import ${importable - filtered} accounts`, { filtered, label });
    await js(wc, `[...document.querySelectorAll('.ga-toolbar .btn')].find((b) => b.textContent === 'Select all').click()`);
    await sleep(100);
    const allLabel = await js<string>(wc, `document.querySelector('.ga-foot .btn.primary').textContent`);
    check("authenticator preview selects every shown row again", allLabel === `Import ${importable} accounts`, allLabel);
    await js(wc, `document.querySelector('.ga-foot .btn.primary').click()`);
    const done = await until(() => js<boolean>(wc, "Boolean(document.querySelector('.ga-result'))").then(Boolean), 30_000);
    const result = await js<string>(wc, `document.querySelector('.ga-import .card-body').innerText`);
    check(
      "authenticator import reports what it did and asks to delete the photos",
      done && /Added 2FA to 5 logins, created 111\. Repaired 2 logins from an earlier import\./.test(result ?? "") && /delete the photos/.test(result ?? ""),
      result,
    );
    await sleep(500);
    await capture("authenticator-import-done", wc);

    // The vault: matched logins got the 2FA, new logins hold only the 2FA, codes as totpCode computes them.
    const same = async (a: TotpConfig | undefined, b: TotpConfig): Promise<boolean> =>
      Boolean(a) && JSON.stringify(a) === JSON.stringify(b) && (await nearbyCodes(a!)).includes((await totpCode(b)).code);
    check("authenticator import adds the 2FA to the login matched by username", await same(vault.get(github.id)?.totp, config(fakeSecret(1))) && vault.get(github.id)?.password === "pw-github");
    check("authenticator import adds the 2FA to the only login of a site", await same(vault.get(discord.id)?.totp, config(fakeSecret(3))));
    check("authenticator import replaces a conflicting 2FA when ticked", await same(vault.get(google.id)?.totp, config(fakeSecret(2))));
    check("authenticator import leaves an equal 2FA as it was", await same(vault.get(gitlab.id)?.totp, config(fakeSecret(4))));
    const created = vault.all().filter((c) => c.password === "" && c.totp);
    const proton = created.find((c) => c.origin === "https://account.proton.me" && c.username === "smoke@example.org");
    const intranet = created.find((c) => c.origin === "https://intranet.acme.example" && c.username === "ops");
    const filler = created.filter((c) => /^https:\/\/svc\d+\.example$/.test(c.origin));
    check("authenticator import creates 2FA-only logins with the right settings", (await same(proton?.totp, config(fakeSecret(7), "SHA256", 8))) && (await same(intranet?.totp, config(fakeSecret(5)))), { proton: Boolean(proton), intranet: Boolean(intranet) });
    check("authenticator import creates every filler account once", filler.length === FILLER && new Set(filler.map((c) => c.origin)).size === FILLER && (await same(filler.find((c) => c.origin === "https://svc42.example")?.totp, config(fakeSecret(142)))), { filler: filler.length });
    check("authenticator import takes a setup code from the same selection", await same(created.find((c) => c.origin === "https://app.fastmail.com")?.totp, setupConfig));
    check("authenticator import skips counter-based accounts", !vault.all().some((c) => c.username === "counter"));
    check("authenticator import adds the 2FA of an 'Issuer - address' label to the address's login", await same(vault.get(bitbucket.id)?.totp, config(fakeSecret(8))));
    check(
      "authenticator import moves the 2FA to the login and removes the earlier 2FA-only entry",
      (await same(vault.get(portal.id)?.totp, config(fakeSecret(9)))) && vault.get(portal.id)?.password === "pw-portal" && !vault.get(portalOld.id),
      { moved: Boolean(vault.get(portal.id)?.totp), removed: !vault.get(portalOld.id) },
    );
    const wiki = vault.get(wikiOld.id);
    check(
      "authenticator import fixes the earlier entry's name and keeps its site and 2FA",
      wiki?.username === "wiki-smoke@example.org" && wiki.origin === "https://wiki.example.net" && wiki.password === "" && (await same(wiki.totp, config(fakeSecret(10)))),
      { username: wiki?.username, origin: wiki?.origin },
    );
    const list = await until(() => js<boolean>(wc, `document.querySelectorAll(".pw-list > .list-row").length === 25 && document.querySelector(".pw-list .pager .muted")?.textContent === "1-25 of ${vault.all().length}"`).then(Boolean));
    check("Passwords list shows the imported logins, 25 at a time", list, await js<string>(wc, `document.querySelector(".pw-list .pager .muted")?.textContent ?? ""`));
    await passwordsTabsSmoke(tab, { win, check, capture });

    // The same photos again: every account is found by its 2FA, on the site it has, and nothing is asked or changed.
    const before = JSON.stringify(vault.all());
    const again = addPhotos(profileId, null, [files[0]!]);
    await readAuthenticatorPhoto(profileId, again.importId, 0);
    const second = authenticatorPreview(profileId, again.importId, { vault }, {});
    discardAuthenticatorImport(again.importId);
    const intranetRow = second.rows.find((r) => r.issuer === "Acme Intranet");
    check(
      "a second import of the same photos asks for no site and has nothing to change",
      second.rows.length === 9 && second.rows.every((r) => r.action === "same" && r.siteKnown && !r.selected) && intranetRow?.site === "https://intranet.acme.example" && JSON.stringify(vault.all()) === before,
      second.rows.map((r) => [r.issuer, r.action, r.site]),
    );
  } finally {
    dialog.showOpenDialog = showOpenDialog;
    nativeTheme.themeSource = "system";
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await fieldMenuSmoke(ctx, url.replace(/\/$/, ""), { win, check, capture });
  await heicKeePassSmoke(ctx, url.replace(/\/$/, ""), { win, check, capture });
}

/** The made-up secrets of the accounts in test/fixtures/heic/export-photo.heic (see test/heic.test.ts). */
const heicConfig = (seed: number): TotpConfig => config(Uint8Array.from({ length: 20 }, (_, i) => (seed * 41 + i * 13 + 5) & 0xff));

/**
 * An iPhone photo (HEIC) in a folder, imported into a KeePass database: the folder pick finds the
 * .HEIC and .heif photos (and skips the rest), the QR code is read in the decoder process, the
 * account whose site and username match an entry of an unlocked database goes to that entry (the
 * other one's entry already has its 2FA), a locked database is pointed out, and after the import the
 * entry has the 2FA in its file (with a .bak copy) and Corvus fills its code on the site.
 */
async function heicKeePassSmoke(ctx: AppContext, base: string, { win, check, capture }: Omit<Helpers, "url">): Promise<void> {
  const kp = win.profile.keepass;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-ga-heic-"));
  const photos = path.join(dir, "photos");
  fs.mkdirSync(photos);
  const fixture = path.resolve(process.cwd(), "test/fixtures/heic/export-photo.heic");
  fs.copyFileSync(fixture, path.join(photos, "IMG_3001.HEIC"));
  fs.copyFileSync(fixture, path.join(photos, "IMG_3002.heif"));
  fs.writeFileSync(path.join(photos, "notes.txt"), "not a photo");
  const file = path.join(dir, "Smoke KeePass.kdbx");
  const locked = path.join(dir, "Locked KeePass.kdbx");
  const fast = { memoryKiB: 4096, iterations: 1, totpFields: "keepassxc" as const };
  fs.writeFileSync(
    file,
    await createKdbx(
      [
        { title: "HEIC smoke login", username: "heic-smoke@example.com", password: "kp-heic-smoke", url: base },
        { title: "heic.example.org", username: "heic-second@example.org", password: "kp-heic-second", url: "https://heic.example.org", totp: heicConfig(2) },
      ],
      "kp-heic-master",
      fast,
    ),
  );
  fs.writeFileSync(locked, await createKdbx([{ title: "Elsewhere", username: "someone@example.org", password: "kp-locked", url: "https://locked.example.org" }], "kp-locked-master", fast));
  const showOpenDialog = dialog.showOpenDialog;
  try {
    kp.addSources([file, locked], "file");
    const dbId = kp.databases().find((d) => d.path === file)?.id ?? "";
    check("KeePass database for the HEIC import unlocks", (await kp.unlock(dbId, "kp-heic-master", null, false)).ok);
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [photos] })) as typeof dialog.showOpenDialog;

    const tab = win.createTab("corvus://passwords");
    const wc = tab.view.webContents;
    await until(() => js<boolean>(wc, "Boolean(window.corvusInternal && document.querySelector('.page-toolbar .btn'))").then(Boolean));
    await js(wc, `[...document.querySelectorAll('.page-toolbar .btn')].find((x) => x.textContent.includes('Google Authenticator'))?.click()`);
    await until(() => js<boolean>(wc, "Boolean(document.querySelector('.ga-import .ga-steps'))").then(Boolean));
    await js(wc, `[...document.querySelectorAll('.ga-import .pw-actions .btn')].find((b) => b.textContent.includes('Choose a folder')).click()`);
    const shown = await until(() => js<boolean>(wc, "Boolean(document.querySelector('.ga-table'))").then(Boolean), 60_000);
    const photoLines = (await js<string[]>(wc, `[...document.querySelectorAll('.ga-photo-list li')].map((li) => li.querySelector('.ga-photo-name').textContent + ': ' + li.querySelector('.ga-photo-status').textContent)`)) ?? [];
    check(
      "the folder pick takes HEIC and HEIF photos and reads the export code in an iPhone photo",
      shown && photoLines.length === 2 && photoLines[0] === "IMG_3001.HEIC: QR 1 of 1: 2 accounts" && photoLines[1] === "IMG_3002.heif: QR 1 of 1: already read, ignored",
      photoLines,
    );

    const rowOf = (issuer: string): Promise<{ what: string; checked: boolean; disabled: boolean } | null> =>
      js(wc, `(() => { const r = [...document.querySelectorAll('.ga-row')].find((x) => x.querySelector('.ga-account strong')?.textContent === ${JSON.stringify(issuer)}); return r ? { what: r.querySelector('.ga-what').textContent, checked: r.querySelector('input[type=checkbox]').checked, disabled: r.querySelector('input[type=checkbox]').disabled } : null; })()`);
    await typeInto(wc, ".ga-row:not(.ga-head) .ga-site.missing", base);
    const matched = await until(async () => /Adds 2FA to the KeePass entry HEIC smoke login in database Smoke KeePass/.test((await rowOf("Corvus HEIC Smoke"))?.what ?? ""), 5000);
    const first = await rowOf("Corvus HEIC Smoke");
    check("an account whose site and username match a KeePass entry goes to that entry, ticked", matched && first?.checked === true, first);
    const second = await rowOf("heic.example.org");
    check(
      "a KeePass entry that already has the 2FA is shown as already set",
      /The KeePass entry heic\.example\.org in database Smoke KeePass already has this 2FA/.test(second?.what ?? "") && second?.disabled === true,
      second,
    );
    const hints = (await js<string>(wc, `[...document.querySelectorAll('.ga-keepass')].map((h) => h.textContent).join(' | ')`)) ?? "";
    check(
      "the preview names the locked database and says which KeePass entries change, with a .bak copy",
      /The KeePass database Locked KeePass is locked/.test(hints) && /Importing changes 1 entry in your KeePass databases/.test(hints),
      hints,
    );
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(400);
      await capture(`authenticator-import-heic-keepass-${theme}`, wc);
    }
    nativeTheme.themeSource = "system";

    const before = fs.readFileSync(file);
    await js(wc, `document.querySelector('.ga-foot .btn.primary').click()`);
    const done = await until(() => js<boolean>(wc, "Boolean(document.querySelector('.ga-result'))").then(Boolean), 30_000);
    const result = (await js<string>(wc, `document.querySelector('.ga-import .card-body').innerText`)) ?? "";
    check("the import reports the KeePass entry that got its 2FA", done && /Added 2FA to 1 entry in KeePass\./.test(result) && !/Could not write/.test(result), result);
    await capture("authenticator-import-heic-keepass-done", wc);
    const opened = await openKdbx(fs.readFileSync(file), "kp-heic-master", null);
    const written = opened.entries.find((e) => e.title === "HEIC smoke login");
    check(
      "the KeePass file holds the 2FA, its password unchanged, with the file as it was in .bak",
      JSON.stringify(written?.totp) === JSON.stringify(heicConfig(1)) && written?.password === "kp-heic-smoke" && fs.readFileSync(`${file}.bak`).equals(before),
      { totp: Boolean(written?.totp) },
    );

    const otp = win.createTab(`${base}/2fa`);
    const ow = otp.view.webContents;
    await until(() => !ow.isDestroyed() && ow.getURL().includes("/2fa") && !otp.loading);
    await until(() => ctx.autofill.stateFor(win).otpAvailable);
    const account = ctx.autofill.suggestions(win).find((m) => m.username === "heic-smoke@example.com");
    if (account) await ctx.autofill.fillTotp(win, account.id);
    const filled = await until(async () => (await nearbyCodes(heicConfig(1))).includes((await js<string>(ow, `document.getElementById("otp").value`)) ?? ""), 5000);
    check("Corvus fills the 2FA code of the KeePass entry the import wrote", Boolean(account?.hasTotp && account.source === "keepass") && filled, account);
    await capture("authenticator-import-heic-keepass-otp-filled", ow);
    win.closeTab(otp.id);
    win.closeTab(tab.id);
  } finally {
    dialog.showOpenDialog = showOpenDialog;
    nativeTheme.themeSource = "system";
    for (const source of kp.sources()) kp.removeSource(source.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The login field menu on a page with a login that has a password and a 2FA-only login of the same
 * user (what an import makes): one item, labelled with the user and the site, that fills both fields;
 * a 2FA-only account fills the username only; the 2FA fill uses the 2FA-only login's code.
 */
async function fieldMenuSmoke(ctx: AppContext, base: string, { win, check, capture }: Omit<Helpers, "url">): Promise<void> {
  const vault = win.profile.credentials;
  const origin = new URL(base).origin;
  const host = new URL(base).host;
  const totp = config(fakeSecret(77));
  const ids = [
    vault.add({ origin, username: "menu-smoke@example.com", password: "pw-menu-smoke" }).id,
    vault.add({ origin, username: "Menu-Smoke@example.com", password: "", totp }).id,
    vault.add({ origin, username: "twofa-only@example.com", password: "", totp: config(fakeSecret(78)) }).id,
  ];
  const dropdown = dropdownDriver(ctx, win);
  try {
    const tab = win.createTab(`${base}/login`);
    const wc = tab.view.webContents;
    await until(() => !wc.isDestroyed() && wc.getURL().includes("/login") && !tab.loading);
    await until(() => ctx.autofill.stateFor(win).available);
    const clickField = async (selector: string): Promise<void> => {
      const before = dropdown.token();
      const box = await js<{ x: number; y: number }>(wc, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!box) return;
      wc.focus();
      wc.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await dropdown.opened(before);
    };
    await clickField("#u");
    const labels = dropdown.labels();
    const merged = `menu-smoke@example.com  \u00b7  ${host}`;
    check(
      "login field menu shows one item per user with the site, and marks 2FA-only accounts",
      labels.filter((l) => l.toLowerCase().startsWith("menu-smoke@")).length === 1 && labels.includes(merged) && labels.includes(`twofa-only@example.com  \u00b7  ${host}  \u00b7  2FA only`),
      labels,
    );
    const pick = (label: string): boolean => dropdown.pick(label);
    pick(merged);
    const fields = (): Promise<string | null> => js<string>(wc, `document.getElementById("u").value + "/" + document.getElementById("p").value`);
    const filled = await until(async () => (await fields()) === "menu-smoke@example.com/pw-menu-smoke", 5000);
    check("picking the merged account fills the username and the password", filled, (await fields())?.split("/")[0]);

    await js(wc, `(() => { const p = document.getElementById("p"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(p, "typed-by-hand"); return true; })()`);
    await clickField("#p");
    pick(`twofa-only@example.com  \u00b7  ${host}  \u00b7  2FA only`);
    const onlyUser = await until(async () => (await fields()) === "twofa-only@example.com/typed-by-hand", 5000);
    check("picking a 2FA-only account fills the username and leaves the password field alone", onlyUser, (await fields())?.split("/")[0]);
    await capture("autofill-field-menu-filled", wc);

    const otp = win.createTab(`${base}/2fa`);
    const ow = otp.view.webContents;
    await until(() => !ow.isDestroyed() && ow.getURL().includes("/2fa") && !otp.loading);
    await until(() => ctx.autofill.stateFor(win).otpAvailable);
    const account = ctx.autofill.suggestions(win).find((m) => m.username.toLowerCase() === "menu-smoke@example.com");
    if (account) await ctx.autofill.fillTotp(win, account.id);
    const code = await until(async () => (await nearbyCodes(totp)).includes((await js<string>(ow, `document.getElementById("otp").value`)) ?? ""), 5000);
    check("the 2FA fill of the merged account uses the 2FA-only login's code", Boolean(account?.hasTotp && account.hasPassword) && code, account);
    win.closeTab(otp.id);
    win.closeTab(tab.id);
  } finally {
    for (const id of ids) vault.remove(id);
  }
}

/** Types into a React-controlled input of a page. */
const typeInto = (wc: WebContents, selector: string, value: string): Promise<unknown> =>
  js(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

/**
 * The Passwords page's tabs on a vault the import filled (100+ logins with a 2FA): the 2FA codes tab
 * opens by click, link and keyboard, is remembered, searches, pages, and shows the codes totpCode
 * gives; "Show login" goes back to the login. Light and dark, wide and 480 px wide.
 */
async function passwordsTabsSmoke(tab: TabRuntime, { win, check, capture }: Omit<Helpers, "url">): Promise<void> {
  const wc = tab.view.webContents;
  const vault = win.profile.credentials;
  const withTotp = vault.all().filter((c) => c.totp).length;
  const pagerText = (list: string): Promise<string | null> => js<string>(wc, `document.querySelector(${JSON.stringify(`${list} .pager .muted`)})?.textContent ?? ""`);
  // Close the import's summary (Done).
  await js(wc, `document.querySelector(".ga-import .ga-result") && document.querySelector(".ga-import .pw-actions .btn.primary").click()`);
  await until(() => js<boolean>(wc, `!document.querySelector(".ga-import")`).then(Boolean), 3000);

  await js(wc, `document.querySelector(".pw-list .pager button:last-child").click()`);
  const moved = await until(async () => (await pagerText(".pw-list")) === `26-50 of ${vault.all().length}`, 5000);
  check("Passwords tab pages its logins", moved, await pagerText(".pw-list"));
  await capture("passwords-tabs-passwords-light", wc);

  await js(wc, `document.getElementById("pw-tab-2fa").click()`);
  const opened = await until(() => js<boolean>(wc, `document.querySelectorAll(".tf-row").length === 25 && location.hash === "#2fa" && localStorage.getItem("corvus.passwords.tab") === "2fa"`).then(Boolean), 5000);
  const count = Number(await js<string>(wc, `document.querySelector("#pw-tab-2fa .pw-tab-count").textContent`));
  check("2FA codes tab opens with the count, in the address and remembered", opened && count >= withTotp && (await pagerText(".tf-list")) === `1-25 of ${count}`, { count, withTotp, pager: await pagerText(".tf-list") });

  const loaded = await until(() => js<boolean>(wc, `[...document.querySelectorAll(".tf-row .tf-code")].every((c) => /^[0-9]{3,4} [0-9]{3,4}$/.test(c.textContent))`).then(Boolean), 10_000);
  const shown = (await js<Array<{ id: string; code: string }>>(wc, `[...document.querySelectorAll(".tf-row")].slice(0, 6).map((r) => ({ id: r.dataset.id, code: r.querySelector(".tf-code").textContent.split(" ").join("") }))`)) ?? [];
  const matches = await Promise.all(shown.map(async (s) => {
    const config = vault.get(s.id)?.totp;
    return Boolean(config) && (await nearbyCodes(config!)).includes(s.code);
  }));
  check("2FA codes tab shows each login's current code", loaded && shown.length === 6 && matches.every(Boolean), { loaded, matches });
  const only = await js<boolean>(wc, `[...document.querySelectorAll(".tf-row")].some((r) => r.querySelector(".pill")?.textContent === "2FA only")`);
  check("2FA codes tab marks 2FA-only logins", only === true);
  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    await sleep(500);
    await capture(`passwords-tabs-2fa-${theme}`, wc);
  }
  nativeTheme.themeSource = "system";

  await js(wc, `document.querySelector(".tf-list .pager button:last-child").click()`);
  const next = await until(async () => (await pagerText(".tf-list"))?.startsWith("26-50 of ") === true, 5000);
  await typeInto(wc, ".page-toolbar .input", "svc4");
  const narrowed = await until(() => js<boolean>(wc, `(() => { const rows = [...document.querySelectorAll(".tf-row .tf-host")]; return rows.length > 0 && rows.length <= 25 && rows.every((r) => r.textContent.includes("svc4")); })()`).then(Boolean), 5000);
  const searchPager = await pagerText(".tf-list");
  check("2FA codes tab pages, and a search narrows the list from its first page", next && narrowed && (searchPager === "" || (searchPager?.startsWith("1-") ?? false)), { searchPager });

  // "Show login" goes to the Passwords tab with the login's site searched.
  await js(wc, `[...document.querySelectorAll(".tf-row")].find((r) => r.querySelector(".tf-host").textContent === "svc42.example").querySelector(".tf-show").click()`);
  const shownLogin = await until(() => js<boolean>(wc, `document.getElementById("pw-tab-passwords").getAttribute("aria-selected") === "true" && document.querySelector(".page-toolbar .input").value === "svc42.example" && document.querySelectorAll(".pw-list > .list-row").length === 1`).then(Boolean), 5000);
  check("Show login opens the login in the Passwords tab", shownLogin);

  // The keyboard moves between the tabs; a link opens the 2FA tab.
  await js(wc, `document.getElementById("pw-tab-passwords").focus(); document.getElementById("pw-tab-passwords").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); true`);
  const byKey = await until(() => js<boolean>(wc, `document.getElementById("pw-tab-2fa").getAttribute("aria-selected") === "true" && document.activeElement?.id === "pw-tab-2fa"`).then(Boolean), 3000);
  const linked = win.createTab("corvus://passwords/#2fa");
  const lw = linked.view.webContents;
  const byLink = await until(() => js<boolean>(lw, `Boolean(document.getElementById("pw-tab-2fa")?.getAttribute("aria-selected") === "true" && document.querySelector(".tf-row"))`).then(Boolean), 10_000);
  check("arrow keys switch tabs and corvus://passwords/#2fa opens the 2FA codes tab", byKey && byLink, { byKey, byLink });
  win.closeTab(linked.id);

  // About 480 px wide: nothing wider than the page, in both tabs.
  win.activate(tab.id);
  await typeInto(wc, ".page-toolbar .input", "");
  const bounds = tab.view.getBounds();
  tab.view.setBounds({ ...bounds, width: 480 });
  const fits: Record<string, boolean> = {};
  const wider: Record<string, string[]> = {};
  for (const which of ["2fa", "passwords"] as const) {
    await js(wc, `document.getElementById("pw-tab-${which}").click()`);
    await sleep(700);
    fits[which] = (await js<boolean>(wc, "document.documentElement.scrollWidth <= window.innerWidth + 1")) === true;
    if (!fits[which]) wider[which] = (await js<string[]>(wc, WIDER_THAN_PAGE)) ?? [];
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(400);
      await capture(`passwords-tabs-${which}-480-${theme}`, wc);
    }
  }
  nativeTheme.themeSource = "system";
  tab.view.setBounds(bounds);
  check("Passwords page fits a 480 px wide window in both tabs", fits["2fa"] === true && fits.passwords === true, { fits, wider });
  await capture("passwords-tabs-passwords-dark", wc);
}

/** The innermost elements that reach past the right edge of the page (what makes it scroll sideways). */
const WIDER_THAN_PAGE = `[...document.querySelectorAll("body *")]
  .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && ![...el.children].some((c) => c.getBoundingClientRect().right > window.innerWidth + 1))
  .slice(0, 6)
  .map((el) => el.tagName.toLowerCase() + "." + String(el.className).split(" ").join(".") + " " + Math.round(el.getBoundingClientRect().right))`;
