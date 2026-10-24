import path from "node:path";
import { cleanSiteSearch, cleanSiteSearches, mergeSiteSearches, MAX_SITE_SEARCHES, type SiteSearch } from "../shared/site-search";
import { JsonFile } from "./json-file";

/** A profile's search shortcuts (keyword + address with %s), in site-search.json. */
export class SiteSearchStore {
  private readonly file: JsonFile<SiteSearch[]>;

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "site-search.json"), () => [], cleanSiteSearches, 0);
  }

  list(): SiteSearch[] {
    return this.file.get();
  }

  /** Adds a shortcut, or replaces the one with the same keyword in its place. */
  save(raw: unknown): SiteSearch[] {
    const s = cleanSiteSearch(raw);
    if (!s) throw new Error("A shortcut needs a keyword without spaces and an http(s) address with %s where the search goes.");
    const list = this.file.get();
    const at = list.findIndex((o) => o.keyword === s.keyword);
    if (at < 0 && list.length >= MAX_SITE_SEARCHES) throw new Error(`At most ${MAX_SITE_SEARCHES} search shortcuts.`);
    const next = at < 0 ? [...list, s] : list.map((o, i) => (i === at ? s : o));
    this.file.set(next);
    return next;
  }

  remove(keyword: string): SiteSearch[] {
    return this.file.update((list) => list.filter((s) => s.keyword !== keyword));
  }

  /** Adds imported shortcuts whose keyword is new; returns how many. */
  importMany(incoming: readonly SiteSearch[]): number {
    const { list, added } = mergeSiteSearches(this.file.get(), incoming);
    if (added > 0) this.file.set(list);
    return added;
  }

  flush(): void {
    this.file.flush();
  }
}
