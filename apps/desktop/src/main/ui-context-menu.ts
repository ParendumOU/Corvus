import { Menu, type BaseWindow, type MenuItemConstructorOptions, type View, type WebContents } from "electron";
import { tr } from "./menu-i18n";

/** What the menu needs from Electron's context-menu params. */
export type UiMenuParams = Pick<Electron.ContextMenuParams, "isEditable" | "editFlags" | "selectionText" | "misspelledWord" | "dictionarySuggestions">;

/** The webContents calls the menu makes (a subset, so tests can pass a fake). */
export type UiMenuTarget = Pick<WebContents, "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll" | "replaceMisspelling"> & {
  session: Pick<WebContents["session"], "addWordToSpellCheckerDictionary">;
};

/**
 * The right-click menu of Corvus's own UI (the Assist panel, the toolbar and Command Bar fields):
 * spelling suggestions and the usual editing commands in text fields, Copy for selected text.
 * Empty where there is nothing to do, so no menu shows.
 */
export function uiContextMenuItems(wc: UiMenuTarget, params: UiMenuParams): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (params.isEditable && params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
    if (params.dictionarySuggestions.length === 0) items.push({ label: tr("No spelling suggestions"), enabled: false });
    items.push({ label: tr("Add to dictionary"), click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    items.push({ type: "separator" });
  }
  if (params.isEditable) {
    const f = params.editFlags;
    items.push(
      { label: tr("Undo"), enabled: f.canUndo, click: () => wc.undo() },
      { label: tr("Redo"), enabled: f.canRedo, click: () => wc.redo() },
      { type: "separator" },
      { label: tr("Cut"), enabled: f.canCut, click: () => wc.cut() },
      { label: tr("Copy"), enabled: f.canCopy, click: () => wc.copy() },
      { label: tr("Paste"), enabled: f.canPaste, click: () => wc.paste() },
      { label: tr("Paste as plain text"), enabled: f.canPaste, click: () => wc.pasteAndMatchStyle() },
      { type: "separator" },
      { label: tr("Select all"), enabled: f.canSelectAll, click: () => wc.selectAll() },
    );
  } else if (params.selectionText.trim()) {
    items.push({ label: tr("Copy"), click: () => wc.copy() }, { label: tr("Select all"), click: () => wc.selectAll() });
  }
  return items;
}

/** Shows uiContextMenuItems on right-click in `view` (placed in `win`). */
export function attachUiContextMenu(win: BaseWindow, view: View, wc: WebContents): void {
  wc.on("context-menu", (_event, params) => {
    const items = uiContextMenuItems(wc, params);
    if (items.length === 0) return;
    const at = view.getBounds();
    Menu.buildFromTemplate(items).popup({ window: win, x: at.x + params.x, y: at.y + params.y });
  });
}
