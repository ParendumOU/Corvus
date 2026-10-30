import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutofillService } from "../src/main/autofill-service";
import type { AppContext } from "../src/main/context";
import { CredentialVault } from "../src/main/credential-store";
import { LoginSources, vaultProvider } from "../src/main/login-sources";
import { SiteSettingsStore } from "../src/main/site-settings";
import { autofillChromeHandlers } from "../src/main/ipc-credentials";
import type { SecretCipher } from "../src/main/settings-store";
import type { BrowserWindowCtl, TabRuntime } from "../src/main/window";

const clipboardText = vi.hoisted(() => ({ value: "" }));
vi.mock("electron", () => ({ ipcMain: { on: () => undefined, handle: () => undefined }, clipboard: { writeText: (text: string) => void (clipboardText.value = text) } }));

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const SITE = "https://example.com";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A window with tabs t1 (active) and t2, over a real vault; counts its state pushes. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-autofill-"));
  dirs.push(dir);
  const vault = new CredentialVault(dir, keychain);
  const siteSettings = new SiteSettingsStore(dir);
  const logins = new LoginSources(() => [vaultProvider(vault)]);
  // Closed-looking views (no page): the service reads the tab's last known address instead.
  const tabs = new Map(["t1", "t2"].map((id) => [id, { id, agentControlled: false, url: `${SITE}/login`, view: {} } as unknown as TabRuntime]));
  let active = "t1";
  const pushes = { count: 0 };
  const win = {
    profile: { credentials: vault, logins, siteSettings },
    isPrivate: false,
    activeTab: () => tabs.get(active),
    pushState: () => void pushes.count++,
  } as unknown as BrowserWindowCtl;
  const ctx = {} as AppContext;
  const autofill = new AutofillService(ctx);
  ctx.autofill = autofill;
  const submit = (tabId: string, username: string, password: string): void => autofill.onSubmitCaptured(win, tabs.get(tabId)!, { origin: `${SITE}/login`, username, password });
  return { vault, win, autofill, ctx, tabs, pushes, submit, siteSettings, activate: (id: string) => void (active = id) };
}

describe("the save-password prompt", () => {
  it("opens by itself once per submitted login, and the window state never carries the password", () => {
    const { win, autofill, pushes, submit } = setup();
    submit("t1", "carol", "pw-one");
    const state = autofill.stateFor(win);
    expect(state).toMatchObject({ canSave: true, savePrompt: true });
    expect(state.saveId).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain("pw-one");

    const before = pushes.count;
    expect(autofill.pendingSave(win)).toEqual({ id: state.saveId, host: "example.com", username: "carol", password: "pw-one", savedUsernames: [] });
    expect(autofill.stateFor(win)).toMatchObject({ canSave: true, saveId: state.saveId, savePrompt: false });
    expect(pushes.count).toBe(before + 1);
    autofill.pendingSave(win);
    expect(pushes.count).toBe(before + 1);

    submit("t1", "carol", "pw-two");
    const next = autofill.stateFor(win);
    expect(next.saveId).toBeGreaterThan(state.saveId);
    expect(next.savePrompt).toBe(true);
  });

  it("belongs to its tab: a save from a background tab prompts when that tab is shown", () => {
    const { win, autofill, submit, activate } = setup();
    submit("t2", "dave", "pw-bg");
    expect(autofill.stateFor(win)).toMatchObject({ canSave: false, saveId: 0, savePrompt: false });
    expect(autofill.pendingSave(win)).toBeNull();
    activate("t2");
    expect(autofill.stateFor(win)).toMatchObject({ canSave: true, savePrompt: true });
    expect(autofill.pendingSave(win)?.username).toBe("dave");
  });

  it("does not open by itself over a tab an agent drives", () => {
    const { win, autofill, tabs, submit } = setup();
    (tabs.get("t1") as { agentControlled: boolean }).agentControlled = true;
    submit("t1", "agent-user", "pw-agent");
    expect(autofill.stateFor(win)).toMatchObject({ canSave: true, savePrompt: false });
  });

  it("stores the username and password as edited in the prompt", () => {
    const { vault, win, autofill, submit } = setup();
    submit("t1", "carol", "pw-one");
    const id = autofill.stateFor(win).saveId;
    autofill.acceptSave(win, { id, username: "carol.smith", password: "pw-edited" });
    expect(vault.all().map((c) => [c.origin, c.username, c.password])).toEqual([[SITE, "carol.smith", "pw-edited"]]);
    expect(autofill.stateFor(win).canSave).toBe(false);
  });

  it("updates a saved login when the edited username is saved for the site, and adds one otherwise", () => {
    const { vault, win, autofill, submit } = setup();
    const alice = vault.add({ origin: SITE, username: "alice", password: "old" });

    // An update turned into a new login: alice keeps her password, bob is added.
    submit("t1", "alice", "new");
    const update = autofill.pendingSave(win)!;
    expect(update.savedUsernames).toEqual(["alice"]);
    autofill.acceptSave(win, { id: update.id, username: "bob", password: "new" });
    expect(vault.get(alice.id)?.password).toBe("old");
    expect(vault.findByLogin(SITE, "bob")?.password).toBe("new");

    // A new login turned into an update of alice's.
    submit("t1", "zed", "zed-pw");
    autofill.acceptSave(win, { id: autofill.stateFor(win).saveId, username: "alice", password: "zed-pw" });
    expect(vault.get(alice.id)?.password).toBe("zed-pw");
    expect(vault.findByLogin(SITE, "zed")).toBeUndefined();
    expect(vault.usernamesAt(SITE).sort()).toEqual(["alice", "bob"]);
  });

  it("stores nothing for a save that is no longer pending, and Cancel drops only its own save", () => {
    const { vault, win, autofill, submit } = setup();
    submit("t1", "carol", "pw-one");
    const stale = autofill.stateFor(win).saveId;
    submit("t1", "carol", "pw-two");
    const current = autofill.stateFor(win).saveId;

    autofill.acceptSave(win, { id: stale, username: "carol", password: "pw-one" });
    autofill.dismissSave(win, stale);
    expect(vault.all()).toEqual([]);
    expect(autofill.stateFor(win).saveId).toBe(current);

    autofill.dismissSave(win, current);
    expect(autofill.stateFor(win).canSave).toBe(false);
    autofill.acceptSave(win, { id: current, username: "carol", password: "pw-two" });
    expect(vault.all()).toEqual([]);
  });
});

