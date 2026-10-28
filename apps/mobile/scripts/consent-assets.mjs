// Builds what Corvus's mobile browser needs to answer cookie banners and send Global Privacy
// Control (modules/browser-kit). For Android, the module's Gradle build runs it (task
// corvusConsentAssets) into its build/generated/corvus-consent folder:
//   assets/corvus-consent/page.js     modules/browser-kit/consent/page.ts with DuckDuckGo Autoconsent, one minified script
//   assets/corvus-consent/gpc.js      GPC_PAGE_SCRIPT of @corvus/shared
//   assets/corvus-consent/rules.txt   Autoconsent's compact rules, packed (packRules) so that the native side picks a
//                                     frame's rules without parsing JSON
//   assets/corvus-consent/LICENSE-autoconsent.txt
//   test/corvus-consent/cases.tsv     what filterCompactRules gives for many frames; ConsentRulesTest checks that
//                                     ConsentRules.kt gives exactly the same
// For iOS (--ios), the module's podspec runs it at pod install into ios/generated:
//   assets/corvus-consent/page.js     modules/browser-kit/consent/page-ios.ts with Autoconsent, for an isolated content world
//   assets/corvus-consent/snippets.json  Autoconsent's main-world snippets by id: the only code the module runs in a page
//   assets/corvus-consent/rules.txt, LICENSE-autoconsent.txt and test/corvus-consent/cases.tsv as above
//                                     (ConsentRules.swift is checked against the same cases)
// Usage: node scripts/consent-assets.mjs <out dir> [--ios]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(mobileDir, 'package.json'));

export const RULES_HEADER = 'corvus-consent-rules 1';
/** The placeholder in page.js that the module replaces with its listener object's name. */
export const PORT_PLACEHOLDER = '__CORVUS_CONSENT_PORT__';
/** Rule step keys whose value is an index into the strings (Autoconsent's compactedRuleSteps). */
const STRING_KEYS = ['e', 'v', 'c', 'k', 'w', 'wv', 'h', 'cc'];

function addStringIds(steps, ids) {
  for (const step of steps) {
    for (const key of STRING_KEYS) if (step[key] !== undefined) ids.add(step[key]);
    if (step.if) addStringIds([step.if], ids);
    if (step.then) addStringIds(step.then, ids);
    if (step.else) addStringIds(step.else, ids);
    if (step.any) addStringIds(step.any, ids);
  }
}

/** The strings a compact rule uses: its prehide selectors and those of its steps, ascending. */
export function ruleStringIds(rule) {
  const ids = new Set(rule[5]);
  for (const i of [6, 7, 8, 9]) addStringIds(rule[i], ids);
  return [...ids].sort((a, b) => a - b);
}

/**
 * Autoconsent's indexed compact rules as lines: the header, the version, the index ranges, the
 * strings (each as a JSON literal), then two lines per rule (its URL pattern as written, then its
 * run context, the strings it uses and the rule as JSON, tab-separated).
 */
export function packRules(rules) {
  const { v, s, r, index } = rules;
  const ranges = [...index.genericRuleRange, ...index.frameRuleRange, ...index.specificRuleRange, index.genericStringEnd, index.frameStringEnd];
  const lines = [RULES_HEADER, String(v), ranges.join(' '), String(s.length), ...s.map((x) => JSON.stringify(x)), String(r.length)];
  for (const rule of r) {
    const pattern = rule[3] ?? '';
    if (/[\r\n]/.test(pattern)) throw new Error(`rule ${rule[1]}: a line break in its URL pattern`);
    lines.push(pattern, `${rule[4]}\t${ruleStringIds(rule).join(',')}\t${JSON.stringify(rule)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A compact ruleset as the native side writes it: JSON.stringify of {v, s, r}, in that order. */
export function canonicalRuleset(set) {
  return JSON.stringify({ v: set.v, s: set.s, r: set.r });
}

const FRAME_URLS = [
  'https://ads.example/frame',
  'https://cdn.privacy-mgmt.com/index.html?message_id=123&consentUUID=x',
  'https://consent.trustarc.com/notice?domain=example.com',
  'https://consentcdn.cookiebot.com/sdk/bc-v4.min.html',
  'https://cmp.quantcast.com/choice/abc/example.com/index.html',
  'https://www.youtube.com/embed/abc',
  'https://sourcepoint.mgr.consensu.org/index.html',
  'https://consent.yahoo.com/v2/collectConsent?sessionId=1',
  'http://10.0.2.2:18767/frame',
];

/** The sites a rule's URL pattern names ("^https?://(www\\.)?example\\.com/" names example.com). */
function patternHosts(pattern) {
  return [...pattern.matchAll(/(?:[a-z0-9-]+\\\.)+[a-z]{2,}/gi)].map((m) => m[0].replace(/\\\./g, '.').toLowerCase());
}

/**
 * Frames to check the native picking on: generic pages, the site of every rule with a URL pattern
 * (as a page and as a frame), and common consent frames.
 */
export function consentCases(rules, filterCompactRules) {
  const main = new Set(['https://example.com/', 'http://10.0.2.2:18766/onetrust', 'https://www.theguardian.com/uk']);
  const frames = new Set(FRAME_URLS);
  for (const rule of rules.r) {
    for (const host of patternHosts(rule[3] ?? '')) {
      main.add(`https://www.${host}/`);
      frames.add(`https://${host}/`);
      frames.add(`https://www.${host}/consent`);
    }
  }
  const rows = [];
  for (const [urls, mainFrame] of [
    [main, true],
    [frames, false],
  ]) {
    for (const url of urls) {
      const subset = filterCompactRules(rules, { url, mainFrame });
      const hash = subset.r.length === 0 ? 'none' : createHash('sha256').update(canonicalRuleset(subset)).digest('hex');
      rows.push(`${mainFrame ? 'main' : 'frame'}\t${url}\t${subset.r.length}\t${hash}`);
    }
  }
  return `${rows.join('\n')}\n`;
}

