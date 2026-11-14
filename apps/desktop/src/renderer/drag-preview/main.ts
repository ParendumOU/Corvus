import { carriesTabs, type DragPreviewBridge, type DragPreviewState } from "../../shared/drag-preview";
import { setUiLanguage, t } from "../common/i18n";
import "../common/theme.css";
import "./drag-preview.css";

declare global {
  interface Window {
    corvusDragPreview?: DragPreviewBridge;
  }
}

const bridge = window.corvusDragPreview;
const root = document.getElementById("root")!;
root.innerHTML = '<div class="dp"><div class="dp-strip"><div class="dp-tab"><span class="dp-title"></span><span class="dp-count" hidden></span></div></div><div class="dp-page"></div><div class="dp-hint"></div></div>';
const title = root.querySelector<HTMLElement>(".dp-title")!;
const count = root.querySelector<HTMLElement>(".dp-count")!;
const pageView = root.querySelector<HTMLElement>(".dp-page")!;
const hint = root.querySelector<HTMLElement>(".dp-hint")!;

function show(state: DragPreviewState): void {
  setUiLanguage(state.language);
  title.textContent = state.title || t("New tab");
  count.hidden = state.count < 2;
  count.textContent = String(state.count);
  pageView.style.backgroundImage = state.thumbnail ? `url("${state.thumbnail}")` : "";
  hint.textContent = state.count > 1 ? t("Drop to open these tabs in a new window") : t("Drop to open in a new window");
}

bridge?.onState(show);

// The preview sits under the pointer: it takes the strip's tab drags, so the system shows a move
// pointer, and a drop on it opens the new window (main knows which tabs and where).
const accept = (e: DragEvent): void => {
  if (!e.dataTransfer || !carriesTabs([...e.dataTransfer.types])) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
};
document.addEventListener("dragenter", accept);
document.addEventListener("dragover", accept);
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer || !carriesTabs([...e.dataTransfer.types])) return;
  e.preventDefault();
  bridge?.drop();
});
