import path from "node:path";
import { Menu, app, dialog, nativeTheme, safeStorage, session } from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import { AdblockService } from "./adblock";
import { CleanExitTracker } from "./clean-exit";
import { CrashReporter, installCrashHandlers } from "./crash-log";
import { AgentActivityService } from "./agent-activity-service";
import { AgentRunner } from "./agent-runner";
import { AnnotationService } from "./annotation-service";
import { AssistService } from "./assist-service";
import { TranslateService } from "./translate-service";
import { TabSleeper } from "./tab-sleeper";
import { AutofillService } from "./autofill-service";
import type { AppContext } from "./context";
import { AgentCredentialService } from "./agent-credentials";
import { SpendApprovalService } from "./spend-approvals";
import { Controller } from "./controller";
import { KeePassService } from "./keepass-service";
import { PasswordCheckupService } from "./password-checkup";
import { SecretFillGuard } from "./secret-fill-guard";
import { DownloadManager } from "./downloads";
import { ExtensionWindowBridge } from "./extension-windows";
import { registerIpc } from "./ipc";
import { McpService } from "./mcp-service";
import { PageMonitor } from "./page-monitor";
import { ProfileManager } from "./profile-manager";
import { ProfileRegistry } from "./profiles";
import { ReaderService } from "./reader-service";
import { handleInternalProtocol, registerInternalScheme, setInternalPageLanguage, setNewTabRoutes } from "./protocol";
import { NewTabService } from "./newtab-service";
import { ScheduledAgentRunner } from "./scheduled-agent-runner";
import { FlowService } from "./flow-service";
import { SearchService } from "./search-service";
import { SemanticSearchService } from "./semantic-search-service";
import { SessionRestore } from "./session-restore";
import { restorePlan } from "../shared/session-state";
import { resolveUiLanguage } from "../shared/settings";
import { SettingsStore } from "./settings-store";
import type { BrowserWindowCtl } from "./window";
import { runSmokeTest } from "./smoke";
import { runMarketingCapture } from "./capture-marketing";
import { SyncService } from "./sync-service";
import { UpdateService } from "./update-service";
import { WebScopeService } from "./webscope-service";
import { WindowManager } from "./window-manager";

registerInternalScheme();
app.setName("Corvus");

// The smoke test also serves its pages as a non-local site (the ad blocker never touches loopback)
// and a stand-in YouTube watch page (video features key on youtube.com).
if (process.env.CORVUS_SMOKE_TEST === "1") {
  app.commandLine.appendSwitch("host-resolver-rules", "MAP corvus-smoke.test 127.0.0.1, MAP www.youtube.com 127.0.0.1");
  // The YouTube stand-in is served over HTTPS (HSTS) with a throwaway certificate.
  app.commandLine.appendSwitch("ignore-certificate-errors");
}

const userDataOverride = process.env.CORVUS_USER_DATA;
if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));
else if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "Corvus Dev"));

function urlsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((arg) => /^https?:\/\//i.test(arg));
}

function setApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]));
}

/**
 * Which windows to open at startup. "restore" always continues the session. "newtab" normally opens
 * a fresh tab, but after an unclean shutdown with a saved session it offers to restore it instead.
 */
async function decideRestore(ctx: AppContext, unclean: boolean): Promise<BrowserWindowCtl[]> {
  if (ctx.settings.get().startup.mode === "restore") return ctx.sessionRestore.restore();
  const hasSession = restorePlan(ctx.sessionRestore.saved(), ctx.profiles.list().map((p) => p.id)).length > 0;
  if (!unclean || !hasSession || process.env.CORVUS_SMOKE_TEST === "1") return [];
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Restore previous session", "Start fresh"],
    defaultId: 0,
    cancelId: 1,
    message: "Corvus didn't shut down normally",
    detail: "Your windows and tabs from the last session were saved. Reopen them?",
  });
  return response === 0 ? ctx.sessionRestore.restore() : [];
}

