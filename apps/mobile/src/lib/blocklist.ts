/**
 * The browser's ad and tracker blocker, the part written in TypeScript: it turns the desktop's
 * filter lists (EasyList syntax) into a compact rule set and writes it as a small text file, which
 * the Android side (modules/browser-kit, ContentBlocker.kt) loads and matches every request
 * against. Only what a phone can match quickly is kept:
 *
 * - `||host^` (any party) and `||host^$third-party`: requests to that host and its subdomains;
 * - `||host/path`: requests to that host whose path starts with it;
 * - `@@||host^`: never blocked (exceptions);
 * - `host##selector`: elements hidden on that site (cosmetic filters), plain CSS selectors only.
 *
 * Rules with other options (resource types, `domain=`, redirects, scriptlets), URL patterns
 * without a host, regular expressions and generic cosmetic filters are left out: a domain blocker
 * that never breaks a page beats half of a full engine. `matchRequest` is the reference matcher;
 * the Kotlin one passes the same cases (modules/browser-kit/android/src/test/resources/blocklist).
 */

/** The filter lists the phone downloads: the ones the desktop blocks ads and trackers with, from the same place (Ghostery's mirror of the original lists). */
export const FILTER_LISTS: readonly string[] = [
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/easylist/easylist.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/easylist/easyprivacy.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/peter-lowe/serverlist.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/filters.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/privacy.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/unbreak.txt',
];

/** How often the lists are downloaded again. */
export const LIST_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Bumped when the compiled format changes, so an older cache is rebuilt. */
export const COMPILED_VERSION = 1;

/**
 * Used until the lists have been downloaded once (and if they never can be): the desktop's own
 * fallback (apps/desktop/src/main/adblock-fallback.ts).
 */
export const FALLBACK_FILTERS = `
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||google-analytics.com^
||googletagmanager.com^
||googletagservices.com^
||adservice.google.com^
||2mdn.net^
||adnxs.com^
||adsrvr.org^
||advertising.com^
||adform.net^
||adroll.com^
||amazon-adsystem.com^
||casalemedia.com^
||criteo.com^
||criteo.net^
||pubmatic.com^
||rubiconproject.com^
||openx.net^
||moatads.com^
||taboola.com^
||outbrain.com^
||scorecardresearch.com^
||serving-sys.com^
||smartadserver.com^
||yieldmo.com^
||zedo.com^
||media.net^
||bidswitch.net^
||sharethrough.com^
||3lift.com^
||contextweb.com^
||gumgum.com^
||indexww.com^
||quantserve.com^
||quantcount.com^
||hotjar.com^
||mouseflow.com^
||fullstory.com^
||mixpanel.com^
||segment.com^
||segment.io^
||branch.io^
||amplitude.com^
||chartbeat.com^
||nr-data.net^
||optimizely.com^
||crazyegg.com^
||sentry.io^$third-party
||facebook.com/tr^
||connect.facebook.net^
||analytics.twitter.com^
||bat.bing.com^
||clarity.ms^
||mc.yandex.ru^
||app-measurement.com^
`;

export interface RuleSet {
  /** Hosts blocked whoever loads them (with their subdomains). */
  block: Set<string>;
  /** Hosts blocked when a page of another site loads them. */
  thirdParty: Set<string>;
  /** Hosts never blocked. */
  allow: Set<string>;
  /** Path prefixes blocked per host ("/ads/"). */
  paths: Map<string, string[]>;
  /** CSS selectors hidden per site. */
  cosmetic: Map<string, string[]>;
}

export function emptyRules(): RuleSet {
  return { block: new Set(), thirdParty: new Set(), allow: new Set(), paths: new Map(), cosmetic: new Map() };
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
/** Options that do not narrow which requests a host rule applies to (or narrow it to third parties). */
const NEUTRAL_OPTIONS = new Set(['important', 'all']);
const THIRD_PARTY_OPTIONS = new Set(['third-party', '3p', '~first-party', '~1p']);
/** Selector syntax of uBlock Origin and Adblock Plus that is not CSS. */
const PROCEDURAL = /:(?:-abp-|has-text|style|remove|matches-|upward|xpath|min-text-length|watch-attr|others|if|if-not|nth-ancestor|matches-path|remove-attr|remove-class|matches-attr)|^\+js|\{|\}/i;
/** Selectors per site, at most (some lists carry very long ones for a few sites). */
const MAX_SELECTORS_PER_SITE = 200;

function add<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** `||host^$opts` or `||host/path` split into host, path prefix and options; null for anything else. */
function hostRule(pattern: string): { host: string; path: string; options: string[] } | null {
  if (!pattern.startsWith('||')) return null;
  let body = pattern.slice(2);
  let options: string[] = [];
  const dollar = body.lastIndexOf('$');
  if (dollar !== -1) {
    options = body
      .slice(dollar + 1)
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean);
    body = body.slice(0, dollar);
  }
  const m = /^([a-z0-9.-]+)(.*)$/i.exec(body);
  if (!m) return null;
  const host = m[1]!.toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(host)) return null;
  // A final "*" adds nothing; "^|" ends like "^" (a separator or the end of the address).
  const rest = m[2]!.replace(/\*$/, '').replace(/\^\|$/, '^');
  if (rest === '' || rest === '^' || rest === '/') return { host, path: '', options };
  // A path prefix may end with "^" (kept: the path must stop there or go on with a separator).
  if (!rest.startsWith('/') || /[*|]/.test(rest) || rest.slice(0, -1).includes('^')) return null;
  return { host, path: rest, options };
}

