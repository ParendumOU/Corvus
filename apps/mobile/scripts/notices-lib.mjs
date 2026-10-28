// Pure helpers of scripts/third-party-notices.mjs (tested in test/third-party-notices.test.ts).
import { isAllowedLicense, licenseOf, packageRootOf } from '../../desktop/scripts/license-policy.mjs';

export { isAllowedLicense, licenseOf };

/** Licence files a package ships ("LICENSE", "LICENCE.md", "COPYING", "NOTICE.txt", ...). */
export const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** Every source of a source map, flat or indexed (Metro writes "sections"). */
export function sourcesOfMap(map) {
  if (!map || typeof map !== 'object') return [];
  return [...(Array.isArray(map.sources) ? map.sources : []), ...(Array.isArray(map.sections) ? map.sections.flatMap((s) => sourcesOfMap(s?.map)) : [])];
}

/**
 * The node_modules package roots a Metro source map's sources belong to, sorted. Sources are
 * absolute paths or relative to `projectRoot`; files outside node_modules (the app, the workspace
 * packages) are first-party and left out.
 */
export function packageRootsOfSources(sources, projectRoot) {
  const roots = new Set();
  for (const source of sources ?? []) {
    if (typeof source !== 'string') continue;
    const plain = source.replace(/^file:\/\//, '').replace(/\\/g, '/');
    const absolute = plain.startsWith('/') || /^[a-z]:\//i.test(plain) ? plain : `${projectRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${plain}`;
    const root = packageRootOf(absolute);
    if (root) roots.add(normalizePath(root));
  }
  return [...roots].sort();
}

function normalizePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.') out.push(part);
  }
  return out.join('/');
}

/** The copyright lines of a licence text ("Copyright (c) 2015 Facebook, Inc."), without duplicates. */
export function copyrightLines(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[#*/\s-]+/, '').trim();
    if (!/^(copyright\b|\(c\)\s*\d|©)/i.test(line)) continue;
    // The licence's own wording, not a holder: "Copyright notice", "copyright holders", "copyright (c) <year> <owner>".
    if (/^copyright\s+(notice|holders?|owner|license|and|statement|\[yyyy\]|<year>|\(c\)\s*<year>|\[year\])/i.test(line)) continue;
    if (line.length > 200 || lines.includes(line)) continue;
    lines.push(line);
  }
  return lines;
}

/** The first match of a simple XML element, its text trimmed ("" when absent). */
function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1].trim()) : '';
}

function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
}

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** What a Maven POM says about its project: name, address, licences, organisation, developers, parent. */
export function parsePom(xml) {
  const body = String(xml ?? '').replace(/<!--[\s\S]*?-->/g, '');
  // Elements of the project itself, not of its <parent>, <dependencies> or <build>.
  const own = body.replace(/<(parent|dependencies|dependencyManagement|build|profiles|distributionManagement|scm|repositories|pluginRepositories)\b[\s\S]*?<\/\1>/g, '');
  const parentXml = /<parent>([\s\S]*?)<\/parent>/.exec(body)?.[1];
  const licensesXml = /<licenses>([\s\S]*?)<\/licenses>/.exec(own)?.[1] ?? '';
  const developersXml = /<developers>([\s\S]*?)<\/developers>/.exec(own)?.[1] ?? '';
  const organizationXml = /<organization>([\s\S]*?)<\/organization>/.exec(own)?.[1] ?? '';
  return {
    name: tag(own.replace(/<(licenses|developers|organization|contributors)\b[\s\S]*?<\/\1>/g, ''), 'name'),
    url: tag(own.replace(/<(licenses|developers|organization|contributors|issueManagement|ciManagement|mailingLists)\b[\s\S]*?<\/\1>/g, ''), 'url'),
    licenses: tags(licensesXml, 'license').map((l) => ({ name: tag(l, 'name'), url: tag(l, 'url') })),
    organization: tag(organizationXml, 'name'),
    developers: tags(developersXml, 'developer')
      .map((d) => tag(d, 'organization') || tag(d, 'name'))
      .filter(Boolean),
    parent: parentXml ? { group: tag(parentXml, 'groupId'), name: tag(parentXml, 'artifactId'), version: tag(parentXml, 'version') } : null,
  };
}

