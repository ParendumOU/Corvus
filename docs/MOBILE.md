# Corvus for mobile

The companion app for Android (and, later, iOS) in `apps/mobile`: the computer's Corvus in your pocket. It has no browser engine of its own and no AI provider of its own: it reads and writes the same end-to-end encrypted sync chain as the desktop app, and asks a paired computer for anything that needs Corvus itself (an AI answer, a page fetched for the reading list, a watched page checked).

## What it does

| Screen | What it shows or does | Sync collections |
|---|---|---|
| Corvus (home) | The open tabs of every computer on the chain (with pins and tab groups), pages sent to this phone, pages it sent that wait to be opened | `open_tabs`, `sent_tabs` |
| Ask Corvus | A question goes to one computer, which answers with its AI search and its own AI provider; the answer shows as it is written, with sources and follow-up questions | `asks` |
| Library | Bookmarks by folder, the reading list (mark read/unread), history of every device by day | `bookmarks`, `reading`, `history` |
| Watched pages | What the computers last saw of each watched page, and a form to watch one more | `watches`, `watch_status` |
| Save or send a page | A page typed or shared from another app (Android share sheet): send it to a computer, save it to the reading list, bookmark it, watch it | `sent_tabs`, `reading`, `bookmarks`, `watches` |
| Open a link | A web link another app opened with Corvus as the browser (Android): open it in the picked browser with one tap, or send it or keep it as above | `sent_tabs`, `reading`, `bookmarks`, `watches` |
| Settings | Pairing, the chain's devices, unpairing, notifications, default browser (Android), version | |

