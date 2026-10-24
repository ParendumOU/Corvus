# Corvus for mobile

The Corvus companion app for Android and iOS: your computer's Corvus in your pocket, over the same
end-to-end encrypted sync the desktop app uses (the sync server only ever stores ciphertext).

Built with Expo and Expo Router. It reuses `@corvus/shared` and `@corvus/sync-core` from this
monorepo.

## Develop

All installs, checks and builds run in Docker, as for the rest of the repository:

```sh
docker compose run --rm dev pnpm install
docker compose run --rm dev sh -c "pnpm -r build && cd apps/mobile && pnpm typecheck && pnpm test"
docker compose run --rm dev sh -c "cd apps/mobile && pnpm export:web && pnpm smoke:web"
```

`pnpm smoke:web` loads the web build in a headless browser and checks its screens.

## Android

`docker compose run --rm android` builds the Android app (see `docker/Dockerfile.android`).

## iOS

The code is iOS-ready. Building for iOS needs an Apple developer account and macOS or EAS Build.
