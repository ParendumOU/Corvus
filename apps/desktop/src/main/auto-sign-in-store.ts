/**
 * Per-profile list of logins the person chose to sign in with automatically (autosignin.json). A
 * login on this list is offered as soon as its login form loads, behind a confirmation prompt, and is
 * then filled and submitted. Ids are built-in vault ids or KeePass entry ids. Local to this device
 * and never synced: it is a convenience setting, not part of the login.
 */
import path from "node:path";
import { JsonFile } from "./json-file";

interface AutoSignInFile {
  v: 1;
  ids: string[];
}

const empty = (): AutoSignInFile => ({ v: 1, ids: [] });

function revive(raw: unknown): AutoSignInFile {
  const ids = (raw as Partial<AutoSignInFile> | null)?.ids;
  return { v: 1, ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length <= 256).slice(0, 1000) : [] };
}

export class AutoSignInStore {
  private readonly file: JsonFile<AutoSignInFile>;

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "autosignin.json"), empty, revive, 0);
  }

  ids(): Set<string> {
    return new Set(this.file.get().ids);
  }

  has(id: string): boolean {
    return this.file.get().ids.includes(id);
  }

  set(id: string, on: boolean): string[] {
    const current = this.file.get().ids;
    if (on === current.includes(id)) return [...current];
    const ids = current.filter((x) => x !== id);
    if (on) ids.push(id);
    this.file.set({ v: 1, ids });
    return ids;
  }

  flush(): void {
    this.file.flush();
  }
}
