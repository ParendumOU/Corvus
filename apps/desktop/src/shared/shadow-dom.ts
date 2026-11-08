/**
 * Form fields inside open shadow roots: sign-in forms built as web components keep their inputs there,
 * where a document-wide query, `document.activeElement` and `elementFromPoint` never reach (they stop
 * at the component's host). The tab preload uses these to read a click in such a field, and the
 * autofill scripts (shared/credential-scripts.ts) embed their source to find and fill it. Each function
 * is self-contained on purpose: no imports and no outer names (the preload is type-checked without the
 * DOM library, hence the small structural types).
 */

interface QueryRoot {
  querySelectorAll(selectors: string): ArrayLike<unknown>;
}

interface FocusRoot {
  readonly activeElement: unknown;
}

interface PointRoot {
  elementFromPoint(x: number, y: number): unknown;
}

/**
 * Every element under `root` that matches `selector`, also inside open shadow roots at any depth (the
 * root's own first, then each shadow root's). Closed shadow roots stay closed.
 */
export function deepQueryAll(root: QueryRoot, selector: string): unknown[] {
  const found: unknown[] = [];
  const roots: QueryRoot[] = [root];
  // A bound for pages that nest components without end.
  for (let i = 0; i < roots.length && i < 1000; i++) {
    const r = roots[i] as QueryRoot;
    const matches = r.querySelectorAll(selector);
    for (let j = 0; j < matches.length; j++) found.push(matches[j]);
    const all = r.querySelectorAll("*");
    for (let j = 0; j < all.length; j++) {
      const shadow = (all[j] as { shadowRoot?: QueryRoot | null }).shadowRoot;
      if (shadow) roots.push(shadow);
    }
  }
  return found;
}

/** The focused element itself, inside the shadow roots of the hosts that hold it. */
export function deepActiveElement(doc: FocusRoot): unknown {
  let el = doc.activeElement as { shadowRoot?: FocusRoot | null } | null;
  for (let depth = 0; el && el.shadowRoot && el.shadowRoot.activeElement && depth < 50; depth++) el = el.shadowRoot.activeElement as typeof el;
  return el;
}

/** The element at a point of the viewport, inside the shadow roots of the hosts there. */
export function deepElementFromPoint(doc: PointRoot, x: number, y: number): unknown {
  let el = doc.elementFromPoint(x, y) as { shadowRoot?: PointRoot | null } | null;
  for (let depth = 0; el && el.shadowRoot && depth < 50; depth++) {
    const inner = el.shadowRoot.elementFromPoint(x, y) as typeof el;
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}
