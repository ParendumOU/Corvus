/** Browsers cannot share into the app's web build: nothing is ever shared. */
export function useSharedText(): { text: string; clear: () => void } {
  return { text: '', clear: () => undefined };
}
