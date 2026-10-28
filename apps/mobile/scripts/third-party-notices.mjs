// Writes the third-party notices the Android app shows in Settings → Third-party licenses
// (assets/third-party-notices.json): every third-party package that ships in the app, with its
// version, licence, copyright and licence text. The app's Gradle build runs it for release builds
// (scripts/third-party-notices.gradle, applied by plugins/with-third-party-notices.js), after Metro
// has bundled the JavaScript, so the list is exactly what ships:
// - JavaScript: the npm packages in the bundle's source map (Metro leaves out what is not imported),
//   plus DuckDuckGo Autoconsent and its dependencies, bundled into the browser's cookie banner
//   script (scripts/consent-assets.mjs);
// - Android: the libraries of the release runtime classpath (AndroidX, React Native, Hermes, ZXing,
//   OkHttp...), with the licences and holders their Maven POMs name and the standard licence text,
//   and the C++ libraries compiled into React Native (Folly, Boost, glog...), from its version list.
// Workspace packages (@corvus/*) and the local Expo modules are first-party. It fails when a licence
// is outside the desktop app's allowlist (apps/desktop/scripts/license-policy.mjs), or unknown.
// Usage: node scripts/third-party-notices.mjs --sourcemap <file> --maven <json> --out <dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LICENSE_FILE, buildNotices, copyrightLines, isAllowedLicense, licenseOf, mavenNotice, packageRootsOfSources, sourcesOfMap } from './notices-lib.mjs';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_TEXT = 64 * 1024;
/** Licences of Android libraries allowed beyond the desktop allowlist: Google's SDK terms (Play services, Firebase). */
const ANDROID_EXTRA = ['Android-SDK', 'BSL-1.0'];
/** Packages bundled outside Metro: the cookie banner script (scripts/consent-assets.mjs). */
const EXTRA_JS = ['@duckduckgo/autoconsent'];
/**
 * C++ libraries compiled into React Native's native code (libreactnative.so of react-android), by
 * their key in React Native's gradle/libs.versions.toml, which gives the version that ships.
 */
const RN_NATIVE = [
  { key: 'boost', name: 'Boost C++ Libraries', license: 'BSL-1.0', copyright: [], homepage: 'https://www.boost.org' },
  { key: 'doubleconversion', name: 'double-conversion', license: 'BSD-3-Clause', copyright: ['Copyright 2006-2011, the V8 project authors'], homepage: 'https://github.com/google/double-conversion' },
  { key: 'fastFloat', name: 'fast_float', license: '(MIT OR Apache-2.0 OR BSL-1.0)', copyright: ['Copyright (c) 2021 The fast_float authors'], homepage: 'https://github.com/fastfloat/fast_float' },
  { key: 'fmt', name: '{fmt}', license: 'MIT', copyright: ['Copyright (c) 2012 - present, Victor Zverovich and {fmt} contributors'], homepage: 'https://github.com/fmtlib/fmt' },
  { key: 'folly', name: 'Folly', license: 'Apache-2.0', copyright: ['Copyright (c) Meta Platforms, Inc. and affiliates.'], homepage: 'https://github.com/facebook/folly' },
  { key: 'glog', name: 'glog', license: 'BSD-3-Clause', copyright: ['Copyright (c) 2008, Google Inc.'], homepage: 'https://github.com/google/glog' },
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!out.sourcemap || !out.maven || !out.out) {
    console.error('usage: node scripts/third-party-notices.mjs --sourcemap <file> --maven <json> --out <dir>');
    process.exit(2);
  }
  return out;
}

function jsPackage(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const texts = fs
    .readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8').slice(0, MAX_TEXT).trim() }));
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  const copyright = texts.flatMap((t) => copyrightLines(t.text));
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return {
    name: pkg.name,
    version: pkg.version,
    license: licenseOf(pkg),
    copyright: copyright.length ? [...new Set(copyright)] : author ? [`Copyright ${author.replace(/\s*<[^>]*>/, '').trim()}`] : [],
    homepage: (pkg.homepage || repo || '').replace(/^git\+/, ''),
    texts,
  };
}

