import { app, session as electronSession, type Session } from "electron";
import type { Profile, ProfileId } from "@corvus/shared";
import { AdblockController } from "./adblock";
import { AnnotationStore } from "./annotation-store";
import { AutoSignInStore } from "./auto-sign-in-store";
import { containerPartition } from "../shared/containers";
import { ContainerStore } from "./containers";
import { CredentialVault } from "./credential-store";
import { ExtensionHost, type ExtensionWindowDelegate } from "./extensions";
import { KeePassStore } from "./keepass-store";
import { LoginSources, vaultProvider } from "./login-sources";
import { PermissionManager, type PermissionHost } from "./permissions";
import { AgentRunStore } from "./agent-run-store";
import { CommandHistoryStore } from "./command-history-store";
import { ProfileManager } from "./profile-manager";
import { handleInternalProtocol } from "./protocol";
import { ReadingStore } from "./reading-store";
import { SemanticIndexStore } from "./semantic-index-store";
import { SiteProfileStore } from "./site-profile-store";
import type { SecretCipher } from "./settings-store";
import { SiteSettingsStore } from "./site-settings";
import { BookmarkStore, HistoryStore } from "./stores";
import { chromeUserAgent, clientHintHeaders, electronUserAgent, type ClientHints, type UserAgents } from "./user-agent";
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
 * values its own subresource requests carry once one has been seen. Returns a switch, since the
 * listener costs extensions their request filtering (see ExtensionHost.filtersRequests).
 */
function clientHints(ses: Session): (on: boolean) => void {
  let hints: ClientHints = clientHintHeaders(Number(process.versions.chrome.split(".")[0]), process.platform);
  let installed = false;
  return (on) => {
    if (on === installed) return;
    installed = on;
    if (!on) {
      ses.webRequest.onBeforeSendHeaders(null);
      return;
    }
    ses.webRequest.onBeforeSendHeaders({ urls: ["https://*/*"] }, (details, callback) => {
      const headers = details.requestHeaders;
      const seen = headers["sec-ch-ua"];
      if (seen) {
        hints = { "sec-ch-ua": seen, "sec-ch-ua-mobile": headers["sec-ch-ua-mobile"] ?? hints["sec-ch-ua-mobile"], "sec-ch-ua-platform": headers["sec-ch-ua-platform"] ?? hints["sec-ch-ua-platform"] };
        callback({ requestHeaders: headers });
      } else if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
        // First, where Chromium puts them on its own navigations.
        callback({ requestHeaders: { ...hints, ...headers } });
      } else {
        callback({ requestHeaders: headers });
      }
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
  /** What the person ran from the Command Bar (its "Recent" list). */
  readonly commands: CommandHistoryStore;
  readonly siteProfiles: SiteProfileStore;
  readonly semanticIndex: SemanticIndexStore;
  readonly credentials: CredentialVault;
  /** KeePass databases (read-only; off until the person adds one). */
  readonly keepass: KeePassStore;
  /** Logins the person chose to sign in with automatically (always confirmed first). */
  readonly autoSignIn: AutoSignInStore;
  /** Every login source of this profile (built-in vault, KeePass) behind one matcher. */
  readonly logins: LoginSources;
  readonly extensions: ExtensionHost;
  readonly siteSettings: SiteSettingsStore;
  readonly permissions: PermissionManager;
  readonly adblock: AdblockController;
  /** Chrome UA for sites, Electron's for Google sign-in (see user-agent.ts). */
  readonly userAgents: UserAgents;
  /** Containers: tabs with their own cookies and site data, each in a session of its own. */
  readonly containers: ContainerStore;
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
    this.userAgents = installUserAgents();
    const setClientHints = clientHints(this.session);
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
    this.commands = new CommandHistoryStore(dataDir);
    this.siteProfiles = new SiteProfileStore(dataDir);
    this.semanticIndex = new SemanticIndexStore(dataDir);
    this.credentials = new CredentialVault(dataDir, cipher);
    this.keepass = new KeePassStore(dataDir, cipher);
    this.autoSignIn = new AutoSignInStore(dataDir);
    const vaultLogins = vaultProvider(this.credentials);
    const keepassLogins = this.keepass.provider();
    this.logins = new LoginSources(() => [vaultLogins, keepassLogins]);
    this.extensions = new ExtensionHost(profile.id, this.session, dataDir, delegate);
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
    clientHints(ses)(true);
    handleInternalProtocol(ses);
    this.permissions.install(ses);
    this.containerSessions.set(containerId, ses);
    for (const listener of this.containerSessionListeners) listener(ses);
    return ses;
  }

  /** Calls `listener` for every container session, now and as they are created. */
  onContainerSession(listener: (session: Session) => void): void {
    this.containerSessionListeners.add(listener);
    for (const ses of this.containerSessions.values()) listener(ses);
  }

  /** Whether `session` is this profile's own or one of its containers'. */
  ownsSession(session: Session): boolean {
    return session === this.session || [...this.containerSessions.values()].includes(session);
  }

  /** Deletes everything a container's session holds (cookies, storage, cache). */
  async clearContainer(containerId: string): Promise<void> {
    const ses = this.containerSessions.get(containerId) ?? electronSession.fromPartition(containerPartition(this.partition, containerId));
    await ses.clearStorageData().catch(() => undefined);
    await ses.clearCache().catch(() => undefined);
  }

  flush(): void {
    this.bookmarks.flush();
    this.history.flush();
    this.workspaces.flush();
    this.siteSearch.flush();
    this.reading.flush();
    this.annotations.flush();
    this.agentRuns.flush();
    this.commands.flush();
    this.siteProfiles.flush();
    this.semanticIndex.flush();
    this.credentials.flush();
    this.keepass.flush();
    this.autoSignIn.flush();
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
