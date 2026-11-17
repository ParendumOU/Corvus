import { webUrl, type CustomSource } from "../../shared/newtab";

/**
 * Whether the New Tab store keeps a source as written (mirrors sanitizeSource in shared/newtab):
 * an incomplete one is dropped on save, so a source being typed is held back until it is whole.
 */
export function sourceComplete(s: CustomSource): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(s.name) && (s.kind === "corvus" || webUrl(s.url) !== null);
}
