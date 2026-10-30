# Roadmap

Corvus is an AI-native Electron browser that is also an MCP server, with AI search, end-to-end-encrypted sync, and a full agent/automation toolset. This file is the one list of what is left to do; what shipped, release by release, is in [CHANGELOG.md](../CHANGELOG.md).

Last updated: 2026-10-30 · current release: **v0.32.7** (Windows + Linux unsigned, macOS signed and notarized) · Corvus for mobile **0.10.0** (Android preview)

---

## Next

In order. Each item is one branch (`feat|fix/<name>`), validated and merged on its own.

1. **Corvus for mobile 0.11.0** once Apple and Google approve 0.10.0 (the release script now publishes to both stores by itself): ships what is already on main: the certificate error page (no Proceed on the phone; Android link, back and reload fixes; failed loads kept out of history), Android language change without a restart (Settings > Apps > Corvus > Language) and coming back to the same screen after Android rebuilds or stops the app. Check the certificate page and the language on a real iPhone through TestFlight.

## Waiting on the owner or on the stores

- **App Store**: Corvus for mobile 0.10.0 is in App Review (submitted 2026-10-29); release it after approval. France stays off until an encryption declaration (ANSSI) is filed, if France is wanted.
- **Google Play**: 0.10.0 is in review; the owner promotes it from internal testing to production in Play Console.
- **On a real iPhone (TestFlight)**: cookie banners, pairing by QR code and the certificate error page.
- **Windows**: confirm a taskbar pin survives a real automatic update (the in-place update shipped in v0.31.0).
- **Code-signing certificate** for Windows: deferred, see Open decisions.

## Later

- **Corvus for mobile**: saved passwords and 2FA codes on the phone; the agent on the phone; ad blocking on iOS (content rule lists); generic element hiding and scriptlets on Android.
- **AI agent requests**: a tab closed while an agent waits answers "cancelled"; a separate "tab closed" outcome would tell the agent more.
- **Next Expo upgrade**: redo the expo-router patch (patches/expo-router@58.0.26.patch, the router binding after Android rebuilds the screen) and recheck Google Play's edge-to-edge warning (today it comes from library calls; the bitmap warning is a false positive).
- **Demo sync chain**: Spanish sample content for reviewers who use the app in Spanish.
- **Import from Google Authenticator**: AVIF photos (the decoder already reads them); a KeePass file blocked only by its access rights shows as writable until the write fails.
- **Live history**: "Also sync them to my other devices", an opt-in second toggle under Settings > Live history from other browsers so pages read from other browsers sync like Corvus's own (today they stay on this computer).
- **Parked**: WebScope active checks (opt-in), to revisit from another angle; Chrome extensions' declarativeNetRequest at scale, only if an extension needs it.

## Open decisions (owner)

1. **Code-signing certificate**: deferred (2026-10-26). Windows builds stay unsigned and SmartScreen warns, which is accepted for now. When it is wanted: Azure Artifact Signing (about 120 $/year, eligibility to confirm) or an OV cloud certificate (Certum, about 110 $/year). Free signing for open source (SignPath Foundation) does not fit: it needs OSI licences for every bundled part (the RAR decoder's licence is not) and builds on its CI.
2. **Distribution**: decided. Installers and the auto-update feed are GitHub Releases of ParendumOU/Corvus (see docs/RELEASE.md); macOS builds are signed with the Developer ID (Parendum OU, `PZ5NDD82FC`, until 2027-11) and notarized.

---

## Shipped (summary)

The details of each release are in [CHANGELOG.md](../CHANGELOG.md).

- **Browser core** (v0.1): windows, tabs, groups, vertical tabs and workspaces, omnibox, bookmarks, history, profiles, session restore, downloads, permissions, Chrome extensions (Web Store installs plus the bookmarks, history, tabGroups, sessions, sidePanel, commands and downloads APIs Corvus adds itself), ad and tracker blocking, cookie banner rejection and Global Privacy Control, watched pages.
- **AI** (v0.1 to v0.24): AI search with cited answers, Corvus Assist (artifacts, formatted answers, history synced end to end), the Command Bar agent (several tasks at once, visible tab groups, take over, run history, approval gate, spending always asks), reader mode with an AI reading suite, inline AI in form fields, voice dictation, agent memory, scheduled agents, recorded workflows, per-site AI profiles, local models and Claude Code as providers.
- **For agents (MCP)**: a local and remote MCP server with three access levels, the full browser toolset, CAPTCHA handling with a handoff to the person, request_user_action (the asking tab blinks, v0.32.3), the Claude Code plugin, and WebScope (capture, repeater, fuzzer, intercept, rules, sessions, live updates in v0.31.0).
- **Sync** (v0.2 to v0.28): end-to-end-encrypted sync with a 24-word recovery phrase of bookmarks, history, settings, profiles, open tabs, logins with their 2FA, reading list, watches, workspaces, annotations and more; conflict recovery; the sync server built into the desktop app ("This computer") or self-hosted.
- **Passwords and 2FA** (v0.2 to v0.32.4): built-in vault with autofill, a save form that opens by itself, Password Checkup, 2FA codes (TOTP) filled together with the login, KeePass databases (read, edit, export), import from Google Authenticator export photos, Passwords and 2FA codes tabs, Back up now and a backup reminder.
- **Downloads** (v0.13): link grabber, package queue, parallel connections, split archives, file hosts resolved in the background.
- **Privacy and connections** (v0.20): proxies per profile, container and site, private windows, the certificate error page (v0.32.1).
- **Platforms and releases**: Windows installer and portable (updates in place, keeps taskbar pins), Linux AppImage and deb, signed and notarized macOS, auto-update from GitHub Releases, releases published by the agent with one script; Corvus for mobile (Android preview on Google Play internal testing, iOS on TestFlight and in App Review): its own browser, pairing by QR code, tabs and pages both ways, Assist through a paired computer, English and Spanish.

## Guiding principles

- **Local-first, E2E by default**: user data is encrypted on the device; the server is dumb storage.
- **Agent actions are gated**: risky steps (forms, logins) need human approval while "Ask before risky actions" is on. Spending money (a "Buy now", "Place order" or "Pagar" click, Enter in a checkout or payment form) always asks, even with it off, in scheduled runs and saved workflows, and for MCP clients at every access level (a native Allow once / Deny dialog). CAPTCHAs are solved by the agent when they do not pass on their own, and go to the human after two failures or when they ask for a phone number or e-mail code; card and password fields still go to the human. 2FA codes go to the human too, unless the user opted that login in (global setting plus per-login switch, both off by default); then Corvus fills the code itself after an approval prompt and the agent never sees it.
- **Provider-agnostic**: Anthropic API, local Claude Code and local models are interchangeable.
- **Default paths work for non-experts**: no Docker, ports or admin shells needed to use Corvus or its sync.
- **pnpm only**, Dockerized builds, tests and smoke green before merge.
