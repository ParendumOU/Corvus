import path from "node:path";
import { app, session as electronSession, webContents as allWebContents, type Session } from "electron";
import type { Profile, ProfileId } from "@corvus/shared";
import { FaviconCache } from "./favicon-cache";
import { probePage } from "./favicon-probe";
import { AdblockController } from "./adblock";
import { AnnotationStore } from "./annotation-store";
import { AutoSignInStore } from "./auto-sign-in-store";
import { BackupStore } from "./backup-store";
import { containerPartition } from "../shared/containers";
import { ContainerStore } from "./containers";
import { CredentialVault } from "./credential-store";
import { ExtensionHost, type ExtensionWindowDelegate } from "./extensions";
import { containerChoice, type ConnectionChoice } from "../shared/connections";
import { ConnectionStore, applyConnection, webrtcPolicy } from "./connections";
import { registerCommandApis, registerDownloadApis, registerExtensionApis, registerSessionApis, registerSidePanelApis, registerTabGroupApis } from "./extension-apis";
import { KeePassStore } from "./keepass-store";
import { LoginSources, vaultProvider } from "./login-sources";
import { PermissionManager, type PermissionHost } from "./permissions";
import { AgentRunStore } from "./agent-run-store";
import { AssistHistoryStore } from "./assist-history-store";
import { CommandHistoryStore } from "./command-history-store";
import { UserMemoryStore } from "./user-memory-store";
import { ProfileManager } from "./profile-manager";
import { handleInternalProtocol } from "./protocol";
import { ReadingStore } from "./reading-store";
import { SemanticIndexStore } from "./semantic-index-store";
import { SiteProfileStore } from "./site-profile-store";
import type { SecretCipher } from "./settings-store";
import { SiteSettingsStore } from "./site-settings";
import { BookmarkStore, HistoryStore } from "./stores";
import { chromeUserAgent, clientHintHeaders, electronUserAgent, outgoingHeaders, type ClientHints, type UserAgents } from "./user-agent";
import { WorkspaceStore } from "./workspace-store";
import { SiteSearchStore } from "./site-search-store";

/** What a profile runtime needs from the window layer (implemented by WindowManager). */
export type ProfileDelegate = ExtensionWindowDelegate & PermissionHost;

let installedUserAgents: UserAgents | null = null;

/**
 * Makes the Chrome UA Chromium's own default (app.userAgentFallback) rather than a per-session
 * override: an override drops the UA client hints (Sec-CH-UA headers) from every request, which no
 * real Chromium does, and requests outside the overridden sessions (favicons, the default session)
 * still went out with Electron's UA. Call before any session exists; both UAs come from Electron's.
 */
export function installUserAgents(): UserAgents {
  if (!installedUserAgents) {
    const native = app.userAgentFallback;
    installedUserAgents = { chrome: chromeUserAgent(native), electron: electronUserAgent(native) };
    app.userAgentFallback = installedUserAgents.chrome;
  }
  return installedUserAgents;
}

/**
 * Adds the client hints Electron leaves out of navigations (see clientHintHeaders), with the exact
 * values its own subresource requests carry once one has been seen, and Global Privacy Control's
 * `Sec-GPC: 1` while `gpc()` says so. Returns a switch, since the listener costs extensions their
 * request filtering (see ExtensionHost.filtersRequests).
 */
function clientHints(ses: Session, gpc: () => boolean): (on: boolean) => void {
  let hints: ClientHints = clientHintHeaders(Number(process.versions.chrome.split(".")[0]), process.platform);
  let installed = false;
  return (on) => {
    if (on === installed) return;
    installed = on;
    if (!on) {
      ses.webRequest.onBeforeSendHeaders(null);
      return;
    }
    ses.webRequest.onBeforeSendHeaders({ urls: ["https://*/*", "http://*/*"] }, (details, callback) => {
      const { headers, seen } = outgoingHeaders(details, hints, gpc());
      if (seen) hints = seen;
      callback({ requestHeaders: headers });
    });
  };
}

