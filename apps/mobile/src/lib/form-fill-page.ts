/**
 * What runs in the page to fill a saved address or card, with the desktop's address and card kits
 * (apps/desktop/src/shared/address-fields.ts, card-fields.ts) passed in. The phone cannot ship them as
 * functions: the app's JavaScript engine (Hermes) keeps no source text, so String(fn) gives nothing to
 * inject. So the functions below and the kits are turned into text by test/form-fill.test.ts, which
 * writes them to form-fill-source.ts and fails when that file no longer matches them. For the same
 * reason every exported function is self-contained: no imports and no outer names, only its arguments
 * and globals of the page.
 *
 * The phone sees no click in a field (pages get no channel into Corvus), so it fills the first form of
 * the right kind: the form of the field that has the focus when that is one, else the first form of
 * that kind, else the page as a whole. Only empty fields the person can see are written. The top frame
 * and the frames of the same site are searched; other sites' frames cannot be reached from the page.
 */
import type { AddressFields } from './autofill-addresses';
import type { CardFields } from './autofill-cards';

type Role = string | null;
type Option = { value: string; text: string };

/** How one kind of form (addresses or cards) is told apart and what its fields take. */
export interface FormAdapter {
  roleOf(el: PageField): Role;
  isForm(roles: readonly Role[]): boolean;
  /** The value of each field, in order; `focused` is the index of the focused field or -1. */
  values(fields: readonly PageField[], roles: readonly Role[], focused: number): (string | null)[];
  option(options: readonly Option[], wanted: string): string | null;
}

/** The parts of the desktop's AddressKit the fill uses. */
export interface PageAddressKit {
  addressFieldFacts(el: PageField): unknown;
  classifyAddressField(facts: never): Role;
  isAddressForm(roles: readonly Role[]): boolean;
  valuesForRoles(roles: readonly Role[], a: AddressFields): (string | null)[];
  matchOption(options: readonly Option[], wanted: string): string | null;
}

/** The parts of the desktop's CardKit the fill uses. */
export interface PageCardKit {
  cardFieldFacts(el: PageField): unknown;
  classifyCardField(facts: never): Role;
  isCardForm(roles: readonly Role[]): boolean;
  planCardFill(fields: readonly { facts: never; value: string; anchor: boolean }[], card: CardFields, cvv: string): (string | null)[];
  matchCardOption(options: readonly Option[], wanted: string): string | null;
}

interface PageEvent {
  readonly type: string;
}

export interface PageWindow {
  location: { origin: string };
  document: PageDocument;
  innerWidth: number;
  scrollX: number;
  scrollY: number;
  /** The frame this window is shown in, in the page around it; null for the top page. */
  frameElement: PageNode | null;
  getComputedStyle(el: PageNode): { visibility: string; display?: string; opacity?: string };
  Event: new (type: string, init: { bubbles: boolean }) => PageEvent;
  HTMLInputElement: { prototype: object };
  HTMLSelectElement: { prototype: object };
  HTMLTextAreaElement: { prototype: object };
}

interface PageRoot {
  querySelectorAll(selector: string): ArrayLike<PageField>;
}

interface PageDocument extends PageRoot {
  activeElement: PageField | null;
  defaultView: PageWindow | null;
}

/** An element as the visibility check reads it: a field, an element around it or a frame. */
interface PageNode {
  parentElement?: PageNode | null;
  ownerDocument: PageDocument;
  getBoundingClientRect(): { left: number; right: number; bottom: number; width: number; height: number };
}

export interface PageField extends PageRoot, PageNode {
  tagName: string;
  value: string;
  disabled?: boolean;
  readOnly?: boolean;
  selectedIndex?: number;
  options?: ArrayLike<Option>;
  form?: PageRoot | null;
  contentDocument?: PageDocument | null;
  dispatchEvent(event: PageEvent): boolean;
}

/** An address's adapter: the desktop's address detection and values. */
export function addressAdapter(makeKit: () => PageAddressKit, address: AddressFields): FormAdapter {
  const kit = makeKit();
  return {
    roleOf: (el) => kit.classifyAddressField(kit.addressFieldFacts(el) as never),
    isForm: (roles) => kit.isAddressForm(roles),
    values: (_fields, roles) => kit.valuesForRoles(roles, address),
    option: (options, wanted) => kit.matchOption(options, wanted),
  };
}

/**
 * A card's adapter: the desktop's card detection and plan, with the CVV the person just typed. The
 * desktop plans from the clicked field; here that is the focused card field, else the card number.
 */
