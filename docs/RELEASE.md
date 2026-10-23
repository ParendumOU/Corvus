# Releasing Corvus

Everything to cut an auto-updating release. Releases live on
[github.com/ParendumOU/Corvus](https://github.com/ParendumOU/Corvus): **GitHub Releases** hold the
installers, `SHA256SUMS.txt` and the electron-updater feed (`latest.yml`, `latest-linux.yml`,
`latest-mac.yml`). The repo root is also the Claude Code plugin marketplace
(`.claude-plugin/marketplace.json` -> `integrations/claude-code`).

The website (https://corvus.parendum.com) links to
`https://github.com/ParendumOU/Corvus/releases/download/v<version>/<file>` with exactly these names:
`Corvus-Setup-<v>.exe`, `Corvus-Portable-<v>.exe`, `Corvus-<v>-x86_64.AppImage`,
`corvus_<v>_amd64.deb` (`test/update-feed.test.ts` pins the patterns in `electron-builder.yml`).

Current: `v0.3.4` (Windows + Linux, unsigned), published 2026-10-23 on ParendumOU/Corvus.
Previous tags: `v0.3.3`, `v0.3.2`, `v0.3.1`, `v0.3.0`, `v0.2.0`, `v0.1.1`.

---

## Credentials

Everything that talks to GitHub uses the token of the gh account **ParendumOU**, read inside the
scripts with `gh auth token -u ParendumOU` (the account stays logged in but does not need to be the
active one). It reaches git as an in-process `http.extraHeader` and gh / electron-builder as the
`GH_TOKEN` environment variable. It is never printed, written to a file, put in a remote URL or
committed. One-time setup on a machine: `gh auth login` as ParendumOU, then switch the active
account back with `gh auth switch` if needed.

Every commit that goes to a ParendumOU GitHub repo uses one identity as **both author and
committer**: `Parendum <295081442+ParendumOU@users.noreply.github.com>`. Set it per command, never
in your global git config, and check it before pushing:

```sh
GIT_AUTHOR_NAME=Parendum GIT_AUTHOR_EMAIL=295081442+ParendumOU@users.noreply.github.com \
GIT_COMMITTER_NAME=Parendum GIT_COMMITTER_EMAIL=295081442+ParendumOU@users.noreply.github.com \
git commit ...
git log -1 --format='%an <%ae> | %cn <%ce>'
```

The release scripts never force-push; rewriting a public history is a deliberate manual step.

## How installed apps find updates

- `apps/desktop/electron-builder.yml` `publish:` is `provider: github`, `owner: ParendumOU`,
  `repo: Corvus`, `releaseType: draft`. It is baked into `app-update.yml` and tells
  `--publish always` where to upload.
- At runtime `UpdateService` (`src/main/update-service.ts`) calls `autoUpdater.setFeedURL` on every
  check with `resolveUpdateFeed()` from `src/shared/update-feed.ts`:
  - Settings > Updates > feed URL **blank** (default): `{ provider: "github", owner: "ParendumOU",
    repo: "Corvus" }`. electron-updater reads `github.com/ParendumOU/Corvus/releases.atom` and
    `releases/latest`, then `latest*.yml` from that release. No token, no API rate limit.
  - feed URL **set** (or `CORVUS_UPDATE_FEED_URL`): a self-hosted electron-builder `generic` feed.
  - Stable sees only the latest published, non-prerelease release; Beta also sees prereleases
    (tag `v0.3.0-beta.1` etc.). **Drafts are invisible** to every installed app.
  - Downgrades are only offered when a pre-release build switches to Stable (electron-updater's
    `channel` setter would otherwise allow them for everyone).
- Only packaged builds check (`app.isPackaged`); dev and smoke never touch the network.
- macOS auto-update (Squirrel.Mac) only works for **signed** builds; unsigned Macs must update by
  hand.

---

## Blockers (external, needed before a *trusted* public release)

| # | What | Why | Status |
|---|------|-----|--------|
| 1 | **Windows code-signing cert** | Without it, SmartScreen warns on every install | none yet |
| 2 | **Apple Developer ID** + a Mac as build host | `.dmg` can only be built on macOS; signing + notarization need the ID | host yes, ID none yet |
| 3 | ~~Update-feed host~~ | Solved: GitHub Releases of ParendumOU/Corvus | done |

None block **unsigned** Windows/Linux releases: those work today. See `docs/CODE-SIGNING.md`.
Signing: `scripts/release.sh` reads `CSC_LINK` + `CSC_KEY_PASSWORD` and signs when they are set;
`scripts/publish-release.sh` passes them through.

---

## Claude Code plugin

The repo root is a Claude Code plugin marketplace. Users install with:

```
/plugin marketplace add ParendumOU/Corvus
/plugin install corvus@corvus
```

The plugin runs the committed bundle `integrations/claude-code/mcp/corvus-mcp-stdio.mjs`, so it
must match the release: `docker compose run --rm dev pnpm --filter @corvus/mcp-server run bundle:bridge`
and commit it if it changed (it also rewrites `mcp/THIRD_PARTY_NOTICES.md`).

The MCP connector for other clients, [ParendumOU/Corvus-MCP](https://github.com/ParendumOU/Corvus-MCP)
(MIT), is generated from this repo: the same bundle and plugin, plus `integrations/mcp-connector/`
(README with client setups, LICENSE, marketplace). Regenerate it into a clone of that repo with
`node scripts/build-mcp-connector.mjs <clone> --commit` (rebuilds the bundle in Docker, validates
the plugin, commits as the Parendum identity, never pushes), review, then push.

---

## Cutting a release (`scripts/publish-release.sh`)

Run from the repo root on a host with Docker and gh.

1. **Green check**:
   `docker compose run --rm dev sh -c "pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm --filter @corvus/desktop test:smoke"`.
2. **Version + changelog**: set the version in `apps/desktop/package.json` (and the root
   `package.json`), move the shipped features from ROADMAP into a new `## v<version>` section of
   CHANGELOG.md, commit. The script refuses if the package version differs or the tree is dirty.
3. **Plugin**: rebuild the bridge bundle (see above) and commit it if it changed.
4. **Windows + Linux to a draft**:
   ```sh
   scripts/publish-release.sh 0.2.0
   # signed: CSC_LINK=.secrets/corvus.pfx CSC_KEY_PASSWORD=... scripts/publish-release.sh 0.2.0
   ```
   Runs the Docker builder (`scripts/release.sh win linux` with `CORVUS_PUBLISH=always` and
   `GH_TOKEN`), so electron-builder creates the **draft** release `v0.2.0` on ParendumOU/Corvus
   (or reuses an existing draft) and uploads the installers, blockmaps, `latest.yml` and
   `latest-linux.yml`. Then it downloads every asset of the draft, checks the four website file
   names and both feed files are there, and uploads `SHA256SUMS.txt` (`gh release upload --clobber`).
   It refuses to touch a tag that is already published.
5. **macOS on a Mac** (optional, same draft). Check out the same commit, then:
   ```sh
   # unsigned: release.sh sets CSC_IDENTITY_AUTO_DISCOVERY=false when CSC_LINK is not set
   # signed + notarized: also export CSC_LINK/CSC_KEY_PASSWORD (Developer ID Application .p12),
   #   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
   CORVUS_PUBLISH=always GH_TOKEN="$(gh auth token -u ParendumOU)" bash scripts/release.sh mac
   scripts/publish-release.sh 0.2.0 --checksums-only
   ```
   electron-builder finds the draft by tag and adds `Corvus-<v>.dmg`, the mac `.zip` (needed by
   the updater), their blockmaps and `latest-mac.yml`; `--checksums-only` rebuilds
   `SHA256SUMS.txt` over all assets including the mac ones. An Apple Silicon Mac builds arm64 only; add
   `--universal` to the `mac)` line of `scripts/release.sh` to ship Intel Macs too.
6. **Review the draft** at https://github.com/ParendumOU/Corvus/releases: install from the draft
   assets on a clean machine, check `SHA256SUMS.txt`, write the release notes.
7. **Publish** the draft in the GitHub web UI (or
   `GH_TOKEN="$(gh auth token -u ParendumOU)" gh release edit v0.2.0 -R ParendumOU/Corvus --draft=false`).
   GitHub creates the tag `v0.2.0` on public `main`; the website links and every installed app's
   update check see it from this moment.
8. **Tag the source**: `git tag v0.2.0 && git push origin v0.2.0` (CI also builds the packages on
   tags, without publishing). **No attribution lines** (project rule).
9. **Verify auto-update** from the previous installed version (first possible with the release
   after v0.2.0, since earlier builds pointed at the placeholder feed).

## Release checklist
- [ ] All tests + smoke green on the commit being released
- [ ] Version bumped, CHANGELOG updated, committed
- [ ] Bridge bundle current (`bundle:bridge` produces no diff)
- [ ] `scripts/publish-release.sh <v>` done; draft has the 4 installers, `latest.yml`, `latest-linux.yml`, `SHA256SUMS.txt`
- [ ] macOS assets + `latest-mac.yml` added and checksums regenerated (if shipping mac)
- [ ] Windows build **signed** (once the cert exists); macOS **notarized** (once the ID exists)
- [ ] Draft reviewed and installed from, then published
- [ ] Source tagged `v<v>`
- [ ] Auto-update verified from the previous version
- [ ] No `Co-Authored-By` / "Generated with" lines anywhere