/** Everything that exists once per profile: session partition, stores and extensions. */
export class ProfileRuntime {
  readonly partition: string;
  readonly session: Session;
  readonly bookmarks: BookmarkStore;
  readonly history: HistoryStore;
  readonly workspaces: WorkspaceStore;
  /** Search shortcuts typed in the address bar ("yt cats"). */
  readonly siteSearch: SiteSearchStore;
  readonly reading: ReadingStore;
  readonly annotations: AnnotationStore;
  readonly agentRuns: AgentRunStore;
  readonly assistHistory: AssistHistoryStore;
  /** What the person ran from the Command Bar (its "Recent" list). */
  readonly commands: CommandHistoryStore;
  readonly userMemory: UserMemoryStore;
  /** Site icons for Corvus's own UI (bookmarks bar, history, suggestions). */
  readonly favicons: FaviconCache;
  readonly siteProfiles: SiteProfileStore;
  readonly semanticIndex: SemanticIndexStore;
  readonly credentials: CredentialVault;
  /** KeePass databases (read, and written only for entries the person adds or edits; off until they add one). */
  readonly keepass: KeePassStore;
  /** Logins the person chose to sign in with automatically (always confirmed first). */
  readonly autoSignIn: AutoSignInStore;
  /** When the saved logins were last backed up (the reminder). */
  readonly backup: BackupStore;
  /** Every login source of this profile (built-in vault, KeePass) behind one matcher. */
  readonly logins: LoginSources;
  readonly extensions: ExtensionHost;
  readonly siteSettings: SiteSettingsStore;
  readonly permissions: PermissionManager;
  readonly adblock: AdblockController;
  /** Global Privacy Control for the profile's sessions (read per request; the blocker's settings hold it). */
  private readonly gpcOn = (): boolean => (this.adblock as AdblockController | undefined)?.options().gpc ?? true;
  /** Chrome UA for sites, Electron's for Google sign-in (see user-agent.ts). */
  readonly userAgents: UserAgents;
  /** Containers: tabs with their own cookies and site data, each in a session of its own. */
  readonly containers: ContainerStore;
  /** Proxies, and which one the profile and each container go through. */
  readonly connections: ConnectionStore;
  /** Each session's latest proxy change, until Chromium uses it. */
  private readonly connecting = new Map<Session, Promise<void>>();
  private readonly connected = new Set<Session>();
  /** Sessions Corvus changed the proxy of (the others still use Chromium's own default: the system's). */
  private readonly proxied = new Set<Session>();
  /** The in-memory session of this profile's private windows, while one is open. */
  private privateSes: Session | null = null;
  private privateRuns = 0;
  private readonly containerSessions = new Map<string, Session>();
  private readonly containerSessionListeners = new Set<(session: Session) => void>();

  constructor(
    public profile: Profile,
    readonly dataDir: string,
    delegate: ProfileDelegate,
    cipher: SecretCipher,
  ) {
    this.partition = ProfileManager.partition(profile.id);
    this.session = electronSession.fromPartition(this.partition);
    // The proxy first, before anything of the profile goes online.
    this.connections = new ConnectionStore(dataDir, cipher);
    this.applyConnections();
    this.connections.onChange(() => this.applyConnections());
    this.userAgents = installUserAgents();
    const setClientHints = clientHints(this.session, this.gpcOn);
    setClientHints(true);
    handleInternalProtocol(this.session);
    this.siteSettings = new SiteSettingsStore(dataDir);
    this.permissions = new PermissionManager(this.siteSettings, delegate);
    this.permissions.install(this.session);
    this.bookmarks = new BookmarkStore(dataDir);
    this.history = new HistoryStore(dataDir);
    this.workspaces = new WorkspaceStore(dataDir);
    this.siteSearch = new SiteSearchStore(dataDir);
    this.reading = new ReadingStore(dataDir);
    this.annotations = new AnnotationStore(dataDir);
    this.agentRuns = new AgentRunStore(dataDir);
    this.assistHistory = new AssistHistoryStore(dataDir);
    this.commands = new CommandHistoryStore(dataDir);
    this.userMemory = new UserMemoryStore(dataDir);
    // Icons are fetched through the profile's connection, once its proxy is in place (nothing leaks
    // around it right after start or a change); bookmarks never opened are followed to where they lead.
    this.favicons = new FaviconCache(
      path.join(dataDir, "Favicons"),
      async (url, init) => {
        await this.whenConnected(this.session);
        return this.session.fetch(url, init);
      },
      {
        probe: async (url) => {
          await this.whenConnected(this.session);
          return probePage(this.session, url);
        },
        probes: (url) => this.bookmarks.isBookmarked(url),
      },
    );
    this.siteProfiles = new SiteProfileStore(dataDir);
    this.semanticIndex = new SemanticIndexStore(dataDir);
    this.credentials = new CredentialVault(dataDir, cipher);
    this.keepass = new KeePassStore(dataDir, cipher);
    this.autoSignIn = new AutoSignInStore(dataDir);
    this.backup = new BackupStore(dataDir);
    const vaultLogins = vaultProvider(this.credentials);
    const keepassLogins = this.keepass.provider();
    this.logins = new LoginSources(() => [vaultLogins, keepassLogins]);
    this.extensions = new ExtensionHost(profile.id, this.session, dataDir, delegate);
    // chrome.bookmarks and chrome.history for extensions, over this profile's stores.
    registerExtensionApis(this.extensions, this.bookmarks, this.history);
    if (delegate.tabGroups) registerTabGroupApis(this.extensions, delegate.tabGroups(profile.id));
    if (delegate.sessions) registerSessionApis(this.extensions, delegate.sessions(profile.id));
    if (delegate.sidePanels) registerSidePanelApis(this.extensions, delegate.sidePanels(profile.id));
    if (delegate.downloads) registerDownloadApis(this.extensions, delegate.downloads(profile.id));
    registerCommandApis(this.extensions, process.platform);
    this.adblock = new AdblockController(dataDir);
    this.containers = new ContainerStore(dataDir);
    // Extensions that filter requests keep doing it unless the built-in blocker, whose own
    // listeners already take that from them, is on.
    const syncClientHints = (): void => setClientHints(this.adblock.settings().enabled || !this.extensions.filtersRequests());
    syncClientHints();
    this.adblock.onChange(syncClientHints);
    this.extensions.onChange(syncClientHints);
  }