async function bundle(input, format) {
  const { rolldown } = await import('rolldown');
  const build = await rolldown({ input, platform: 'browser', logLevel: 'warn' });
  const { output } = await build.generate({ format, minify: format === 'iife' });
  await build.close();
  return output[0].code;
}

/** Autoconsent's main-world snippets as source text, by id (each an arrow function to call). */
export function snippetSources(evalSnippets) {
  const out = {};
  for (const [id, snippet] of Object.entries(evalSnippets)) {
    if (!/^EVAL_[A-Z0-9_]+$/.test(id) || id.length > 80) throw new Error(`unexpected snippet id ${id}`);
    if (typeof snippet === 'function') out[id] = String(snippet);
  }
  return out;
}

export async function buildConsentAssets(outDir, { ios = false } = {}) {
  const autoconsent = await import('@duckduckgo/autoconsent');
  const packageDir = path.resolve(path.dirname(require.resolve('@duckduckgo/autoconsent')), '..');
  const { version, license } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const rules = require('@duckduckgo/autoconsent/rules/compact-rules.json');

  const page = await bundle(path.join(mobileDir, 'modules/browser-kit/consent', ios ? 'page-ios.ts' : 'page.ts'), 'iife');
  if (!ios && page.split(PORT_PLACEHOLDER).length !== 2) throw new Error(`page.js must name ${PORT_PLACEHOLDER} exactly once`);
  const shared = await bundle(path.resolve(mobileDir, '../../packages/shared/src/cookie-consent.ts'), 'esm');
  const { GPC_PAGE_SCRIPT } = await import(`data:text/javascript;base64,${Buffer.from(shared).toString('base64')}`);

  const assets = path.join(outDir, 'assets', 'corvus-consent');
  const tests = path.join(outDir, 'test', 'corvus-consent');
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(tests, { recursive: true });
  const notice = `/*! Corvus cookie banner script (MPL-2.0). Includes DuckDuckGo Autoconsent ${version} (${license}, source: https://github.com/duckduckgo/autoconsent). */\n`;
  fs.writeFileSync(path.join(assets, 'page.js'), notice + page);
  if (ios) fs.writeFileSync(path.join(assets, 'snippets.json'), JSON.stringify(snippetSources(autoconsent.evalSnippets)));
  else fs.writeFileSync(path.join(assets, 'gpc.js'), GPC_PAGE_SCRIPT);
  fs.writeFileSync(path.join(assets, 'rules.txt'), packRules(rules));
  fs.copyFileSync(path.join(packageDir, 'LICENSE'), path.join(assets, 'LICENSE-autoconsent.txt'));
  fs.writeFileSync(path.join(tests, 'cases.tsv'), consentCases(rules, autoconsent.filterCompactRules));
  console.log(`[consent-assets] Autoconsent ${version}${ios ? ' (iOS)' : ''}: page.js ${Math.round((notice.length + page.length) / 1024)} KB, ${rules.r.length} rules -> ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outDir = process.argv[2];
  if (!outDir || (process.argv[3] && process.argv[3] !== '--ios')) {
    console.error('usage: node scripts/consent-assets.mjs <out dir> [--ios]');
    process.exit(2);
  }
  await buildConsentAssets(path.resolve(outDir), { ios: process.argv[3] === '--ios' });
}
