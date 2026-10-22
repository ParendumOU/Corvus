/**
 * IPC contract for named workspaces (chrome UI only). Merged into ChromeRpc in ./ipc.ts.
 */
export type WorkspaceOpenMode = "new-window" | "replace" | "merge";

export interface WorkspaceView {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tabCount: number;
  groupCount: number;
}

export interface WorkspaceChromeRpc {
  "workspaces.list"(): WorkspaceView[];
  /** Save the current window's tabs and groups as a new workspace. */
  "workspaces.saveCurrent"(name: string): WorkspaceView[];
  "workspaces.open"(id: string, mode: WorkspaceOpenMode): void;
  "workspaces.rename"(id: string, name: string): WorkspaceView[];
  "workspaces.remove"(id: string): WorkspaceView[];
}
