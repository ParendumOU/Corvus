#!/usr/bin/env node
// Uploads the Android App Bundle to Google Play and releases it on a track (internal testing by
// default), through the Google Play Developer API with the service account in /secrets.
//
//   docker compose --profile android run --rm --no-deps --entrypoint node android \
//     apps/mobile/scripts/play-upload.mjs [--track internal|production] [--notes "<text>"] [--notes-es "<text>"] [--aab <path>]
//
// Defaults: the bundle out/mobile/corvus-mobile-<version>.aab built by build-android.sh, the
// package and version from apps/mobile/app.json and package.json, the key
// /secrets/google-play-service-account.json (PLAY_SERVICE_ACCOUNT overrides it). The service
// account needs "Release to production" (or "Release apps to testing tracks" for testing tracks) on
// the app in Play Console. Releases go out at 100%; Google reviews them and publishes them when approved.
// Node built-ins only.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const app = JSON.parse(readFileSync(join(mobileDir, "app.json"), "utf8")).expo;
const version = JSON.parse(readFileSync(join(mobileDir, "package.json"), "utf8")).version;
const packageName = app.android.package;
const track = option("track", "internal");
const aabPath = option("aab", join(mobileDir, "..", "..", "out", "mobile", `corvus-mobile-${version}.aab`));
/** A text option, or the contents of the file it names as @path. */
const text = (value) => (value.startsWith("@") ? readFileSync(value.slice(1), "utf8").trim() : value);
const notes = text(option("notes", `Corvus for mobile ${version}.`));
const notesEs = text(option("notes-es", ""));
const keyFile = process.env.PLAY_SERVICE_ACCOUNT || "/secrets/google-play-service-account.json";

const b64url = (data) => Buffer.from(data).toString("base64url");

/** An OAuth access token for the service account (JWT bearer grant). */
async function accessToken() {
  const key = JSON.parse(readFileSync(keyFile, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iss: key.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: key.token_uri, iat: now, exp: now + 3600 }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token request failed (${res.status}): ${body.error_description || body.error}`);
  return body.access_token;
}

async function call(token, method, url, body, contentType = "application/json") {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": contentType } : {}) },
    ...(body !== undefined ? { body: contentType === "application/json" ? JSON.stringify(body) : body } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${url.replace(/\?.*/, "")} failed (${res.status}): ${json.error?.message ?? text}`);
  return json;
}

const token = await accessToken();
const edits = `${API}/${packageName}/edits`;
const edit = await call(token, "POST", edits, {});
console.log(`Edit ${edit.id} for ${packageName}; uploading ${aabPath}...`);

let bundle;
try {
  bundle = await call(token, "POST", `${UPLOAD}/${packageName}/edits/${edit.id}/bundles?uploadType=media`, readFileSync(aabPath), "application/octet-stream");
} catch (err) {
  // Play keeps every version code it has seen: a bundle uploaded before is not an error to stop on.
  if (!/already been used/i.test(String(err.message))) throw err;
  await call(token, "DELETE", `${edits}/${edit.id}`);
  console.log(`This version code is already on Google Play (${version}); nothing uploaded.`);
  process.exit(0);
}
console.log(`Uploaded versionCode ${bundle.versionCode} (sha256 ${bundle.sha256}).`);

const release = { name: version, versionCodes: [String(bundle.versionCode)], releaseNotes: [{ language: "en-US", text: notes.slice(0, 500) }, ...(notesEs ? [{ language: "es-ES", text: notesEs.slice(0, 500) }] : [])] };
try {
  await call(token, "PUT", `${edits}/${edit.id}/tracks/${track}`, { track, releases: [{ ...release, status: "completed" }] });
  await call(token, "POST", `${edits}/${edit.id}:commit`);
  console.log(`Released ${version} (versionCode ${bundle.versionCode}) on the ${track} track.`);
} catch (err) {
  // An app that was never published accepts only draft releases: leave a draft to roll out by hand.
  if (!/draft/i.test(String(err.message))) throw err;
  await call(token, "PUT", `${edits}/${edit.id}/tracks/${track}`, { track, releases: [{ ...release, status: "draft" }] });
  await call(token, "POST", `${edits}/${edit.id}:commit`);
  console.log(`Saved ${version} as a DRAFT on the ${track} track (Play accepts only drafts for this app): roll it out in Play Console.`);
}
