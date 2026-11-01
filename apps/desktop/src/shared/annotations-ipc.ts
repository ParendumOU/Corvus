/**
 * IPC contract for page annotations (highlights + notes).
 *
 * Two surfaces:
 *   - Tab preload <-> main: plain ipcRenderer channels. The preload (isolated world, DOM access) owns
 *     the in-page selection toolbar and highlight rendering; main owns persistence. Main never trusts
 *     the sender: every create/update/delete is re-validated against a real tab main frame.
 *   - corvus://annotations manager page -> main: the typed InternalRpc surface (AnnotationLibraryRpc).
 */
import type { Annotation, AnnotationAnchor, AnnotationColor } from "./annotations";

/** Preload -> main: the user highlighted a selection. */
export const ANNOTATION_CREATE_CHANNEL = "corvus:annotation-create";
/** Preload -> main: edit a highlight's note or color (from the in-page popover). */
export const ANNOTATION_UPDATE_CHANNEL = "corvus:annotation-update";
/** Preload -> main: delete a highlight (from the in-page popover). */
export const ANNOTATION_DELETE_CHANNEL = "corvus:annotation-delete";
/** Main -> preload: (re)apply the saved annotations for this page. */
export const ANNOTATION_APPLY_CHANNEL = "corvus:annotation-apply";
/** Main -> preload: an AI agent is acting on the page, so its clicks and selections are not the person's. */
export const ANNOTATION_AGENT_CHANNEL = "corvus:annotation-agent";

export interface AnnotationCreateRequest {
  url: string;
  pageTitle: string;
  color: AnnotationColor;
  note: string;
  anchor: AnnotationAnchor;
}

export interface AnnotationUpdateRequest {
  id: string;
  note?: string;
  color?: AnnotationColor;
}

export interface AnnotationDeleteRequest {
  id: string;
}

/** The in-page toolbar's and popover's text, in Corvus's language. */
export interface AnnotationLabels {
  toolbar: string;
  colors: Record<AnnotationColor, string>;
  note: string;
  notePlaceholder: string;
  saveHighlight: string;
  noNote: string;
  editNote: string;
  save: string;
  delete: string;
}

/** What the preload renders. scrollToId (if present) is scrolled into view after re-anchoring. */
export interface AnnotationApplyMessage {
  annotations: Annotation[];
  scrollToId?: string;
  labels: AnnotationLabels;
}

/** Manager page (corvus://annotations) methods. */
export interface AnnotationLibraryRpc {
  "annotations.list"(query: string): Annotation[];
  "annotations.updateNote"(id: string, note: string): void;
  "annotations.setColor"(id: string, color: AnnotationColor): void;
  "annotations.remove"(id: string): void;
  "annotations.clear"(): void;
  /** Open the annotated page in a new tab and scroll to the given annotation. */
  "annotations.open"(id: string): void;
  /** Export all annotations as Markdown via a save dialog; returns false if cancelled. */
  "annotations.export"(): boolean;
}
