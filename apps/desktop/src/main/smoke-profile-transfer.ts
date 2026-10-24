import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import { exportProfile, importProfile } from "./profile-transfer";
import type { BrowserWindowCtl } from "./window";

interface TransferSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Profile export/import: the profile goes out as one sealed file (no login in clear in it) and
 * comes back as a new profile with its bookmarks and working logins; a wrong password is refused.
 * The save/open dialogs are skipped: the files are passed directly.
 */
export async function runProfileTransferSmoke(ctx: AppContext, h: TransferSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const source = win.profile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-transfer-"));
  const file = path.join(dir, "smoke.corvus-profile");
  const login = source.credentials.add({ origin: "https://transfer.example", username: "mover", password: "moved-pw-123" });
  let importedId: string | null = null;
  try {
    const bookmarks = source.bookmarks.list().length;
    exportProfile(ctx, source, "smoke transfer pw", file);
    const text = fs.readFileSync(file, "utf8");
    check("profile transfer: the export is one sealed file, no login in clear", text.startsWith('{"format":"corvus-profile"') && !text.includes("moved-pw-123") && !text.includes("transfer.example"), {
      bytes: text.length,
    });

    let refused = "";
    try {
      importProfile(ctx, file, "not the password");
    } catch (err) {
      refused = (err as Error).message;
    }
    const before = ctx.profiles.list().length;
    const imported = importProfile(ctx, file, "smoke transfer pw");
    importedId = imported.id;
    const runtime = ctx.profiles.get(imported.id);
    const moved = runtime.credentials.all().find((c) => c.id === login.id);
    check(
      "profile transfer: import makes a new profile with the bookmarks and logins",
      /Wrong password/.test(refused) &&
        ctx.profiles.list().length === before + 1 &&
        imported.name !== source.profile.name &&
        runtime.bookmarks.list().length === bookmarks &&
        moved?.password === "moved-pw-123",
      { refused, name: imported.name, bookmarks: [bookmarks, runtime.bookmarks.list().length], login: Boolean(moved) },
    );

    const settings = win.createTab("corvus://settings/#profiles", { activate: true });
    await sleep(1500);
    await settings.view.webContents.executeJavaScript(
      "[...document.querySelectorAll('#profiles .btn')].find((b) => b.textContent.includes('Export'))?.click()",
    );
    await sleep(300);
    const form = (await settings.view.webContents.executeJavaScript("document.querySelectorAll('.profile-transfer input[type=password]').length")) as number;
    check("profile transfer: Settings > Profiles asks for the export password twice", form === 2, form);
    await capture("settings-profile-export", settings.view.webContents);
    win.closeTab(settings.id);
  } finally {
    source.credentials.remove(login.id);
    if (importedId) await ctx.profiles.remove(importedId).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
