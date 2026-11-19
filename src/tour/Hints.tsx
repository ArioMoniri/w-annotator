import type { JSX } from 'react';
import type { HintId } from './steps';

/*
 * Small looping drawings for the tour card. Plain SVG moved with CSS
 * transforms and opacity (see the tour block in styles.css). Each one is drawn
 * in its finished state, which is what shows when motion is reduced.
 */

const SEG_A = '#E69F00';
const SEG_B = '#56B4E9';

function Scroll() {
  return (
    <>
      {/* A mouse with a turning wheel. */}
      <rect x="62" y="12" width="22" height="34" rx="11" className="line" />
      <rect x="71.5" y="19" width="3" height="8" rx="1.5" className="solid hint-wheel" />
      {/* A stack of slices with the current one marked. */}
      {[14, 22, 30, 38, 46].map((y) => (
        <rect key={y} x="126" y={y - 1.5} width="64" height="3" rx="1.5" className="faint" />
      ))}
      <rect x="122" y="28.5" width="72" height="3" rx="1.5" className="accent hint-slice" />
    </>
  );
}

function BrushStroke() {
  return (
    <>
      <line x1="66" y1="38" x2="182" y2="20" stroke={SEG_A} strokeWidth="16" strokeLinecap="round" opacity="0.7" />
      {/* Slides away to uncover the stroke. */}
      <rect x="52" y="4" width="150" height="50" className="cover hint-cover" />
      <circle cx="182" cy="20" r="9" className="line hint-brush" />
    </>
  );
}

function Slices() {
  return (
    <>
      {[56, 108, 160].map((x, i) => (
        <g key={x}>
          <rect x={x} y="10" width="38" height="38" rx="4" className="line faint-line" />
          <ellipse cx={x + 19} cy="29" rx={i === 1 ? 11 : i === 0 ? 9 : 13} ry="9" fill={SEG_A} opacity="0.85" className={i === 1 ? 'hint-fill' : undefined} />
        </g>
      ))}
    </>
  );
}

function Cursors() {
  const pointer = 'M0 0 L0 13 L3.6 9.8 L6.2 15.4 L8.4 14.4 L5.8 8.9 L10.4 8.9 Z';
  return (
    <>
      <path d="M70 36 q 20 -22 46 -8" stroke={SEG_A} strokeWidth="8" strokeLinecap="round" fill="none" opacity="0.7" />
      <path d="M140 22 q 20 20 44 6" stroke={SEG_B} strokeWidth="8" strokeLinecap="round" fill="none" opacity="0.7" />
      <g className="hint-cursor-a">
        <path d={pointer} transform="translate(116 28)" fill="#7AB0FF" stroke="#0a0b0d" strokeWidth="0.75" />
      </g>
      <g className="hint-cursor-b">
        <path d={pointer} transform="translate(184 28)" fill="#F29E6B" stroke="#0a0b0d" strokeWidth="0.75" />
      </g>
    </>
  );
}

const HINTS: Record<HintId, () => JSX.Element> = { scroll: Scroll, brush: BrushStroke, slices: Slices, cursors: Cursors };

export function Hint({ id }: { id: HintId }) {
  const Drawing = HINTS[id];
  return (
    <svg className="tour-hint" data-hint={id} viewBox="0 0 256 58" aria-hidden="true" focusable="false">
      <Drawing />
    </svg>
  );
}
