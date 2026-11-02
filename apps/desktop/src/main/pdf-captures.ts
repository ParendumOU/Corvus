import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDF_MAX_BYTES } from "../shared/pdf-ipc";

/** The part of Electron's DownloadItem a capture uses. */
export interface CapturableDownload {
  setSavePath(path: string): void;
  getFilename(): string;
  once(event: "done", listener: (event: unknown, state: "completed" | "cancelled" | "interrupted") => void): unknown;
}

interface Capture {
  profileId: string;
  src: string;
  /** The name the server gave the file (Content-Disposition), else Chromium's guess from the URL. */
  filename: string;
  bytes: Promise<Uint8Array>;
}

/**
 * PDFs the browser downloaded for the viewer. A PDF that arrives as a download (a bank's download
 * button, a .aspx link, a form post) is kept as it came, with the page's cookies, form data and
 * one-time link, instead of being fetched again without them. The latest few stay in memory so a
 * reload of the viewer still has them; the temporary file goes as soon as it is read.
 */
export class PdfCaptures {
  private readonly captures = new Map<string, Capture>();

  constructor(
    private readonly tempDir: string,
    private readonly keep = 6,
  ) {}

  /** Lets `item` finish into a temporary file and returns the id the viewer asks for. */
  capture(item: CapturableDownload, profileId: string, src: string): string {
    const id = crypto.randomUUID();
    const file = path.join(this.tempDir, `corvus-pdf-${id}.pdf`);
    item.setSavePath(file);
    const bytes = new Promise<Uint8Array>((resolve, reject) => {
      const read = async (state: string): Promise<Uint8Array> => {
        try {
          if (state !== "completed") throw new Error("The PDF download did not finish.");
          const data = await fs.readFile(file);
          if (data.byteLength > PDF_MAX_BYTES) throw new Error("This PDF is too large to open.");
          return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } finally {
          await fs.rm(file, { force: true }).catch(() => undefined);
        }
      };
      item.once("done", (_event, state) => void read(state).then(resolve, reject));
    });
    // Nobody may ask for it (the tab closed): a failure is then nobody's error.
    bytes.catch(() => undefined);
    this.captures.set(id, { profileId, src, filename: item.getFilename(), bytes });
    for (const old of this.captures.keys()) {
      if (this.captures.size <= this.keep) break;
      this.captures.delete(old);
    }
    return id;
  }

  /** Capture `id`, when it is this profile's capture of `src`; null when gone. */
  get(id: string, profileId: string, src: string): { filename: string; bytes: Promise<Uint8Array> } | null {
    const capture = this.captures.get(id);
    return capture && capture.profileId === profileId && capture.src === src ? capture : null;
  }
}