describe("Never for this site", () => {
  it("drops the save and stops offering to save on that exact host until it is taken off the list", () => {
    const { vault, win, autofill, tabs, siteSettings, submit } = setup();
    const submitAt = (origin: string, username: string): void => autofill.onSubmitCaptured(win, tabs.get("t1")!, { origin, username, password: "pw" });
    submit("t1", "carol", "pw-one");
    const stale = autofill.stateFor(win).saveId;
    submit("t1", "carol", "pw-two");
    autofill.neverSave(win, stale);
    expect(siteSettings.neverSave()).toEqual([]);
    autofill.neverSave(win, autofill.stateFor(win).saveId);
    expect(siteSettings.neverSave()).toEqual(["example.com"]);
    expect(autofill.stateFor(win)).toMatchObject({ canSave: false, savePrompt: false });
    expect(vault.all()).toEqual([]);

    // Neither a new login nor a changed one is offered there again; other hosts of the domain still ask.
    submit("t1", "dave", "pw-three");
    expect(autofill.stateFor(win).canSave).toBe(false);
    submitAt("https://accounts.example.com/login", "dave");
    expect(autofill.stateFor(win)).toMatchObject({ canSave: true, savePrompt: true });
    autofill.dismissSave(win, autofill.stateFor(win).saveId);

    siteSettings.setNeverSave("example.com", false);
    submit("t1", "dave", "pw-four");
    expect(autofill.stateFor(win)).toMatchObject({ canSave: true, savePrompt: true });
  });

  it("is a save prompt answer the IPC checks", () => {
    const { win, ctx, siteSettings, submit } = setup();
    const ipc = autofillChromeHandlers(ctx);
    submit("t1", "carol", "pw-one");
    for (const bad of ["1", 0, -1, 1.5, undefined]) expect(() => ipc["autofill.saveNever"](win, bad as never), String(bad)).toThrow();
    ipc["autofill.saveNever"](win, ctx.autofill.stateFor(win).saveId);
    expect(siteSettings.neverSave()).toEqual(["example.com"]);
  });
});

describe("the account used last", () => {
  const TOTP = { secret: "JBSWY3DPEHPK3PXPJBSWY3DP", algorithm: "SHA1" as const, digits: 6, period: 30 };

  it("comes first on the site after its code is copied, never noted from a private window", async () => {
    const { vault, win, autofill } = setup();
    const older = vault.add({ origin: "https://central.example.com", username: "info@example.com", password: "", totp: TOTP });
    const newer = vault.add({ origin: "https://cloud.example.com", username: "cloud@example.com", password: "", totp: TOTP });
    (vault.get(older.id) as { updatedAt: number }).updatedAt = 1;
    expect(autofill.suggestions(win).map((m) => m.id)).toEqual([newer.id, older.id]);

    (win as { isPrivate: boolean }).isPrivate = true;
    expect(await autofill.copyTotp(win, older.id)).toBe(true);
    expect(clipboardText.value).toMatch(/^\d{6}$/);
    expect(autofill.suggestions(win).map((m) => m.id)).toEqual([newer.id, older.id]);

    (win as { isPrivate: boolean }).isPrivate = false;
    expect(await autofill.copyTotp(win, older.id)).toBe(true);
    expect(autofill.suggestions(win).map((m) => m.id)).toEqual([older.id, newer.id]);
    // A login of another site, or one without a 2FA, copies nothing.
    expect(await autofill.copyTotp(win, "gone")).toBe(false);
  });
});

describe("the save-password IPC", () => {
  it("hands the pending save only to the prompt, and checks what comes back", () => {
    const { vault, win, autofill, ctx, submit } = setup();
    const ipc = autofillChromeHandlers(ctx);
    expect(ipc["autofill.savePending"](win)).toBeNull();
    submit("t1", "carol", "pw-one");
    const pending = ipc["autofill.savePending"](win) as ReturnType<typeof autofill.pendingSave>;
    expect(pending?.password).toBe("pw-one");
    const id = pending!.id;

    const bad: unknown[] = [
      undefined,
      { id, username: "carol" },
      { id, username: "carol", password: "" },
      { id, username: 7, password: "pw" },
      { id, username: "carol", password: "x".repeat(4097) },
      { id, username: "u".repeat(4097), password: "pw" },
      { id: "1", username: "carol", password: "pw" },
      { id: 0, username: "carol", password: "pw" },
      { id: 1.5, username: "carol", password: "pw" },
    ];
    for (const edit of bad) expect(() => ipc["autofill.saveAccept"](win, edit as never), JSON.stringify(edit)).toThrow();
    expect(() => ipc["autofill.saveDismiss"](win, "x" as never)).toThrow();
    expect(vault.all()).toEqual([]);

    ipc["autofill.saveAccept"](win, { id, username: "", password: "pw-edited" });
    expect(vault.all().map((c) => [c.username, c.password])).toEqual([["", "pw-edited"]]);
  });
});
