import { execFile } from "node:child_process";
import { shell } from "electron";
import type { NetworkHelp } from "../shared/ipc";

const RUN_TIMEOUT_MS = 8000;

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Windows network categories of the connected networks (`Get-NetConnectionProfile`: Public, Private, DomainAuthenticated). */
export function networkCategories(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** An inbound firewall rule for this program. */
export interface ProgramRule {
  enabled: boolean;
  allow: boolean;
  /** The rule's profiles as written ("Private", "Domain,Private,Public", "Pública"...). */
  profiles: string;
}

/**
 * The inbound Windows Firewall rules for `program` (`netsh advfirewall firewall show rule name=all
 * dir=in verbose`, no admin needed). Windows writes them when someone answers its "allow network
 * access" prompt: Allow for the networks ticked, Block when they chose Cancel. Rules are blank-line
 * separated blocks of "Field: value" lines in the system's language and code page (English and
 * Spanish are read, accents aside; the program path is the same in every language).
 */
export function programRules(output: string, program: string): ProgramRule[] {
  const target = program.toLowerCase();
  const rules: ProgramRule[] = [];
  for (const block of output.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim());
    if (!lines.some((l) => l.toLowerCase().endsWith(target))) continue;
    const field = (re: RegExp): string => lines.find((l) => re.test(l))?.replace(/^[^:]*:\s*/, "") ?? "";
    rules.push({
      enabled: !/^no$/i.test(field(/^(enabled|habilitad[oa])\s*:/i)),
      allow: !/^(block|bloquear)$/i.test(field(/^(action|acci.n)\s*:/i)),
      profiles: field(/^(profiles|perfiles)\s*:/i),
    });
  }
  return rules;
}

const CATEGORY_RE: Record<string, RegExp> = {
  Public: /public|p.blica/i,
  Private: /private|privada/i,
  DomainAuthenticated: /domain|dominio/i,
};

function covers(profiles: string, category: string): boolean {
  return /\b(any|all)\b|cualquiera|tod[oa]s/i.test(profiles) || (CATEGORY_RE[category]?.test(profiles) ?? false);
}

/**
 * What the rules mean for the connected networks: a Block rule for one of them keeps devices out;
 * a Public network keeps them out unless a rule lets Corvus in on Public networks (the prompt
 * offers Private networks first).
 */
export function firewallVerdict(categories: string[], rules: ProgramRule[]): Pick<NetworkHelp, "publicNetwork" | "firewallBlocks"> {
  const live = rules.filter((r) => r.enabled);
  return {
    firewallBlocks: categories.some((c) => live.some((r) => !r.allow && covers(r.profiles, c))),
    publicNetwork: categories.includes("Public") && !live.some((r) => r.allow && covers(r.profiles, "Public")),
  };
}

/** What may keep other devices from reaching this computer, as far as Corvus can tell without admin rights. */
export async function networkHelp(): Promise<NetworkHelp> {
  if (process.platform !== "win32") return { platform: process.platform, publicNetwork: null, firewallBlocks: null };
  const [profiles, rules] = await Promise.all([
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-NetConnectionProfile | ForEach-Object { $_.NetworkCategory.ToString() }"]),
    run("netsh.exe", ["advfirewall", "firewall", "show", "rule", "name=all", "dir=in", "verbose"]),
  ]);
  if (profiles === null || rules === null) return { platform: process.platform, publicNetwork: null, firewallBlocks: null };
  return { platform: process.platform, ...firewallVerdict(networkCategories(profiles), programRules(rules, process.execPath)) };
}

/** Opens the system page where the person can fix it (changing it may ask for an administrator there). */
export async function openNetworkSettings(which: "network" | "firewall"): Promise<void> {
  if (process.platform === "win32") {
    if (which === "network") await shell.openExternal("ms-settings:network-status");
    else await run("control.exe", ["/name", "Microsoft.WindowsFirewall", "/page", "pageConfigureApps"]);
  } else if (process.platform === "darwin") {
    await shell.openExternal(which === "network" ? "x-apple.systempreferences:com.apple.Network-Settings.extension" : "x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall");
  }
}
