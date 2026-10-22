import { session as electronSession, type Session } from "electron";
import type { Profile, ProfileId } from "@corvus/shared";
import { AdblockController } from "./adblock";
import { AnnotationStore } from "./annotation-store";
import { CredentialVault } from "./credential-store";
import { ExtensionHost, type ExtensionWindowDelegate } from "./extensions";
import { PermissionManager, type PermissionHost } from "./permissions";
import { AgentRunStore } from "./agent-run-store";
import { ProfileManager } from "./profile-manager";
import { handleInternalProtocol } from "./protocol";
import { ReadingStore } from "./reading-store";
import { SemanticIndexStore } from "./semantic-index-store";
import { SiteProfileStore } from "./site-profile-store";
import type { SecretCipher } from "./settings-store";
import { SiteSettingsStore } from "./site-settings";
import { BookmarkStore, HistoryStore } from "./stores";
import { WorkspaceStore } from "./workspace-store";

/** What a profile runtime needs from the window layer (implemented by WindowManager). */
export type ProfileDelegate = ExtensionWindowDelegate & PermissionHost;

/** Strip the Electron and app tokens so sites (and the Chrome Web Store) see a regular Chrome UA. */
export function chromeUserAgent(ua: string): string {
  return ua.replace(/\s(?:Electron|Corvus|corvus|@corvus\/desktop)\/\S+/g, "");
}

/** Everything that exists once per profile: session partition, stores and extensions. */
export class ProfileRuntime {
  readonly partition: string;
  readonly session: Session;
  readonly bookmarks: BookmarkStore;
  readonly history: HistoryStore;
  readonly workspaces: WorkspaceStore;
  readonly reading: ReadingStore;
  readonly annotations: AnnotationStore;
  readonly agentRuns: AgentRunStore;
  readonly siteProfiles: SiteProfileStore;
  readonly semanticIndex: SemanticIndexStore;
  readonly credentials: CredentialVault;
  readonly extensions: ExtensionHost;
  readonly siteSettings: SiteSettingsStore;
  readonly permissions: PermissionManager;
  readonly adblock: AdblockController;

  constructor(
    public profile: Profile,
    readonly dataDir: string,
    delegate: ProfileDelegate,
    cipher: SecretCipher,
  ) {
    this.partition = ProfileManager.partition(profile.id);
    this.session = electronSession.fromPartition(this.partition);
    this.session.setUserAgent(chromeUserAgent(this.session.getUserAgent()));
    handleInternalProtocol(this.session);
    this.siteSettings = new SiteSettingsStore(dataDir);
    this.permissions = new PermissionManager(this.siteSettings, delegate);
    this.permissions.install(this.session);
    this.bookmarks = new BookmarkStore(dataDir);
    this.history = new HistoryStore(dataDir);
    this.workspaces = new WorkspaceStore(dataDir);
    this.reading = new ReadingStore(dataDir);
    this.annotations = new AnnotationStore(dataDir);
    this.agentRuns = new AgentRunStore(dataDir);
    this.siteProfiles = new SiteProfileStore(dataDir);
    this.semanticIndex = new SemanticIndexStore(dataDir);
    this.credentials = new CredentialVault(dataDir, cipher);
    this.extensions = new ExtensionHost(profile.id, this.session, dataDir, delegate);
    this.adblock = new AdblockController(dataDir);
  }

  flush(): void {
    this.bookmarks.flush();
    this.history.flush();
    this.workspaces.flush();
    this.reading.flush();
    this.annotations.flush();
    this.agentRuns.flush();
    this.siteProfiles.flush();
    this.semanticIndex.flush();
    this.credentials.flush();
    this.siteSettings.flush();
    this.adblock.flush();
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
    return this.loaded().find((r) => r.session === session);
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
    this.runtimes.delete(id);
    this.manager.remove(id);
  }

  flush(): void {
    for (const runtime of this.runtimes.values()) runtime.flush();
  }
}
