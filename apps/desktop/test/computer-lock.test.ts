import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ powerMonitor: {} }));

import { logindLocked, logindSessionPath, screenSaverLocked, watchComputerLock } from "../src/main/computer-lock";
import { DBusConnection, MESSAGE, decodeMessage, encodeMessage, socketPathOf, splitSignature, type DBusMessage, type OutgoingMessage } from "../src/main/dbus";
import { fakeBus as startFakeBus, matchRules as matches, type FakeBus } from "../src/main/smoke-fake-dbus";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const until = async (ok: () => boolean, ms = 3000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (ok()) return true;
  return ok();
};

/** A D-Bus message written big-endian by hand: a signal with one boolean. */
function bigEndianSignal(): Buffer {
  const out: number[] = [];
  const pad = (n: number): void => {
    while (out.length % n) out.push(0);
  };
  const u32 = (v: number): void => {
    pad(4);
    out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  };
  const str = (s: string): void => {
    u32(s.length);
    out.push(...Buffer.from(s), 0);
  };
  const sig = (s: string): void => void out.push(s.length, ...Buffer.from(s), 0);
  out.push(0x42, MESSAGE.signal, 0, 1);
  u32(4);
  u32(7);
  const lengthAt = out.length;
  u32(0);
  pad(8);
  const start = out.length;
  const field = (code: number, type: string, write: () => void): void => {
    pad(8);
    out.push(code);
    sig(type);
    write();
  };
  field(1, "o", () => str("/org/freedesktop/ScreenSaver"));
  field(2, "s", () => str("org.freedesktop.ScreenSaver"));
  field(3, "s", () => str("ActiveChanged"));
  field(8, "g", () => sig("b"));
  const length = out.length - start;
  out.splice(lengthAt, 4, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255);
  pad(8);
  u32(1);
  return Buffer.from(out);
}

const signal = (m: Omit<OutgoingMessage, "type">): DBusMessage => decodeMessage(encodeMessage({ ...m, type: MESSAGE.signal }, 1))!.message;

describe("the D-Bus wire format", () => {
  it("splits signatures into whole types", () => {
    expect(splitSignature("sa{sv}as")).toEqual(["s", "a{sv}", "as"]);
    expect(splitSignature("a(yv)(ii)aai")).toEqual(["a(yv)", "(ii)", "aai"]);
    expect(() => splitSignature("a{sv")).toThrow();
    expect(() => splitSignature("z")).toThrow();
  });

  it("reads back what it writes, containers and variants included", () => {
    const sent: OutgoingMessage = {
      type: MESSAGE.signal,
      path: "/org/freedesktop/login1/session/_32",
      interface: "org.freedesktop.DBus.Properties",
      member: "PropertiesChanged",
      sender: ":1.5",
      signature: "sa{sv}asyxtd(qn)",
      body: ["org.freedesktop.login1.Session", [["LockedHint", { signature: "b", value: true }], ["Name", { signature: "s", value: "ana" }]], ["IdleHint"], 7, -5, 2 ** 40, 1.5, [65535, -2]],
    };
    const decoded = decodeMessage(encodeMessage(sent, 9))!;
    expect(decoded.message).toMatchObject({ type: MESSAGE.signal, serial: 9, path: sent.path, interface: sent.interface, member: sent.member, sender: ":1.5", body: sent.body });
    expect(decoded.size).toBe(encodeMessage(sent, 9).length);
  });

  it("reads big-endian messages", () => {
    const { message } = decodeMessage(bigEndianSignal())!;
    expect(message).toMatchObject({ type: MESSAGE.signal, serial: 7, interface: "org.freedesktop.ScreenSaver", member: "ActiveChanged", body: [true] });
    expect(screenSaverLocked(message)).toBe(true);
  });

  it("waits for a whole message and refuses broken ones", () => {
    const whole = encodeMessage({ type: MESSAGE.call, path: "/", member: "Hello", destination: "org.freedesktop.DBus" }, 1);
    expect(decodeMessage(whole.subarray(0, whole.length - 1))).toBeNull();
    expect(decodeMessage(Buffer.concat([whole, whole]))?.size).toBe(whole.length);
    const wrongOrder = Buffer.from(whole);
    wrongOrder[0] = 0x58;
    expect(() => decodeMessage(wrongOrder)).toThrow();
    const huge = Buffer.from(whole);
    huge.writeUInt32LE(0x7fffffff, 4);
    expect(() => decodeMessage(huge)).toThrow();
  });

  it("finds the socket of a bus address", () => {
    expect(socketPathOf("unix:path=/run/user/1000/bus")).toBe("/run/user/1000/bus");
    expect(socketPathOf("unix:abstract=/tmp/dbus-x,guid=abc")).toBe("\0/tmp/dbus-x");
    expect(socketPathOf("tcp:host=example.test,port=1;unix:path=/tmp/a%20b")).toBe("/tmp/a b");
    expect(socketPathOf("tcp:host=example.test,port=1")).toBeNull();
  });
});

