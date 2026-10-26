import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Menu, app, nativeTheme, safeStorage, session } from "electron";
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
import { UserActionService } from "./user-actions";
import { Controller } from "./controller";
import { KeePassService } from "./keepass-service";
import { PasswordCheckupService } from "./password-checkup";
import { TelegramLink } from "./telegram-link";
import { SecretFillGuard } from "./secret-fill-guard";
import { DefaultBrowser } from "./default-browser";
import { DownloadManager } from "./downloads";
import { DownloadQueue } from "./download-queue";
import { BrowserImport } from "./browser-import";
import { LinkGrabber } from "./link-grabber";
import { ExtensionWindowBridge } from "./extension-windows";
import { registerIpc } from "./ipc";
import { McpService } from "./mcp-service";
import { PageMonitor } from "./page-monitor";
import { ProfileManager } from "./profile-manager";
import { installConnectionHooks } from "./connection-hooks";
import { ProfileRegistry, installUserAgents } from "./profiles";
import { ReaderService } from "./reader-service";
import { handleInternalProtocol, registerInternalScheme, setInternalPageLanguage, setFaviconSource, setNewTabRoutes } from "./protocol";
import { NewTabService } from "./newtab-service";
import { ScheduledAgentRunner } from "./scheduled-agent-runner";
import { FlowService } from "./flow-service";
import { SearchService } from "./search-service";
import { SemanticSearchService } from "./semantic-search-service";
import { SessionRestore } from "./session-restore";
import { restorePlan } from "../shared/session-state";
import { launchTargets } from "../shared/default-browser";
import { resolveUiLanguage, type UiLanguage } from "../shared/settings";
import { setMenuLanguage, tr } from "./menu-i18n";
import { SettingsStore } from "./settings-store";
import { DictationService } from "./dictation-service";
import { DialogService, pageDialogPresenter } from "./dialogs";
import { PageDialogs } from "./page-dialogs";
import { setExtensionMessageBox } from "./extensions";
import { dictationReady, internalMicrophoneAllowed } from "../shared/dictation";
import { SyncService } from "./sync-service";
import { UpdateService } from "./update-service";
import { WebScopeService } from "./webscope-service";
import { WindowManager } from "./window-manager";

/** When this bundle finished loading (its imports parsed and run), for the startup probe. */
const MAIN_LOADED_AT = Date.now();

registerInternalScheme();
app.setName("Corvus");
// Before any session exists, so every request (tabs, favicons, the default session) shares one UA.
installUserAgents();

// The smoke test also serves its pages as a non-local site (the ad blocker never touches loopback)
// and a stand-in YouTube watch page (video features key on youtube.com).
if (process.env.CORVUS_SMOKE_TEST === "1") {
  app.commandLine.appendSwitch("host-resolver-rules", "MAP corvus-smoke.test 127.0.0.1, MAP www.youtube.com 127.0.0.1");
  // The YouTube stand-in is served over HTTPS (HSTS) with a throwaway certificate.
  app.commandLine.appendSwitch("ignore-certificate-errors");
  // Dictation records from a fake microphone (a beep) instead of the machine's.
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
}

const userDataOverride = process.env.CORVUS_USER_DATA;
if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));
else if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "Corvus Dev"));

/** The links and web files a launch asks for (relative paths from the folder it was started in). */
function urlsFromArgv(argv: string[], cwd = process.cwd()): string[] {
  const resolve = (p: string): string => path.resolve(cwd, p);
  return launchTargets(
    argv,
    (p) => {
      try {
        return fs.statSync(resolve(p)).isFile();
      } catch {
        return false;
      }
    },
    (p) => pathToFileURL(resolve(p)).href,
  );
}

/** Opens links in the focused window, or a new one, and brings it to the front. */
function openUrls(ctx: AppContext, urls: string[]): void {
  const win = ctx.windows.focused() ?? ctx.windows.all()[0];
  if (!win) {
    ctx.windows.open(ctx.profiles.manager.lastUsed, urls);
    return;
  }
  for (const url of urls) win.createTab(url);
  if (win.win.isMinimized()) win.win.restore();
  win.win.focus();
}