/** One line of a filter list into the rule set; false when it is not a rule the phone keeps. */
function addLine(rules: RuleSet, raw: string): boolean {
  const line = raw.trim();
  if (line === '' || line.startsWith('!') || line.startsWith('[')) return false;
  const cosmetic = /^([^#]*)##(.+)$/.exec(line);
  if (cosmetic) {
    const selector = cosmetic[2]!.trim();
    if (PROCEDURAL.test(selector)) return false;
    const sites = cosmetic[1]!
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== '' && !s.startsWith('~') && HOST_RE.test(s));
    for (const site of sites) {
      if ((rules.cosmetic.get(site)?.length ?? 0) < MAX_SELECTORS_PER_SITE) add(rules.cosmetic, site, selector);
    }
    return sites.length > 0;
  }
  // Other cosmetic and scriptlet syntax (#@#, #?#, #$#, #%#) is not kept.
  if (/#[@?$%]#/.test(line)) return false;
  const exception = line.startsWith('@@');
  const rule = hostRule(exception ? line.slice(2) : line);
  if (!rule) return false;
  if (exception) {
    if (rule.options.length > 0 || rule.path) return false;
    rules.allow.add(rule.host);
    return true;
  }
  const narrowing = rule.options.filter((o) => !NEUTRAL_OPTIONS.has(o));
  const thirdParty = narrowing.length > 0 && narrowing.every((o) => THIRD_PARTY_OPTIONS.has(o));
  if (narrowing.length > 0 && !thirdParty) return false;
  if (rule.path) {
    if (thirdParty) return false;
    add(rules.paths, rule.host, rule.path);
  } else if (thirdParty) {
    rules.thirdParty.add(rule.host);
  } else {
    rules.block.add(rule.host);
  }
  return true;
}

/** Adds every rule of a filter list it can keep; returns how many it kept. */
export function addFilterList(rules: RuleSet, text: string): number {
  return addFilterLines(rules, text.split(/\r?\n/));
}

/** The same for some lines of a list (a long list is read a piece at a time). */
export function addFilterLines(rules: RuleSet, lines: readonly string[]): number {
  let kept = 0;
  for (const line of lines) if (addLine(rules, line)) kept++;
  return kept;
}

export function parseFilters(...lists: string[]): RuleSet {
  const rules = emptyRules();
  for (const text of lists) addFilterList(rules, text);
  // A host blocked for everyone needs no third-party rule.
  for (const host of rules.thirdParty) if (rules.block.has(host)) rules.thirdParty.delete(host);
  return rules;
}

export function ruleCount(rules: RuleSet): number {
  let n = rules.block.size + rules.thirdParty.size + rules.allow.size;
  for (const list of rules.paths.values()) n += list.length;
  for (const list of rules.cosmetic.values()) n += list.length;
  return n;
}

/**
 * The compiled rules as the Android side reads them: a header, then one rule per line, a letter and
 * a tab first ("b" blocked host, "t" third-party host, "a" allowed host, "p" host and path, "c" site
 * and selector).
 */
export function serializeRules(rules: RuleSet): string {
  const lines = [`! corvus-blocklist ${COMPILED_VERSION}`];
  const sorted = (set: Iterable<string>): string[] => [...set].sort();
  for (const host of sorted(rules.block)) lines.push(`b\t${host}`);
  for (const host of sorted(rules.thirdParty)) lines.push(`t\t${host}`);
  for (const host of sorted(rules.allow)) lines.push(`a\t${host}`);
  for (const host of sorted(rules.paths.keys())) for (const path of rules.paths.get(host)!) lines.push(`p\t${host}\t${path}`);
  for (const site of sorted(rules.cosmetic.keys())) for (const selector of rules.cosmetic.get(site)!) lines.push(`c\t${site}\t${selector}`);
  return `${lines.join('\n')}\n`;
}

/** Reads compiled rules back (what ContentBlocker.kt does); null for another format version. */
export function parseCompiled(text: string): RuleSet | null {
  const lines = text.split('\n');
  if (lines[0] !== `! corvus-blocklist ${COMPILED_VERSION}`) return null;
  const rules = emptyRules();
  for (const line of lines.slice(1)) {
    const [kind, a, b] = line.split('\t');
    if (!a) continue;
    if (kind === 'b') rules.block.add(a);
    else if (kind === 't') rules.thirdParty.add(a);
    else if (kind === 'a') rules.allow.add(a);
    else if (kind === 'p' && b) add(rules.paths, a, b);
    else if (kind === 'c' && b) add(rules.cosmetic, a, b);
  }
  return rules;
}

function hostAndPath(url: string): { host: string; path: string; web: boolean } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::\d+)?([^?#]*)/i.exec(url);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  return { host: m[2]!.toLowerCase().replace(/\.$/, ''), path: m[3] || '/', web: scheme === 'http' || scheme === 'https' };
}

/** The host and every parent domain of it with a dot ("a.b.example.com", "b.example.com", "example.com"). */
export function hostSuffixes(host: string): string[] {
  const out: string[] = [];
  let h = host;
  while (h.includes('.')) {
    out.push(h);
    h = h.slice(h.indexOf('.') + 1);
  }
  return out;
}

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'gob', 'or', 'ne', 'go', 'mil', 'nom', 'ltd', 'plc', 'gv']);

