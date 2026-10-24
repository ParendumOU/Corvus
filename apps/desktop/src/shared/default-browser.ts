/**
 * Corvus as the default browser: what it registers for (web links and web files), the Windows
 * registry entries that make it show up in Default apps, reading which browser Windows uses now, and
 * which links and files a launch (command line or second instance) asks Corvus to open. Pure, so the
 * rules are unit tested; main/default-browser.ts applies them per operating system.
 */

/** File types Corvus opens when it is the default: web pages, SVG and WebP images, and PDFs. */
export const DEFAULT_BROWSER_EXTENSIONS = [".htm", ".html", ".shtml", ".xhtml", ".svg", ".webp", ".pdf"] as const;

/** MIME types and URL schemes for Linux (xdg-mime) and the .desktop file. */
export const LINUX_MIME_TYPES = [
  "x-scheme-handler/http",
  "x-scheme-handler/https",
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "image/webp",
  "application/pdf",
] as const;

/** Name Corvus registers under (Default apps, RegisteredApplications). */
export const WINDOWS_APP_NAME = "Corvus";
export const WINDOWS_URL_PROGID = "CorvusURL";
export const WINDOWS_HTML_PROGID = "CorvusHTML";
export const WINDOWS_PDF_PROGID = "CorvusPDF";
const CLIENT_KEY = String.raw`HKEY_CURRENT_USER\Software\Clients\StartMenuInternet\Corvus`;
const CLASSES = String.raw`HKEY_CURRENT_USER\Software\Classes`;

/** Every registry key Corvus creates (the uninstaller and "unregister" delete these). */
export const WINDOWS_REGISTRY_KEYS = [
  CLIENT_KEY,
  `${CLASSES}\\${WINDOWS_URL_PROGID}`,
  `${CLASSES}\\${WINDOWS_HTML_PROGID}`,
  `${CLASSES}\\${WINDOWS_PDF_PROGID}`,
] as const;

/** A string value in .reg syntax: backslashes and quotes escaped. */
function regString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The .reg file that registers Corvus for the current user only (no administrator rights): a
 * StartMenuInternet client with its capabilities, the RegisteredApplications entry that lists it in
 * Default apps, and the ProgIDs its links and files open with. Windows does not let an app make
 * itself the default; the person picks Corvus in Default apps.
 *
 * Every open command ends in `-- "%1"`: the "--" stops Chromium reading what follows as switches,
 * so a link or file name can never turn into a command-line option.
 */
export function windowsRegFile(exe: string, opts: { description: string }): string {
  const open = `"${exe}" -- "%1"`;
  const icon = `"${exe}",0`;
  const lines: string[] = ["Windows Registry Editor Version 5.00", ""];
  const key = (path: string, values: Array<[string | null, string]>): void => {
    lines.push(`[${path}]`);
    for (const [name, value] of values) lines.push(`${name === null ? "@" : regString(name)}=${regString(value)}`);
    lines.push("");
  };
  key(CLIENT_KEY, [[null, WINDOWS_APP_NAME]]);
  key(`${CLIENT_KEY}\\DefaultIcon`, [[null, icon]]);
  key(`${CLIENT_KEY}\\shell\\open\\command`, [[null, `"${exe}"`]]);
  key(`${CLIENT_KEY}\\Capabilities`, [
    ["ApplicationName", WINDOWS_APP_NAME],
    ["ApplicationDescription", opts.description],
    ["ApplicationIcon", icon],
  ]);
  key(`${CLIENT_KEY}\\Capabilities\\StartMenu`, [["StartMenuInternet", WINDOWS_APP_NAME]]);
  key(`${CLIENT_KEY}\\Capabilities\\URLAssociations`, [
    ["http", WINDOWS_URL_PROGID],
    ["https", WINDOWS_URL_PROGID],
  ]);
  key(
    `${CLIENT_KEY}\\Capabilities\\FileAssociations`,
    DEFAULT_BROWSER_EXTENSIONS.map((ext) => [ext, ext === ".pdf" ? WINDOWS_PDF_PROGID : WINDOWS_HTML_PROGID]),
  );
  key(String.raw`HKEY_CURRENT_USER\Software\RegisteredApplications`, [[WINDOWS_APP_NAME, String.raw`Software\Clients\StartMenuInternet\Corvus\Capabilities`]]);
  for (const [progId, name, urlProtocol] of [
    [WINDOWS_URL_PROGID, "Corvus URL", true],
    [WINDOWS_HTML_PROGID, "Corvus HTML Document", false],
    [WINDOWS_PDF_PROGID, "Corvus PDF Document", false],
  ] as const) {
    key(`${CLASSES}\\${progId}`, [[null, name], ...(urlProtocol ? ([["URL Protocol", ""]] as Array<[string, string]>) : [])]);
    key(`${CLASSES}\\${progId}\\DefaultIcon`, [[null, icon]]);
    key(`${CLASSES}\\${progId}\\shell\\open\\command`, [[null, open]]);
  }
  return lines.join("\r\n");
}

/** The ProgId in `reg query ...\UserChoice /v ProgId` output, or null. */
export function parseUserChoice(output: string): string | null {
  const m = /^\s*ProgId\s+REG_SZ\s+(\S.*?)\s*$/im.exec(output);
  return m ? m[1]! : null;
}

/** Whether `reg query HKCU\Software\RegisteredApplications /v Corvus` found Corvus registered. */
export function parseRegistered(output: string): boolean {
  return /^\s*Corvus\s+REG_SZ\s+/im.test(output);
}

/** The .desktop entry for Linux builds that do not install one (AppImage). */
export function linuxDesktopEntry(exec: string, icon: string): string {
  const quoted = /[\s"'\\$`]/.test(exec) ? `"${exec.replace(/(["\\$`])/g, "\\$1")}"` : exec;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Corvus",
    "GenericName=Web Browser",
    "Comment=AI-native browser that is also an MCP server",
    `Exec=${quoted} %U`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Network;WebBrowser;",
    `MimeType=${LINUX_MIME_TYPES.join(";")};`,
    "StartupWMClass=Corvus",
    "",
  ].join("\n");
}

/**
 * The links and files a launch asks Corvus to open: http(s) addresses, and local files of the types
 * above that exist (as file:// URLs). Switches are ignored, and so is anything else on the line.
 * `toFileUrl` resolves a path (relative ones from the launch folder) to a file:// URL.
 */
export function launchTargets(argv: readonly string[], isFile: (path: string) => boolean, toFileUrl: (path: string) => string): string[] {
  const out: string[] = [];
  let afterTerminator = false;
  // argv[0] is the executable (and, unpackaged, argv[1] is the app folder: not a web file, so skipped).
  for (const arg of argv.slice(1)) {
    if (!afterTerminator && arg === "--") {
      afterTerminator = true;
      continue;
    }
    if (!afterTerminator && arg.startsWith("-")) continue;
    let target: string | null = null;
    if (/^https?:\/\//i.test(arg)) target = arg;
    else if (/^file:\/\//i.test(arg)) target = hasWebExtension(safeDecode(arg)) ? arg : null;
    else if (hasWebExtension(arg) && isFile(arg)) target = toFileUrl(arg);
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasWebExtension(path: string): boolean {
  const lower = path.toLowerCase().replace(/[?#].*$/, "");
  return DEFAULT_BROWSER_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
