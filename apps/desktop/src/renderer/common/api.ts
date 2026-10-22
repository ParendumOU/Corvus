import type { ChromeBridge, InternalBridge } from "../../shared/ipc";

declare global {
  interface Window {
    corvus?: ChromeBridge;
    corvusInternal?: InternalBridge;
  }
}

function missing(name: string): never {
  throw new Error(`${name} bridge is not available on this page`);
}

export const chromeApi = (): ChromeBridge => window.corvus ?? missing("Chrome UI");
export const internalApi = (): InternalBridge => window.corvusInternal ?? missing("Internal page");

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
