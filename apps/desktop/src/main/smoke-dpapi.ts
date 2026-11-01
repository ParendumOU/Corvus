import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { utilityProcess, type UtilityProcess, type WebContents } from "electron";
import type { DpapiChild } from "./browser-keys";
import type { AppContext } from "./context";
import { loadKoffi, memoryWorks, openDpapi, readBytes, wipeBytes, writeBytes } from "./dpapi-native";
import { paths } from "./paths";
import { FIXTURE_WINDOWS_PASSWORDS, fakeDpapi, writeWindowsFixtures } from "./smoke-password-fixtures";
import type { BrowserWindowCtl } from "./window";

interface DpapiSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

/**
 * crypt32 and kernel32 as far as the import uses them, for this Linux container: the same prototypes,
 * with DPAPI as XOR, refusing a one-byte blob, and LocalFree checking the plain bytes were wiped first.
 */
const FAKE_CRYPT32 = `
#include <stdint.h>
#include <stdlib.h>
typedef struct { uint32_t cbData; unsigned char *pbData; } DATA_BLOB;
static unsigned char *last;
static uint32_t lastSize;
static int freed, wiped;
int CryptUnprotectData(DATA_BLOB *in, void *descr, DATA_BLOB *entropy, void *reserved, void *prompt, uint32_t flags, DATA_BLOB *out) {
  if (!in || !out || !in->pbData || descr || entropy || reserved || prompt || flags != 1 || in->cbData == 1) return 0;
  out->cbData = in->cbData;
  out->pbData = malloc(in->cbData);
  for (uint32_t i = 0; i < in->cbData; i++) out->pbData[i] = in->pbData[i] ^ 0x5a;
  last = out->pbData;
  lastSize = in->cbData;
  return 1;
}
void *LocalFree(void *memory) {
  if (memory == last) {
    int zero = 1;
    for (uint32_t i = 0; i < lastSize; i++) zero = zero && last[i] == 0;
    wiped += zero;
  }
  freed += memory != 0;
  free(memory);
  return 0;
}
int FakeFreed(void) { return freed; }
int FakeWiped(void) { return wiped; }
`;

/** Stand-ins for the worker, as plain scripts: right answers, a native crash, and silence. */
const STUBS = {
  answer: `process.parentPort.on("message", (event) => {
  const { id, blob } = event.data;
  process.parentPort.postMessage({ id, data: Uint8Array.from(blob, (byte) => byte ^ 0x5a) });
});`,
  crash: `process.parentPort.on("message", () => process.abort());`,
  hang: `process.parentPort.on("message", () => {});`,
};

/**
 * What must never again close Corvus, in real Electron, where V8's memory sandbox applies (the unit
 * tests run in Node, which is how koffi's view got through). koffi's memory helpers on memory from
 * koffi.alloc; the exact CryptUnprotectData and LocalFree calls against a compiled stand-in library;
 * the real worker starting and answering; and an import on a Windows-layout profile with workers that
 * answer, crash and hang, which ends with those logins protected and Corvus still here.
 */
