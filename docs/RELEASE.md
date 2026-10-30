# Releasing Corvus

Everything to cut an auto-updating release. Releases live on [github.com/ParendumOU/Corvus](https://github.com/ParendumOU/Corvus): **GitHub Releases** hold the installers, `SHA256SUMS.txt` and the electron-updater feed (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`). The repo root is also the Claude Code plugin marketplace (`.claude-plugin/marketplace.json` -> `integrations/claude-code`).

The website (https://corvus.parendum.com) links to `https://github.com/ParendumOU/Corvus/releases/download/v<version>/<file>` with exactly these names: `Corvus-Setup-<v>.exe`, `Corvus-Portable-<v>.exe`, `Corvus-<v>-x86_64.AppImage`, `corvus_<v>_amd64.deb` (`test/update-feed.test.ts` pins the patterns in `electron-builder.yml`).

Current: `v0.32.6` (Windows + Linux unsigned, macOS signed and notarized), draft. Corvus for mobile: `mobile-v0.10.0` (Android preview, pre-release), published 2026-10-29.

Previous tags: `v0.32.5`, `v0.32.4`, `v0.32.3`, `v0.32.2`, `v0.32.1`, `v0.32.0`, `v0.31.0`, `v0.30.0`, `v0.29.0`, `v0.28.0`, `v0.27.0`, `v0.26.1`, `v0.26.0`, `v0.25.1`, `v0.25.0`, `v0.24.0`, `v0.23.0`, `v0.22.0`, `v0.21.1`, `v0.21.0`, `v0.20.2`, `v0.20.1`, `v0.20.0`, `v0.19.0`, `v0.18.0`, `v0.17.0`, `v0.16.0`, `v0.15.0`, `v0.14.0`, `v0.13.0`, `v0.12.0`, `v0.11.0`, `v0.10.0`, `v0.9.0`, `v0.8.0`, `v0.7.0`, `v0.6.0`, `v0.5.0`, `v0.4.2`, `v0.4.1`, `v0.4.0`, `v0.3.4`, `v0.3.3`, `v0.3.2`, `v0.3.1`, `v0.3.0`, `v0.2.0`, `v0.1.1`.

---

## Credentials

Everything that talks to GitHub uses the token of the gh account **ParendumOU**, read inside the scripts with `gh auth token -u ParendumOU` (the account stays logged in but does not need to be the active one). It reaches git as an in-process `http.extraHeader` and gh / electron-builder as the `GH_TOKEN` environment variable. It is never printed, written to a file, put in a remote URL or committed. One-time setup on a machine: `gh auth login` as ParendumOU, then switch the active account back with `gh auth switch` if needed.

Every commit that goes to a ParendumOU GitHub repo uses one identity as **both author and committer**: `Parendum <295081442+ParendumOU@users.noreply.github.com>`. Set it per command, never in your global git config, and check it before pushing:

```sh
GIT_AUTHOR_NAME=Parendum GIT_AUTHOR_EMAIL=295081442+ParendumOU@users.noreply.github.com \
GIT_COMMITTER_NAME=Parendum GIT_COMMITTER_EMAIL=295081442+ParendumOU@users.noreply.github.com \
git commit ...
git log -1 --format='%an <%ae> | %cn <%ce>'
```

The release scripts never force-push; rewriting a public history is a deliberate manual step.

## How installed apps find updates

- `apps/desktop/electron-builder.yml` `publish:` is `provider: github`, `owner: ParendumOU`, `repo: Corvus`, `releaseType: draft`. It is baked into `app-update.yml` and tells `--publish always` where to upload.
- At runtime `UpdateService` (`src/main/update-service.ts`) calls `autoUpdater.setFeedURL` on every check with `resolveUpdateFeed()` from `src/shared/update-feed.ts`:
  - Settings > Updates > feed URL **blank** (default): `{ provider: "github", owner: "ParendumOU", repo: "Corvus" }`. electron-updater reads `github.com/ParendumOU/Corvus/releases.atom` and `releases/latest`, then `latest*.yml` from that release. No token, no API rate limit.
  - feed URL **set** (or `CORVUS_UPDATE_FEED_URL`): a self-hosted electron-builder `generic` feed.
  - Stable sees only the latest published, non-prerelease release; Beta also sees prereleases (tag `v0.3.0-beta.1` etc.). **Drafts are invisible** to every installed app.
  - Downgrades are only offered when a pre-release build switches to Stable (electron-updater's `channel` setter would otherwise allow them for everyone).
- Only packaged builds check (`app.isPackaged`); dev and smoke never touch the network.
- macOS auto-update (Squirrel.Mac) only works for **signed** builds; unsigned Macs must update by hand.

## How a Windows update installs (in place, pins kept)

- **Installed (NSIS)**: Restart to update runs the downloaded Corvus-Setup silently (`quitAndInstall(true, true)`, so `--updated /S --force-run`): no installer wizard, the new files replace the old ones in the same folder, Corvus starts again from the Start menu shortcut. electron-builder runs the old uninstaller with `--keep-shortcuts --updated`, so the Start menu and desktop shortcuts are the same files afterwards and taskbar/Start pins stay. The profile (`%APPDATA%\Corvus`) is never touched.
- **Setup run by hand** over an install does the same: electron-builder only keeps shortcuts for `--updated` when `allowToChangeInstallationDirectory` is on, and otherwise unpins Corvus (`WinShell::UninstShortcut`, `UninstAppUserModelId`) and makes new shortcuts. `customHeader` in `apps/desktop/build/installer.nsh` undefines that flag after the folder page is built, so the page stays and the shortcuts are kept whenever `Corvus.exe` is already in the chosen folder (another folder still gets new shortcuts).
- **App ID**: pins belong to the Application User Model ID. The installer gives its shortcuts the `appId` (`com.parendum.corvus`), and the app sets the same one (`WINDOWS_APP_ID` in `src/shared/taskbar-identity.ts`, checked against `electron-builder.yml` by `test/taskbar-identity.test.ts`) on the process and on every window (`src/main/taskbar.ts`). Never change `appId`, `productName` or the executable name: the next update would leave every pin pointing at nothing.
- **Portable**: downloads the next `Corvus-Portable-<v>.exe` to `%LOCALAPPDATA%\corvus-portable-update`, checks it against `SHA256SUMS.txt`, and after Corvus quits writes it into the running copy's own file (same name, folder, NTFS file ID and desktop position), then starts it. If the file stays locked for a minute, the old bytes are put back and the old copy starts. The portable launcher runs Corvus from `%TEMP%\<per-build id>`, deleted when Corvus quits, so its windows (ID `com.parendum.corvus.portable`) name the portable file as what a taskbar pin starts.
- **Checked on Windows 11** (2026-10-29) with test-identity builds (another `appId` and `productName`, installed with `/S /D=<scratch folder>`): `--updated /S` and a plain `/S` over the install keep both `.lnk` files (same NTFS file IDs; before this change the plain run recreated them), another folder recreates them for the new path, and the windows carry the shortcuts' app ID; the portable swap keeps the file ID. Taskbar pinning itself cannot be scripted on Windows 11: that pins follow is inferred from the kept shortcuts and app ID.

---

## Blockers (external, needed before a *trusted* public release)

| # | What | Why | Status |
|---|------|-----|--------|
| 1 | **Windows code-signing cert** | Without it, SmartScreen warns on every install | deferred: unsigned for now (2026-10-26) |
| 2 | ~~**Apple Developer ID** + a Mac as build host~~ | `.dmg` can only be built on macOS; signing + notarization need the ID | done: signed + notarized universal `.dmg` since v0.27.0, built on the Mac build host (2026-10-26) |
| 3 | ~~Update-feed host~~ | Solved: GitHub Releases of ParendumOU/Corvus | done |

None block **unsigned** Windows/Linux releases: those work today. See `docs/CODE-SIGNING.md`. Signing: `scripts/release.sh` reads `CSC_LINK` + `CSC_KEY_PASSWORD` and signs when they are set; `scripts/publish-release.sh` passes them through.

---

## Claude Code plugin

The repo root is a Claude Code plugin marketplace. Users install with:

```
/plugin marketplace add ParendumOU/Corvus
/plugin install corvus@corvus
```

The plugin runs the committed bundle `integrations/claude-code/mcp/corvus-mcp-stdio.mjs`, so it must match the release: `docker compose run --rm dev pnpm --filter @corvus/mcp-server run bundle:bridge` and commit it if it changed (it also rewrites `mcp/THIRD_PARTY_NOTICES.md`).

The MCP connector for other clients, [ParendumOU/Corvus-MCP](https://github.com/ParendumOU/Corvus-MCP) (MIT), is generated from this repo: the same bundle and plugin, plus `integrations/mcp-connector/` (README with client setups, LICENSE, marketplace). Regenerate it into a clone of that repo with `node scripts/build-mcp-connector.mjs <clone> --commit` (rebuilds the bundle in Docker, validates the plugin, commits as the Parendum identity, never pushes), review, then push.

---

## Cutting a release (`scripts/publish-release.sh`)

Run from the repo root on a host with Docker and gh.

1. **Green check**: `bash scripts/validate-docker.sh` (`-p corvus-wt-<x>` in a worktree) runs `scripts/validate.sh` in the dev container (build, typecheck, tests and smoke) and must end in `VALIDATION: OK`. It records a fingerprint of the code after each pass (docs, Markdown and the `"version"` lines left out), so the release commit, which only bumps versions and edits CHANGELOG and docs, reuses the pass its code already had instead of running it again (about 6 minutes saved). `CORVUS_VALIDATE_FULL=1` forces a full run; the plain `docker compose run --rm dev sh scripts/validate.sh` always runs everything.
2. **Version + changelog**: set the version in `apps/desktop/package.json` (and the root `package.json`), move the shipped features from ROADMAP into a new `## v<version>` section of CHANGELOG.md, commit. The script refuses if the package version differs or the tree is dirty.
3. **Plugin**: rebuild the bridge bundle (see above) and commit it if it changed.
4. **Windows + Linux to a draft**:
   ```sh
   scripts/publish-release.sh 0.2.0
   # signed: CSC_LINK=.secrets/corvus.pfx CSC_KEY_PASSWORD=... scripts/publish-release.sh 0.2.0
   ```
   Runs the Docker builder (`scripts/release.sh win linux` with `CORVUS_PUBLISH=always` and `GH_TOKEN`), so electron-builder creates the **draft** release `v0.2.0` on ParendumOU/Corvus (or reuses an existing draft) and uploads the installers, blockmaps, `latest.yml` and `latest-linux.yml`. Then it downloads every asset of the draft, checks the four website file names and both feed files are there, and uploads `SHA256SUMS.txt` (`gh release upload --clobber`). It refuses to touch a tag that is already published.
5. **macOS on a Mac** (same draft). The release script does this on its own: it sends the release commit to the Mac build host (reached over SSH), which builds a universal `.dmg` + `.zip`, signs them with the Developer ID and notarizes them with the App Store Connect API key; the files come back, go into the draft, and `SHA256SUMS.txt` is rebuilt. The signing files live on that Mac only in `~/corvus-secrets`. On macOS 27 electron-builder cannot unlock its own temporary keychain over SSH, so the build imports the `.p12` into a keychain of its own and passes it as `CSC_KEYCHAIN`. By hand, on any Mac, from the same commit:
   ```sh
   # unsigned: release.sh sets CSC_IDENTITY_AUTO_DISCOVERY=false when CSC_LINK is not set
   # signed + notarized: also export the variables in ../secrets/apple-signing.env: CSC_LINK and
   #   CSC_KEY_PASSWORD (Developer ID Application .p12), APPLE_API_KEY (the .p8 path),
   #   APPLE_API_KEY_ID, APPLE_API_ISSUER and APPLE_TEAM_ID (App Store Connect API key notarization)
   CORVUS_PUBLISH=always GH_TOKEN="$(gh auth token -u ParendumOU)" bash scripts/release.sh mac
   scripts/publish-release.sh 0.2.0 --checksums-only
   ```
   electron-builder finds the draft by tag and adds `Corvus-<v>.dmg`, the mac `.zip` (needed by the updater), their blockmaps and `latest-mac.yml`; `--checksums-only` rebuilds `SHA256SUMS.txt` over all assets including the mac ones. An Apple Silicon Mac builds arm64 only this way; the release script builds `--universal` (Apple Silicon and Intel in one download).
6. **Review the draft** at https://github.com/ParendumOU/Corvus/releases: install from the draft assets on a clean machine, check `SHA256SUMS.txt`, write the release notes.
7. **Publish** the draft in the GitHub web UI (or `GH_TOKEN="$(gh auth token -u ParendumOU)" gh release edit v0.2.0 -R ParendumOU/Corvus --draft=false`). GitHub creates the tag `v0.2.0` on public `main`; the website links and every installed app's update check see it from this moment.
8. **Tag the source**: `git tag v0.2.0 && git push origin v0.2.0` (CI also builds the packages on tags, without publishing). **No attribution lines** (project rule).
9. **Verify auto-update** from the previous installed version (first possible with the release after v0.2.0, since earlier builds pointed at the placeholder feed).

## Corvus for mobile releases

The Android app (`apps/mobile`) is released from the same repo as a **pre-release** tagged `mobile-v<version>`, never marked latest: stable desktop apps read the latest release, and from v0.11.0 on the beta channel skips non-desktop tags (`newestDesktopTag` in `src/shared/update-feed.ts`). Beta installs of v0.10.0 and earlier take the newest entry of the releases feed whatever it is, so they report an update error while a mobile release is newer than every desktop release: when both ship together, make the desktop release the newer one (its target commit comes after the mobile release's).

1. Bump `apps/mobile/package.json` and `apps/mobile/app.json` (`expo.version`, and `android.versionCode` + 1 with `ios.buildNumber` the same).
2. Checks in Docker: `typecheck`, `test`, `export:web` and `smoke:web` of `@corvus/mobile` (the smoke needs the `sync-server` service and `CORVUS_SYNC_URL`).
3. Signed APK: `docker compose --profile android run --rm --build android` (`--build` keeps the toolchain image in step with `docker/Dockerfile.android`), with the release key mounted from `../secrets` (`corvus-mobile.keystore` and `corvus-mobile-keystore.env`, never in a repository). It prints the APK's SHA-256. Losing the key means later versions cannot install over earlier ones: keep a backup of it off this machine. The same run builds the App Bundle for Google Play. Install the APK on a phone and open it before shipping (`adb install -r`): 0.3.0 and 0.4.0 closed at start-up and nothing caught it.
4. The target is a public commit with this version's `apps/mobile` sources.
5. `gh release create mobile-v<v> -R ParendumOU/Corvus --prerelease --latest=false --target <public SHA> --title "Corvus for mobile <v>" --notes-file <notes>` with `corvus-mobile-<v>.apk` and `SHA256SUMS.txt`.
6. Google Play internal testing: `docker compose --profile android run --rm --no-deps --entrypoint node android apps/mobile/scripts/play-upload.mjs --notes "<text>"` uploads the bundle and releases it to testers through the Google Play Developer API, with the service account in `../secrets/google-play-service-account.json` (project `corvus-512818`, invited in Play Console with "Release apps to testing tracks"). A version code already on Play is skipped.
7. iOS for TestFlight: `ios-release.sh <v> <commit> <repo>` (next to the release script) builds the app on the Mac build host, signs it for the App Store with the Apple Distribution certificate, uploads it to App Store Connect and waits until it is processed; see "iOS builds (TestFlight)" in `MOBILE.md`. `ios.buildNumber` in `app.json` must equal `android.versionCode` and be new for App Store Connect.

The release script (`publish-release.ps1 <v> -MobileVersion <m>`) runs steps 3, 5, 6 and 7 (`-NoIos` skips 7, which it waits for at the very end).

## Release checklist
- [ ] All tests + smoke green on the commit being released
- [ ] Version bumped, CHANGELOG updated, committed
- [ ] Bridge bundle current (`bundle:bridge` produces no diff)
- [ ] `scripts/publish-release.sh <v>` done; draft has the 4 installers, `latest.yml`, `latest-linux.yml`, `SHA256SUMS.txt`
- [ ] macOS assets + `latest-mac.yml` added and checksums regenerated (if shipping mac)
- [ ] Windows build **signed** (once the cert exists); macOS **notarized** (once the ID exists)
- [ ] Draft reviewed and installed from, then published
- [ ] Source tagged `v<v>`
- [ ] Auto-update verified from the previous version (Windows: no installer window, Corvus restarts, pins and shortcuts stay)
- [ ] No `Co-Authored-By` / "Generated with" lines anywhere
