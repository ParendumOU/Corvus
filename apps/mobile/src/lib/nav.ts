import { router } from 'expo-router';

// expo-router throws when a screen navigates before the root navigator has rendered once. It
// happened in a release build on a tap right after the app started, and a throw in a press
// handler closes the app, so the move waits a moment and tries again instead.
const NOT_READY = 'before the first render';
const TRIES = 20;
const WAIT_MS = 100;

function attempt(run: () => void, tries = TRIES): void {
  try {
    run();
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes(NOT_READY)) throw err;
    if (tries > 0) setTimeout(() => attempt(run, tries - 1), WAIT_MS);
  }
}

/** The app's navigation: expo-router's, safe to call while the app is still starting. */
export const nav = {
  push: (...args: Parameters<typeof router.push>): void => attempt(() => router.push(...args)),
  navigate: (...args: Parameters<typeof router.navigate>): void => attempt(() => router.navigate(...args)),
  replace: (...args: Parameters<typeof router.replace>): void => attempt(() => router.replace(...args)),
};
