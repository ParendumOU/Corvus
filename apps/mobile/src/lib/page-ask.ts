/**
 * "Ask Corvus about this page": the page goes with the first question of a new chat as the context
 * of the conversation (an `asks` record's `context`, which every computer that answers follow-ups
 * already reads), so no new field is needed on the chain. The computer's AI search sees the page's
 * title, address and the start of its text, and searches with the title. Pure, tested as is.
 */
import { MAX_CONTEXT_ANSWER, type SearchTurn } from '@corvus/shared';

/** How the page is introduced to the computer (English, as the rest of the AI's prompt). */
const PREFIX = 'The page I am reading: ';
/** The computer keeps at most 300 characters of a context question. */
const MAX_TITLE = 100;
const MAX_URL = 160;

export interface PageInfo {
  url: string;
  title: string;
}

/** What the page script below returned, checked. */
export interface PageText {
  title: string;
  description: string;
  text: string;
}

/** Collapses whitespace and cuts to `max` characters at a word. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** The first turn of a chat about a page: the page as the question, its text as the answer. */
export function pageContext(page: PageInfo, text: PageText | null): SearchTurn[] {
  const title = clip(page.title || text?.title || '', MAX_TITLE);
  const url = page.url.length > MAX_URL ? `${page.url.slice(0, MAX_URL - 1)}…` : page.url;
  const question = `${PREFIX}${title ? `“${title}” ` : ''}(${url})`;
  const body = [text?.description ?? '', text?.text ?? ''].map((s) => s.trim()).filter(Boolean);
  // The description often repeats the text's opening: keep it only when it adds something.
  if (body.length === 2 && body[1]!.startsWith(body[0]!.slice(0, 60))) body.shift();
  return [{ question, answer: clip(body.join('\n'), MAX_CONTEXT_ANSWER) }];
}

/** The page a chat is about, from its first question's context (null for any other chat). */
export function contextPage(context: readonly SearchTurn[] | undefined): PageInfo | null {
  const first = context?.[0]?.question;
  if (!first?.startsWith(PREFIX)) return null;
  const m = /^(?:“(.*)” )?\((https?:\/\/\S*)\)$/s.exec(first.slice(PREFIX.length));
  if (!m) return null;
  return { title: m[1] ?? '', url: m[2]!.replace(/…$/, '') };
}

/**
 * Run in the page (the WebView's evaluateJavascript, which hands the value to the app only, with no
 * bridge the page could call): its title, description and main text, the article or main element
 * when there is one.
 */
export const PAGE_TEXT_SCRIPT = `(function(){try{
var d=document,m=d.querySelector('meta[name="description"],meta[property="og:description"]');
var root=d.querySelector('article')||d.querySelector('main')||d.querySelector('[role="main"]')||d.body;
var t=root?root.innerText:'';
return JSON.stringify({title:d.title||'',description:m?(m.getAttribute('content')||''):'',text:(t||'').slice(0,6000)});
}catch(e){return '{}';}})()`;

/** The script's result (evaluateJavascript hands back its value JSON-encoded), checked. */
export function parsePageText(raw: string | null | undefined): PageText | null {
  if (!raw) return null;
  try {
    let value: unknown = JSON.parse(raw);
    if (typeof value === 'string') value = JSON.parse(value);
    const v = value as Partial<PageText> | null;
    if (!v || typeof v !== 'object') return null;
    return { title: typeof v.title === 'string' ? v.title : '', description: typeof v.description === 'string' ? v.description : '', text: typeof v.text === 'string' ? v.text : '' };
  } catch {
    return null;
  }
}