describe("the computer's lock on Linux", () => {
  it("names logind sessions the way logind escapes them", () => {
    expect(logindSessionPath("2")).toBe("/org/freedesktop/login1/session/_32");
    expect(logindSessionPath("12")).toBe("/org/freedesktop/login1/session/_312");
    expect(logindSessionPath("c2")).toBe("/org/freedesktop/login1/session/c2");
  });

  it("locks on the screen saver turning on, never off", () => {
    const changed = (on: boolean): DBusMessage => signal({ path: "/ScreenSaver", interface: "org.freedesktop.ScreenSaver", member: "ActiveChanged", signature: "b", body: [on] });
    expect(screenSaverLocked(changed(true))).toBe(true);
    expect(screenSaverLocked(changed(false))).toBe(false);
    // GNOME's own screen saver says so on a blank screen too, locked or not: logind tells instead.
    expect(screenSaverLocked(signal({ path: "/org/gnome/ScreenSaver", interface: "org.gnome.ScreenSaver", member: "ActiveChanged", signature: "b", body: [true] }))).toBe(false);
  });

  it("locks on logind's Lock and LockedHint for this session only", () => {
    const own = logindSessionPath("2");
    const hint = (value: boolean, at = own): DBusMessage =>
      signal({ path: at, interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", signature: "sa{sv}as", body: ["org.freedesktop.login1.Session", [["LockedHint", { signature: "b", value }]], []] });
    expect(logindLocked(signal({ path: own, interface: "org.freedesktop.login1.Session", member: "Lock" }), own)).toBe(true);
    expect(logindLocked(signal({ path: own, interface: "org.freedesktop.login1.Session", member: "Unlock" }), own)).toBe(false);
    expect(logindLocked(hint(true), own)).toBe(true);
    expect(logindLocked(hint(false), own)).toBe(false);
    expect(logindLocked(hint(true, logindSessionPath("3")), own)).toBe(false);
    expect(logindLocked(signal({ path: own, interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", signature: "sa{sv}as", body: ["org.freedesktop.login1.Session", [["IdleHint", { signature: "b", value: true }]], []] }), own)).toBe(false);
  });
});

/** A bus closed after the test. */
async function fakeBus(answer?: Parameters<typeof startFakeBus>[0]): Promise<FakeBus> {
  const bus = await startFakeBus(answer);
  cleanups.push(bus.close);
  return bus;
}

describe.runIf(process.platform === "linux")("watching the computer's lock over D-Bus", () => {
  it("signs in, calls and gets answers", async () => {
    const bus = await fakeBus((m) => (m.member === "Ping" ? { signature: "u", body: [5] } : undefined));
    const conn = await DBusConnection.connect(bus.address);
    cleanups.push(() => conn.close());
    expect(conn.name).toBe(":1.42");
    expect(await conn.call({ destination: "org.example.Test", path: "/", interface: "org.example.Test", member: "Ping" })).toEqual([5]);
  });

  it("locks on logind and the screen saver, and stops listening when told", async () => {
    const session = await fakeBus();
    const system = await fakeBus((m) => (m.member === "Get" && m.path === "/org/freedesktop/login1/session/auto" ? { signature: "v", body: [{ signature: "s", value: "c2" }] } : undefined));
    let locks = 0;
    const stop = watchComputerLock({ onLock: () => locks++, onUnlock: () => undefined }, { DBUS_SESSION_BUS_ADDRESS: session.address, DBUS_SYSTEM_BUS_ADDRESS: system.address });
    cleanups.push(stop);
    expect(await until(() => matches(system).length === 2 && matches(session).length === 1)).toBe(true);
    const own = "/org/freedesktop/login1/session/c2";
    expect(matches(system).every((rule) => rule.includes(`path='${own}'`) && rule.includes("sender='org.freedesktop.login1'"))).toBe(true);

    const hint = (value: boolean): Omit<OutgoingMessage, "type"> => ({
      path: own,
      interface: "org.freedesktop.DBus.Properties",
      member: "PropertiesChanged",
      signature: "sa{sv}as",
      body: ["org.freedesktop.login1.Session", [["LockedHint", { signature: "b", value }]], []],
    });
    system.emit(hint(true));
    expect(await until(() => locks === 1)).toBe(true);
    system.emit(hint(false));
    system.emit({ path: own, interface: "org.freedesktop.login1.Session", member: "Lock" });
    expect(await until(() => locks === 2)).toBe(true);
    session.emit({ path: "/ScreenSaver", interface: "org.freedesktop.ScreenSaver", member: "ActiveChanged", signature: "b", body: [true] });
    expect(await until(() => locks === 3)).toBe(true);

    stop();
    expect(await until(() => !system.connected() && !session.connected())).toBe(true);
  });

  it("takes the session from XDG_SESSION_ID when it is set", async () => {
    const system = await fakeBus();
    const stop = watchComputerLock({ onLock: () => undefined, onUnlock: () => undefined }, { DBUS_SYSTEM_BUS_ADDRESS: system.address, XDG_SESSION_ID: "2" });
    cleanups.push(stop);
    expect(await until(() => matches(system).length === 2)).toBe(true);
    expect(system.received.some((m) => m.member === "Get")).toBe(false);
    expect(matches(system)[0]).toContain("path='/org/freedesktop/login1/session/_32'");
  });
});
