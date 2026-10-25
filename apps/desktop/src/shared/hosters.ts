/**
 * File hosts the download queue knows: their names, the addresses they answer on, and how many
 * files one of them serves at once to a free account. Pure, shared by the link grabber (which
 * links are hoster pages), the queue (how many run per host) and the downloads page (labels).
 * How each one is resolved into a file lives in main/hosters/.
 */

export type HosterId =
  | "mega"
  | "mediafire"
  | "pixeldrain"
  | "gdrive"
  | "dropbox"
  | "onedrive"
  | "wetransfer"
  | "gofile"
  | "yandex"
  | "sourceforge"
  | "1fichier"
  | "krakenfiles"
  | "sendspace"
  | "solidfiles"
  | "buzzheavier"
  | "xfs"
  | "captcha"
  | "protector";

export interface Hoster {
  id: HosterId;
  /** Shown in the queue ("MediaFire"); for the shared groups, the site's own name. */
  name: string;
  /** Files downloaded at once from it. */
  slots: number;
}

interface CatalogEntry {
  id: HosterId;
  name: string;
  slots: number;
  hosts: readonly string[];
}

/** Sites built on the XFileSharing script: a free-download form, often a countdown, then the file. */
const XFS_SITES: Record<string, string> = {
  "send.cm": "Send.cm",
  "katfile.com": "Katfile",
  "ddownload.com": "DDownload",
  "ddl.to": "DDownload",
  "dailyuploads.net": "Dailyuploads",
  "usersdrive.com": "UsersDrive",
  "hexupload.net": "HexUpload",
  "hexload.com": "HexUpload",
  "uploadrar.com": "UploadRAR",
  "clicknupload.click": "ClicknUpload",
  "clicknupload.org": "ClicknUpload",
  "clicknupload.co": "ClicknUpload",
  "mexa.sh": "Mexa",
  "uploady.io": "Uploady",
  "drop.download": "Drop.download",
  "hotlink.cc": "Hotlink",
  "uploadboy.com": "UploadBoy",
  "file-upload.org": "File-Upload",
  "userupload.net": "UserUpload",
  "up-load.io": "Up-Load",
  "uploadev.org": "Uploadev",
  "frdl.io": "FRDL",
  "filespayout.com": "FilesPayout",
  "worldbytez.com": "WorldBytez",
};

/** Sites whose free download needs a CAPTCHA: the person solves it in the page (premium accounts get the file). */
const CAPTCHA_SITES: Record<string, string> = {
  "rapidgator.net": "Rapidgator",
  "rg.to": "Rapidgator",
  "nitroflare.com": "Nitroflare",
  "nitro.download": "Nitroflare",
  "turbobit.net": "Turbobit",
  "turb.to": "Turbobit",
  "turb.cc": "Turbobit",
  "hitfile.net": "Hitfile",
  "hil.to": "Hitfile",
  "filefactory.com": "FileFactory",
  "uploadhaven.com": "UploadHaven",
  "workupload.com": "Workupload",
  "alfafile.net": "Alfafile",
  "filejoker.net": "FileJoker",
  "filenext.com": "FileNext",
  "fileboom.me": "Fileboom",
  "keep2share.cc": "Keep2Share",
  "k2s.cc": "Keep2Share",
  "tezfiles.com": "TezFiles",
  "fikper.com": "Fikper",
  "uptobox.com": "Uptobox",
  "terabox.com": "TeraBox",
  "1024terabox.com": "TeraBox",
};

/** Link protectors and paid shorteners: they show the real links after a CAPTCHA or an ad. */
const PROTECTORS: Record<string, string> = {
  "filecrypt.cc": "FileCrypt",
  "filecrypt.co": "FileCrypt",
  "keeplinks.org": "Keeplinks",
  "linkvertise.com": "Linkvertise",
  "ouo.io": "ouo.io",
  "ouo.press": "ouo.io",
  "shrinkme.io": "ShrinkMe",
  "adf.ly": "AdFly",
  "safelinking.net": "SafeLinking",
};

const CATALOG: readonly CatalogEntry[] = [
  { id: "mega", name: "MEGA", slots: 2, hosts: ["mega.nz", "mega.co.nz", "mega.io"] },
  { id: "mediafire", name: "MediaFire", slots: 2, hosts: ["mediafire.com"] },
  { id: "pixeldrain", name: "Pixeldrain", slots: 2, hosts: ["pixeldrain.com", "pixeldra.in"] },
  { id: "gdrive", name: "Google Drive", slots: 2, hosts: ["drive.google.com", "drive.usercontent.google.com", "docs.google.com"] },
  { id: "dropbox", name: "Dropbox", slots: 2, hosts: ["dropbox.com", "db.tt"] },
  { id: "onedrive", name: "OneDrive", slots: 2, hosts: ["onedrive.live.com", "1drv.ms"] },
  { id: "wetransfer", name: "WeTransfer", slots: 1, hosts: ["wetransfer.com", "we.tl"] },
  { id: "gofile", name: "Gofile", slots: 2, hosts: ["gofile.io"] },
  { id: "yandex", name: "Yandex Disk", slots: 2, hosts: ["disk.yandex.ru", "disk.yandex.com", "disk.yandex.com.tr", "disk.yandex.kz", "disk.yandex.by", "disk.yandex.ua", "yadi.sk"] },
  { id: "sourceforge", name: "SourceForge", slots: 2, hosts: ["sourceforge.net"] },
  {
    id: "1fichier",
    name: "1fichier",
    slots: 1,
    hosts: ["1fichier.com", "alterupload.com", "cjoint.net", "desfichiers.com", "dfichiers.com", "megadl.fr", "mesfichiers.org", "piecejointe.net", "pjointe.com", "tenvoi.com", "dl4free.com"],
  },
  { id: "krakenfiles", name: "KrakenFiles", slots: 1, hosts: ["krakenfiles.com"] },
  { id: "sendspace", name: "SendSpace", slots: 1, hosts: ["sendspace.com"] },
  { id: "solidfiles", name: "Solidfiles", slots: 1, hosts: ["solidfiles.com"] },
  { id: "buzzheavier", name: "BuzzHeavier", slots: 2, hosts: ["buzzheavier.com"] },
];