  /**
   * The session of a container's tabs, set up on first use like the profile's own (user agent,
   * corvus:// pages, site permissions); services that hook sessions follow `onContainerSession`.
   * Extensions are the profile session's own and do not run in container tabs.
   */
  containerSession(containerId: string): Session {
    const known = this.containerSessions.get(containerId);
    if (known) return known;
    const ses = electronSession.fromPartition(containerPartition(this.partition, containerId));
    this.connect(ses, containerChoice(this.connections.config(), containerId));
    clientHints(ses, this.gpcOn)(true);
    handleInternalProtocol(ses);
    this.permissions.install(ses);
    this.containerSessions.set(containerId, ses);
    for (const listener of this.containerSessionListeners) listener(ses);
    return ses;
  }

  /** Puts the profile's and its containers' sessions on their connection (proxy, PAC or direct). */
  private applyConnections(): void {
    const config = this.connections.config();
    this.connect(this.session, config.profile);
    for (const [id, ses] of this.containerSessions) this.connect(ses, containerChoice(config, id));
    if (this.privateSes) this.connect(this.privateSes, config.profile);
    for (const wc of allWebContents.getAllWebContents()) if (this.ownsSession(wc.session)) wc.setWebRTCIPHandlingPolicy(this.webrtcPolicy(wc.session));
  }

  private connect(ses: Session, choice: ConnectionChoice): void {
    const config = this.connections.config();
    // A session nobody changed already uses the system's settings: nothing to apply or wait for.
    if (choice.mode === "system" && config.rules.length === 0 && !this.proxied.has(ses)) {
      this.connecting.delete(ses);
      this.connected.add(ses);
      return;
    }
    this.proxied.add(ses);
    const done = applyConnection(ses, choice, config)
      .catch(() => undefined)
      .then(() => {
        if (this.connecting.get(ses) === done) this.connected.add(ses);
      });
    this.connected.delete(ses);
    this.connecting.set(ses, done);
  }

  /** Whether a session already uses its connection (a tab can start loading at once). */
  isConnected(ses: Session): boolean {
    return this.connected.has(ses) || !this.ownsSession(ses);
  }

  /** Resolves once a session uses its latest connection. */
  whenConnected(ses: Session): Promise<void> {
    return this.connecting.get(ses) ?? Promise.resolve();
  }

  /** The connection a session of this profile takes (the profile's, or its container's). */
  choiceFor(ses: Session): ConnectionChoice {
    const config = this.connections.config();
    for (const [id, s] of this.containerSessions) if (s === ses) return containerChoice(config, id);
    return config.profile;
  }

  /** WebRTC for pages of a session: through the proxy only when the profile protects it. */
  webrtcPolicy(ses: Session): "default" | "disable_non_proxied_udp" {
    return webrtcPolicy(this.choiceFor(ses), this.connections.config());
  }

  /** The sign-in of one of this profile's proxies, when it has one. */
  proxyCredentials(host: string, port: number): { username: string; password: string } | null {
    const proxy = this.connections.proxyAt(host, port);
    if (!proxy?.username) return null;
    return { username: proxy.username, password: this.connections.password(proxy.id) ?? "" };
  }

  /**
   * The session of this profile's private windows: in memory only (nothing of it reaches the disk),
   * shared by the private windows open at the same time and dropped when the last one closes.
   * It connects like the profile; extensions do not run in it.
   */
  privateSession(): Session {
    if (this.privateSes) return this.privateSes;
    // No "persist:" prefix: Chromium keeps cookies, storage and cache in memory.
    const ses = electronSession.fromPartition(`corvus-private-${this.profile.id}-${++this.privateRuns}-${Date.now()}`, { cache: false });
    this.privateSes = ses;
    this.connect(ses, this.connections.config().profile);
    clientHints(ses, this.gpcOn)(true);
    handleInternalProtocol(ses);
    this.permissions.install(ses);
    for (const listener of this.containerSessionListeners) listener(ses);
    return ses;
  }

