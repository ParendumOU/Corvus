import path from "node:path";
import type { GroupColor } from "@corvus/shared";
import { DEFAULT_CONTAINERS, cleanContainerName, containerIdFor, isContainerColor, reviveContainers, type Container } from "../shared/containers";
import { JsonFile } from "./json-file";

interface ContainersFile {
  version: 1;
  containers: Container[];
}

/** A profile's containers (containers.json): names and colours; their data lives in their sessions. */
export class ContainerStore {
  private readonly file: JsonFile<ContainersFile>;
  private readonly listeners = new Set<() => void>();

  constructor(dir: string) {
    this.file = JsonFile.load(
      path.join(dir, "containers.json"),
      () => ({ version: 1, containers: [...DEFAULT_CONTAINERS] }),
      (raw) => ({ version: 1, containers: reviveContainers((raw as { containers?: unknown } | null)?.containers) }),
    );
  }

  list(): Container[] {
    return this.file.get().containers;
  }

  get(id: string): Container | undefined {
    return this.list().find((c) => c.id === id);
  }

  add(name: string, color: GroupColor): Container {
    const clean = cleanContainerName(name);
    if (!clean) throw new Error("A container needs a name");
    const container: Container = { id: containerIdFor(clean, new Set(this.list().map((c) => c.id))), name: clean, color: isContainerColor(color) ? color : "grey" };
    this.file.update((f) => ({ ...f, containers: [...f.containers, container] }));
    this.emit();
    return container;
  }

  update(id: string, patch: { name?: string; color?: GroupColor }): Container | undefined {
    const name = patch.name === undefined ? undefined : cleanContainerName(patch.name);
    if (patch.name !== undefined && !name) throw new Error("A container needs a name");
    let updated: Container | undefined;
    this.file.update((f) => ({
      ...f,
      containers: f.containers.map((c) => {
        if (c.id !== id) return c;
        updated = { ...c, ...(name ? { name } : {}), ...(isContainerColor(patch.color) ? { color: patch.color } : {}) };
        return updated;
      }),
    }));
    if (updated) this.emit();
    return updated;
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.file.update((f) => ({ ...f, containers: f.containers.filter((c) => c.id !== id) }));
    this.emit();
    return true;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  flush(): void {
    this.file.flush();
  }
}
