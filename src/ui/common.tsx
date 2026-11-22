import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { formatCombo, useShortcuts, type ActionId } from '../state/shortcuts';
import { trapTab } from './focus';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** The key an action is bound to right now, ready to show, or '' when it has none. */
export function useKeyHint(): (id: ActionId) => string {
  const bindings = useShortcuts((s) => s.bindings);
  return (id) => (bindings[id] ? formatCombo(bindings[id], isMac) : '');
}

/**
 * Calls `onAway` on a click outside the element or on Escape. Escape puts focus back on what
 * opened it: `trigger` when given, otherwise the `aria-haspopup` button inside the element.
 * With `holdTab`, for a popover that is a small dialog, Tab and Shift+Tab are handled as in
 * `Modal`: they reach every control and stay inside.
 */
export function useDismiss<T extends HTMLElement>(open: boolean, onAway: () => void, trigger?: () => HTMLElement | null, holdTab = false) {
  const ref = useRef<T>(null);
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const holdTabRef = useRef(holdTab);
  holdTabRef.current = holdTab;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onAway();
        (triggerRef.current?.() ?? ref.current?.querySelector<HTMLElement>('[aria-haspopup]'))?.focus();
      } else if (holdTabRef.current && ref.current) {
        trapTab(e, ref.current);
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, onAway]);
  return ref;
}

/**
 * Lets a closed dialog fade out: a lifeless copy of it stays for --dur-fast while the real
 * one is already gone, so every way of closing gets the same exit.
 */
function fadeOut(scrim: HTMLElement): void {
  const ms = parseFloat(getComputedStyle(scrim).getPropertyValue('--dur-fast')) || 0;
  if (ms <= 0 || !scrim.parentElement) return;
  const ghost = scrim.cloneNode(true) as HTMLElement;
  ghost.setAttribute('data-leaving', '');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  for (const el of [ghost, ...ghost.querySelectorAll('*')]) {
    for (const name of ['role', 'aria-modal', 'aria-label', 'data-testid', 'id']) el.removeAttribute(name);
  }
  scrim.parentElement.appendChild(ghost);
  setTimeout(() => ghost.remove(), ms);
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  /** Where focus goes on close when what opened the dialog is no longer on screen. A CSS selector. */
  returnTo?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest handlers, so the listeners below never act on stale ones.
  const live = useRef(props);
  live.current = props;
  useLayoutEffect(() => {
    const scrim = ref.current?.parentElement;
    return () => {
      if (scrim) fadeOut(scrim);
    };
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const emptyInput = Array.from(root?.querySelectorAll<HTMLInputElement>('input[type="text"]:not([disabled])') ?? []).find((i) => !i.value);
    const target =
      emptyInput ??
      root?.querySelector<HTMLElement>('button.primary:not([disabled])') ??
      root?.querySelector<HTMLElement>('button:not(.close):not([disabled])');
    target?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        live.current.onClose();
      }
      if (ref.current) trapTab(e, ref.current);
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      // Back to what opened the dialog. A menu item or a button that has since gone cannot take
      // focus, so fall back to the control the dialog belongs to rather than to the page.
      const find = (selector?: string) => (selector ? document.querySelector<HTMLElement>(selector) : null);
      const opener = previous && previous !== document.body && previous.isConnected ? previous : null;
      const target = find(live.current.returnTo) ?? opener ?? find('.filebtn, .dropzone .btn');
      target?.focus?.();
    };
  }, []);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}${props.className ? ` ${props.className}` : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        {props.children}
      </div>
    </div>
  );
}

export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  onChange: (v: number) => void;
}) {
  const fill = ((props.value - props.min) / (props.max - props.min || 1)) * 100;
  return (
    <input
      type="range"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      value={props.value}
      style={{ ['--fill' as string]: `${fill}%` }}
      onChange={(e) => props.onChange(Number(e.target.value))}
    />
  );
}

export function NumberField(props: {
  value: number;
  label: string;
  wide?: boolean;
  min?: number;
  max?: number;
  /** What one press of an arrow key adds or takes; 1 unless given. */
  step?: number;
  onCommit: (v: number) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.value = String(props.value);
  }, [props.value]);
  const commit = () => {
    const el = ref.current!;
    let v = Number(el.value);
    if (!Number.isFinite(v) || el.value.trim() === '') {
      el.value = String(props.value);
      return;
    }
    if (props.min !== undefined) v = Math.max(props.min, v);
    if (props.max !== undefined) v = Math.min(props.max, v);
    el.value = String(v);
    props.onCommit(v);
  };
  return (
    <input
      ref={ref}
      className={`numfield${props.wide ? ' wide' : ''}`}
      aria-label={props.label}
      inputMode="decimal"
      defaultValue={props.value}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = (props.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          // Rounded, so a step of 0.01 does not leave 0.30000000000000004 in the field.
          ref.current!.value = String(Number((Number(ref.current!.value || props.value) + step).toFixed(6)));
          commit();
        } else if (e.key === 'Escape') {
          ref.current!.value = String(props.value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * One choice out of a few. A row of buttons where there is room; with `collapsed`, a list
 * with the same name and the same options, so no label ever has to be shortened.
 */
export function Choice<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  label: string;
  /** Id of a visible label, used in place of `label` when there is one. */
  labelledBy?: string;
  collapsed?: boolean;
  onChange: (v: T) => void;
}) {
  const name = { 'aria-label': props.labelledBy ? undefined : props.label, 'aria-labelledby': props.labelledBy };
  if (props.collapsed) {
    return (
      <select
        className="select choice"
        {...name}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value as T);
          // Give the keyboard back to the tool shortcuts.
          e.target.blur();
        }}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="seg-control" role="group" {...name}>
      {props.options.map((o) => (
        <button key={o.value} aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off setting. The visible label and help text live beside it and are tied to it by id. */
export function Switch(props: { on: boolean; labelledBy: string; describedBy?: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={props.on}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      onClick={() => props.onChange(!props.on)}
    >
      <i />
    </button>
  );
}
