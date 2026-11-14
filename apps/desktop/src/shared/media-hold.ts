/**
 * A tab the person opens in the background loads at once but plays nothing until they first go to
 * it, as Chrome defers a background tab's media (see shared/background-tabs.ts holdsMedia). The main
 * process mutes the page meanwhile (Web Audio, frames without the tab preload), and the tab preload
 * holds the page's audio and video elements: a play() the page calls waits, and an element that
 * starts by itself (autoplay) is paused, until the tab is shown; then they start.
 */

/** Sync IPC from a frame's tab preload at its start, while its document is hidden: whether its tab holds media. */
export const MEDIA_HOLD_CHANNEL = "corvus:media-hold";
/** Main to every frame of the tab, when it is first shown: its media may play. */
export const MEDIA_RELEASE_CHANNEL = "corvus:media-release";

interface Waiting {
  resolve: (value: undefined) => void;
  reject: (reason: unknown) => void;
}

/**
 * Runs in the page's own world (contextBridge.executeInMainWorld, so it is self-contained): until
 * the release `onRelease` is given runs, a play() of an audio or video element waits, its promise
 * settling once the element really starts, and a pause() before that cancels it, as it would a start
 * still loading. The release puts the native methods back, so nothing of this stays in the page.
 * Proxies of the native methods keep their name and their native-looking source.
 */
export function holdMediaInPage(onRelease: (release: () => void) => void): void {
  const g = globalThis as unknown as { HTMLMediaElement?: { prototype: Record<string, unknown> }; DOMException: new (message: string, name: string) => unknown };
  const proto = g.HTMLMediaElement?.prototype;
  if (!proto) return;
  const play = proto.play as (this: unknown) => Promise<undefined>;
  const pause = proto.pause as (this: unknown) => void;
  const waiting = new Map<unknown, Waiting[]>();
  const heldPlay = new Proxy(play, {
    apply: (_target, el: unknown) =>
      new Promise<undefined>((resolve, reject) => {
        const list = waiting.get(el) ?? [];
        list.push({ resolve, reject });
        waiting.set(el, list);
      }),
  });
  const heldPause = new Proxy(pause, {
    apply: (target, el: unknown, args: unknown[]) => {
      const list = waiting.get(el);
      if (list) {
        waiting.delete(el);
        for (const w of list) w.reject(new g.DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
      }
      return Reflect.apply(target, el, args);
    },
  });
  proto.play = heldPlay;
  proto.pause = heldPause;
  onRelease(() => {
    if (proto.play === heldPlay) proto.play = play;
    if (proto.pause === heldPause) proto.pause = pause;
    const started = [...waiting];
    waiting.clear();
    for (const [el, list] of started) {
      const start = Reflect.apply(play, el, []) as Promise<undefined>;
      for (const w of list) start.then(w.resolve, w.reject);
    }
  });
}
