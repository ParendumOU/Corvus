/**
 * Pure parsers for bookmark exports from other browsers, used by the first-run import step.
 * Two formats cover every mainstream browser:
 *   - Netscape bookmark HTML (`File → Export bookmarks` in Chrome, Edge, Firefox, Safari, Brave…).
 *   - The raw Chrome/Edge `Bookmarks` JSON file in the user profile.
 * The result is a tree the main process walks to create folders and bookmarks. History is not
 * imported here: a browser's history lives in a locked SQLite file, so a clean cross-browser import
 * is not possible from a file the user can hand us; the wizard notes this and offers Skip instead.
 */

export interface ImportedBookmark {
  title: string;
  url: string;
}

export interface ImportedFolder {
  title: string;
  children: ImportedNode[];
}

export type ImportedNode = ImportedBookmark | ImportedFolder;

export function isImportedFolder(node: ImportedNode): node is ImportedFolder {
  return "children" in node;
}

/** Total bookmark leaves in a tree (folders excluded). */
export function countBookmarks(nodes: ImportedNode[]): number {
  let total = 0;
  for (const node of nodes) total += isImportedFolder(node) ? countBookmarks(node.children) : 1;
  return total;
}

/** Total folders in a tree. */
export function countFolders(nodes: ImportedNode[]): number {
  let total = 0;
  for (const node of nodes) if (isImportedFolder(node)) total += 1 + countFolders(node.children);
  return total;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function cleanTitle(raw: string, fallback: string): string {
  const text = decodeEntities(raw.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 500);
}

/** Parse a Netscape bookmark HTML export into a tree. Tolerant of the loosely-nested markup browsers emit. */
export function parseNetscapeHtml(html: string): ImportedNode[] {
  const root: ImportedNode[] = [];
  const stack: ImportedNode[][] = [];
  let pendingTitle: string | null = null;
  const token = /<dl[^>]*>|<\/dl>|<h3[^>]*>([\s\S]*?)<\/h3>|<a\s+[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html)) !== null) {
    const [whole, h3, href, anchorText] = match;
    const lead = whole.slice(0, 3).toLowerCase();
    if (lead === "<dl") {
      if (stack.length === 0) {
        stack.push(root);
      } else {
        const folder: ImportedFolder = { title: pendingTitle ?? "Imported", children: [] };
        stack[stack.length - 1]!.push(folder);
        stack.push(folder.children);
      }
      pendingTitle = null;
    } else if (lead === "</d") {
      if (stack.length > 0) stack.pop();
    } else if (h3 !== undefined) {
      pendingTitle = cleanTitle(h3, "Imported");
    } else if (href !== undefined) {
      const target = stack[stack.length - 1] ?? root;
      target.push({ title: cleanTitle(anchorText ?? "", href), url: decodeEntities(href) });
    }
  }
  return root;
}

interface ChromeNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromeNode[];
}

function fromChromeNode(node: ChromeNode): ImportedNode | null {
  if (node.type === "url" || (node.url && node.type !== "folder")) {
    if (typeof node.url !== "string") return null;
    return { title: cleanTitle(node.name ?? "", node.url), url: node.url };
  }
  if (node.type === "folder" || Array.isArray(node.children)) {
    const children: ImportedNode[] = [];
    for (const child of node.children ?? []) {
      const parsed = fromChromeNode(child);
      if (parsed) children.push(parsed);
    }
    return { title: cleanTitle(node.name ?? "", "Imported"), children };
  }
  return null;
}

/** A browser's bookmarks by where they go in Corvus: its bookmarks bar, and Other bookmarks. */
export interface ImportedRoots {
  bar: ImportedNode[];
  other: ImportedNode[];
}

/** Chrome/Edge's roots: the bookmarks bar to Corvus's bar, "Other" and the mobile ones to Other bookmarks. */
export function parseChromeRoots(text: string): ImportedRoots {
  let data: { roots?: Record<string, ChromeNode> };
  try {
    data = JSON.parse(text) as { roots?: Record<string, ChromeNode> };
  } catch {
    return { bar: [], other: [] };
  }
  const roots = data.roots;
  if (!roots || typeof roots !== "object") return { bar: [], other: [] };
  const children = (key: string): ImportedNode[] => {
    const parsed = roots[key] ? fromChromeNode(roots[key]) : null;
    if (!parsed) return [];
    return isImportedFolder(parsed) ? parsed.children : [parsed];
  };
  return { bar: children("bookmark_bar"), other: [...children("other"), ...children("synced")] };
}

/** Parse a Chrome/Edge `Bookmarks` JSON file into a tree. */
export function parseChromeJson(text: string): ImportedNode[] {
  const roots = parseChromeRoots(text);
  return [...roots.bar, ...roots.other];
}

/** Dispatch on file name / content shape. Returns the imported tree (possibly empty). */
export function parseBookmarkFile(fileName: string, content: string): ImportedNode[] {
  const looksJson = /\.json$/i.test(fileName) || content.trimStart().startsWith("{");
  return looksJson ? parseChromeJson(content) : parseNetscapeHtml(content);
}
