# Code signing

## Windows

The release builder signs every Windows binary (app, installer, uninstaller, portable) when `CSC_LINK` and `CSC_KEY_PASSWORD` are set. Signing runs inside the Linux builder container via electron-builder (osslsigncode), with an RFC 3161 timestamp, so signatures stay valid after the certificate expires.

```sh
# Local (Git Bash / Linux / macOS); relative paths are resolved from the repo root
CSC_LINK=.secrets/corvus.pfx CSC_KEY_PASSWORD=... docker compose --profile release run --rm builder
```

In GitLab CI set `CSC_LINK` (type **File**, protected) and `CSC_KEY_PASSWORD` (masked, protected). Without them the build is unsigned. `.secrets/` is git-ignored.

### Test certificate

`scripts/dev-codesign-cert.sh` creates a self-signed certificate to test the pipeline. Windows reports such signatures as untrusted (`UnknownError` in `Get-AuthenticodeSignature`) and SmartScreen still warns. Never ship with it.

### Getting a trusted certificate

A trusted certificate requires identity validation of the publisher (Parendum), which only the company can complete. Since June 2023 CAs issue code-signing keys only on hardware tokens or cloud HSMs, so a plain `.pfx` download is no longer possible for new certificates. Options:

| Option | Cost (approx.) | Works from the Linux builder | Notes |
|---|---|---|---|
| Azure Artifact Signing (formerly Trusted Signing) | ~$10/month | Yes, via jsign | Cheapest. Organization must pass Microsoft identity validation. |
| OV certificate on a cloud HSM (e.g. SSL.com eSigner, DigiCert KeyLocker) | ~$130–400/year + HSM fee | Yes, via jsign or the vendor CLI | Works in CI. |
| OV/EV certificate on a USB token | ~$200–500/year | No (needs the token plugged into a Windows machine) | Not CI-friendly. |

EV certificates no longer bypass SmartScreen instantly (Microsoft changed this in 2024); reputation builds with downloads for both OV and EV. Cloud-HSM options need a small change to `scripts/release.sh` (sign with jsign after electron-builder) once the provider is chosen.

## macOS

Requires an Apple Developer account ($99/year), a "Developer ID Application" certificate and notarization, on a macOS runner. The `package:macos` CI job builds unsigned until then.