export function cardAdapter(makeKit: () => PageCardKit, card: CardFields, cvv: string): FormAdapter {
  const kit = makeKit();
  return {
    roleOf: (el) => kit.classifyCardField(kit.cardFieldFacts(el) as never),
    isForm: (roles) => kit.isCardForm(roles),
    values: (fields, roles, focused) => {
      const anchor = focused >= 0 && roles[focused] !== null ? focused : roles.indexOf('number');
      return kit.planCardFill(
        fields.map((el, i) => ({ facts: kit.cardFieldFacts(el) as never, value: '', anchor: i === anchor })),
        card,
        cvv,
      );
    },
    option: (options, wanted) => kit.matchCardOption(options, wanted),
  };
}

/** Fills the page of `win` as `adapter` says; returns the fields written, or -1 when the page is no longer `origin`. */
export function fillFormInPage(adapter: FormAdapter, origin: string, win: PageWindow): number {
  if (win.location.origin !== origin) return -1;
  const viewOf = (el: PageNode): PageWindow => el.ownerDocument.defaultView || win;
  // Whether the person can see the field. The focused one only needs a box; any other also a usable
  // size, a place on the page and nothing see-through around it, in each frame up to the top page, so
  // a page cannot collect through hidden fields what the person did not mean to give it.
  const visible = (el: PageField, focused: boolean): boolean => {
    let box: PageNode | null = el;
    for (let depth = 0; box && depth < 5; depth++) {
      const view = viewOf(box);
      const r = box.getBoundingClientRect();
      const style = view.getComputedStyle(box);
      if (!(r.width > 0 && r.height > 0) || style.visibility === 'hidden' || style.display === 'none') return false;
      if (focused) return true;
      if (r.width < 2 || r.height < 2 || r.right + view.scrollX <= 0 || r.bottom + view.scrollY <= 0 || r.left >= view.innerWidth) return false;
      for (let node: PageNode | null | undefined = box; node; node = node.parentElement) {
        if (!(parseFloat(view.getComputedStyle(node).opacity ?? '1') >= 0.1)) return false;
      }
      box = view === win ? null : view.frameElement || null;
    }
    return box === null;
  };

  const docs: PageDocument[] = [win.document];
  for (let d = 0; d < docs.length && docs.length < 20; d++) {
    const frames = docs[d]!.querySelectorAll('iframe, frame');
    for (let i = 0; i < frames.length; i++) {
      try {
        const inner = frames[i]!.contentDocument;
        if (inner) docs.push(inner);
      } catch {
        // Another site's frame: out of reach, as accepted for the phone.
      }
    }
  }

  let active = win.document.activeElement;
  for (let depth = 0; active && active.contentDocument && depth < 5; depth++) active = active.contentDocument.activeElement;
  const fieldsIn = (root: PageRoot): PageField[] =>
    Array.prototype.slice.call(root.querySelectorAll('input:not([type=hidden]), select, textarea'), 0, 200).filter((el: PageField) => !el.disabled && !el.readOnly && visible(el, el === active));

  const scopes: PageRoot[] = [];
  if (active && active.form) scopes.push(active.form);
  for (const doc of docs) {
    const forms = doc.querySelectorAll('form');
    for (let i = 0; i < forms.length; i++) scopes.push(forms[i]!);
  }
  for (const doc of docs) scopes.push(doc);

  for (const scope of scopes) {
    const fields = fieldsIn(scope);
    const roles = fields.map((el) => adapter.roleOf(el));
    if (!adapter.isForm(roles)) continue;
    const values = adapter.values(fields, roles, active ? fields.indexOf(active) : -1);
    let filled = 0;
    fields.forEach((el, i) => {
      let value = values[i];
      if (value === null || value === undefined || value === '') return;
      const isSelect = el.tagName === 'SELECT';
      const current = isSelect ? ((el.selectedIndex ?? 0) > 0 ? String(el.value || '') : '') : String(el.value || '');
      if (current.trim() !== '') return;
      if (isSelect) {
        value = adapter.option(Array.prototype.map.call(el.options || [], (o: Option) => ({ value: o.value, text: o.text })) as Option[], value);
        if (value === null) return;
      }
      const view = viewOf(el);
      const proto = isSelect ? view.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new view.Event('input', { bubbles: true }));
      el.dispatchEvent(new view.Event('change', { bubbles: true }));
      filled++;
    });
    return filled;
  }
  return 0;
}
