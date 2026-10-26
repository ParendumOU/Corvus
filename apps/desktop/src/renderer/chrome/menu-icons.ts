/**
 * The icons of the bookmarks bar's "»" menu, a native menu built in the main process (menus.ts):
 * the same icons the bar shows, drawn here as PNGs since only the chrome UI can decode every kind
 * of site icon (.ico, SVG, WebP…) and draw the letter tile and the folder.
 */
import type { Bookmark } from "@corvus/shared";
import { chromeApi } from "../common/api";
import { hostOf, letterTile } from "../common/ui";

/** Drawn at twice the 16px a menu shows them at, so they stay sharp on high-DPI screens. */
const PX = 32;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The icon did not load"));
    img.src = src;
  });
}

/** An image (a data: URL, which keeps the canvas readable) scaled into the icon square. */
async function drawImage(g: CanvasRenderingContext2D, src: string): Promise<void> {
  g.drawImage(await loadImage(src), 0, 0, PX, PX);
}

/** The letter tile <Favicon> shows for a site without an icon (common/ui.tsx). */
function drawLetter(g: CanvasRenderingContext2D, host: string): void {
  const { letter, color } = letterTile(host);
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(0, 0, PX, PX, PX / 4);
  g.fill();
  g.fillStyle = "#fff";
  g.font = `600 ${Math.round(PX * 0.6)}px ${getComputedStyle(document.body).fontFamily}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(letter, PX / 2, PX / 2 + 1);
}

/** An inline SVG icon of the bar (a folder, the globe, Corvus's mark) in the colour it is drawn with. */
async function drawSvg(g: CanvasRenderingContext2D, svg: SVGSVGElement): Promise<void> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("width", String(PX));
  copy.setAttribute("height", String(PX));
  copy.style.color = getComputedStyle(svg).color;
  await drawImage(g, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`);
}

/**
 * The bar's icons for these items (laid out but hidden past the bar's end), as PNG data: URLs by
 * bookmark id: the site's icon from Corvus's cache, else the letter tile, or the folder, globe or
 * Corvus mark the bar draws. One that cannot be drawn is left out (the menu shows no icon there).
 */
export async function barMenuIcons(box: HTMLElement | null, items: Array<{ bookmark: Bookmark; index: number }>): Promise<Record<string, string>> {
  const web = items.filter(({ bookmark: b }) => b.kind === "bookmark" && /^https?:/i.test(b.url ?? ""));
  const sites = web.length > 0 ? await chromeApi().call("bookmarks.siteIcons", web.map(({ bookmark: b }) => b.url ?? "")) : [];
  const siteIcon = new Map(web.map(({ bookmark: b }, i) => [b.id, sites[i] ?? null]));
  const icons: Record<string, string> = {};
  await Promise.all(
    items.map(async ({ bookmark: b, index }) => {
      const canvas = document.createElement("canvas");
      canvas.width = PX;
      canvas.height = PX;
      const g = canvas.getContext("2d");
      if (!g) return;
      try {
        const svg = box?.querySelector<SVGSVGElement>(`[data-bar-index="${index}"] svg`);
        const site = siteIcon.get(b.id);
        if (site) await drawImage(g, site).catch(() => drawLetter(g, hostOf(b.url ?? "")));
        else if (siteIcon.has(b.id)) drawLetter(g, hostOf(b.url ?? ""));
        else if (svg) await drawSvg(g, svg);
        else return;
        icons[b.id] = canvas.toDataURL("image/png");
      } catch {
        // Left without an icon.
      }
    }),
  );
  return icons;
}
