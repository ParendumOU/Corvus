/**
 * The tabs an interactive agent run opens: they sit in one tab group named after the task, so the
 * person sees where the agent is working, and stay open for them when the run ends. Pure helpers
 * shared by the main process and tests.
 */

/** Longest group name shown in the tab strip. */
export const AGENT_GROUP_TITLE_MAX = 32;

/**
 * The group's name: the one the agent gave (2–4 words), or else the task as typed, on one line
 * and cut at a word boundary.
 */
export function agentGroupTitle(task: string, given = ""): string {
  const text = (given.trim() || task).replace(/\s+/g, " ").trim().replace(/[.!?:;,]+$/, "");
  if (text.length <= AGENT_GROUP_TITLE_MAX) return text;
  const cut = text.slice(0, AGENT_GROUP_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= AGENT_GROUP_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface AgentTabLine {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

/**
 * One list_tabs line: the id, `*` for the tab on screen, and what the tab is to this run (the
 * working tab, one it opened, the tab it started in).
 */
export function agentTabLine(t: AgentTabLine, marks: { working: boolean; own: boolean; start: boolean }): string {
  const tags = [marks.working ? "working" : "", marks.own ? "yours" : "", marks.start ? "started here" : ""].filter(Boolean);
  return `${t.id}${t.active ? "*" : ""}${tags.length ? ` [${tags.join(", ")}]` : ""} ${t.title} — ${t.url}`;
}
