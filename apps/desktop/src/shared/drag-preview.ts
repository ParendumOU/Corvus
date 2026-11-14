import type { UiLanguage } from "./settings";

/**
 * The preview of a new window that follows the pointer while tabs are dragged out of their strip
 * (corvus://drag-preview, see main/tab-drag-preview.ts and shared/tab-tearoff.ts showsTearOffPreview).
 */

/** The tab strip's drag data: a tab (and those selected with it) or a whole group, by id. */
export const TAB_DRAG_MIME = "application/x-corvus-tab";
export const GROUP_DRAG_MIME = "application/x-corvus-group";

/** Main to the preview page: what it shows. */
export const DRAG_PREVIEW_EVENT = "corvus:drag-preview-event";
/** The preview page to main: the drag was dropped on it. */
export const DRAG_PREVIEW_DROP = "corvus:drag-preview-drop";

export interface DragPreviewState {
  language: UiLanguage;
  /** The title of the tab the window would show. */
  title: string;
  /** How many tabs go (several selected, or a group). */
  count: number;
  /** That tab's page, small (a data: URL), when it could be captured. */
  thumbnail: string | null;
}

export interface DragPreviewBridge {
  onState(listener: (state: DragPreviewState) => void): () => void;
  drop(): void;
}

/** Whether a drag carries tabs of the strip (the only drags the preview takes). */
export function carriesTabs(types: readonly string[]): boolean {
  return types.includes(TAB_DRAG_MIME) || types.includes(GROUP_DRAG_MIME);
}
