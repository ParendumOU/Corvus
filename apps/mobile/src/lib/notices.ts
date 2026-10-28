/**
 * The third-party notices of Settings → Third-party licenses: what scripts/third-party-notices.mjs
 * writes into the Android app's assets at build time (every npm package in the JavaScript bundle and
 * every Android library of the release build, with licence, copyright and licence text).
 */

export interface NoticePackage {
  name: string;
  version: string;
  /** SPDX expression ("MIT", "(MIT OR Apache-2.0)"). */
  license: string;
  /** The copyright lines of its licence files, or its holders. */
  copyright: string[];
  homepage: string;
  /** Indexes into `Notices.texts`: its licence files, or the standard text of its licence. */
  texts: number[];
  /** Android libraries: where the licence is published. */
  licenseUrls?: string[];
}

export type NoticeSectionId = 'js' | 'android';

export interface Notices {
  version: string;
  sections: { id: NoticeSectionId; packages: NoticePackage[] }[];
  texts: string[];
}

export function isNotices(value: unknown): value is Notices {
  const v = value as Notices | null;
  return !!v && typeof v.version === 'string' && Array.isArray(v.sections) && Array.isArray(v.texts) && v.sections.every((s) => typeof s.id === 'string' && Array.isArray(s.packages));
}

/** Folds case and accents, so "licencia" finds "Licencia" and "apache" finds "Apache". */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The sections with only the packages that match every word of `query` in their name, version,
 * licence or copyright; empty sections are left out. An empty query keeps everything.
 */
export function filterNotices(notices: Notices, query: string): Notices['sections'] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return notices.sections.filter((s) => s.packages.length > 0);
  return notices.sections
    .map((s) => ({
      id: s.id,
      packages: s.packages.filter((p) => {
        const hay = fold([p.name, p.version, p.license, ...p.copyright].join(' '));
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((s) => s.packages.length > 0);
}

/** How many packages, in all sections. */
export function noticeCount(sections: Notices['sections']): number {
  return sections.reduce((n, s) => n + s.packages.length, 0);
}

const LIST_ITEM = /^([-*•]|\(?[a-z0-9]{1,3}[.)])\s/i;

/**
 * A licence text for a phone's width: the lines of each paragraph joined (licence files are wrapped
 * at 80 columns and indented), keeping blank lines between paragraphs and a break before list items.
 */
export function reflowLicense(text: string): string {
  const out: string[] = [];
  let blank = true;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      if (!blank) out.push('');
      blank = true;
      continue;
    }
    if (blank || LIST_ITEM.test(line)) out.push(line);
    else out[out.length - 1] += ` ${line}`;
    blank = false;
  }
  return out.join('\n').replace(/\n+$/, '');
}
