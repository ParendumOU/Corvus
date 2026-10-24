// Entry of the archive extractor (an Electron utility process): runs 7-Zip on one package folder,
// one command per message, so extracting gigabytes never stalls the browser.
import { runSevenZip } from "./sevenzip";

interface RunRequest {
  id: number;
  root: string;
  args: string[];
}

process.parentPort.on("message", (event) => {
  const { id, root, args } = event.data as RunRequest;
  void runSevenZip(root, args).then((result) => process.parentPort.postMessage({ id, ...result }));
});