const MAVEN_LICENSES = [
  [/apache/i, 'Apache-2.0'],
  [/\bmit\b/i, 'MIT'],
  [/bsd[\s-]*3|3[\s-]*clause|new bsd|revised bsd/i, 'BSD-3-Clause'],
  [/bsd[\s-]*2|2[\s-]*clause|simplified bsd/i, 'BSD-2-Clause'],
  [/^bsd$|bsd license/i, 'BSD-3-Clause'],
  [/mozilla public license.*2\.0|\bmpl[\s-]*2/i, 'MPL-2.0'],
  [/eclipse public license.*2\.0|\bepl[\s-]*2/i, 'EPL-2.0'],
  [/eclipse public license|\bepl\b/i, 'EPL-1.0'],
  [/\bisc\b/i, 'ISC'],
  [/creative commons|cc0/i, 'CC0-1.0'],
  [/android software development kit license/i, 'Android-SDK'],
];

const LICENSE_URLS = [
  [/apache\.org\/licenses\/LICENSE-2\.0/i, 'Apache-2.0'],
  [/opensource\.org\/licenses\/mit/i, 'MIT'],
  [/opensource\.org\/licenses\/bsd-3/i, 'BSD-3-Clause'],
  [/developer\.android\.com\/studio\/terms/i, 'Android-SDK'],
];

/** The SPDX id of a licence a POM names in words ("The Apache Software License, Version 2.0"), else its name. */
export function spdxOfMavenLicense({ name = '', url = '' }) {
  for (const [re, id] of MAVEN_LICENSES) if (re.test(name)) return id;
  for (const [re, id] of LICENSE_URLS) if (re.test(url)) return id;
  return name.trim() || url.trim();
}

/**
 * One Android library from its POMs, nearest first (its own, then its parents'): the first POM
 * that names licences gives them, the first that names an organisation or developers gives the
 * holders of the copyright.
 */
export function mavenNotice({ group, name, version, poms }) {
  const parsed = (poms ?? []).map(parsePom);
  const licenses = parsed.find((p) => p.licenses.length > 0)?.licenses ?? [];
  const holders = parsed.map((p) => p.organization || p.developers.join(', ')).find(Boolean) ?? '';
  const ids = [...new Set(licenses.map(spdxOfMavenLicense))];
  return {
    name: `${group}:${name}`,
    version,
    license: ids.length > 1 ? `(${ids.join(' OR ')})` : (ids[0] ?? ''),
    licenseUrls: [...new Set(licenses.map((l) => l.url).filter(Boolean))],
    copyright: holders ? [`Copyright ${holders}`] : [],
    homepage: parsed.map((p) => p.url).find(Boolean) ?? '',
    title: parsed[0]?.name ?? '',
  };
}

/**
 * The notices file the app reads: packages sorted by name, each with its licence and copyright, and
 * the licence texts in a separate list (many packages share one text) that packages point into.
 */
export function buildNotices({ version, js, android, standardTexts }) {
  const texts = [];
  const index = new Map();
  const textId = (text) => {
    if (!index.has(text)) {
      index.set(text, texts.length);
      texts.push(text);
    }
    return index.get(text);
  };
  /** The standard text of each licence an SPDX expression names, for a package without its own licence file. */
  const standard = (license) => license.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/).map((id) => standardTexts[id]).filter(Boolean).map(textId);
  const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });
  const jsPackages = [...js].sort(byName).map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license,
    copyright: p.copyright,
    homepage: p.homepage,
    texts: p.texts.length ? p.texts.map((t) => textId(t.text)) : standard(p.license),
  }));
  const androidPackages = [...android].sort(byName).map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license,
    copyright: p.copyright,
    homepage: p.homepage || p.licenseUrls[0] || '',
    texts: standard(p.license),
    licenseUrls: p.licenseUrls,
  }));
  return { version, sections: [{ id: 'js', packages: jsPackages }, { id: 'android', packages: androidPackages }], texts };
}
