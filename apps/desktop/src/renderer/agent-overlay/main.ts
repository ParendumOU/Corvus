import type { OverlayBridge, OverlayEvent } from "../../shared/assist-ipc";
import "./overlay.css";

declare global {
  interface Window {
    corvusOverlay?: OverlayBridge;
  }
}

const CURSOR = `<svg width="30" height="34" viewBox="0 0 30 34" aria-hidden="true">
  <defs>
    <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7a5cff"/><stop offset="0.55" stop-color="#3b82f6"/><stop offset="1" stop-color="#14b8a6"/>
    </linearGradient>
  </defs>
  <path d="M3 2.5l22 11.2-9.6 2.6-4.4 9.4z" fill="url(#cg)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
</svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

const root = document.getElementById("root") as HTMLElement;
const edge = el("div", "edge", root);
const scan = el("div", "scan", root);
const ring = el("div", "ring", root);
const ripple = el("div", "ripple", root);
const cursor = el("div", "cursor", root);
cursor.innerHTML = CURSOR;
const caption = el("div", "caption", root);
const captionDot = el("span", "caption-dot", caption);
const captionText = el("span", "caption-text", caption);
void captionDot;

let pos = { x: window.innerWidth * 0.62, y: window.innerHeight * 0.72 };
let placed = false;

function place(node: HTMLElement, x: number, y: number): void {
  node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function restart(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

function placeCaption(x: number, y: number): void {
  const w = caption.offsetWidth || 220;
  const h = caption.offsetHeight || 30;
  const cx = Math.min(Math.max(8, x + 22), window.innerWidth - w - 8);
  const cy = y + 30 + h > window.innerHeight - 8 ? y - h - 14 : y + 30;
  place(caption, cx, Math.max(8, cy));
}

function act(e: Extract<OverlayEvent, { type: "act" }>): void {
  document.documentElement.classList.toggle("dark", e.dark);
  root.classList.add("on");
  captionText.textContent = e.caption;
  caption.dataset.kind = e.kind;
  restart(edge, "pulse");

  const target = e.target;
  if (target) {
    const pad = 5;
    ring.style.width = `${target.width + pad * 2}px`;
    ring.style.height = `${target.height + pad * 2}px`;
    place(ring, target.x - pad, target.y - pad);
    restart(ring, "show");
    const tx = target.x + Math.min(target.width * 0.5, 28);
    const ty = target.y + Math.min(target.height * 0.62, 22);
    if (!placed) {
      cursor.style.transition = "none";
      place(cursor, pos.x, pos.y);
      void cursor.offsetWidth;
      cursor.style.transition = "";
    }
    pos = { x: tx, y: ty };
    placed = true;
    cursor.classList.add("show");
    place(cursor, tx - 3, ty - 2);
    placeCaption(tx, ty);
    caption.classList.add("show");
    caption.classList.remove("top");
    ripple.style.left = `${tx}px`;
    ripple.style.top = `${ty}px`;
    ripple.classList.remove("go");
    if (e.kind === "click") {
      window.setTimeout(() => restart(ripple, "go"), 460);
    }
    ring.classList.toggle("typing", e.kind === "type");
  } else {
    ring.classList.remove("show");
    caption.classList.add("show", "top");
    caption.style.transform = "";
    if (e.kind === "read" || e.kind === "navigate" || e.kind === "scroll") restart(scan, "go");
    if (e.kind === "screenshot") restart(edge, "flash");
  }
}

function hide(): void {
  root.classList.remove("on");
  caption.classList.remove("show");
  ring.classList.remove("show");
}

window.corvusOverlay?.onEvent((e) => (e.type === "act" ? act(e) : hide()));
window.addEventListener("pointerdown", () => {
  hide();
  window.corvusOverlay?.dismiss();
});
