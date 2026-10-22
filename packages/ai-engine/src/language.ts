import { francAll } from "franc-min";

/** ISO-639-3 (franc) -> BCP-47. Only languages listed here can be detected. */
const ISO3_TO_BCP47: Record<string, string> = {
  eng: "en",
  spa: "es",
  por: "pt",
  fra: "fr",
  deu: "de",
  ita: "it",
  nld: "nl",
  pol: "pl",
  ron: "ro",
  hun: "hu",
  ces: "cs",
  swe: "sv",
  tur: "tr",
  vie: "vi",
  ind: "id",
  zlm: "ms",
  tgl: "tl",
  swh: "sw",
  hrv: "hr",
  bos: "bs",
  srp: "sr",
  azj: "az",
  uzn: "uz",
  rus: "ru",
  ukr: "uk",
  bul: "bg",
  bel: "be",
  kaz: "kk",
  arb: "ar",
  pes: "fa",
  urd: "ur",
  hin: "hi",
  mar: "mr",
  npi: "ne",
};

const CANDIDATES = Object.keys(ISO3_TO_BCP47);

/** Scripts that identify a language on their own, so even a two-character query is reliable. */
const SCRIPT_LANGS: Array<[RegExp, string]> = [
  [/[\u3040-\u30ff]/, "ja"], // kana before Han: Japanese mixes both
  [/[\uac00-\ud7af\u1100-\u11ff]/, "ko"],
  [/[\u4e00-\u9fff]/, "zh"],
  [/[\u0e00-\u0e7f]/, "th"],
  [/[\u0370-\u03ff]/, "el"],
  [/[\u0590-\u05ff]/, "he"],
  [/[\u10a0-\u10ff]/, "ka"],
  [/[\u0530-\u058f]/, "hy"],
];

/** Scripts shared by several languages: franc decides, with a default when it is unsure. */
const SHARED_SCRIPTS: Array<[RegExp, (s: string) => string]> = [
  [/[\u0400-\u04ff]/, (s) => (/[іїєґ]/i.test(s) ? "uk" : "ru")],
  [/[\u0600-\u06ff]/, () => "ar"],
  [/[\u0900-\u097f]/, () => "hi"],
];

// Function words and letters that strongly indicate a language. Trigrams alone are unreliable
// for 2-5 word queries; these hints confirm or override them.
const STOPWORDS: Record<string, string[]> = {
  en: "the of and to in on at by from is are what how why who when where which for with near best does do can my your this that vs".split(" "),
  es: "el la los las de del que qué cómo como para por una un es son en mejor mejores dónde cuál cuándo y".split(" "),
  fr: "le la les des du de que quel quelle comment pour une un est sont et où meilleur meilleure ce cette".split(" "),
  de: "der die das und ist sind wie was wer wo warum ein eine für mit von bei beste besten nicht".split(" "),
  it: "il lo la gli le di che come per una uno è sono dove quale quando migliore migliori del della cos".split(" "),
  pt: "o os as de do da que como para uma um é são em onde qual quando melhor melhores não".split(" "),
  nl: "de het een en is zijn hoe wat wie waar waarom voor met van beste niet".split(" "),
  pl: "jak co gdzie dlaczego jest są w na do dla z czy najlepszy najlepsze nie".split(" "),
};

const LETTER_HINTS: Array<[RegExp, string]> = [
  [/[ñ¿¡]/, "es"],
  [/[ãõ]/, "pt"],
  [/ß/, "de"],
  [/[łśżźćń]/, "pl"],
  [/[œ]/, "fr"],
];

export interface DetectedLanguage {
  lang: string;
  confidence: number;
}

export interface DetectOptions {
  /** Minimum letters before trigram detection is trusted on its own. Default 20. */
  minLetters?: number;
  /** Minimum relative margin between the best and second-best trigram candidate (0..1). Default 0.1. */
  minConfidence?: number;
}

function hintVotes(text: string): Map<string, number> {
  const votes = new Map<string, number>();
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const hits = words.filter((w) => set.has(w)).length;
    if (hits) votes.set(lang, hits);
  }
  for (const [re, lang] of LETTER_HINTS) {
    if (re.test(text)) votes.set(lang, (votes.get(lang) ?? 0) + 2);
  }
  return votes;
}

function topVote(votes: Map<string, number>): { lang: string; hits: number; margin: number } | undefined {
  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [first, second] = sorted;
  if (!first) return undefined;
  return { lang: first[0], hits: first[1], margin: first[1] - (second?.[1] ?? 0) };
}

/**
 * Detects the query language, or returns undefined when unsure. Short queries are the norm in a
 * search box and trigram statistics are weak on them, so a guess is only accepted when the
 * script is unambiguous, function words agree, or trigrams win by a clear margin on longer text.
 */
export function detectLanguage(text: string, opts: DetectOptions = {}): DetectedLanguage | undefined {
  const minLetters = opts.minLetters ?? 20;
  const minConfidence = opts.minConfidence ?? 0.1;
  const sample = text.replace(/https?:\/\/\S+/g, " ").trim();
  for (const [re, lang] of SCRIPT_LANGS) {
    if (re.test(sample)) return { lang, confidence: 1 };
  }

  const letters = sample.replace(/[^\p{L}]/gu, "").length;
  const ranked = letters > 0 ? francAll(sample, { only: CANDIDATES, minLength: 1 }) : [];
  const best = ranked[0];
  const francLang = best && best[0] !== "und" ? ISO3_TO_BCP47[best[0]] : undefined;
  const francConfidence = ranked[1] ? 1 - ranked[1][1] : 1;

  for (const [re, fallback] of SHARED_SCRIPTS) {
    if (!re.test(sample)) continue;
    if (francLang && francConfidence >= minConfidence) return { lang: francLang, confidence: francConfidence };
    return { lang: fallback(sample), confidence: 0.5 };
  }

  const votes = hintVotes(sample);
  const vote = topVote(votes);
  if (francLang && vote && votes.get(francLang) === vote.hits) {
    return { lang: francLang, confidence: Math.max(francConfidence, 0.5) };
  }
  if (vote && vote.hits >= 2 && vote.margin >= 1) {
    return { lang: vote.lang, confidence: Math.min(0.9, 0.3 + 0.15 * vote.margin) };
  }
  if (francLang && letters >= minLetters && francConfidence >= minConfidence && (vote?.hits ?? 0) < 2) {
    return { lang: francLang, confidence: francConfidence };
  }
  return undefined;
}

/** Normalizes a locale such as "es_ES" or "pt-br" to BCP-47 casing ("es-ES", "pt-BR"). */
export function normalizeLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  const [lang, ...rest] = locale.trim().replace(/_/g, "-").split("-").filter(Boolean);
  if (!lang || !/^[a-z]{2,3}$/i.test(lang)) return undefined;
  const subtags = rest.map((p) =>
    p.length === 2 ? p.toUpperCase() : p.length === 4 ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p.toLowerCase(),
  );
  return [lang.toLowerCase(), ...subtags].join("-");
}

/** explicit opts.lang > detected from query > UI locale > "en". */
export function resolveLanguage(query: string, explicit?: string, uiLocale?: string): string {
  const forced = normalizeLocale(explicit);
  if (forced) return forced;
  const ui = normalizeLocale(uiLocale);
  const detected = detectLanguage(query)?.lang;
  // Keep the UI locale's region ("pt-BR") when the query is in the same base language.
  if (detected) return ui && ui.split("-")[0] === detected ? ui : detected;
  return ui ?? "en";
}