async function main(): Promise<void> {
  await app.whenReady();

  handleInternalProtocol(session.defaultSession);
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  const userData = app.getPath("userData");
  const cleanExit = new CleanExitTracker(userData);
  const uncleanShutdown = cleanExit.wasUnclean();
  cleanExit.markRunning();
  const settings = new SettingsStore(userData, safeStorage, process.env);
  const crashReporter = new CrashReporter(userData, () => settings.get().crashReports.saveLogs);
  installCrashHandlers(crashReporter);
  nativeTheme.themeSource = settings.get().appearance.theme;
  setInternalPageLanguage(() => resolveUiLanguage(settings.get().appearance.language, app.getLocale()));
  const profiles = new ProfileRegistry(new ProfileManager(path.join(userData, "Profiles")), safeStorage);

  const ctx = { settings, profiles } as AppContext;
  ctx.crashReporter = crashReporter;
  ctx.windows = new WindowManager(ctx);
  ctx.search = new SearchService(settings);
  ctx.semanticSearch = new SemanticSearchService(ctx);
  ctx.agents = new AgentActivityService(ctx);
  ctx.assist = new AssistService(ctx);
  ctx.translate = new TranslateService(ctx);
  ctx.tabSleeper = new TabSleeper(ctx);
  ctx.reader = new ReaderService(ctx);
  ctx.controller = new Controller(ctx);
  ctx.agentRunner = new AgentRunner(ctx);
  ctx.agentCredentials = new AgentCredentialService(ctx);
  ctx.spendApprovals = new SpendApprovalService(ctx);
  ctx.webscope = new WebScopeService(ctx);
  ctx.monitor = new PageMonitor(ctx);
  ctx.newtab = new NewTabService(ctx);
  setNewTabRoutes({
    widget: (s, id, tone) => {
      const runtime = profiles.bySession(s);
      return runtime ? ctx.newtab.widgetDoc(runtime, id, resolveUiLanguage(settings.get().appearance.language, app.getLocale()), tone) : null;
    },
    media: (s, file) => {
      const runtime = profiles.bySession(s);
      return runtime ? ctx.newtab.media(runtime, file) : null;
    },
  });
  ctx.scheduledAgents = new ScheduledAgentRunner(ctx);
  ctx.flows = new FlowService(ctx);
  ctx.autofill = new AutofillService(ctx);
  ctx.keepass = new KeePassService(ctx);
  ctx.passwordCheckup = new PasswordCheckupService();
  ctx.secretFills = new SecretFillGuard();
  ctx.annotations = new AnnotationService(ctx);
  ctx.mcp = new McpService(ctx);
  ctx.updater = new UpdateService(ctx);
  ctx.sync = new SyncService(ctx, safeStorage, process.env.CORVUS_SYNC_URL || "http://localhost:8797");
  ctx.downloads = new DownloadManager(ctx);
  ctx.sessionRestore = new SessionRestore(ctx, userData);
  ctx.adblock = new AdblockService(userData, (profileId) => {
    for (const win of ctx.windows.forProfile(profileId)) {
      win.pushState();
      win.notifyInternalPages({ type: "settings-changed" }, ["settings"]);
    }
  });
  profiles.setDelegate(new ExtensionWindowBridge(ctx));
  profiles.onCreated((runtime) => ctx.downloads.attach(runtime));
  profiles.onCreated((runtime) => ctx.adblock.attach(runtime.session, runtime.adblock, runtime.profile.id));
  // Container tabs get downloads and the ad blocker like the profile's own tabs.
  profiles.onCreated((runtime) =>
    runtime.onContainerSession((ses) => {
      ctx.downloads.attachSession(runtime, ses);
      ctx.adblock.attach(ses, runtime.adblock, runtime.profile.id);
    }),
  );
  profiles.onCreated((runtime) =>
    runtime.containers.onChange(() => {
      for (const win of ctx.windows.forProfile(runtime.profile.id)) {
        win.pushState();
        win.notifyInternalPages({ type: "settings-changed" }, ["settings"]);
      }
    }),
  );
  profiles.onCreated((runtime) => ctx.monitor.attach(runtime));
  profiles.onCreated((runtime) => ctx.semanticSearch.attach(runtime));
  profiles.onCreated((runtime) => ctx.scheduledAgents.attach(runtime));
  profiles.onCreated((runtime) => ctx.flows.attach(runtime));
  profiles.onCreated((runtime) => ctx.keepass.attach(runtime));
  profiles.onCreated((runtime) =>
    runtime.agentRuns.onChange(() => {
      for (const win of ctx.windows.forProfile(runtime.profile.id)) win.notifyInternalPages({ type: "agent-runs-changed" }, ["agent-runs"]);
    }),
  );
  profiles.onCreated((runtime) =>
    runtime.siteProfiles.onChange(() => {
      for (const win of ctx.windows.forProfile(runtime.profile.id)) win.notifyInternalPages({ type: "site-profiles-changed" }, ["site-profiles"]);
    }),
  );
  profiles.onCreated((runtime) =>
    runtime.credentials.changes.on(() => {
      for (const win of ctx.windows.forProfile(runtime.profile.id)) win.notifyInternalPages({ type: "credentials-changed" }, ["passwords"]);
    }),
  );
  profiles.onCreated((runtime) =>
    runtime.annotations.onChange(() => {
      ctx.annotations.reapplyProfile(runtime.profile.id);
      for (const win of ctx.windows.forProfile(runtime.profile.id)) win.notifyInternalPages({ type: "annotations-changed" }, ["annotations"]);
    }),
  );
  registerIpc(ctx);
  setApplicationMenu();

  settings.onChange((next, prev) => {
    if (next.appearance.theme !== prev.appearance.theme) nativeTheme.themeSource = next.appearance.theme;
    if (JSON.stringify(next.appearance) !== JSON.stringify(prev.appearance)) ctx.windows.relayoutAll();
    ctx.windows.broadcastState();
  });

  app.on("second-instance", (_event, argv) => {
    ctx.mcp.enableFromArgv(argv);
    const urls = urlsFromArgv(argv);
    const win = ctx.windows.focused();
    if (!win) {
      ctx.windows.open(profiles.manager.lastUsed, urls);
      return;
    }
    for (const url of urls) win.createTab(url);
    if (win.win.isMinimized()) win.win.restore();
    win.win.focus();
  });
  app.on("activate", () => {
    if (ctx.windows.all().length === 0) ctx.windows.open(profiles.manager.lastUsed);
  });
  app.on("before-quit", () => {
    cleanExit.markCleanExit();
    ctx.sync.stop();
    ctx.sessionRestore.quitting();
    ctx.downloads.flush();
    profiles.flush();
    settings.flush();
    ctx.webscope.stop();
    ctx.monitor.stop();
    ctx.newtab.flush();
    ctx.scheduledAgents.stop();
    ctx.flows.stop();
    void ctx.mcp.stop();
  });

  const startUrls = urlsFromArgv(process.argv);
  const restored = await decideRestore(ctx, uncleanShutdown);
  const first = restored[0];
  if (first) for (const url of startUrls) first.createTab(url);
  else ctx.windows.open(profiles.manager.lastUsed, startUrls);
  if (!settings.get().onboarding.completed && process.env.CORVUS_SMOKE_TEST !== "1" && process.env.CORVUS_CAPTURE !== "1") {
    const win = ctx.windows.focused() ?? ctx.windows.all()[0];
    win?.createTab("corvus://welcome/", { activate: true });
  }
  ctx.sessionRestore.start();
  ctx.webscope.apply();
  ctx.mcp.recordAppLocation();
  ctx.mcp.enableFromArgv(process.argv);
  void ctx.mcp.apply();
  ctx.sync.start();
  ctx.monitor.start();
  ctx.tabSleeper.start();
  ctx.updater.startupCheck();

  if (process.env.CORVUS_SMOKE_TEST === "1") void runSmokeTest(ctx);
  else if (process.env.CORVUS_CAPTURE === "1") void runMarketingCapture(ctx);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  main().catch((err: unknown) => {
    console.error("[corvus] fatal startup error:", err);
    app.exit(1);
  });
}
