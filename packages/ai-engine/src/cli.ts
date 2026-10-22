#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { AIProviderKind, AiEngineConfig, RetrieverKind, SearchCategory } from "@corvus/shared";
import { createSearchEngine } from "./engine.js";

const USAGE = `Usage: corvus-search [options] "<query>"

Options:
  --deep                 Also read the top 3 pages (more tokens, better answers)
  --lang <bcp47>         Force the answer language (default: detected, then --locale)
  --locale <bcp47>       UI locale fallback (default: $LANG or "en")
  --max <n>              Max results (default 8)
  --category <c>         general | news | images | videos (verticals: results only, no tokens)
  --provider <kind>      anthropic-api | claude-code-cli (env CORVUS_AI_PROVIDER)
  --retriever <kind>     searxng | brave | duckduckgo (env CORVUS_RETRIEVER)
  --model <id>           Model id (env CORVUS_AI_MODEL, default claude-haiku-5-5)
  --cache-dir <dir>      On-disk cache directory (env CORVUS_CACHE_DIR)
  --no-answer            Results only, no LLM call
  --json                 Print raw SearchEvents as JSON lines

Env: ANTHROPIC_API_KEY, CORVUS_SEARXNG_URL, BRAVE_SEARCH_API_KEY, CORVUS_CLAUDE_CLI`;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      deep: { type: "boolean", default: false },
      lang: { type: "string" },
      locale: { type: "string" },
      max: { type: "string" },
      category: { type: "string" },
      provider: { type: "string" },
      retriever: { type: "string" },
      model: { type: "string" },
      "cache-dir": { type: "string" },
      "no-answer": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const query = positionals.join(" ").trim();
  if (values.help || !query) {
    process.stderr.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }

  const config: AiEngineConfig = {
    provider: (values.provider ?? env("CORVUS_AI_PROVIDER") ?? "anthropic-api") as AIProviderKind,
    apiKey: values["no-answer"] ? undefined : env("ANTHROPIC_API_KEY"),
    model: values.model ?? env("CORVUS_AI_MODEL"),
    claudeCliPath: env("CORVUS_CLAUDE_CLI"),
    retriever: (values.retriever ?? env("CORVUS_RETRIEVER") ?? "searxng") as RetrieverKind,
    searxngUrl: env("CORVUS_SEARXNG_URL") ?? "http://localhost:8898",
    braveApiKey: env("BRAVE_SEARCH_API_KEY"),
    cacheDir: values["cache-dir"] ?? env("CORVUS_CACHE_DIR"),
    uiLocale: values.locale ?? env("LANG")?.split(".")[0],
  };
  const engine = createSearchEngine(config, values["no-answer"] ? { provider: null } : {});

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const out = process.stdout;
  let exitCode = 0;
  for await (const ev of engine.search(query, {
    lang: values.lang,
    depth: values.deep ? "deep" : "quick",
    maxResults: values.max ? Number(values.max) : undefined,
    category: (values.category ?? "general") as SearchCategory,
    signal: controller.signal,
  })) {
    if (values.json) {
      out.write(`${JSON.stringify(ev)}\n`);
      continue;
    }
    switch (ev.type) {
      case "results":
        out.write(`Results via ${ev.retriever}${ev.cached ? " (cached)" : ""}:\n`);
        for (const r of ev.results) {
          const extra = [r.age ?? r.publishedAt?.slice(0, 10), r.publisher, r.duration, r.image?.src].filter(Boolean).join(" · ");
          out.write(`  [${r.rank}] ${r.title}\n      ${r.url}${extra ? `\n      ${extra}` : ""}\n`);
        }
        out.write("\n");
        break;
      case "answer-delta":
        out.write(ev.text);
        break;
      case "answer-done":
        out.write(`\n\nCited: ${ev.citations.map((i) => `[${i + 1}]`).join(" ") || "none"}\n`);
        break;
      case "key-point":
        out.write(`  • ${ev.point.text}\n`);
        break;
      case "rating":
        out.write(`  [${ev.rating.index + 1}] ${ev.rating.score}/10 ${ev.rating.tags.join(",")} ${ev.rating.summary}\n`);
        break;
      case "rerank":
        out.write(`AI order: ${ev.order.map((i) => i + 1).join(" ")}\n`);
        break;
      case "entity":
        out.write(`${ev.entity.title}: ${ev.entity.description}\n`);
        for (const f of ev.entity.facts) out.write(`  ${f.label}: ${f.value}\n`);
        break;
      case "follow-up":
        out.write(`  → ${ev.question}\n`);
        break;
      case "confidence":
        out.write(`Confidence: ${ev.level ?? "?"}${ev.sourcesDisagree ? ` (sources disagree: ${ev.note ?? ""})` : ""}\n`);
        break;
      case "usage":
        out.write(`Usage: ${ev.inputTokens} in / ${ev.outputTokens} out (${ev.model})\n`);
        break;
      case "error":
        process.stderr.write(`\nError${ev.recoverable ? "" : " (fatal)"}: ${ev.message}\n`);
        if (!ev.recoverable) exitCode = 1;
        break;
    }
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
