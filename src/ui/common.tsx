import { useEffect, useRef, type ReactNode } from 'react';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Calls `onAway` on a click outside the element or on Escape. */
export function useDismiss<T extends HTMLElement>(open: boolean, onAway: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onAway();
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

export function Modal(props: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input:not([disabled]), button.primary, button');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const items = Array.from(
          ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary'),
        );
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
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
          const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          ref.current!.value = String(Number(ref.current!.value || props.value) + step);
          commit();
        } else if (e.key === 'Escape') {
          ref.current!.value = String(props.value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function Choice<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  label: string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg-control" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
