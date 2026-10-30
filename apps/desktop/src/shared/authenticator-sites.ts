/**
 * Where to put a 2FA account imported from an authenticator app: the sign-in page of well-known
 * issuers (autofill matches the exact origin, so it is the page that asks for the code), or the
 * issuer itself when it is a domain name. Anything else stays empty for the person to fill in: a
 * wrong guess would offer the code on the wrong site. The account's e-mail domain is never used.
 */
import { siteOf } from "./tab-organizer";

/** Sign-in origin by normalized issuer name (lowercase letters and digits only). */
const ISSUER_SITES: Record<string, string> = {
  google: "https://accounts.google.com",
  gmail: "https://accounts.google.com",
  microsoft: "https://login.live.com",
  microsoftaccount: "https://login.live.com",
  outlook: "https://login.live.com",
  hotmail: "https://login.live.com",
  apple: "https://appleid.apple.com",
  appleid: "https://appleid.apple.com",
  amazon: "https://www.amazon.com",
  aws: "https://signin.aws.amazon.com",
  amazonwebservices: "https://signin.aws.amazon.com",
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  bitbucket: "https://bitbucket.org",
  atlassian: "https://id.atlassian.com",
  discord: "https://discord.com",
  x: "https://x.com",
  xcorp: "https://x.com",
  twitter: "https://x.com",
  xtwitter: "https://x.com",
  facebook: "https://www.facebook.com",
  instagram: "https://www.instagram.com",
  linkedin: "https://www.linkedin.com",
  reddit: "https://www.reddit.com",
  dropbox: "https://www.dropbox.com",
  proton: "https://account.proton.me",
  protonmail: "https://account.proton.me",
  protonag: "https://account.proton.me",
  cloudflare: "https://dash.cloudflare.com",
  digitalocean: "https://cloud.digitalocean.com",
  hetzner: "https://accounts.hetzner.com",
  hetznercloud: "https://accounts.hetzner.com",
  ovh: "https://www.ovh.com",
  ovhcloud: "https://www.ovh.com",
  binance: "https://accounts.binance.com",
  coinbase: "https://login.coinbase.com",
  kraken: "https://www.kraken.com",
  bybit: "https://www.bybit.com",
  paypal: "https://www.paypal.com",
  stripe: "https://dashboard.stripe.com",
  slack: "https://slack.com",
  epicgames: "https://www.epicgames.com",
  steam: "https://store.steampowered.com",
  twitch: "https://www.twitch.tv",
  npm: "https://www.npmjs.com",
  npmjs: "https://www.npmjs.com",
  docker: "https://login.docker.com",
  dockerhub: "https://login.docker.com",
  tailscale: "https://login.tailscale.com",
  namecheap: "https://www.namecheap.com",
  godaddy: "https://sso.godaddy.com",
  heroku: "https://id.heroku.com",
  vercel: "https://vercel.com",
  netlify: "https://app.netlify.com",
  bitwarden: "https://vault.bitwarden.com",
  "1password": "https://my.1password.com",
  mega: "https://mega.nz",
  zoho: "https://accounts.zoho.com",
  yahoo: "https://login.yahoo.com",
  okx: "https://www.okx.com",
  kucoin: "https://www.kucoin.com",
  bitstamp: "https://www.bitstamp.net",
  gemini: "https://exchange.gemini.com",
  cryptocom: "https://crypto.com",
  huggingface: "https://huggingface.co",
  openai: "https://auth.openai.com",
  tiktok: "https://www.tiktok.com",
  nintendo: "https://accounts.nintendo.com",
  ubisoft: "https://account.ubisoft.com",
  ea: "https://signin.ea.com",
  battlenet: "https://account.battle.net",
  blizzard: "https://account.battle.net",
  shopify: "https://accounts.shopify.com",
  wordpress: "https://wordpress.com",
  wordpresscom: "https://wordpress.com",
  mailchimp: "https://login.mailchimp.com",
  zoom: "https://zoom.us",
  figma: "https://www.figma.com",
  linode: "https://login.linode.com",
  vultr: "https://my.vultr.com",
  backblaze: "https://secure.backblaze.com",
  fastmail: "https://app.fastmail.com",
  tuta: "https://app.tuta.com",
  tutanota: "https://app.tuta.com",
  porkbun: "https://porkbun.com",
  gandi: "https://account.gandi.net",
  hostinger: "https://hpanel.hostinger.com",
  ionos: "https://login.ionos.com",
  sentry: "https://sentry.io",
  jetbrains: "https://account.jetbrains.com",
  pypi: "https://pypi.org",
  rubygems: "https://rubygems.org",
  wise: "https://wise.com",
  kick: "https://kick.com",
  patreon: "https://www.patreon.com",
  ebay: "https://signin.ebay.com",
  snapchat: "https://accounts.snapchat.com",
  mozilla: "https://accounts.firefox.com",
  firefox: "https://accounts.firefox.com",
};

/** Brands distinctive enough to recognize by the first word of a longer issuer ("Google Cloud"). */
const BRANDS = new Set(["google", "microsoft", "amazon", "github", "gitlab", "atlassian", "hetzner", "proton", "cloudflare", "digitalocean", "binance", "coinbase", "paypal", "dropbox", "discord", "docker", "ovhcloud", "bitwarden", "nintendo", "ubisoft"]);

const normalize = (issuer: string): string => issuer.toLowerCase().replace(/[^a-z0-9]/g, "");

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const hostOf = (origin: string): string => new URL(origin).hostname;

/** Known sign-in origins by host and by bare domain ("github.com", "google.com"), first one wins. */
const BY_HOST = new Map<string, string>();
for (const origin of Object.values(ISSUER_SITES)) {
  for (const key of [hostOf(origin), siteOf(origin)]) if (!BY_HOST.has(key)) BY_HOST.set(key, origin);
}

/**
 * The sign-in origin for an issuer: a known service ("GitHub", "Amazon Web Services", "Google Cloud"
 * by its first word), or the issuer itself when it is a domain name ("vault.example.org"). "" when
 * unknown.
 */
export function issuerSite(issuer: string): string {
  const name = issuer.trim();
  if (!name) return "";
  const known = ISSUER_SITES[normalize(name)];
  if (known) return known;
  if (DOMAIN.test(name)) {
    const host = name.toLowerCase().replace(/^www\./, "");
    return BY_HOST.get(host) ?? `https://${name.toLowerCase()}`;
  }
  const first = normalize(name.split(/[\s(:,]+/)[0] ?? "");
  return BRANDS.has(first) ? (ISSUER_SITES[first] ?? "") : "";
}
