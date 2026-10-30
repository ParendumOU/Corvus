import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialog, nativeImage, nativeTheme, type WebContents } from "electron";
import type { AuthenticatorPreview, PhotoReport } from "../shared/authenticator-import";
import { encodeMigrationPayload, migrationUri, type MigrationOtpInput } from "../shared/authenticator-migration";
import { base32Encode, totpCode, type TotpConfig } from "../shared/totp";
import { addPhotos, authenticatorPreview, discardAuthenticatorImport, readAuthenticatorPhoto } from "./authenticator-import";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface Helpers {
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

/** A made-up 20-byte secret per seed: no real account's. */
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
export async function runAuthenticatorImportSmoke(_ctx: AppContext, { win, check, capture }: Helpers): Promise<void> {
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
  const setupConfig = config(fakeSecret(900));
  const setup = await writeSetupPng(dir, `otpauth://totp/Fastmail:setup-smoke@example.com?secret=${setupConfig.secret}&issuer=Fastmail`);
  const picked = [...files, again, blank, setup];
  check("authenticator smoke photos written", picked.every((f) => fs.statSync(f).size > 1000), { photos: picked.length, ms: Date.now() - started });

  // Logins the accounts should find: by username, the only login of a site, a conflict, an equal 2FA.
  const github = vault.add({ origin: "https://github.com", username: "octo-smoke", password: "pw-github" });
  const google = vault.add({ origin: "https://accounts.google.com", username: "conflict-smoke@example.com", password: "pw-google", totp: config(fakeSecret(222)) });
  const discord = vault.add({ origin: "https://discord.com", username: "someone@example.com", password: "pw-discord" });
  const gitlab = vault.add({ origin: "https://gitlab.com", username: "same-smoke", password: "pw-gitlab", totp: config(fakeSecret(4)) });

  // The main-process side alone: what the page receives carries no secret.
  const profileId = win.profile.profile.id;
  const direct = addPhotos(profileId, null, [files[0]!, files[1]!]);
  const firstReport = await readAuthenticatorPhoto(profileId, direct.importId, 0);
  await readAuthenticatorPhoto(profileId, direct.importId, 1);
  const directPreview: AuthenticatorPreview = authenticatorPreview(profileId, direct.importId, vault, {});
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

    const rowsOf = (): Promise<Array<{ issuer: string; account: string; site: string; what: string; cls: string; checked: boolean; disabled: boolean }> | null> =>
      js(wc, `[...document.querySelectorAll('.ga-row:not(.ga-head)')].map((r) => ({ issuer: r.querySelector('.ga-account strong').textContent, account: r.querySelector('.ga-account .muted').textContent, site: r.querySelector('.ga-site').value, what: r.querySelector('.ga-what').textContent, cls: r.className, checked: r.querySelector('input[type=checkbox]').checked, disabled: r.querySelector('input[type=checkbox]').disabled }))`);
    const rows = (await rowsOf()) ?? [];
    const row = (issuer: string) => rows.find((r) => r.issuer === issuer);
    check("authenticator preview lists every importable account", rows.length === accounts.length - 1 + 1, { rows: rows.length });
    check("authenticator preview matches a login by username", /Adds 2FA to your login octo-smoke on github\.com/.test(row("GitHub")?.what ?? "") && row("GitHub")?.checked === true, row("GitHub"));
    check("authenticator preview uses the only login of a site", /Adds 2FA to your login someone@example\.com on discord\.com/.test(row("Discord")?.what ?? "") && row("Discord")?.checked === true, row("Discord"));
    check("authenticator preview marks a different 2FA as a conflict, off", (row("Google")?.cls ?? "").includes("replace") && row("Google")?.checked === false, row("Google"));
    check("authenticator preview knows an equal 2FA is already there", (row("GitLab")?.cls ?? "").includes("same") && row("GitLab")?.disabled === true, row("GitLab"));
    check("authenticator preview asks for the site of an unknown issuer", (row("Acme Intranet")?.cls ?? "").includes("needs-site") && row("Acme Intranet")?.disabled === true, row("Acme Intranet"));
    check("authenticator preview creates 2FA-only logins on the issuer's site", row("Proton")?.site === "https://account.proton.me" && /New login \(2FA only\)/.test(row("Proton")?.what ?? ""), row("Proton"));
    const counts = await js<string>(wc, `[...document.querySelectorAll('.ga-chip')].map((c) => c.textContent).join(' | ')`);
    const skipped = await js<string>(wc, `document.querySelector('.ga-skipped summary')?.textContent ?? ''`);
    check("authenticator preview counts rows and lists skipped HOTP accounts", /All 115/.test(counts ?? "") && /Matched 2/.test(counts ?? "") && /Conflicts 1/.test(counts ?? "") && /1 account cannot be imported/.test(skipped ?? ""), { counts, skipped });
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
      done && /Added 2FA to 3 logins, created 111\./.test(result ?? "") && /delete the photos/.test(result ?? ""),
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
    const list = await until(() => js<boolean>(wc, "document.querySelectorAll('.list .list-row').length > 100").then(Boolean));
    check("Passwords list shows the imported logins", list);
  } finally {
    dialog.showOpenDialog = showOpenDialog;
    nativeTheme.themeSource = "system";
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
