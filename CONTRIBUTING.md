# Contributing to Corvus

Thanks for helping. Bug reports, fixes and features are all welcome. For anything larger than a small fix, please open an issue first so we can agree on the approach.

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Ground rules

- **pnpm only.** Never use npm, npx or yarn; the root `package.json` refuses them. The lockfile is `pnpm-lock.yaml`.
- **Docker for everything.** Development, tests and packaging run in the containers defined in `docker-compose.yml`, so the only thing you need on the host is Docker. This keeps Linux `node_modules` out of your working copy and makes results match CI.
- **Tests and the headless smoke test must pass** before a change is merged.

## Setup

```sh
docker compose run --rm dev pnpm install
docker compose run --rm dev pnpm -r build
```

The dev image sets `CI=true`, so `pnpm install` uses the lockfile as is. If you add or change a dependency, run `docker compose run --rm dev pnpm install --no-frozen-lockfile` once and commit the updated `pnpm-lock.yaml`.

Optional services for AI search and sync: `docker compose up -d searxng sync-server`.

## Before you open a pull request

Run all of these and make sure they pass:

```sh
docker compose run --rm dev pnpm -r build
docker compose run --rm dev pnpm -r typecheck
docker compose run --rm dev pnpm -r test
docker compose run --rm dev pnpm --filter @corvus/desktop test:smoke
```

The smoke test starts the real Electron app under Xvfb and drives it end to end, with no network access needed. If you add an internal `corvus://` page, add it to the smoke page list too.

## Code

- TypeScript in strict mode everywhere. Shared contracts live in `packages/shared`; pure logic goes in `apps/desktop/src/shared` so it can be unit tested without Electron.
- Add or update unit tests (Vitest) next to the code you change.
- Any new setting must be classified as synced or local only in `apps/desktop/src/shared/sync-settings.ts` (a test enforces this).
- Anything an agent can trigger must go through the existing access levels and approval gate. Text that comes from web pages is untrusted and must stay marked as such.
- Keep comments for the reasons behind non-obvious code, not for what the code does.
- If you change `packages/mcp-server`, rebuild the Claude Code bridge bundle with `docker compose run --rm dev pnpm --filter @corvus/mcp-server run bundle:bridge` and commit it.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) in English, for example `fix(omnibox): keep the caret position on paste`.
- Keep pull requests focused on one change and describe how you tested it.

## License

By contributing, you agree that your contributions are licensed under the [Mozilla Public License 2.0](LICENSE), the same license as the rest of Corvus.
