/**
 * IPC contract for named workspaces (chrome UI only). Merged into ChromeRpc in ./ipc.ts.
 */
import type { GroupId } from "@corvus/shared";

export interface WorkspaceView {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tabCount: number;
  /** The tab group showing this workspace in the asking window, if it is open there. */
  openGroupId?: GroupId;
}

export interface WorkspaceChromeRpc {
  "workspaces.list"(): WorkspaceView[];
  /** Save the current window's tabs as a new workspace. */
  "workspaces.saveCurrent"(name: string): WorkspaceView[];
  /** Save a tab group as a new workspace, or re-save it into the workspace it is linked to. */
  "workspaces.saveGroup"(groupId: GroupId): WorkspaceView[];
  /** Open a workspace as one tab group in this window; focuses that group if it is already open. */
  "workspaces.open"(id: string): void;
  "workspaces.rename"(id: string, name: string): WorkspaceView[];
  "workspaces.remove"(id: string): WorkspaceView[];
}
