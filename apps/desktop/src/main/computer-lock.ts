/**
 * When the computer's session locks (Win+L, ⌃⌘Q, the screen locking by itself): Electron's
 * powerMonitor tells on Windows and macOS; on Linux the desktop tells over D-Bus, through logind
 * (its Lock request and the LockedHint the screen locker sets) and the freedesktop screen saver
 * (ActiveChanged, which KDE's locker sends). Logging out or switching off is not a lock.
 */
import fs from "node:fs";
import { powerMonitor } from "electron";
import { DBusConnection, MESSAGE, sessionBusAddress, socketPathOf, systemBusAddress, type DBusMessage, type Variant } from "./dbus";

export interface ComputerLockEvents {
  onLock(): void;
  /** Windows and macOS only: Linux keeps drawing windows while locked, nothing waits for it. */
  onUnlock(): void;
}

const LOGIND = "org.freedesktop.login1";
const LOGIND_SESSION = "org.freedesktop.login1.Session";
const SCREEN_SAVER = "org.freedesktop.ScreenSaver";

/** logind's object path for a session id ("2" -> "/org/freedesktop/login1/session/_32"). */
export function logindSessionPath(id: string): string {
  let escaped = "";
  for (const [i, c] of [...Buffer.from(id, "utf8")].entries()) {
    const ch = String.fromCharCode(c);
    escaped += /[A-Za-z]/.test(ch) || (i > 0 && /[0-9]/.test(ch)) ? ch : `_${c.toString(16).padStart(2, "0")}`;
  }
  return `/org/freedesktop/login1/session/${escaped || "_"}`;
}

/** A session bus signal that says the screen locked (the freedesktop screen saver became active). */
export function screenSaverLocked(m: DBusMessage): boolean {
  return m.type === MESSAGE.signal && m.interface === SCREEN_SAVER && m.member === "ActiveChanged" && m.body[0] === true;
}

/** A logind signal (system bus) that says this session locks: a Lock request, or LockedHint turning true. */
export function logindLocked(m: DBusMessage, sessionPath: string): boolean {
  if (m.type !== MESSAGE.signal || m.path !== sessionPath) return false;
  if (m.interface === LOGIND_SESSION) return m.member === "Lock";
  if (m.interface !== "org.freedesktop.DBus.Properties" || m.member !== "PropertiesChanged" || m.body[0] !== LOGIND_SESSION) return false;
  const changed = m.body[1];
  return Array.isArray(changed) && changed.some((entry) => Array.isArray(entry) && entry[0] === "LockedHint" && (entry[1] as Variant | undefined)?.value === true);
}

/** This app's logind session: XDG_SESSION_ID, else the one logind picks for it (its own, or the user's graphical one). */
async function logindSession(bus: DBusConnection, env: NodeJS.ProcessEnv): Promise<string> {
  if (env.XDG_SESSION_ID) return logindSessionPath(env.XDG_SESSION_ID);
  const [id] = await bus.call({
    destination: LOGIND,
    path: "/org/freedesktop/login1/session/auto",
    interface: "org.freedesktop.DBus.Properties",
    member: "Get",
    signature: "ss",
    body: [LOGIND_SESSION, "Id"],
  });
  return logindSessionPath(String((id as Variant).value));
}

function watchLinux(onLock: () => void, env: NodeJS.ProcessEnv): () => void {
  const buses: DBusConnection[] = [];
  let stopped = false;
  const warn = (what: string) => (err: unknown) => console.warn(`[corvus] the computer's lock is not watched through ${what}:`, (err as Error).message);
  const open = async (address: string | null): Promise<DBusConnection | null> => {
    // No bus, or one switched off ("disabled:"): nothing to listen on.
    if (!address || !socketPathOf(address)) return null;
    const bus = await DBusConnection.connect(address);
    if (stopped) {
      bus.close();
      return null;
    }
    buses.push(bus);
    return bus;
  };
  void (async () => {
    const bus = await open(sessionBusAddress(env));
    if (!bus) return;
    bus.onSignal((m) => screenSaverLocked(m) && onLock());
    await bus.addMatch(`type='signal',interface='${SCREEN_SAVER}',member='ActiveChanged'`);
  })().catch(warn("the screen saver"));
  void (async () => {
    const bus = await open(systemBusAddress(env));
    if (!bus) return;
    const path = await logindSession(bus, env);
    bus.onSignal((m) => logindLocked(m, path) && onLock());
    const rule = (iface: string, member: string): string => `type='signal',sender='${LOGIND}',path='${path}',interface='${iface}',member='${member}'`;
    await Promise.all([bus.addMatch(rule(LOGIND_SESSION, "Lock")), bus.addMatch(rule("org.freedesktop.DBus.Properties", "PropertiesChanged"))]);
  })().catch(warn("logind"));
  return () => {
    stopped = true;
    for (const bus of buses.splice(0)) bus.close();
  };
}

/** Whether this computer can tell Corvus it locks (Linux: a D-Bus bus to listen on). */
export function computerLockSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "linux") return process.platform === "win32" || process.platform === "darwin";
  return [sessionBusAddress(env), systemBusAddress(env)].some((address) => {
    const socketPath = address && socketPathOf(address);
    return !!socketPath && (socketPath.startsWith("\0") || fs.existsSync(socketPath));
  });
}

/** Calls `events` as the computer locks and unlocks, until the returned function is called. */
export function watchComputerLock(events: ComputerLockEvents, env: NodeJS.ProcessEnv = process.env): () => void {
  if (process.platform === "linux") return watchLinux(events.onLock, env);
  const onLock = (): void => events.onLock();
  const onUnlock = (): void => events.onUnlock();
  powerMonitor.on("lock-screen", onLock);
  powerMonitor.on("unlock-screen", onUnlock);
  return () => {
    powerMonitor.off("lock-screen", onLock);
    powerMonitor.off("unlock-screen", onUnlock);
  };
}