/** Node-style lookup of `name` from `fromDir` (works with pnpm's symlinked layout, and with packages whose exports hide package.json). */
function resolvePackage(fromDir, name) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/** A package and its production dependencies. */
function withDependencies(fromDir, name, into) {
  const dir = resolvePackage(fromDir, name);
  if (!dir) {
    console.error(`[notices] cannot find ${name} from ${fromDir}`);
    process.exit(1);
  }
  if (into.has(dir)) return;
  into.add(dir);
  for (const dep of Object.keys(readJson(path.join(dir, 'package.json')).dependencies ?? {})) withDependencies(dir, dep, into);
}

function main() {
  const opts = args();
  const app = readJson(path.join(mobileDir, 'package.json'));
  const map = readJson(opts.sourcemap);
  // Metro names files from the workspace root ("/node_modules/.pnpm/...").
  const workspaceDir = path.resolve(mobileDir, '../..');
  const roots = new Set();
  for (const root of packageRootsOfSources(sourcesOfMap(map), mobileDir)) {
    const dir = [root, path.join(workspaceDir, root)].find((d) => fs.existsSync(path.join(d, 'package.json')));
    if (!dir) {
      console.error(`[notices] cannot find the package of ${root}`);
      process.exit(1);
    }
    roots.add(fs.realpathSync(dir));
  }
  for (const name of EXTRA_JS) withDependencies(mobileDir, name, roots);

  const js = new Map();
  for (const dir of roots) {
    const p = jsPackage(dir);
    if (!p.name || p.name.startsWith('@corvus/')) continue;
    js.set(`${p.name}@${p.version}`, p);
  }

  const android = readJson(opts.maven)
    .map((lib) => mavenNotice({ ...lib, poms: lib.poms.map((pom) => fs.readFileSync(pom, 'utf8')) }))
    .filter((p) => !p.name.startsWith('com.parendum.') && !p.name.startsWith('expo.modules.corvus.'));
  const rn = resolvePackage(mobileDir, 'react-native');
  const versions = fs.readFileSync(path.join(rn, 'gradle/libs.versions.toml'), 'utf8');
  for (const lib of RN_NATIVE) {
    const version = new RegExp(`^\\s*${lib.key}\\s*=\\s*"([^"]+)"`, 'm').exec(versions)?.[1];
    if (!version) {
      console.error(`[notices] React Native no longer names ${lib.key} in gradle/libs.versions.toml`);
      process.exit(1);
    }
    android.push({ ...lib, version: version.replace(/_/g, '.'), licenseUrls: [], title: lib.name });
  }

  const refused = [
    ...[...js.values()].filter((p) => !isAllowedLicense(p.license)),
    ...android.filter((p) => !isAllowedLicense(p.license) && !ANDROID_EXTRA.includes(p.license)),
  ];
  if (refused.length > 0) {
    console.error('[notices] licences outside the allowlist or unknown:');
    for (const p of refused) console.error(`  ${p.name}@${p.version}: ${p.license || '(none declared)'}`);
    process.exit(1);
  }

  const licensesDir = path.join(mobileDir, 'scripts/licenses');
  const standardTexts = Object.fromEntries(fs.readdirSync(licensesDir).map((f) => [f.replace(/\.txt$/, ''), fs.readFileSync(path.join(licensesDir, f), 'utf8').trim()]));
  const notices = buildNotices({ version: app.version, js: js.values(), android, standardTexts });
  fs.mkdirSync(opts.out, { recursive: true });
  const target = path.join(opts.out, 'third-party-notices.json');
  fs.writeFileSync(target, JSON.stringify(notices));
  console.log(`[notices] wrote ${target}: ${js.size} JavaScript packages, ${android.length} Android libraries, ${notices.texts.length} licence texts`);
}

main();
