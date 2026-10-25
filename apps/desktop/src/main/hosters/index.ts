import { hosterFor, type HosterId, type HosterReason } from "../../shared/hosters";
import { looksLikeFile } from "../../shared/link-grabber";
import { anchors, hasCaptcha, isChallenge, metaRefresh } from "./html";
import { resolveMega } from "./mega";
import {
  resolveBuzzheavier,
  resolveDrive,
  resolveDropbox,
  resolveGofile,
  resolveKrakenfiles,
  resolveMediafire,
  resolveOnedrive,
  resolveOnefichier,
  resolvePixeldrain,
  resolveSendspace,
  resolveSolidfiles,
  resolveSourceforge,
  resolveWetransfer,
  resolveYandex,
} from "./sites";
import { attention, file, offline, type HosterNet, type Resolution, type Resolver } from "./types";
import { resolveXfs } from "./xfs";

export type { HosterNet, Resolution } from "./types";

/**
 * The link on a page that most looks like its file: a link with the `download` attribute or to a
 * named file, better when its text says "download". Null when no link stands out.
 */
export function pageDownloadLink(html: string, base: string): string | null {
  const scored = anchors(html, base)
    .filter((a) => a.href !== base)
    .map((a) => {
      let score = 0;
      if (/\sdownload(?:\s|=|>)/i.test(a.tag)) score += 2;
      if (looksLikeFile(a.href)) score += 2;
      if (/download|descargar|télécharger|herunterladen|scarica/i.test(`${a.text} ${a.tag}`)) score += 1;
      return { href: a.href, score };
    })
    .filter((c) => c.score >= 2)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const best = scored.filter((c) => c.score === scored[0]!.score);
  return new Set(best.map((c) => c.href)).size === 1 ? best[0]!.href : null;
}

/**
 * Any other page: a link that answers with the file is the file; a shortener that lands on a
 * known host goes on with that host; otherwise the page's own download link, if one stands out.
 */
async function resolvePage(raw: string, net: HosterNet, stuck: HosterReason, depth: number): Promise<Resolution> {
  const res = await net.fetch(raw);
  if (res.isFile) {
    await res.cancel();
    return file(res.url);
  }
  if (depth === 0 && res.url !== raw && hosterFor(res.url) && hosterFor(res.url)?.id !== hosterFor(raw)?.id) {
    await res.cancel();
    return resolveLink(res.url, net, depth + 1);
  }
  const html = await res.text();
  if (res.status === 404 || res.status === 410) return offline();
  if (isChallenge(html)) return attention("challenge");
  const link = pageDownloadLink(html, res.url);
  if (link) return file(link);
  const refresh = metaRefresh(html, res.url);
  if (refresh && looksLikeFile(refresh)) return file(refresh);
  return attention(hasCaptcha(html) ? "captcha" : stuck);
}

const RESOLVERS: Record<HosterId, Resolver | null> = {
  mega: resolveMega,
  mediafire: resolveMediafire,
  pixeldrain: resolvePixeldrain,
  gdrive: resolveDrive,
  dropbox: resolveDropbox,
  onedrive: resolveOnedrive,
  wetransfer: resolveWetransfer,
  gofile: resolveGofile,
  yandex: resolveYandex,
  sourceforge: resolveSourceforge,
  "1fichier": resolveOnefichier,
  krakenfiles: resolveKrakenfiles,
  sendspace: resolveSendspace,
  solidfiles: resolveSolidfiles,
  buzzheavier: resolveBuzzheavier,
  xfs: resolveXfs,
  // Free downloads there need a CAPTCHA; a premium account's page may hold the file.
  captcha: null,
  protector: null,
};

/** Finds the file behind a hoster (or any) link, through the profile's session. */
export async function resolveLink(url: string, net: HosterNet, depth = 0): Promise<Resolution> {
  const hoster = hosterFor(url);
  if (hoster?.id === "protector") return attention("protector");
  const resolver = hoster ? RESOLVERS[hoster.id] : null;
  if (resolver) return resolver(url, net);
  return resolvePage(url, net, hoster?.id === "captcha" ? "captcha" : "page", depth);
}
