import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { trapTab } from '../ui/focus';
import { Hint } from './Hints';
import { endTour, tourBack, tourNext, tourWithSample, tourWithoutSample, useTour } from './state';
import { cutout, placeCard, stepsFor, type Rect, type Size, type TourState } from './steps';

const CORNER = 10;

/** The box around every on-screen element the step points at, or null when there is none. */
function measure(targets: string[]): Rect | null {
  let box: { l: number; t: number; r: number; b: number } | null = null;
  for (const name of targets)
    for (const el of document.querySelectorAll(`[data-tour~="${name}"]`)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      box = box
        ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) }
        : { l: r.left, t: r.top, r: r.right, b: r.bottom };
    }
  if (!box) return null;
  return cutout({ x: Math.round(box.l), y: Math.round(box.t), w: Math.round(box.r - box.l), h: Math.round(box.b - box.t) }, { w: window.innerWidth, h: window.innerHeight });
}

const same = (a: Rect | null, b: Rect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

function Layer({ tour }: { tour: TourState }) {
  const steps = stepsFor(tour.kind);
  const step = tour.phase === 'steps' ? steps[tour.index] : null;
  const card = useRef<HTMLDivElement>(null);
  const [hole, setHole] = useState<Rect | null>(null);
  const [view, setView] = useState<Size>({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState<Size>({ w: 304, h: 200 });
  const [opening, setOpening] = useState(false);

  // Follow the target: it can appear late, slide in, or move when the window is resized.
  const follow = useCallback(() => {
    const next = step ? measure(step.targets) : null;
    setHole((prev) => (same(prev, next) ? prev : next));
    setView((prev) => (prev.w === window.innerWidth && prev.h === window.innerHeight ? prev : { w: window.innerWidth, h: window.innerHeight }));
  }, [step]);
  useLayoutEffect(() => {
    follow();
    const timer = setInterval(follow, 200);
    window.addEventListener('resize', follow);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', follow);
    };
  }, [follow]);

  // The card's own size changes from step to step; placement needs the real one.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const read = () => setSize((prev) => (prev.w === el.offsetWidth && prev.h === el.offsetHeight ? prev : { w: el.offsetWidth, h: el.offsetHeight }));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keyboard focus stays in the card and goes back where it was afterwards.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    card.current?.querySelector<HTMLElement>('[data-primary]')?.focus();
  }, [tour.phase, tour.index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        if (card.current) trapTab(e, card.current);
        return;
      }
      // Nothing behind the tour reacts to keys while it is open.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        endTour();
      } else if (tour.phase === 'steps' || tour.phase === 'end') {
        const onButton = (e.target as HTMLElement | null)?.tagName === 'BUTTON';
        if (e.key === 'ArrowRight' || (e.key === 'Enter' && !onButton)) {
          e.preventDefault();
          if (tour.phase === 'steps') tourNext();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          tourBack();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tour.phase]);

  // With nothing to point at, the hole closes to a point and the whole window is dimmed.
  const h = hole ?? { x: Math.round(view.w / 2), y: Math.round(view.h / 2), w: 0, h: 0 };
  const r = hole ? Math.min(CORNER, h.w / 2, h.h / 2) : 0;
  const at = placeCard(hole, size, view, step?.prefer);
  const move = (x: number, y: number) => ({ transform: `translate(${x}px, ${y}px)` });

  return (
    <div
      className="tour"
      data-testid="tour"
      data-phase={tour.phase}
      onScroll={(e) => {
        // Belt and braces for engines without overflow: clip.
        e.currentTarget.scrollTop = 0;
        e.currentTarget.scrollLeft = 0;
      }}
    >
      <div className="tour-dim" aria-hidden="true">
        <i style={move(0, h.y - view.h)} />
        <i style={move(0, h.y + h.h)} />
        <i style={move(h.x - view.w, 0)} />
        <i style={move(h.x + h.w, 0)} />
        <b data-corner="tl" style={{ ...move(h.x, h.y), width: r, height: r }} />
        <b data-corner="tr" style={{ ...move(h.x + h.w - r, h.y), width: r, height: r }} />
        <b data-corner="bl" style={{ ...move(h.x, h.y + h.h - r), width: r, height: r }} />
        <b data-corner="br" style={{ ...move(h.x + h.w - r, h.y + h.h - r), width: r, height: r }} />
      </div>
      {hole && <div className="tour-hole" data-testid="tour-hole" key={step?.id} style={{ left: h.x, top: h.y, width: h.w, height: h.h }} />}
      <div
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome tour"
        data-testid="tour-card"
        data-step={step?.id ?? tour.phase}
        data-targets={step?.targets.join(' ')}
        ref={card}
        style={move(at.x, at.y)}
      >
        {tour.phase === 'offer' && (
          <div className="tour-body" key="offer">
            <h2>Welcome to W Annotator</h2>
            <p>A short tour of the main controls. The sample is a public research scan.</p>
            <div className="tour-choices">
              <button
                className="btn primary lg"
                data-primary
                disabled={opening}
                onClick={() => {
                  setOpening(true);
                  void tourWithSample().finally(() => setOpening(false));
                }}
              >
                {opening ? 'Opening the sample…' : 'Open a sample to look around'}
              </button>
              <button className="btn secondary lg" disabled={opening} onClick={tourWithoutSample}>
                Look around without it
              </button>
              <button className="btn text" disabled={opening} onClick={() => endTour()}>
                Skip tour
              </button>
            </div>
          </div>
        )}
        {step && (
          <div className="tour-body" key={step.id}>
            {step.hint && <Hint id={step.hint} />}
            <div className="tour-head">
              <h2>{step.title}</h2>
              <button className="btn text" onClick={() => endTour()}>
                Skip tour
              </button>
            </div>
            <p aria-live="polite">{step.body}</p>
            <div className="tour-foot">
              <span className="tour-dots" role="img" aria-label={`Step ${tour.index + 1} of ${steps.length}`}>
                {steps.map((s, i) => (
                  <i key={s.id} data-on={i === tour.index} />
                ))}
              </span>
              <button className="btn secondary" disabled={tour.index === 0} onClick={tourBack}>
                Back
              </button>
              <button className="btn primary" data-primary onClick={tourNext}>
                Next
              </button>
            </div>
          </div>
        )}
        {tour.phase === 'end' && (
          <div className="tour-body" key="end">
            <h2>You're set.</h2>
            <p>You can replay this tour from Settings, under Help.</p>
            {tour.sample ? (
              <div className="tour-choices">
                <button className="btn primary lg" data-primary onClick={() => endTour()}>
                  Keep the sample open
                </button>
                <button className="btn secondary lg" onClick={() => endTour(true)}>
                  Close the sample
                </button>
              </div>
            ) : (
              <div className="tour-foot end">
                <button className="btn primary" data-primary onClick={() => endTour()}>
                  Done
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The welcome tour: a dimmed layer with a hole around the control being explained, and a card beside it. */
export function Tour() {
  const tour = useTour();
  return tour.phase === 'off' ? null : <Layer tour={tour} />;
}