function hostName(raw: string): string {
  return raw.toLowerCase().replace(/^www\./, "");
}

const matches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** The file host an address belongs to, or null for any other site. */
export function hosterFor(rawUrl: string): Hoster | null {
  let host: string;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    host = hostName(url.hostname);
  } catch {
    return null;
  }
  for (const e of CATALOG) if (e.hosts.some((h) => matches(host, h))) return { id: e.id, name: e.name, slots: e.slots };
  const group = (sites: Record<string, string>, id: HosterId, slots: number): Hoster | null => {
    const domain = Object.keys(sites).find((d) => matches(host, d));
    return domain ? { id, name: sites[domain]!, slots } : null;
  };
  return group(XFS_SITES, "xfs", 1) ?? group(CAPTCHA_SITES, "captcha", 1) ?? group(PROTECTORS, "protector", 1);
}

/**
 * Hoster addresses that are file or folder pages (not the site's home, help or sign-in pages), so
 * the link grabber keeps only links that lead to something to download.
 */
export function isHosterDownloadLink(rawUrl: string): boolean {
  const hoster = hosterFor(rawUrl);
  if (!hoster) return false;
  const url = new URL(rawUrl);
  const p = url.pathname;
  switch (hoster.id) {
    case "mega":
      return /^\/(file|folder|embed)\//.test(p) || /^#F?!/.test(url.hash);
    case "mediafire":
      return /^\/(file|file_premium|download|view|folder)\//.test(p) || (p === "/" && /^\?[a-z0-9]{8,}/i.test(url.search));
    case "pixeldrain":
      return /^\/(u|l|api\/file|api\/list)\//.test(p);
    case "gdrive":
      return p.includes("/file/d/") || p.includes("/folders/") || url.searchParams.has("id");
    case "dropbox":
      return /^\/(s|sh|scl\/fi|scl\/fo)\//.test(p) || hostName(url.hostname) === "db.tt";
    case "onedrive":
      return hostName(url.hostname) === "1drv.ms" || url.searchParams.has("resid") || url.searchParams.has("id") || p.includes("/redir");
    case "wetransfer":
      return hostName(url.hostname) === "we.tl" || p.startsWith("/downloads/");
    case "gofile":
      return p.startsWith("/d/");
    case "yandex":
      return /^\/(d|i)\//.test(p);
    case "sourceforge":
      return /^\/projects\/[^/]+\/files\/.+/.test(p);
    case "1fichier":
      return /^[?][a-z0-9]{5,}/i.test(url.search);
    default:
      // Script and CAPTCHA hosts, protectors: anything past the home page on the site itself (its
      // download servers, dl3.rapidgator.net and the like, serve the files themselves).
      return hostName(url.hostname).split(".").length === 2 && (p.length > 1 || url.search.length > 1);
  }
}

/** Every domain the catalog knows (for docs and tests). */
export function knownHosterDomains(): string[] {
  return [...CATALOG.flatMap((e) => e.hosts), ...Object.keys(XFS_SITES), ...Object.keys(CAPTCHA_SITES), ...Object.keys(PROTECTORS)];
}

/** Why a hoster link waits, needs the person, or failed (the downloads page words each one). */
export type HosterReason =
  /** The free download needs a CAPTCHA. */
  | "captcha"
  /** The site checks that a person is there (Cloudflare and the like). */
  | "challenge"
  /** The host asks to sign in. */
  | "login"
  /** Only premium accounts get this file. */
  | "premium"
  /** The file has a password, typed in its page. */
  | "password"
  /** The links are behind a link protector (CAPTCHA or ad). */
  | "protector"
  /** Corvus did not find the file on the page. */
  | "page"
  /** The page's link expired or the page download failed: open it again. */
  | "expired"
  /** A free-account limit: wait before the next download. */
  | "limit"
  /** The host's transfer quota is used up for now. */
  | "quota"
  /** A countdown before the free download. */
  | "countdown"
  /** The host is busy or rate-limits for now. */
  | "busy"
  /** The file was deleted, taken down or never existed. */
  | "offline";
