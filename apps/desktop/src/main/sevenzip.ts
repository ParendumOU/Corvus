// 7-Zip compiled to WebAssembly, working on one folder of the disk: the folder is mounted at
// /package and is the only part of the disk 7-Zip sees. Runs in the archive extractor's utility
// process (main/archive-worker.ts), and directly in the tests.
import SevenZip from "7z-wasm";

export interface SevenZipResult {
  code: number;
  lines: string[];
  /**
   * 7-Zip threw instead of reporting: the WebAssembly build cannot catch its own C++ exceptions,
   * which 7-Zip raises for damaged data and for a wrong password on a .7z archive.
   */
  crashed?: boolean;
}

/** One command on a fresh 7-Zip instance (an instance does not survive a failed run). */
export async function runSevenZip(root: string, args: string[]): Promise<SevenZipResult> {
  const lines: string[] = [];
  try {
    // stdin answers nothing: 7-Zip must never wait for a password or a question.
    const sevenZip = await SevenZip({ print: (s) => lines.push(s), printErr: (s) => lines.push(s), stdin: () => null as unknown as number });
    sevenZip.FS.mkdir("/package");
    sevenZip.FS.mount(sevenZip.NODEFS, { root }, "/package");
    sevenZip.FS.chdir("/package");
    const code = sevenZip.callMain(args) as unknown;
    return { code: typeof code === "number" ? code : 0, lines };
  } catch (err) {
    const status = (err as { status?: unknown })?.status;
    // An exit() comes as an ExitStatus with a status; a C++ exception as a bare number.
    if (typeof status === "number") return { code: status, lines };
    lines.push("ERROR: The archive could not be read (damaged data or a wrong password)");
    return { code: 2, lines, crashed: true };
  }
}
