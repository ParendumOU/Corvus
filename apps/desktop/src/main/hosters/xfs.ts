import { anchors, forms, hasCaptcha, isChallenge, waitSeconds, type Form } from "./html";
import { attention, file, offline, wait, type HosterNet, type Resolution } from "./types";

/**
 * Hosts on the XFileSharing script (send.cm, katfile, ddownload, …): the file page has a "Free
 * download" form (op=download1), then often a countdown and a second form (op=download2) that
 * answers with the file or a page holding its link. A CAPTCHA on the way is left to the person.
 */

/** Longest countdown waited in place; longer ones put the file back in the queue for later. */
const MAX_INLINE_WAIT_S = 120;

const GONE = /File Not Found|file was removed|file has been removed|No such file|The file you were looking for could not be found|file is no longer available/i;

/** The countdown before the second form ("<span class="seconds">30</span>", "countdown ... 30"). */
export function xfsCountdown(html: string): number {
  const m = /<span[^>]*class=["'][^"']*seconds[^"']*["'][^>]*>\s*(\d+)\s*</i.exec(html) ?? /id=["']countdown["'][\s\S]{0,200}?(\d{1,3})/i.exec(html);
  return m ? Number(m[1]) : 0;
}

/** The download form of an XFS page: op=download1 or op=download2. */
export function xfsForm(html: string, base: string): Form | null {
  return forms(html, base).find((f) => f.fields.op === "download1" || f.fields.op === "download2") ?? null;
}

/** The file's link on the last page: the script's /d/<hash>/ path, or a link to a named file. */
export function xfsDirectLink(html: string, base: string): string | null {
  const host = new URL(base).hostname;
  const links = anchors(html, base);
  return (
    links.find((a) => /\/d\/[a-z0-9]{8,}\//i.test(a.href))?.href ??
    links.find((a) => /download|direct link|click here/i.test(a.text) && new URL(a.href).hostname !== host && /\/[^/?#]+\.[a-z0-9]{2,5}(?:$|\?)/i.test(new URL(a.href).pathname))?.href ??
    null
  );
}

export async function resolveXfs(raw: string, net: HosterNet): Promise<Resolution> {
  let res = await net.fetch(raw);
  for (let step = 0; step < 4; step++) {
    if (res.isFile) {
      await res.cancel();
      return file(res.url, { segments: false });
    }
    const html = await res.text();
    if (res.status === 404 || GONE.test(html)) return offline();
    if (isChallenge(html)) return attention("challenge");
    const limit = /You have to wait|You can download files up to|reached the download limit|download limit/i.test(html) ? waitSeconds(html) : null;
    if (limit) return wait(limit, "limit");
    if (hasCaptcha(html)) return attention("captcha");
    if (/<input[^>]*name=["']password["']/i.test(html)) return attention("password");
    if (/premium (?:users|members) only|only for premium/i.test(html)) return attention("premium");
    const form = xfsForm(html, res.url);
    if (!form) {
      const link = xfsDirectLink(html, res.url);
      return link ? file(link, { segments: false }) : attention("page");
    }
    const fields = { ...form.fields };
    // The free path, never the premium one.
    delete fields.method_premium;
    if (fields.op === "download1" && !fields.method_free) fields.method_free = "Free Download";
    const countdown = xfsCountdown(html);
    if (countdown > MAX_INLINE_WAIT_S) return wait(countdown, "countdown");
    if (countdown > 0) await net.sleep(countdown * 1000 + 500);
    res = await net.fetch(form.action, { method: "POST", headers: { referer: res.url }, form: fields });
  }
  return attention("page");
}
