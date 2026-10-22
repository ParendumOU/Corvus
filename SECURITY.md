# Security policy

Corvus is a browser that AI agents can drive, so we take security reports seriously and are
grateful for them.

## Reporting a vulnerability

Please report security issues **privately** by email to **security@parendum.com**. Do not open a
public issue, pull request or discussion for a vulnerability.

Include as much of this as you can:

- The Corvus version (Settings > Updates shows it) and your operating system
- What an attacker can do, and what they need first (a malicious web page, a connected MCP
  client, local access, and so on)
- Steps to reproduce, a proof of concept, or a minimal test page
- Any logs or screenshots that help

We will acknowledge your report, keep you informed while we investigate and fix it, and credit you
in the release notes if you would like. Please give us a reasonable amount of time to release a fix
before you disclose the issue publicly.

## Supported versions

Security fixes go into the latest release. Installed copies update themselves from
[GitHub Releases](https://github.com/ParendumOU/Corvus/releases), so please check that you can
reproduce the issue on the newest version.

## In scope

- The Corvus desktop browser (`apps/desktop`): isolation between web pages, internal
  `corvus://` pages, extensions and profiles; the permission prompts; the password manager; the
  auto-updater
- The MCP server and its stdio bridge (`packages/mcp-server`, `integrations/claude-code`): bearer
  token and client approval, the access levels (read-only, standard, full), the approval gate for
  risky agent actions, and the Host and Origin checks, both local and with remote access enabled
- Prompt injection from web content that makes an agent act beyond its access level or skip an
  approval Corvus should have asked for
- End-to-end encrypted sync (`packages/sync-core`, `services/sync-server`): anything that exposes
  plaintext or keys to the server or to another account
- The AI engine (`packages/ai-engine`): server-side request forgery into private networks, and
  leaks of API keys or page content to places they should not go
- WebScope (`packages/webscope`) acting outside the scope the user set

## Out of scope

- Bugs in Electron or Chromium themselves; please report those upstream (we still want to hear
  about them if Corvus makes them easier to exploit)
- Attacks that need an already compromised machine or a malicious local administrator
- Behaviour of third-party websites, extensions or AI providers
- Agents doing what the user explicitly approved, or what the chosen access level allows
- Missing code signing warnings (SmartScreen, Gatekeeper) on unsigned builds
- Denial of service against a sync server you host yourself, unless it also bypasses
  authentication or exposes data