**Notifications** (off until turned on in Settings, which asks the system's permission): pages a computer sends to this phone, and watched pages that changed. They are local notifications: about every 15 minutes, when the system allows it (`expo-background-task`: WorkManager on Android, BG tasks on iOS), the phone pulls the chain and notifies what is new. There is no push service.

**Language**: Spanish on a phone set to Spanish, English otherwise (`src/lib/i18n.ts`, `src/lib/i18n-es.ts`; a test checks every text has its Spanish one).

## How it fits with the desktop app

- **Pairing**: on the computer, Settings → Sync → "Pair a phone" shows a QR code with the sync server's address and the chain's recovery phrase. Anyone with it can read the synced data, so pair only your own phone. The phone scans it with a decoder that runs on the phone (see "The QR scanner has no Google code" below), or the details can be typed in. The phrase is kept in the OS's secure storage (Keystore / Keychain).
- **The sync server** only ever stores ciphertext. It has to be reachable from the phone. When the computer's sync server setting is `localhost` (e.g. the server in Docker on that computer), the QR code carries the computer's LAN address instead (same port; Tailscale or other addresses can be picked), the computer checks that the server answers there, and the pairing screen says the phone must be on the same Wi-Fi (allow the port in the firewall, pair again if the address changes). For any other address a phone likely cannot reach, such as a bare Docker name, the screen warns. A code from an older desktop that still carries `localhost` gets a specific error on the phone instead of the raw connection error.
- **Sending pages** both ways uses `sent_tabs`: the receiving device opens the page and deletes the record, which tells the sender it arrived. On the computer, "Send to your phone…" (tab and link menus) lists the paired phones.
- **Questions** (`asks`): the phone writes the question; the computer it went to answers it with its AI search (quick depth) and writes the answer into the same record as it streams in. Each computer decides whether it answers (Settings → Send to your phone → "Answer questions from Corvus on your phone", on by default). Corvus has to be open there.
- A sync server older than a collection the app uses refuses it; the app says the server needs updating instead of failing silently.

## Default browser (Android)

Corvus for mobile can be the phone's default browser, although it has no browser engine: every link opened on the phone comes to Corvus first, which offers it in one tap to the real browser the person picked, or sends it to a computer or keeps it.

- **Browser candidate**: `app.json` adds an `android.intentFilters` entry to the main activity (`VIEW` on `http` and `https`, categories `BROWSABLE` and `DEFAULT`, no host), so Android lists Corvus under Default apps → Browser app and in "Open with". iOS gets nothing: Apple lets only real browsers be the default one.
- **Native side**: the local Expo module `apps/mobile/modules/default-browser` (Kotlin, Android only; `expo prebuild` autolinks it from `modules/`, also in the Docker Android build). It tells whether Corvus holds the browser role (`RoleManager.isRoleHeld(ROLE_BROWSER)` on Android 10 and later, the default resolver of a web link before), shows the system's "Set as default browser" dialog (`RoleManager.createRequestRoleIntent`, answered through `startActivityForResult`), falls back to the Default apps settings screen where there is no such dialog, lists the other browser apps (a `<queries>` entry for web links makes them visible on Android 11 and later) and opens a page in one of them by its package. On iOS and in the web build the module is absent and the JavaScript side (`modules/default-browser/index.ts`) is `null`.
- **Links that come in**: expo-router's `redirectSystemPath` (`src/app/+native-intent.ts`, logic in `src/lib/links.ts`) turns an incoming `http(s)` address into `/open?url=…`, at a cold start and while the app runs; the app's own `corvus://` links and shares from other apps (`/send`) are untouched. The Open screen (`src/app/open.tsx`) shows the address with a big **Open in <browser>** button first, then the same send and keep actions as Save or send a page (`src/components/page-actions.tsx`). Unpaired, it offers only Open, with a hint to pair. After Open, or after a page is sent or kept (with a short toast), Corvus steps back (`moveTaskToBack`), so going back from the browser returns to the app the link came from.
- **No loops**: every page the app opens goes through `src/lib/open-url.ts`. While Corvus is the default browser on Android, pages go to the picked browser by its package (`Intent.setPackage`, and `browserPackage` for Custom Tabs), never back to the system, which would hand them to Corvus again. A link Corvus was asked to open always goes there by package, since the person may have picked Corvus "just once". On iOS, on the web and while Corvus is not the default, pages open as before.
- **Which browser**: Settings → Default browser (Android only) says whether Corvus is the default, has "Set as default browser" (the system dialog) and "Open pages in" with the installed browsers. Until the person picks one, it is the browser that was the default before Corvus (remembered while it was), else the current default, else the first one found; the choice is kept in AsyncStorage (`src/lib/browser-choice.ts`, tested in `test/browser-choice.test.ts`).
- **The offer**: once paired, Home shows one discreet card, "Make Corvus your default browser", while Corvus is not the default; its close button ("Not now") hides it for good.
- **Try it on a phone**: `adb shell am start -a android.intent.action.VIEW -d https://example.com -n com.parendum.corvus.mobile/.MainActivity` opens the Open screen without changing the default browser; `adb shell cmd role get-role-holders android.app.role.BROWSER` shows which app holds the role.

## Develop and check

Everything runs in Docker, from the repository root:

```sh
docker compose run --rm dev pnpm install
docker compose run --rm dev sh -c "pnpm -r build && cd apps/mobile && pnpm typecheck && pnpm test"
docker compose up -d --build sync-server
docker compose run --rm dev sh -c "cd apps/mobile && pnpm export:web && pnpm smoke:web"
```

`pnpm test` covers the pure logic in `src/lib`. `pnpm smoke:web` loads the web build in a headless browser against the real sync server: it pairs, then checks every screen with a fake computer made with `@corvus/sync-core`. Screenshots land in `out/mobile-smoke`.

Icons are drawn from SVG sources in `assets/source` (the Corvus mark of the desktop app): `docker compose run --rm dev bash apps/mobile/scripts/make-icons.sh`. The tab bar's icons are PNGs of the same stroke icons the screens use: `docker compose run --rm dev node apps/mobile/scripts/make-tab-icons.mjs`.

The look comes from one design system: color roles for light and dark, spacing, radii, type scale and elevation in `src/constants/theme.ts`, and the components every screen is built from in `src/components` (buttons, cards and section headers, list rows, text and search fields, chips and segmented controls, the tab strip, empty and loading states, banner, toast and confirmation dialog, the screen scaffold). The icons in `src/components/icon.tsx` are the desktop app's stroke icons, drawn with `react-native-svg`.

## Android builds

`docker compose --profile android run --rm android` generates the native project (`expo prebuild`, never committed) and builds the release APK into `out/mobile/`. With the release key mounted from `../secrets` (`corvus-mobile.keystore` and `corvus-mobile-keystore.env`, kept outside every repository and backed up off the machine) it is signed for release; without it, with the debug key (local testing only). Releases: see "Corvus for mobile releases" in `RELEASE.md`.

With the release key the same run also builds the App Bundle for Google Play, `out/mobile/corvus-mobile-<version>.aab`, signed by Gradle with that key (the generated project would otherwise sign release builds with the debug key).

Release builds are not shrunk with R8 (`-Pandroid.enableMinifyInReleaseBuilds=false`): the Expo template turns it on, and it broke WorkManager, which `expo-background-task` uses, so 0.3.0 and 0.4.0 closed at start-up. Before shipping a build, install it on a phone (`adb install -r out/mobile/corvus-mobile-<version>.apk`) and open it.

**The QR scanner has no Google code.** On Android the pairing code is read by Corvus's own scanner, the local Expo module `modules/qr-scanner`: a CameraX preview whose frames (1280x960, luminance only) are decoded on the phone by ZXing (`com.google.zxing:core`, Apache-2.0, plain Java with no network code), reporting each code to the pairing screen. expo-camera is left out of the Android build (`expo.autolinking.android.exclude` in `apps/mobile/package.json`), because on Android its scanner is Google ML Kit, which sends Google diagnostics, and it also links ML Kit's document scanner and asks Play services to download ML Kit's barcode module. `barcodeScannerEnabled: false` in `app.json` would keep ML Kit out even if expo-camera were linked again. On iOS the app keeps expo-camera, which reads QR codes with Apple's AVFoundation (that option only drops its ZXingObjC reader for other barcode types). `build-android.sh` runs the decoder's tests first (`QrDecoderTest`: real QR images of pairing codes in `modules/qr-scanner/android/src/test/resources/qr`, made by `modules/qr-scanner/scripts/make-fixtures.mjs`: clean, blurred, rotated, tilted, low-contrast, inverted, small) and fails if ML Kit shows up in the APK: its classes (`com.google.mlkit`, ML Kit's internal Play services classes, `androidx.camera.mlkit` from `camera-mlkit-vision`) or anything of it in the manifest. ZXing reads the code with the phone up to about 25 degrees off square (the far edge of the code at least 85% as long as the near one), so the person may need to hold the phone a little straighter than with ML Kit.

