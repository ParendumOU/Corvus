/**
 * Which settings travel through sync. Explicit allowlist: secrets (API keys, the MCP token) are not
 * part of Settings at all, and machine-specific or security-sensitive values never leave the device.
 * test/sync-settings.test.ts fails when a setting is added without being classified here.
 */
import type { Settings, SettingsPatch } from "./settings";

export const SYNCED_SETTINGS = [
  "appearance.theme",
  "appearance.showBookmarksBar",
  "appearance.tabLayout",
  "ai.provider",
  "ai.model",
  "ai.localApi",
  "ai.retriever",
  "ai.answerLanguage",
  "ai.maxOutputTokens",
  "agent.maxSteps",
  "agent.askBeforeRisky",
  "downloads.askWhereToSave",
  "startup.mode",
  "reader.fontSize",
  "reader.lineWidth",
  "reader.theme",
  "reader.font",
  "reader.translateLanguage",
  "pdf.openInViewer",
] as const;

/** Machine-specific URLs that sync only when the user opts in. */
export const OPT_IN_SYNCED_SETTINGS = ["ai.searxngUrl", "ai.localBaseUrl"] as const;

/** Every other setting, with the reason it stays on this device. */
export const LOCAL_ONLY_SETTINGS: Readonly<Record<string, string>> = {
  "ai.claudeCliPath": "Path of an executable on this machine.",
  "downloads.directory": "Folder on this machine.",
  "mcp.enabled": "Exposes this browser to local AI agents; a per-device security decision.",
  "mcp.host": "Bind interface (loopback vs all interfaces); a per-device security decision.",
  "mcp.port": "Port on this machine.",
  "mcp.accessLevel": "What local agents may do; a per-device security decision.",
  "mcp.allowEvaluate": "Lets agents run scripts in pages; a per-device security decision.",
  "mcp.approvedClients": "Approvals are for agents running on this machine.",
  "webscope.enabled": "Captures local browser traffic for security testing; a per-device decision.",
  "webscope.maxBodyBytes": "Capture buffer size tuned to this machine.",
  "appearance.sidebarWidth": "Vertical tab sidebar width tuned to this screen.",
  "appearance.sidebarCollapsed": "Sidebar collapse is a per-device UI state.",
  "monitor.enabled": "Runs a background network fetcher on this device; a per-device decision.",
  "monitor.defaultIntervalMinutes": "Monitoring runs per device, so its cadence stays local.",
  "monitor.maxWatches": "Concurrency cap tuned to this machine.",
  "scheduledAgents.enabled": "Runs background AI agent tasks on this device; a per-device decision.",
  "scheduledAgents.maxSteps": "Scheduled-run step cap tuned to this machine.",
  "scheduledAgents.maxTokens": "Scheduled-run token budget tuned to this machine.",
  "update.autoCheck": "Updating applies to this installed build only.",
  "update.channel": "Release channel is chosen per install.",
  "update.feedUrl": "Update server URL is per device/deployment.",
  "semanticSearch.indexPages": "Builds a local text index of your pages on this device; a per-device privacy decision.",
  "semanticSearch.useEmbeddings": "Uses a local embedding endpoint on this machine; a per-device decision.",
  "semanticSearch.embeddingModel": "Embedding model available on this machine's local endpoint.",
  "crashReports.saveLogs": "Local diagnostic logs are a per-device choice; they never leave this machine.",
  "onboarding.completed": "First-run state of this installation; each device shows the welcome wizard once.",
};

export type SyncedSettingKey = (typeof SYNCED_SETTINGS)[number] | (typeof OPT_IN_SYNCED_SETTINGS)[number];

export function syncedSettingKeys(includeServiceUrls: boolean): SyncedSettingKey[] {
  return includeServiceUrls ? [...SYNCED_SETTINGS, ...OPT_IN_SYNCED_SETTINGS] : [...SYNCED_SETTINGS];
}

export function readSetting(settings: Settings, key: string): unknown {
  const [section, name] = key.split(".") as [string, string];
  return (settings as unknown as Record<string, Record<string, unknown> | undefined>)[section]?.[name];
}

/** Patch for SettingsStore.update(); mergeSettings validates types and enums. */
export function settingsPatch(entries: Array<[SyncedSettingKey, unknown]>): SettingsPatch {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of entries) {
    const [section, name] = key.split(".") as [string, string];
    (patch[section] ??= {})[name] = value;
  }
  return patch as SettingsPatch;
}
