// Preload for every web frame of a profile session: element hiding for the tab's page. Reports the ids
// and classes the page uses, so only rules that can match get inserted, and applies the procedural
// filters CSS cannot express (:has-text, :upward...). Exposes nothing to the page.
import { ipcRenderer } from "electron";
import { DOMMonitor, extractFeaturesFromDOM } from "@ghostery/adblocker-content";
import { handlePseudoDirective, querySelectorAll } from "@ghostery/adblocker-extended-selectors";
import { ADBLOCK_COSMETIC_CHANNEL, ADBLOCK_COSMETIC_EXTENDED_CHANNEL, ADBLOCK_COSMETIC_OBSERVE_CHANNEL, ADBLOCK_COSMETIC_REFRESH_CHANNEL, type ExtendedRule } from "../shared/adblock";

// Type-checked with the Node project (no DOM lib); declare the globals it reads.
declare const location: { href: string; protocol: string };
declare const document: { documentElement: never };
declare const window: { top: unknown; addEventListener(type: string, listener: () => void, options?: { once?: boolean; passive?: boolean }): void };
type AnyMonitor = { queryAll(w: unknown): void; start(w: unknown): void; stop(): void };

/** Pages like YouTube change all the time: a rule pass at most this often. */
const APPLY_EVERY_MS = 300;

const rules = new Map<number, ExtendedRule>();
let pending: ReturnType<typeof setTimeout> | null = null;

function apply(): void {
  pending = null;
  for (const rule of rules.values()) {
    try {
      for (const element of querySelectorAll(document.documentElement, rule.ast as never) as Array<{ setAttribute(name: string, value: string): void }>) {
        if (rule.directive) handlePseudoDirective(element as never, rule.directive as never);
        else if (rule.attribute) element.setAttribute(rule.attribute, "");
      }
    } catch {
      // A rule that cannot run on this page must not stop the others.
    }
  }
}

function scheduleApply(): void {
  if (pending === null && rules.size > 0) pending = setTimeout(apply, APPLY_EVERY_MS);
}

function addRules(extended: unknown): void {
  if (!Array.isArray(extended)) return;
  for (const rule of extended as ExtendedRule[]) rules.set(rule.id, rule);
  scheduleApply();
}

function ask(features?: { classes: string[]; hrefs: string[]; ids: string[] }): void {
  void ipcRenderer.invoke(ADBLOCK_COSMETIC_CHANNEL, location.href, features).then(addRules, () => undefined);
}

if ((location.protocol === "http:" || location.protocol === "https:") && window.top === window) {
  ipcRenderer.on(ADBLOCK_COSMETIC_EXTENDED_CHANNEL, (_event, extended: unknown) => addRules(extended));
  ipcRenderer.on(ADBLOCK_COSMETIC_REFRESH_CHANNEL, () => {
    ask();
    ask(extractFeaturesFromDOM());
  });
  ask();
  window.addEventListener(
    "DOMContentLoaded",
    () => {
      const monitor = new DOMMonitor((update) => {
        if (update.type === "features") ask({ classes: update.classes, hrefs: update.hrefs, ids: update.ids });
        else scheduleApply();
      }) as unknown as AnyMonitor;
      monitor.queryAll(window);
      void ipcRenderer.invoke(ADBLOCK_COSMETIC_OBSERVE_CHANNEL).then((observe: unknown) => {
        if (observe === true) monitor.start(window);
      });
      window.addEventListener("unload", () => monitor.stop(), { once: true, passive: true });
    },
    { once: true, passive: true },
  );
}
