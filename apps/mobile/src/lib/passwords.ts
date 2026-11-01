/**
 * The passwords saved in Corvus on the computers, as the phone reads them from the sync chain
 * (collection "credentials", end-to-end encrypted there and sealed again on the phone, see
 * password-vault.ts). The phone only reads them: they are added and changed on a computer. Pure so
 * it is unit tested.
 */

/** A saved login, as the phone uses it (the synced record has more: 2FA, history, agent switches). */
export interface Login {
  id: string;
  /** The site's origin (scheme://host[:port]). */
  origin: string;
  username: string;
  password: string;
  notes: string;
  updatedAt: number;
}

/** The host people read for a login's site ("example.com" for https://www.example.com). */
export function loginHost(origin: string): string {
  try {
    return new URL(origin).host.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

/** The saved logins in the synced records: the valid ones, by site then username. */
export function loginsOf(records: Record<string, unknown>): Login[] {
  const out: Login[] = [];
  for (const [id, raw] of Object.entries(records)) {
    const v = raw as Partial<Record<keyof Login, unknown>> | null;
    if (!v || typeof v.origin !== 'string' || !v.origin || typeof v.username !== 'string' || typeof v.password !== 'string') continue;
    out.push({ id, origin: v.origin, username: v.username, password: v.password, notes: typeof v.notes === 'string' ? v.notes : '', updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0 });
  }
  return out.sort((a, b) => loginHost(a.origin).localeCompare(loginHost(b.origin)) || a.username.localeCompare(b.username));
}

/** Logins whose site or username contains every word of `query`. */
export function filterLogins(logins: readonly Login[], query: string): Login[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...logins];
  return logins.filter((l) => words.every((w) => `${loginHost(l.origin)} ${l.username}`.toLowerCase().includes(w)));
}

/**
 * The logins for a page or a host asking to sign in: the same origin first, then the same host over
 * the other scheme or with or without "www." (a login saved on http://router.lan also fits
 * https://router.lan). Other sites' logins never match, so a page cannot get them filled in.
 */
export function loginsFor(logins: readonly Login[], pageUrlOrHost: string): Login[] {
  let origin = '';
  let host = '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(pageUrlOrHost) ? pageUrlOrHost : `https://${pageUrlOrHost}`);
    origin = /^[a-z][a-z0-9+.-]*:\/\//i.test(pageUrlOrHost) ? url.origin : '';
    host = url.host.toLowerCase().replace(/^www\./, '');
  } catch {
    return [];
  }
  if (!host) return [];
  // A login saved over https is never offered to a page over plain http, where it would travel readable.
  const plain = origin.startsWith('http:');
  const exact = logins.filter((l) => origin !== '' && l.origin === origin);
  const sameHost = logins.filter((l) => !exact.includes(l) && loginHost(l.origin).toLowerCase() === host && !(plain && l.origin.startsWith('https:')));
  return [...exact, ...sameHost];
}

/**
 * A script that fills a login into the page: the visible password field and the text or email field
 * before it in the same form (or the page). Fields are set as typing would (input and change
 * events), so sites built on frameworks see the values. It fills nothing when the page is no longer
 * the login's site (it navigated while the phone's lock was asked for). Evaluates to true when a
 * field was filled.
 */
export function fillLoginScript(login: Pick<Login, 'origin' | 'username' | 'password'>): string {
  const { username, password } = login;
  return `(function () {
  if (location.host.toLowerCase().replace(/^www\\./, '') !== ${JSON.stringify(loginHost(login.origin).toLowerCase())}) return false;
  if (${JSON.stringify(login.origin.startsWith('https:'))} && location.protocol !== 'https:') return false;
  var visible = function (el) { var r = el.getBoundingClientRect(); return !el.disabled && !el.readOnly && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  var set = function (el, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input')).filter(visible);
  var pass = inputs.filter(function (el) { return el.type === 'password'; })[0];
  var scope = pass ? Array.prototype.slice.call((pass.form || document).querySelectorAll('input')).filter(visible) : inputs;
  var before = pass ? scope.slice(0, scope.indexOf(pass)) : scope;
  var user = before.filter(function (el) { return ['text', 'email', 'tel', ''].indexOf(el.type) >= 0; }).pop();
  var filled = false;
  if (user && ${JSON.stringify(username)} !== '') { set(user, ${JSON.stringify(username)}); filled = true; }
  if (pass) { set(pass, ${JSON.stringify(password)}); filled = true; }
  return filled;
})();`;
}
