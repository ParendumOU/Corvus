/**
 * Links saved to the reading list without their article (from the phone) are filled in by a
 * computer: it fetches the page (public addresses only, no cookies), keeps the reader-mode
 * article, and the filled item syncs back to every device.
 */
import { articleToMarkdown, extractArticle, fetchPublicHtml } from "@corvus/ai-engine";
import type { ReadingItem } from "../shared/reading";

export type ArticleFields = Pick<ReadingItem, "title" | "siteName" | "byline" | "excerpt" | "markdown" | "wordCount" | "readingMinutes">;

export interface FillableStore {
  linkOnly(): ReadingItem[];
  fill(id: string, article: ArticleFields): boolean;
}

/** The reader-mode article of a page, or null when it cannot be fetched or is not an article. */
export async function fetchArticle(url: string, fetchHtml: typeof fetchPublicHtml = fetchPublicHtml): Promise<ArticleFields | null> {
  const page = await fetchHtml(url);
  if (!page) return null;
  const article = extractArticle(page.html, page.url);
  if (!article) return null;
  return {
    title: article.title,
    siteName: article.siteName,
    byline: article.byline,
    excerpt: article.excerpt,
    markdown: articleToMarkdown(article),
    wordCount: article.wordCount,
    readingMinutes: article.readingMinutes,
  };
}

/** Fills link-only items one at a time; each item is tried once per session. */
export class ReadingFiller {
  private readonly tried = new Set<string>();
  private running = false;

  constructor(private readonly fetch: (url: string) => Promise<ArticleFields | null> = (url) => fetchArticle(url)) {}

  /** Returns how many items were filled in. */
  async run(store: FillableStore): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let filled = 0;
    try {
      for (const item of store.linkOnly()) {
        if (this.tried.has(item.id)) continue;
        this.tried.add(item.id);
        const article = await this.fetch(item.url).catch(() => null);
        if (article && store.fill(item.id, article)) filled++;
      }
    } finally {
      this.running = false;
    }
    return filled;
  }
}