export async function runDpapiSmoke(ctx: AppContext, h: DpapiSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-dpapi-smoke-"));
  const vault = win.profile.credentials;
  const before = new Set(vault.all().map((c) => c.id));
  const removeImported = (): void => vault.applyRemote(vault.all().filter((c) => !before.has(c.id)).map((c) => ({ id: c.id, cred: null })));
  const language = ctx.settings.get().appearance.language;
  let tabId: string | null = null;
  try {
    // ------------------------------------------------------------------ koffi inside Electron
    const koffi = loadKoffi();
    const pointer = koffi.alloc("uint8_t", 16);
    const pattern = crypto.randomBytes(16);
    writeBytes(koffi, pointer, pattern);
    const copy = readBytes(koffi, pointer, 16);
    wipeBytes(koffi, pointer, 16);
    const wipedMemory = readBytes(koffi, pointer, 16);
    koffi.free(pointer);
    check(
      "DPAPI: koffi's memory helpers work in real Electron on memory from koffi.alloc: bytes in, a copy out that outlives the wipe",
      Buffer.from(copy).equals(pattern) && wipedMemory.every((byte) => byte === 0) && memoryWorks(koffi),
      { copied: Buffer.from(copy).equals(pattern), wiped: wipedMemory.every((byte) => byte === 0) },
    );

    const source = path.join(dir, "fake-crypt32.c");
    const library = path.join(dir, "fake-crypt32.so");
    fs.writeFileSync(source, FAKE_CRYPT32);
    execFileSync("gcc", ["-shared", "-fPIC", source, "-o", library]);
    const unprotect = openDpapi(koffi, library, library);
    const blob = crypto.randomBytes(48);
    const plain = unprotect(blob);
    const refused = unprotect(Uint8Array.from([1]));
    const fake = koffi.load(library);
    const freed = (fake.func("int FakeFreed(void)") as () => number)();
    const wiped = (fake.func("int FakeWiped(void)") as () => number)();
    check(
      "DPAPI: the exact CryptUnprotectData call runs in real Electron: struct in, _Out_ struct back, a copy of the answer, its memory wiped and handed to LocalFree",
      plain !== null && fakeDpapi(blob).equals(Buffer.from(plain)) && refused === null && freed === 1 && wiped === 1,
      { answered: plain?.length, refused, freed, wiped },
    );

    // ---------------------------------------------------------------- the real worker, from out/main
    const worker = utilityProcess.fork(paths.dpapiWorker, [], { serviceName: "Corvus smoke DPAPI", stdio: "ignore" });
    const replies = new Map<number, { data?: unknown; ok?: boolean }>();
    worker.on("message", (message: { id: number; data?: unknown; ok?: boolean }) => replies.set(message.id, message));
    const spawned = await new Promise<boolean>((resolve) => {
      worker.once("spawn", () => resolve(true));
      worker.once("exit", () => resolve(false));
    });
    worker.postMessage({ id: 1, probe: true });
    worker.postMessage({ id: 2, blob: new Uint8Array(blob) });
    const answered = await until(() => replies.has(1) && replies.has(2));
    worker.kill();
    check(
      "DPAPI: the real worker starts from out/main, finds koffi and its memory helpers work there; with no crypt32.dll on this system it answers null",
      spawned && answered && replies.get(1)?.ok === true && replies.get(2)?.data === null,
      { spawned, answered, probe: replies.get(1), data: replies.get(2)?.data },
    );

    // ----------------------------------------------------- an import on a Windows-layout profile
    const stubs = Object.fromEntries(
      Object.entries(STUBS).map(([name, script]) => {
        const file = path.join(dir, `${name}.cjs`);
        fs.writeFileSync(file, script);
        return [name, file];
      }),
    ) as Record<keyof typeof STUBS | "real", string>;
    stubs.real = paths.dpapiWorker;
    ctx.browserImport.setTestRoots(writeWindowsFixtures(path.join(dir, "windows"), Date.now()));
    ctx.browserImport.setTestKeyProviders(null);
    const importWith = async (entry: string, timeoutMs: number) => {
      const children: UtilityProcess[] = [];
      ctx.browserImport.setTestDpapi(() => {
        const child = utilityProcess.fork(entry, [], { serviceName: "Corvus smoke DPAPI", stdio: "ignore" });
        children.push(child);
        return child as unknown as DpapiChild;
      }, timeoutMs);
      const started = Date.now();
      const result = await ctx.browserImport.run(win.profile, "brave", "Default", ["passwords"]);
      const took = Date.now() - started;
      const ended = await until(() => children.every((child) => child.pid === undefined), 5000);
      return { passwords: result.passwords, errors: result.errors, forks: children.length, ended, took };
    };

    const { current, old } = FIXTURE_WINDOWS_PASSWORDS;
    const good = await importWith(stubs.answer, 10_000);
    check(
      "DPAPI: an import reads the key and the rows from before v10 through one worker, killed when it ends",
      good.passwords?.added === 2 && good.forks === 1 && good.ended && vault.findByLogin(current.origin, current.username)?.password === current.password && vault.findByLogin(old.origin, old.username)?.password === old.password,
      { added: good.passwords?.added, forks: good.forks, ended: good.ended },
    );
    removeImported();

    const unread = (r: Awaited<ReturnType<typeof importWith>>): boolean => r.passwords?.added === 0 && r.passwords.protected === 2 && r.passwords.locked === 2 && Object.keys(r.errors).length === 0 && r.forks === 1 && r.ended;
    const crashed = await importWith(stubs.crash, 10_000);
    check("DPAPI: a worker that crashes natively leaves the import finished, the logins protected and Corvus running", unread(crashed) && !win.win.isDestroyed(), { ...crashed, passwords: crashed.passwords?.locked });

    const hung = await importWith(stubs.hang, 1500);
    check("DPAPI: a worker that hangs is killed after one timeout, however many logins are left", unread(hung) && hung.took < 2900, { ...hung, passwords: hung.passwords?.locked });

    const real = await importWith(stubs.real, 10_000);
    check("DPAPI: the real worker with no crypt32.dll leaves the logins protected, as a failed koffi load does", unread(real), { ...real, passwords: real.passwords?.locked });

    // ------------------------------------------------------------------------- what the person reads
    ctx.settings.update({ appearance: { language: "en" } });
    ctx.browserImport.setTestDpapi(() => utilityProcess.fork(stubs.crash, [], { serviceName: "Corvus smoke DPAPI", stdio: "ignore" }) as unknown as DpapiChild, 10_000);
    const tab = win.createTab("corvus://settings/#import");
    tabId = tab.id;
    const wc = tab.view.webContents;
    const row = '[data-import-source="brave"] [data-import-profile="Default"]';
    const listed = await until(async () => (await wc.executeJavaScript(`Boolean(document.querySelector('${row} [data-import-kind="passwords"] input')?.checked)`)) === true, 15_000);
    await wc.executeJavaScript(`document.querySelector('${row} [data-import-run]').click(); true`);
    const said = await until(async () => (await wc.executeJavaScript(`Boolean(document.querySelector('${row} [data-import-password-locked]'))`)) === true, 15_000);
    const text = (await wc.executeJavaScript(`document.querySelector('${row}').innerText`)) as string;
    await wc.executeJavaScript(`document.querySelector('${row} [data-import-password-result]').scrollIntoView({ block: "center" }); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    await sleep(250);
    await capture("pwimport-could-not-read-en", wc);
    check(
      "DPAPI: after a crash the page stays up, says Corvus could not read the passwords, and offers the browser's own export",
      listed && said && text.includes("Corvus could not read 2 of these passwords on this computer") && text.includes("Open Brave's export") && (await wc.executeJavaScript("1 + 1")) === 2,
      text.slice(0, 500),
    );
  } finally {
    ctx.settings.update({ appearance: { language } });
    ctx.browserImport.setTestDpapi(undefined);
    ctx.browserImport.setTestRoots(null);
    if (tabId) win.closeTab(tabId);
    removeImported();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
