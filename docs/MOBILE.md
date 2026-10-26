# Corvus for mobile

The companion app for Android (and, later, iOS) in `apps/mobile`: the computer's Corvus in your
pocket. It has no browser engine of its own and no AI provider of its own: it reads and writes the
same end-to-end encrypted sync chain as the desktop app, and asks a paired computer for anything
that needs Corvus itself (an AI answer, a page fetched for the reading list, a watched page
checked).

## What it does

| Screen | What it shows or does | Sync collections |
|---|---|---|
| Corvus (home) | The open tabs of every computer on the chain (with pins and tab groups), pages sent to this phone, pages it sent that wait to be opened | `open_tabs`, `sent_tabs` |
| Ask Corvus | A question goes to one computer, which answers with its AI search and its own AI provider; the answer shows as it is written, with sources and follow-up questions | `asks` |
| Library | Bookmarks by folder, the reading list (mark read/unread), history of every device by day | `bookmarks`, `reading`, `history` |
| Watched pages | What the computers last saw of each watched page, and a form to watch one more | `watches`, `watch_status` |
| Save or send a page | A page typed or shared from another app (Android share sheet): send it to a computer, save it to the reading list, bookmark it, watch it | `sent_tabs`, `reading`, `bookmarks`, `watches` |
| Settings | Pairing, the chain's devices, unpairing, notifications, version | |

**Notifications** (off until turned on in Settings, which asks the system's permission): pages a
computer sends to this phone, and watched pages that changed. They are local notifications: about
every 15 minutes, when the system allows it (`expo-background-task`: WorkManager on Android, BG
tasks on iOS), the phone pulls the chain and notifies what is new. There is no push service.

**Language**: Spanish on a phone set to Spanish, English otherwise (`src/lib/i18n.ts`,
`src/lib/i18n-es.ts`; a test checks every text has its Spanish one).

## How it fits with the desktop app

- **Pairing**: on the computer, Settings → Sync → "Pair a phone" shows a QR code with the sync
  server's address and the chain's recovery phrase. Anyone with it can read the synced data, so
  pair only your own phone. The phrase is kept in the OS's secure storage (Keystore / Keychain).
- **The sync server** only ever stores ciphertext. It has to be reachable from the phone (not
  `localhost`); the pairing screen on the computer says when it is not.
- **Sending pages** both ways uses `sent_tabs`: the receiving device opens the page and deletes the
  record, which tells the sender it arrived. On the computer, "Send to your phone…" (tab and link
  menus) lists the paired phones.
- **Questions** (`asks`): the phone writes the question; the computer it went to answers it with
  its AI search (quick depth) and writes the answer into the same record as it streams in. Each
  computer decides whether it answers (Settings → Send to your phone → "Answer questions from
  Corvus on your phone", on by default). Corvus has to be open there.
- A sync server older than a collection the app uses refuses it; the app says the server needs
  updating instead of failing silently.

## Develop and check

Everything runs in Docker, from the repository root:

```sh
docker compose run --rm dev pnpm install
docker compose run --rm dev sh -c "pnpm -r build && cd apps/mobile && pnpm typecheck && pnpm test"
docker compose up -d --build sync-server
docker compose run --rm dev sh -c "cd apps/mobile && pnpm export:web && pnpm smoke:web"
```

`pnpm test` covers the pure logic in `src/lib`. `pnpm smoke:web` loads the web build in a headless
browser against the real sync server: it pairs, then checks every screen with a fake computer
made with `@corvus/sync-core`. Screenshots land in `out/mobile-smoke`.

Icons are drawn from SVG sources in `assets/source` (the Corvus mark of the desktop app):
`docker compose run --rm dev bash apps/mobile/scripts/make-icons.sh`.

## Android builds

`docker compose --profile android run --rm android` generates the native project (`expo
prebuild`, never committed) and builds the release APK into `out/mobile/`. With the release key
mounted from `../secrets` (`corvus-mobile.keystore` and `corvus-mobile-keystore.env`, kept outside
every repository and backed up off the machine) it is signed for release; without it, with the
debug key (local testing only). Releases: see "Corvus for mobile releases" in `RELEASE.md`.

With the release key the same run also builds the App Bundle for Google Play,
`out/mobile/corvus-mobile-<version>.aab`, signed by Gradle with that key (the generated project
would otherwise sign release builds with the debug key).

Release builds are not shrunk with R8 (`-Pandroid.enableMinifyInReleaseBuilds=false`): the Expo
template turns it on, and it broke WorkManager, which `expo-background-task` uses, so 0.3.0 and
0.4.0 closed at start-up. Before shipping a build, install it on a phone (`adb install -r
out/mobile/corvus-mobile-<version>.apk`) and open it.

## Google Play

The package `com.parendum.corvus.mobile` is registered to Parendum OÜ under Android developer
verification (Play Console → Manage account → Android developer verification), with the release
key's certificate (SHA-256 `62:68:03:EE:…:30:3C:47:E9`). That covers installing the APK from
GitHub on certified phones. Phones with Android Advanced Protection install apps only from Google
Play, and Play Protect stays quiet about apps it distributes, so the app also goes to Play:

1. **Create the app** in Play Console (Create app, "Corvus", app, free). The package name is set
   by the first bundle uploaded.
2. **Play App Signing with our key**, so the Play app and the GitHub APK carry the same signature
   and update each other: in Test and release → App integrity, choose to use your own key, "Export
   and upload a key from Java keystore", download Google's `pepk.jar` and encryption public key,
   then export the release key with them (in the `android` container, where Java is):
   `java -jar pepk.jar --keystore=/secrets/corvus-mobile.keystore --alias=<KEY_ALIAS>
   --output=/secrets/play-signing-key.zip --include-cert --rsa-aes-encryption
   --encryption-key-path=<encryption_public_key.pem>` and upload the zip. The same key stays the
   upload key, so no second key is needed.
3. **Internal testing**: Test and release → Testing → Internal testing → create a release with
   the `.aab`, add the testers' Google accounts, and open the opt-in link on the phone. Internal
   testing is not public and needs no full store listing or review.
4. A public listing (store page, privacy policy, data safety, content rating, review) comes only
   when Corvus for mobile leaves preview.

Steps 1 and 2 are done (the app exists in Parendum's Play Console with Play App Signing on our
key). Every mobile release now goes to internal testing on its own: `apps/mobile/scripts/
play-upload.mjs` uploads the bundle through the Google Play Developer API (see "Corvus for mobile
releases" in `RELEASE.md`).

Each bundle needs a higher `android.versionCode` in `app.json` than the last one uploaded.

## iOS readiness

The code is written for both platforms (no Android-only APIs without a fallback), and `app.json`
has the iOS bundle identifier `com.parendum.corvus.mobile`. What is missing to ship on iOS:

1. A Mac with Xcode or EAS Build (`eas build --platform ios`, which needs an Expo account). The
   Apple Developer account exists (team Parendum OU, `PZ5NDD82FC`), the App ID
   `com.parendum.corvus.mobile` is registered and an App Store Connect API key is kept with the
   other secrets (`../secrets/apple-signing.env`).
2. Background tasks on iOS run when the system decides (often less than every 15 minutes); the
   notification text in Settings already says so.
3. Sharing a page to Corvus from other apps needs a share extension on iOS (`expo-sharing` has
   `ios.enabled`); the Android share target exists already.
4. A TestFlight build before the App Store, with the privacy answers (no tracking, data stays
   end-to-end encrypted on the person's own sync server).
