/**
 * Just enough HTML reading for hoster pages: forms, links, meta refreshes and the signs of a
 * CAPTCHA or a "are you human" check. Pages are only read, never run.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** An attribute's value in one tag ("<a href=...>"), entities decoded. */
export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

/** An absolute http(s) address, or null. */
export function absolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export interface Anchor {
  href: string;
  text: string;
  tag: string;
}

/** Every link of the page, with absolute addresses and its text (tags stripped). */
export function anchors(html: string, base: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = `<a${m[1]}>`;
    const href = absolute(attr(tag, "href"), base);
    if (href) out.push({ href, text: decodeEntities(m[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(), tag });
  }
  return out;
}

export interface Form {
  action: string;
  method: "GET" | "POST";
  /** Hidden and submit inputs, buttons with a name, in order. */
  fields: Record<string, string>;
  /** The form's own HTML. */
  html: string;
}

export function forms(html: string, base: string): Form[] {
  const out: Form[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const tag = `<form${m[1]}>`;
    const body = m[2]!;
    const fields: Record<string, string> = {};
    for (const input of body.matchAll(/<input\b[^>]*>/gi)) {
      const name = attr(input[0], "name");
      const type = (attr(input[0], "type") ?? "text").toLowerCase();
      if (!name || type === "checkbox" || type === "radio" || type === "file") continue;
      // A submit input only counts when it has a name (method_free, ...).
      fields[name] = attr(input[0], "value") ?? "";
    }
    for (const button of body.matchAll(/<button\b[^>]*>/gi)) {
      const name = attr(button[0], "name");
      if (name && !(name in fields)) fields[name] = attr(button[0], "value") ?? "";
    }
    out.push({ action: absolute(attr(tag, "action"), base) ?? base, method: (attr(tag, "method") ?? "get").toUpperCase() === "POST" ? "POST" : "GET", fields, html: body });
  }
  return out;
}

/** The address of a `<meta http-equiv="refresh" content="5; url=...">`. */
export function metaRefresh(html: string, base: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*["']?refresh/i.test(m[0])) continue;
    const content = attr(m[0], "content") ?? "";
    const url = /url\s*=\s*['"]?([^'";]+)/i.exec(content)?.[1];
    if (url) return absolute(url, base);
  }
  return null;
}

/** The page asks for a CAPTCHA (reCAPTCHA, hCaptcha, Turnstile, a typed code). */
export function hasCaptcha(html: string): boolean {
  return /g-recaptcha|recaptcha\/api\.js|h-captcha|hcaptcha\.com\/1\/api|cf-turnstile|challenges\.cloudflare\.com\/turnstile|name=["']?(?:captcha_code|code|adcopy_response|captcha)["'\s>]/i.test(html);
}

/** The page is a "checking your browser" interstitial (Cloudflare, DDoS-Guard). */
export function isChallenge(html: string): boolean {
  return /<title>\s*(?:Just a moment|Attention Required|DDoS-Guard)|cf-chl-|challenge-platform|ddos-guard\/js-challenge/i.test(html);
}

/** The page's <title>, without the site's suffix. */
export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]!).replace(/\s+/g, " ").trim() || null : null;
}

/** "1.5 GB" -> bytes (rough: the server's own size wins once the download starts). */
export function parseSize(text: string): number | undefined {
  const m = /([\d.,]+)\s*([KMGT]?)i?B\b/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,(?=\d{3}\b)/g, "").replace(",", "."));
  const unit = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]!.toUpperCase() as "" | "K" | "M" | "G" | "T"];
  return Number.isFinite(n) ? Math.round(n * unit) : undefined;
}

/** A waiting time written on the page ("wait 4 minutes", "17 seconds"), in seconds. */
export function waitSeconds(text: string): number | null {
  const m = /(?:wait|attendre|esperar?|warten)[^.<]{0,40}?(\d+)\s*(hours?|heures?|horas?|minutes?|minutos?|min\b|seconds?|secondes?|segundos?|sec\b|s\b)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return unit.startsWith("h") ? n * 3600 : unit.startsWith("m") ? n * 60 : n;
}
