/**
 * Tab inside dialogs. The app moves focus itself rather than leave Tab to the webview: on
 * macOS, Safari and the desktop app's webview skip buttons, checkboxes and sliders with plain
 * Tab unless a system setting is on, which would leave most of a dialog out of reach.
 */

/** What decides whether Tab stops at an element. */
export interface Control {
  tag: string;
  /** The `type` of an input; empty for anything else. */
  type: string;
  /** The `tabindex` attribute as written, or null when there is none. */
  tabindex: string | null;
  disabled: boolean;
  /** Takes up room on screen. */
  shown: boolean;
}

const NATIVE = ['button', 'input', 'select', 'textarea', 'a', 'summary'];
/** Everything that could take Tab. Links only with an address. */
const CANDIDATES = 'button, input, select, textarea, a[href], summary, [tabindex]';

/** Whether Tab stops at this control. */
export function takesTab(c: Control): boolean {
  if (c.disabled || !c.shown) return false;
  if (c.tabindex !== null) {
    const index = Number.parseInt(c.tabindex, 10);
    if (index < 0) return false;
    if (index >= 0) return true;
  }
  const tag = c.tag.toLowerCase();
  if (tag === 'input' && c.type.toLowerCase() === 'hidden') return false;
  return NATIVE.includes(tag);
}

/**
 * Which of `count` stops Tab goes to. `from` says where focus is among them: how many stops
 * come before it, and whether it is on one. Null when focus is outside. Wraps at both ends;
 * -1 when there are no stops.
 */
export function nextStop(count: number, from: { before: number; onStop: boolean } | null, back: boolean): number {
  if (count <= 0) return -1;
  if (!from) return back ? count - 1 : 0;
  const next = back ? from.before - 1 : from.before + (from.onStop ? 1 : 0);
  return ((next % count) + count) % count;
}

/** The controls inside `root` that Tab stops at, in order. */
export function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CANDIDATES)).filter((el) =>
    takesTab({
      tag: el.tagName,
      type: el.getAttribute('type') ?? '',
      tabindex: el.getAttribute('tabindex'),
      disabled: el.matches(':disabled'),
      shown: isShown(el),
    }),
  );
}

/** On screen: has a box, is not hidden, and is not inside a closed disclosure, which Chromium keeps a box for. */
function isShown(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  return typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : true;
}

/**
 * Handles a Tab key press for a dialog: focus goes to the next control inside `root`, or the
 * one before with Shift, and never leaves it. Returns false, and does nothing, for any other key.
 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  // Ctrl+Tab and ⌘ Tab belong to the system. Option+Tab is taken too: it is how Safari reaches every control.
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.isComposing) return false;
  e.preventDefault();
  const stops = tabStops(root);
  const active = document.activeElement;
  const from =
    active && root.contains(active)
      ? {
          before: stops.filter((s) => s !== active && s.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).length,
          onStop: stops.includes(active as HTMLElement),
        }
      : null;
  let at = nextStop(stops.length, from, e.shiftKey);
  // A stop that turns the focus down is passed over, so Tab never gets stuck in front of it.
  for (let tries = 0; tries < stops.length; tries++) {
    const target = stops[at];
    target.focus();
    if (document.activeElement === target) {
      // As the webview does on Tab: a text field arrives with its text selected.
      if (target instanceof HTMLInputElement) target.select();
      break;
    }
    at = nextStop(stops.length, { before: at, onStop: true }, e.shiftKey);
  }
  return true;
}
