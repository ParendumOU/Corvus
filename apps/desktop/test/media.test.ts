import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/shared/settings";
import { PIP_ENTER_SCRIPT, PIP_EXIT_SCRIPT, shouldAutoPip } from "../src/shared/media";

interface FakeVideo {
  name: string;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  readyState: number;
  videoWidth: number;
  disablePictureInPicture: boolean;
  size: number;
  getBoundingClientRect(): { width: number; height: number };
  requestPictureInPicture(): Promise<void>;
}

/** A page with these videos; `floated` records which one went picture-in-picture. */
function page(videos: Array<Partial<FakeVideo> & { name: string }>, opts: { enabled?: boolean; reject?: boolean } = {}) {
  const doc: { pictureInPictureElement: FakeVideo | null; pictureInPictureEnabled: boolean; querySelectorAll: () => FakeVideo[]; exitPictureInPicture: () => Promise<void> } = {
    pictureInPictureElement: null,
    pictureInPictureEnabled: opts.enabled !== false,
    querySelectorAll: () => list,
    exitPictureInPicture: async () => {
      doc.pictureInPictureElement = null;
    },
  };
  const list: FakeVideo[] = videos.map((v) => {
    const video: FakeVideo = {
      paused: false,
      ended: false,
      muted: false,
      volume: 1,
      readyState: 4,
      videoWidth: 640,
      disablePictureInPicture: false,
      size: 100,
      ...v,
      getBoundingClientRect: () => ({ width: video.size, height: video.size }),
      requestPictureInPicture: async () => {
        if (opts.reject) throw new Error("NotAllowedError");
        doc.pictureInPictureElement = video;
      },
    };
    return video;
  });
  const run = (code: string): Promise<string> => runInNewContext(code, { document: doc, Array }) as Promise<string>;
  return { doc, run };
}

describe("automatic picture-in-picture", () => {
  it("floats only web pages that play sound, when the setting is on", () => {
    expect(defaultSettings().media.autoPictureInPicture).toBe(true);
    expect(shouldAutoPip({ audible: true, url: "https://video.example/watch", enabled: true })).toBe(true);
    expect(shouldAutoPip({ audible: false, url: "https://video.example/watch", enabled: true })).toBe(false);
    expect(shouldAutoPip({ audible: true, url: "https://video.example/watch", enabled: false })).toBe(false);
    expect(shouldAutoPip({ audible: true, url: "corvus://newtab/", enabled: true })).toBe(false);
  });

  it("floats the largest video playing with sound", async () => {
    const { doc, run } = page([
      { name: "muted", muted: true, size: 900 },
      { name: "paused", paused: true, size: 800 },
      { name: "no-pip", disablePictureInPicture: true, size: 700 },
      { name: "small", size: 200 },
      { name: "main", size: 500 },
    ]);
    expect(await run(PIP_ENTER_SCRIPT)).toBe("entered");
    expect((doc.pictureInPictureElement as FakeVideo | null)?.name).toBe("main");
    expect(await run(PIP_ENTER_SCRIPT)).toBe("already");
    expect(await run(PIP_EXIT_SCRIPT)).toBe("exited");
    expect(doc.pictureInPictureElement).toBeNull();
    expect(await run(PIP_EXIT_SCRIPT)).toBe("none");
  });

  it("does nothing without a suitable video, and reports a refused request", async () => {
    expect(await page([{ name: "silent", volume: 0 }]).run(PIP_ENTER_SCRIPT)).toBe("none");
    expect(await page([{ name: "loading", readyState: 1 }]).run(PIP_ENTER_SCRIPT)).toBe("none");
    expect(await page([{ name: "v" }], { enabled: false }).run(PIP_ENTER_SCRIPT)).toBe("unsupported");
    expect(await page([{ name: "v" }], { reject: true }).run(PIP_ENTER_SCRIPT)).toBe("failed");
  });
});
