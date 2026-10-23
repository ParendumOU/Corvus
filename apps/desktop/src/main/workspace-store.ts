import crypto from "node:crypto";
import path from "node:path";
import type { GroupColor, TabGroup } from "@corvus/shared";
import {
  cleanName,
  nextWorkspaceName,
  removeWorkspace,
  renameWorkspace,
  reviveWorkspace,
  reviveWorkspaces,
  summarize,
  updateWorkspaceTabs,
  upsertWorkspace,
  workspaceFromGroup,
  workspaceFromWindow,
  type LiveTab,
  type Workspace,
  type WorkspaceSummary,
} from "../shared/workspaces";
import { JsonFile } from "./json-file";

type Listener = () => void;

/** Named workspaces for one profile, persisted as JSON (like bookmarks). */
export class WorkspaceStore {
  private readonly file: JsonFile<Workspace[]>;
  private readonly listeners = new Set<Listener>();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "workspaces.json"), () => [], (raw) => reviveWorkspaces(raw, Date.now()), 0);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  list(): Workspace[] {
    return this.file.get();
  }

  summaries(): WorkspaceSummary[] {
    return this.file.get().map(summarize);
  }

  get(id: string): Workspace | undefined {
    return this.file.get().find((w) => w.id === id);
  }

  /** Save a window's tabs as a new workspace. Nothing is saved when no tab is worth keeping. */
  save(name: string, tabs: readonly LiveTab[], groups: readonly TabGroup[]): WorkspaceSummary[] {
    this.put(workspaceFromWindow(name || "Workspace", tabs, groups, crypto.randomUUID(), Date.now()));
    return this.summaries();
  }

  /** Save one tab group as a new workspace (named after the group, or "Workspace N"). */
  saveGroup(title: string, tabs: readonly LiveTab[], color: GroupColor): Workspace | null {
    const name = cleanName(title) || nextWorkspaceName(this.file.get().map((w) => w.name));
    const ws = workspaceFromGroup(name, tabs, color, crypto.randomUUID(), Date.now());
    return this.put(ws) ? ws : null;
  }

  /** Re-save a workspace with its open group's current tabs. False when it no longer exists. */
  updateTabs(id: string, tabs: readonly LiveTab[], color: GroupColor): boolean {
    const ws = this.get(id);
    return ws ? this.put(updateWorkspaceTabs(ws, tabs, color, Date.now())) : false;
  }

  private put(ws: Workspace): boolean {
    if (ws.tabs.length === 0) return false;
    this.file.set(upsertWorkspace(this.file.get(), ws));
    this.emit();
    return true;
  }

  rename(id: string, name: string): WorkspaceSummary[] {
    if (cleanName(name)) {
      this.file.set(renameWorkspace(this.file.get(), id, name, Date.now()));
      this.emit();
    }
    return this.summaries();
  }

  remove(id: string): WorkspaceSummary[] {
    this.file.set(removeWorkspace(this.file.get(), id));
    this.emit();
    return this.summaries();
  }

  /**
   * Apply changes from sync, keyed by workspace id. An upsert inserts or replaces the workspace; a
   * tombstone removes it. Invalid payloads are ignored (the engine then forgets them). Flushed
   * before returning so a crash can't lose a change and re-push it as a deletion.
   */
  applyRemote(changes: Array<{ id: string; workspace: Workspace | null }>): void {
    const before = this.file.get();
    let list = before;
    for (const { id, workspace } of changes) {
      if (workspace === null) {
        list = removeWorkspace(list, id);
      } else {
        const revived = reviveWorkspace({ ...workspace, id }, Date.now());
        if (revived) list = upsertWorkspace(list, revived);
      }
    }
    if (list === before) return;
    this.file.set(list);
    this.file.flush();
    this.emit();
  }

  flush(): void {
    this.file.flush();
  }
}