/** A host's site (registrable domain), close enough for third-party checks: "news.bbc.co.uk" is "bbc.co.uk". */
export function siteOf(host: string): string {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const take = labels[labels.length - 1]!.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const isLoopback = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]';

/** Whether a page's site is one the person turned blocking off for (the site or a parent domain of it). */
export function siteAllowed(pageHost: string, allowedSites: readonly string[]): boolean {
  const host = pageHost.toLowerCase().replace(/^www\./, '');
  return allowedSites.some((site) => host === site || host.endsWith(`.${site}`));
}

export interface RequestContext {
  /** The page that makes the request (its top frame); null when it is not known. */
  pageUrl: string | null;
  /** The page itself (never blocked). */
  mainFrame: boolean;
  /** Sites the person turned blocking off for. */
  allowedSites: readonly string[];
}

/** A path prefix ("/ads/"); one ending with "^" matches the path that stops there or goes on with a separator ("/tr^": "/tr", "/tr/x", not "/trending"). */
export function pathMatches(path: string, prefix: string): boolean {
  if (!prefix.endsWith('^')) return path.startsWith(prefix);
  const base = prefix.slice(0, -1);
  return path.startsWith(base) && (path.length === base.length || !/[A-Za-z0-9_.%-]/.test(path[base.length]!));
}

/** Whether a request is blocked. */
export function matchRequest(rules: RuleSet, url: string, ctx: RequestContext): boolean {
  if (ctx.mainFrame) return false;
  const req = hostAndPath(url);
  if (!req || !req.web || req.host === '' || isLoopback(req.host)) return false;
  const page = ctx.pageUrl ? hostAndPath(ctx.pageUrl) : null;
  if (page && siteAllowed(page.host, ctx.allowedSites)) return false;
  const suffixes = hostSuffixes(req.host);
  if (suffixes.some((h) => rules.allow.has(h))) return false;
  if (suffixes.some((h) => rules.block.has(h))) return true;
  if (page && page.host !== '' && siteOf(page.host) !== siteOf(req.host) && suffixes.some((h) => rules.thirdParty.has(h))) return true;
  for (const h of suffixes) {
    const prefixes = rules.paths.get(h);
    if (prefixes?.some((p) => pathMatches(req.path, p))) return true;
  }
  return false;
}

/** The selectors hidden on a page: the rules of its host and of every parent domain of it. */
export function cosmeticSelectors(rules: RuleSet, pageUrl: string): string[] {
  const page = hostAndPath(pageUrl);
  if (!page || !page.web) return [];
  const out: string[] = [];
  for (const h of hostSuffixes(page.host)) for (const s of rules.cosmetic.get(h) ?? []) if (!out.includes(s)) out.push(s);
  return out;
}

/**
 * The script that hides those elements: one style sheet, added once per document (it stays when
 * the page replaces its body). Run in the page with the WebView's injectJavaScript.
 */
export function cosmeticScript(selectors: readonly string[]): string | null {
  if (selectors.length === 0) return null;
  // One rule per selector: a selector this WebView does not know drops only its own rule.
  const css = selectors.map((s) => `${s}{display:none!important}`).join('\n');
  return `(function(){try{var id='corvus-hide';if(document.getElementById(id))return;var s=document.createElement('style');s.id=id;s.textContent=${JSON.stringify(css)};(document.head||document.documentElement).appendChild(s);}catch(e){}})();true;`;
}