## Google Play

The package `com.parendum.corvus.mobile` is registered to Parendum OÜ under Android developer verification (Play Console → Manage account → Android developer verification), with the release key's certificate (SHA-256 `62:68:03:EE:…:30:3C:47:E9`). That covers installing the APK from GitHub on certified phones. Phones with Android Advanced Protection install apps only from Google Play, and Play Protect stays quiet about apps it distributes, so the app also goes to Play:

1. **Create the app** in Play Console (Create app, "Corvus", app, free). The package name is set by the first bundle uploaded.
2. **Play App Signing with our key**, so the Play app and the GitHub APK carry the same signature and update each other: in Test and release → App integrity, choose to use your own key, "Export and upload a key from Java keystore", download Google's `pepk.jar` and encryption public key, then export the release key with them (in the `android` container, where Java is): `java -jar pepk.jar --keystore=/secrets/corvus-mobile.keystore --alias=<KEY_ALIAS> --output=/secrets/play-signing-key.zip --include-cert --rsa-aes-encryption --encryption-key-path=<encryption_public_key.pem>` and upload the zip. The same key stays the upload key, so no second key is needed.
3. **Internal testing**: Test and release → Testing → Internal testing → create a release with the `.aab`, add the testers' Google accounts, and open the opt-in link on the phone. Internal testing is not public and needs no full store listing or review.
4. A public listing (store page, privacy policy, data safety, content rating, review) comes only when Corvus for mobile leaves preview.

Steps 1 and 2 are done (the app exists in Parendum's Play Console with Play App Signing on our key). Every mobile release now goes to internal testing on its own: `apps/mobile/scripts/play-upload.mjs` uploads the bundle through the Google Play Developer API (see "Corvus for mobile releases" in `RELEASE.md`).

Each bundle needs a higher `android.versionCode` in `app.json` than the last one uploaded.

What leaves the phone, for the privacy policy (https://corvus.parendum.com/privacy) and Play's Data safety form:
- The synced records go to the person's sync server end-to-end encrypted; the server also sees device names and types, timestamps and IP addresses. Site icons load straight from each site.
- **QR scanning sends nothing anywhere**: the camera frames and the code are decoded on the phone by Corvus's own scanner (ZXing on Android, Apple's AVFoundation on iOS). Google ML Kit is no longer in the app (earlier versions had it through `expo-camera`, and it sent Google diagnostics).
- `expo-notifications` bundles Firebase Cloud Messaging, but no Firebase project is configured and no push token is requested; `app.json` blocks its `c2dm` permission and Play's install referrer.
- `android.allowBackup` is off: nothing the app stores goes into Android's cloud backup.
- **Being the default browser sends nothing anywhere** (Android): the list of installed browsers is read on the phone only (package visibility limited to apps that open `http`/`https` links, no `QUERY_ALL_PACKAGES`), the picked browser is remembered on the phone, and each link goes straight to that browser unless the person sends or saves it, which goes through sync like any other record.

## iOS readiness

The code is written for both platforms (no Android-only APIs without a fallback), and `app.json` has the iOS bundle identifier `com.parendum.corvus.mobile`. What is missing to ship on iOS:

1. A Mac with Xcode or EAS Build (`eas build --platform ios`, which needs an Expo account). The Apple Developer account exists (team Parendum OU, `PZ5NDD82FC`), the App ID `com.parendum.corvus.mobile` is registered and an App Store Connect API key is kept with the other secrets (`../secrets/apple-signing.env`).
2. Background tasks on iOS run when the system decides (often less than every 15 minutes); the notification text in Settings already says so.
3. Sharing a page to Corvus from other apps needs a share extension on iOS (`expo-sharing` has `ios.enabled`); the Android share target exists already.
4. A TestFlight build before the App Store, with the privacy answers (no tracking, data stays end-to-end encrypted on the person's own sync server).