  isPrivateSession(ses: Session): boolean {
    return ses === this.privateSes;
  }

  /** The last private window closed: what its session held is wiped. */
  async endPrivateSession(): Promise<void> {
    const ses = this.privateSes;
    if (!ses) return;
    this.privateSes = null;
    this.connecting.delete(ses);
    this.connected.delete(ses);
    this.proxied.delete(ses);
    await ses.clearStorageData().catch(() => undefined);
    await ses.clearCache().catch(() => undefined);
    await ses.clearAuthCache().catch(() => undefined);
  }

  /** Calls `listener` for every container session, now and as they are created. */
  onContainerSession(listener: (session: Session) => void): void {
    this.containerSessionListeners.add(listener);
    for (const ses of this.containerSessions.values()) listener(ses);
  }

  /** Whether `session` is this profile's own or one of its containers'. */
  ownsSession(session: Session): boolean {
    return session === this.session || session === this.privateSes || [...this.containerSessions.values()].includes(session);
  }

  /** Deletes everything a container's session holds (cookies, storage, cache). */
  async clearContainer(containerId: string): Promise<void> {
    const ses = this.containerSessions.get(containerId) ?? electronSession.fromPartition(containerPartition(this.partition, containerId));
    await ses.clearStorageData().catch(() => undefined);
    await ses.clearCache().catch(() => undefined);
  }

  flush(): void {
    this.connections.flush();
    this.bookmarks.flush();
    this.history.flush();
    this.workspaces.flush();
    this.siteSearch.flush();
    this.reading.flush();
    this.annotations.flush();
    this.agentRuns.flush();
    this.assistHistory.flush();
    this.commands.flush();
    this.userMemory.flush();
    this.siteProfiles.flush();
    this.semanticIndex.flush();
    this.credentials.flush();
    this.keepass.flush();
    this.autoSignIn.flush();
    this.backup.flush();
    this.siteSettings.flush();
    this.adblock.flush();
    this.containers.flush();
  }
}

export class ProfileRegistry {
  private readonly runtimes = new Map<ProfileId, ProfileRuntime>();
  private delegate: ProfileDelegate | null = null;
  private readonly createdListeners = new Set<(runtime: ProfileRuntime) => void>();

  constructor(
    readonly manager: ProfileManager,
    private readonly cipher: SecretCipher,
  ) {}

  setDelegate(delegate: ProfileDelegate): void {
    this.delegate = delegate;
  }

  /** Called once for every profile runtime as it is created (sessions are created lazily). */
  onCreated(listener: (runtime: ProfileRuntime) => void): void {
    this.createdListeners.add(listener);
    for (const runtime of this.runtimes.values()) listener(runtime);
  }

  list(): Profile[] {
    return this.manager.list();
  }

  get(id: ProfileId): ProfileRuntime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      if (!this.delegate) throw new Error("ProfileRegistry used before the window layer was attached");
      runtime = new ProfileRuntime(this.manager.require(id), this.manager.dataDir(id), this.delegate, this.cipher);
      this.runtimes.set(id, runtime);
      for (const listener of this.createdListeners) listener(runtime);
    }
    return runtime;
  }

  loaded(): ProfileRuntime[] {
    return [...this.runtimes.values()];
  }

  bySession(session: Session): ProfileRuntime | undefined {
    return this.loaded().find((r) => r.ownsSession(session));
  }

  create(name: string): Profile {
    return this.manager.create(name);
  }

  rename(id: ProfileId, name: string): Profile {
    const profile = this.manager.rename(id, name);
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.profile = profile;
    return profile;
  }

  setMeta(id: ProfileId, meta: { name: string; avatar?: string }): Profile {
    const profile = this.manager.setMeta(id, meta);
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.profile = profile;
    return profile;
  }

  setSyncChain(id: ProfileId, chainId: string | undefined): void {
    this.manager.setSyncChain(id, chainId);
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.profile = this.manager.require(id);
  }

  /** Caller must close the profile's windows first. */
  async remove(id: ProfileId): Promise<void> {
    const runtime = this.runtimes.get(id);
    const ses = runtime?.session ?? electronSession.fromPartition(ProfileManager.partition(id));
    await ses.clearStorageData();
    await ses.clearCache();
    runtime?.flush();
    runtime?.keepass.dispose();
    this.runtimes.delete(id);
    this.manager.remove(id);
  }

  flush(): void {
    for (const runtime of this.runtimes.values()) runtime.flush();
  }
}