/** macOS hands links and files over in events, from before the app is ready: kept until a window is. */
const pendingSystemOpens: string[] = [];
let systemOpen: ((urls: string[]) => void) | null = null;
function openFromSystem(urls: string[]): void {
  if (systemOpen) systemOpen(urls);
  else pendingSystemOpens.push(...urls);
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
/**
 * The first windows: the saved session when Corvus reopens it, else a new window. After a crash
 * with a session saved, Corvus asks in that new window whether to reopen the session, and closes
 * the new window again when it does (unless it holds pages Corvus was started with).
 */
function openStartWindows(ctx: AppContext, unclean: boolean, profileId: string, startUrls: string[]): void {
  if (ctx.settings.get().startup.mode === "restore") {
    const first = ctx.sessionRestore.restore()[0];
    if (first) for (const url of startUrls) first.createTab(url);
    else ctx.windows.open(profileId, startUrls);
    return;
  }
  // Read before any window opens: the new window's own state is saved over it.
  const snapshot = ctx.sessionRestore.saved();
  const hasSession = restorePlan(snapshot, ctx.profiles.list().map((p) => p.id)).length > 0;
  const win = ctx.windows.open(profileId, startUrls);
  if (!unclean || !hasSession || process.env.CORVUS_SMOKE_TEST === "1") return;
  // Asked without holding up the rest of the start.
  void ctx.dialogs.ask(
    {
      tone: "warning",
      title: tr("Corvus didn't shut down normally"),
      message: tr("Corvus didn't shut down normally"),
      detail: tr("Your windows and tabs from the last session were saved. Reopen them?"),
      buttons: [tr("Start fresh"), tr("Restore previous session")],
      defaultId: 1,
      cancelId: 0,
    },
    win,
  ).then(({ button }) => {
    if (button !== 1) return;
    const restored = ctx.sessionRestore.restore(snapshot);
    if (restored.length > 0 && startUrls.length === 0) win.close();
  });
}

async function main(): Promise<void> {
  await app.whenReady();

  handleInternalProtocol(session.defaultSession);
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);

  const userData = app.getPath("userData");
  const cleanExit = new CleanExitTracker(userData);
  const uncleanShutdown = cleanExit.wasUnclean();
  cleanExit.markRunning();
  const settings = new SettingsStore(userData, safeStorage, process.env);
  // Corvus's own UI may only open the microphone, for dictation once it is set up; nothing else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(internalMicrophoneAllowed(permission, "mediaTypes" in details ? details.mediaTypes : undefined, details.requestingUrl, dictationReady(settings.get().dictation))),
  );
  const crashReporter = new CrashReporter(userData, () => settings.get().crashReports.saveLogs);
  installCrashHandlers(crashReporter);
  nativeTheme.themeSource = settings.get().appearance.theme;
  const uiLanguage = (): UiLanguage => resolveUiLanguage(settings.get().appearance.language, app.getLocale());
  setInternalPageLanguage(uiLanguage);
  setMenuLanguage(uiLanguage);
  const profiles = new ProfileRegistry(new ProfileManager(path.join(userData, "Profiles")), safeStorage);

  const ctx = { settings, profiles } as AppContext;
  ctx.crashReporter = crashReporter;
  ctx.dictation = new DictationService(settings);
  ctx.dialogs = new DialogService(ctx);
  ctx.pageDialogs = new PageDialogs(pageDialogPresenter(ctx));
  setExtensionMessageBox((options, window) => ctx.dialogs.messageBox(options, ctx.windows.all().find((w) => w.win === window)));
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
  ctx.userActions = new UserActionService(ctx);
  ctx.webscope = new WebScopeService(ctx);
  ctx.monitor = new PageMonitor(ctx);
  ctx.newtab = new NewTabService(ctx);
  setFaviconSource({
    forSession: (s) => {
      const runtime = profiles.bySession(s);
      return runtime ? (url) => runtime.favicons.icon(url) : null;
    },
    forProfile: (id) => (profiles.list().some((p) => p.id === id) ? (url) => profiles.get(id).favicons.icon(url) : null),
  });
  setNewTabRoutes({
    widget: (s, id, tone) => {
      const runtime = profiles.bySession(s);
      return runtime ? ctx.newtab.widgetDoc(runtime, id, uiLanguage(), tone) : null;
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
  ctx.telegram = new TelegramLink(ctx);
  ctx.secretFills = new SecretFillGuard();
  ctx.annotations = new AnnotationService(ctx);
  ctx.mcp = new McpService(ctx);
  ctx.updater = new UpdateService(ctx);
  ctx.sync = new SyncService(ctx, safeStorage, process.env.CORVUS_SYNC_URL || "http://localhost:8797");
  ctx.downloads = new DownloadManager(ctx);
  ctx.grabber = new LinkGrabber(ctx);
  ctx.queue = new DownloadQueue(ctx);
  ctx.browserImport = new BrowserImport();
  ctx.defaultBrowser = new DefaultBrowser(ctx);
  ctx.sessionRestore = new SessionRestore(ctx, userData);
  ctx.adblock = new AdblockService(userData, (profileId) => {
    for (const win of ctx.windows.forProfile(profileId)) {
      win.pushState();
      win.notifyInternalPages({ type: "settings-changed" }, ["settings"]);
    }
  });
  profiles.setDelegate(new ExtensionWindowBridge(ctx));
  installConnectionHooks(profiles);
  profiles.onCreated((runtime) => ctx.downloads.attach(runtime));
  profiles.onCreated((runtime) =>
    runtime.connections.onChange(() => {
      for (const w of ctx.windows.forProfile(runtime.profile.id)) w.pushState();
    }),
  );
  profiles.onCreated((runtime) => ctx.queue.attach(runtime));
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

  app.on("second-instance", (_event, argv, workingDirectory) => {
    ctx.mcp.enableFromArgv(argv);
    openUrls(ctx, urlsFromArgv(argv, workingDirectory));
  });
  app.on("activate", () => {
    if (ctx.windows.all().length === 0) ctx.windows.open(profiles.manager.lastUsed);
  });
  app.on("before-quit", () => {
    cleanExit.markCleanExit();
    ctx.sync.stop();
    ctx.sessionRestore.quitting();
    ctx.downloads.flush();
    ctx.grabber.stop();
    ctx.queue.flush();
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
  openStartWindows(ctx, uncleanShutdown, profiles.manager.lastUsed, startUrls);
  systemOpen = (urls) => openUrls(ctx, urls);
  if (pendingSystemOpens.length > 0) openUrls(ctx, pendingSystemOpens.splice(0));
  const automated = process.env.CORVUS_SMOKE_TEST === "1" || process.env.CORVUS_CAPTURE === "1";
  if (!settings.get().onboarding.completed && !automated) {
    const win = ctx.windows.focused() ?? ctx.windows.all()[0];
    win?.createTab("corvus://welcome/", { activate: true });
  } else if (!automated) {
    void ctx.defaultBrowser.startup(ctx.windows.focused() ?? ctx.windows.all()[0]);
  }
  ctx.sessionRestore.start();
  ctx.webscope.apply();
  ctx.mcp.recordAppLocation();
  ctx.mcp.enableFromArgv(process.argv);
  void ctx.mcp.apply();
  ctx.sync.start();
  ctx.monitor.start();
  ctx.telegram.start();
  ctx.grabber.start();
  ctx.tabSleeper.start();
  ctx.updater.startupCheck();

  // The smoke test and the marketing capture are chunks of their own: normal starts never load them.
  if (process.env.CORVUS_SMOKE_TEST === "1") void import("./smoke").then((m) => m.runSmokeTest(ctx));
  else if (process.env.CORVUS_CAPTURE === "1") void import("./capture-marketing").then((m) => m.runMarketingCapture(ctx));
  else if (process.env.CORVUS_STARTUP_PROBE === "1") reportStartup(ctx);
}

/**
 * CORVUS_STARTUP_PROBE=1: prints how long the main bundle took to load and the first window's
 * browser bar to finish loading (ms since the process started), then quits. For measuring starts.
 */
function reportStartup(ctx: AppContext): void {
  const created = process.getCreationTime() ?? MAIN_LOADED_AT;
  const chrome = ctx.windows.all()[0]?.chrome.webContents;
  const done = (): void => {
    console.log(`[startup] ${JSON.stringify({ mainLoadedMs: MAIN_LOADED_AT - created, chromeLoadedMs: Date.now() - created })}`);
    app.quit();
  };
  if (!chrome || !chrome.isLoading()) done();
  else chrome.once("did-finish-load", done);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) openFromSystem([url]);
  });
  app.on("open-file", (event, file) => {
    event.preventDefault();
    openFromSystem(urlsFromArgv(["", file]));
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  main().catch((err: unknown) => {
    console.error("[corvus] fatal startup error:", err);
    app.exit(1);
  });
}
