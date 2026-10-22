import type { SearchEngine, SearchEvent, SearchOptions } from "@corvus/shared";

/** SearchEngine that replays fixed events (or events built from the query). */
export class MockSearchEngine implements SearchEngine {
  readonly queries: Array<{ query: string; opts?: SearchOptions }> = [];

  constructor(private readonly events?: (query: string) => SearchEvent[]) {}

  async *search(query: string, opts?: SearchOptions): AsyncIterable<SearchEvent> {
    this.queries.push(opts ? { query, opts } : { query });
    const events = this.events?.(query) ?? defaultEvents(query);
    for (const ev of events) {
      if (opts?.signal?.aborted) return;
      yield ev;
    }
  }
}

function defaultEvents(query: string): SearchEvent[] {
  const slug = encodeURIComponent(query);
  return [
    {
      type: "results",
      retriever: "searxng",
      cached: false,
      results: [
        { url: `https://example.com/${slug}`, title: `About ${query}`, snippet: `Overview of ${query}.`, source: "example.com", rank: 1 },
        { url: `https://example.org/${slug}`, title: `${query} explained`, snippet: `Details on ${query}.`, source: "example.org", rank: 2 },
      ],
    },
    { type: "answer-delta", text: `${query} is covered ` },
    { type: "answer-done", text: `${query} is covered by both sources [1][2].`, citations: [0, 1] },
    { type: "usage", inputTokens: 120, outputTokens: 20, model: "mock" },
  ];
}
