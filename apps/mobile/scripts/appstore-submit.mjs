#!/usr/bin/env node
// Puts an iOS build on the App Store: the app's version for it (a new one, or the editable one renamed),
// the build, "What's New" in every language, release after approval, and the review submission. Run
// by the release script once the build is processed in App Store Connect:
//
//     apps/mobile/scripts/appstore-submit.mjs --version 0.11.0 --build 13 --notes-en "<text>" [--notes-es "<text>"] [--dry-run]
//
// The newest release wins, as on Google Play: a version still waiting for review is taken back and
// replaced by this one. A version Apple is reviewing right now is left alone (exit code 3: run this
// again once it is decided). Uses the App Store Connect API key in /secrets/apple-signing.env
// (APPLE_API_KEY file name, APPLE_API_KEY_ID, APPLE_API_ISSUER); the key needs the App Manager or
// Admin role. Node built-ins only.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com/v1";
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const dryRun = args.includes("--dry-run");
const mobileDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = JSON.parse(readFileSync(join(mobileDir, "app.json"), "utf8")).expo;
const version = option("version", JSON.parse(readFileSync(join(mobileDir, "package.json"), "utf8")).version);
const buildNumber = option("build", String(app.ios.buildNumber));
/** A text option, or the contents of the file it names as @path. */
const text = (value) => (value.startsWith("@") ? readFileSync(value.slice(1), "utf8").trim() : value);
const notesEn = text(option("notes-en", ""));
const notesEs = text(option("notes-es", "")) || notesEn;
if (!notesEn) throw new Error("--notes-en is required (the App Store asks for What's New in every language)");
const secrets = process.env.APPLE_SECRETS_DIR || "/secrets";

/** States in which a version can still be edited and submitted. */
const EDITABLE = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);

const env = {};
for (const line of readFileSync(join(secrets, "apple-signing.env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\r$/, "").replace(/^"|"$/g, "");
}
const key = createPrivateKey(readFileSync(join(secrets, env.APPLE_API_KEY.split(/[\\/]/).pop())));

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "ES256", kid: env.APPLE_API_KEY_ID, typ: "JWT" })}.${b64({ iss: env.APPLE_API_ISSUER, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" })}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function call(method, path, body) {
  if (dryRun && method !== "GET") {
    console.log(`  [dry run] ${method} ${path}`);
    return { data: { id: "dry-run" } };
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${json.errors?.map((e) => e.detail || e.title).join("; ") || text}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appId = (await call("GET", `/apps?filter[bundleId]=${encodeURIComponent(app.ios.bundleIdentifier)}&fields[apps]=bundleId`)).data[0]?.id;
if (!appId) throw new Error(`No app with bundle id ${app.ios.bundleIdentifier} in App Store Connect`);

// The build, processed and valid.
const builds = await call("GET", `/builds?filter[app]=${appId}&filter[version]=${buildNumber}&filter[preReleaseVersion.version]=${version}&fields[builds]=version,processingState,usesNonExemptEncryption&limit=5`);
const build = builds.data.find((b) => b.attributes.processingState === "VALID");
if (!build) throw new Error(`Build ${version} (${buildNumber}) is not processed in App Store Connect yet`);
console.log(`Build ${version} (${buildNumber}): ${build.id}`);
if (build.attributes.usesNonExemptEncryption === null) {
  await call("PATCH", `/builds/${build.id}`, { data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } } });
}

const versionsOf = async () =>
  (await call("GET", `/apps/${appId}/appStoreVersions?filter[platform]=IOS&fields[appStoreVersions]=versionString,appStoreState&limit=10`)).data;
let versions = await versionsOf();
const states = versions.map((v) => `${v.attributes.versionString} ${v.attributes.appStoreState}`).join(", ");
console.log(`App Store versions: ${states || "none"}`);

const same = versions.find((v) => v.attributes.versionString === version);
if (same && ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE", "READY_FOR_SALE", "READY_FOR_DISTRIBUTION"].includes(same.attributes.appStoreState)) {
  console.log(`${version} is already ${same.attributes.appStoreState}: nothing to do.`);
  process.exit(0);
}
const inReview = versions.find((v) => v.attributes.appStoreState === "IN_REVIEW");
if (inReview) {
  console.log(`Apple is reviewing ${inReview.attributes.versionString} right now: ${version} waits. Run this again once that review is decided.`);
  process.exit(3);
}

// An older version still waiting for review gives way to this one.
const waiting = versions.find((v) => v.attributes.appStoreState === "WAITING_FOR_REVIEW");
if (waiting) {
  console.log(`Taking ${waiting.attributes.versionString} back from review: ${version} replaces it.`);
  const subs = (await call("GET", `/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&limit=10`)).data;
  for (const s of subs.filter((s) => s.attributes.state === "WAITING_FOR_REVIEW")) {
    await call("PATCH", `/reviewSubmissions/${s.id}`, { data: { type: "reviewSubmissions", id: s.id, attributes: { canceled: true } } });
  }
  for (let i = 0; i < 40 && !dryRun; i++) {
    versions = await versionsOf();
    if (versions.find((v) => v.id === waiting.id && EDITABLE.has(v.attributes.appStoreState))) break;
    await sleep(15000);
  }
}

// This release's version: the editable one (renamed if needed), or a new one.
let target = versions.find((v) => v.id === waiting?.id && (dryRun || EDITABLE.has(v.attributes.appStoreState))) ?? versions.find((v) => EDITABLE.has(v.attributes.appStoreState));
if (target) {
  console.log(`Using version ${target.attributes.versionString} (${target.attributes.appStoreState}) as ${version}.`);
  await call("PATCH", `/appStoreVersions/${target.id}`, { data: { type: "appStoreVersions", id: target.id, attributes: { versionString: version, releaseType: "AFTER_APPROVAL" } } });
} else {
  console.log(`Creating version ${version}.`);
  target = (await call("POST", "/appStoreVersions", { data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: version, releaseType: "AFTER_APPROVAL" }, relationships: { app: { data: { type: "apps", id: appId } } } } })).data;
}
await call("PATCH", `/appStoreVersions/${target.id}/relationships/build`, { data: { type: "builds", id: build.id } });

// What's New in every language of the listing.
if (target.id !== "dry-run") {
  const locs = (await call("GET", `/appStoreVersions/${target.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale`)).data;
  for (const loc of locs) {
    const whatsNew = (loc.attributes.locale.startsWith("es") ? notesEs : notesEn).slice(0, 4000);
    await call("PATCH", `/appStoreVersionLocalizations/${loc.id}`, { data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: { whatsNew } } });
    console.log(`What's New set for ${loc.attributes.locale}.`);
  }
}

// The review submission: an open draft is reused (Apple keeps one per platform), else a new one.
const drafts = (await call("GET", `/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW&limit=5`)).data;
const submission = drafts[0] ?? (await call("POST", "/reviewSubmissions", { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: appId } } } } })).data;
await call("POST", "/reviewSubmissionItems", { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } }, appStoreVersion: { data: { type: "appStoreVersions", id: target.id } } } } });
await call("PATCH", `/reviewSubmissions/${submission.id}`, { data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } } });
console.log(`${dryRun ? "[dry run] Would submit" : "Submitted"} ${version} (${buildNumber}) for App Review; it goes live by itself once approved.`);
