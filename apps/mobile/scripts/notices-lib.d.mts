// Types of scripts/notices-lib.mjs for the tests.
export interface JsNotice {
  name: string;
  version: string;
  license: string;
  copyright: string[];
  homepage: string;
  texts: { file: string; text: string }[];
}
export interface MavenNotice {
  name: string;
  version: string;
  license: string;
  licenseUrls: string[];
  copyright: string[];
  homepage: string;
  title: string;
}
export interface Pom {
  name: string;
  url: string;
  licenses: { name: string; url: string }[];
  organization: string;
  developers: string[];
  parent: { group: string; name: string; version: string } | null;
}
export const LICENSE_FILE: RegExp;
export function isAllowedLicense(expression: string | undefined): boolean;
export function licenseOf(pkg: unknown): string;
export function packageRootsOfSources(sources: readonly unknown[] | undefined, projectRoot: string): string[];
export function copyrightLines(text: string): string[];
export function parsePom(xml: string): Pom;
export function spdxOfMavenLicense(license: { name?: string; url?: string }): string;
export function mavenNotice(library: { group: string; name: string; version: string; poms: string[] }): MavenNotice;
export function buildNotices(input: {
  version: string;
  js: Iterable<JsNotice>;
  android: MavenNotice[];
  standardTexts: Record<string, string>;
}): import('../src/lib/notices').Notices;
export function sourcesOfMap(map: unknown): unknown[];
