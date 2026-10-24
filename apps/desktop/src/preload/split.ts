// Preload for the split-view divider helper views. It builds a divider's DOM (the view loads an
// empty document whose hash says the axis: "#x" between columns, "#y" between rows) and reports
// drag gestures to the main process, which does the actual pane resizing.
// Runs in the preload's isolated world; exposes nothing to the page's own JS context.
import { ipcRenderer } from "electron";
import { SPLIT_DIVIDER_CHANNEL, type SplitDividerMessage } from "../shared/split";

// Type-checked with the Node project (no DOM lib); declare the globals this preload touches.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const document: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any;
declare const location: { hash: string };

function send(message: SplitDividerMessage): void {
  ipcRenderer.send(SPLIT_DIVIDER_CHANNEL, message);
}

window.addEventListener("DOMContentLoaded", () => {
  const rows = location.hash === "#y";
  const doc = document;
  const style = doc.createElement("style");
  style.textContent = [
    `html,body{margin:0;height:100%;overflow:hidden;background:transparent;cursor:${rows ? "row-resize" : "col-resize"}}`,
    rows
      ? ".ln{position:fixed;left:0;right:0;top:50%;transform:translateY(-50%);height:2px;background:#c3c7cd}.ln.drag{background:#1a73e8;height:4px}"
      : ".ln{position:fixed;top:0;bottom:0;left:50%;transform:translateX(-50%);width:2px;background:#c3c7cd}.ln.drag{background:#1a73e8;width:4px}",
    "@media(prefers-color-scheme:dark){.ln{background:#5f6368}.ln.drag{background:#8ab4f8}}",
  ].join("");
  doc.head.appendChild(style);
  const line = doc.createElement("div");
  line.className = "ln";
  doc.body.appendChild(line);

  let dragging = false;
  doc.body.addEventListener("pointerdown", (e: any) => {
    dragging = true;
    line.classList.add("drag");
    try {
      doc.body.setPointerCapture(e.pointerId);
    } catch {
      // capture is best-effort; the view is expanded full-content during the drag regardless.
    }
    send({ phase: "start" });
    e.preventDefault();
  });
  doc.body.addEventListener("pointermove", (e: any) => {
    if (!dragging) return;
    const fraction = rows ? e.clientY / Math.max(1, window.innerHeight) : e.clientX / Math.max(1, window.innerWidth);
    const at = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    if (rows) line.style.top = at;
    else line.style.left = at;
    send({ phase: "move", fraction });
  });
  const end = (e: any): void => {
    if (!dragging) return;
    dragging = false;
    line.classList.remove("drag");
    line.style.left = "";
    line.style.top = "";
    try {
      doc.body.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    send({ phase: "end" });
  };
  doc.body.addEventListener("pointerup", end);
  doc.body.addEventListener("pointercancel", end);
});
