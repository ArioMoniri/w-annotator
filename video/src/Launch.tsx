import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Easing, Img, OffthreadVideo, Sequence, continueRender, delayRender, interpolate, staticFile, useCurrentFrame } from 'remotion';
// Inter (SIL Open Font License 1.1), bundled from the package so the render needs no network.
import '@fontsource-variable/inter/opsz.css';
import raw from './track.json';

/** Written by scripts/build-footage.cjs from the recorded session. One entry per footage frame. */
interface Track {
  n: number;
  /** [name, first frame, end frame) of each scene */
  scenes: [string, number, number][];
  /** [first frame, end frame) of the part with two windows */
  dual: [number, number] | null;
  /** per frame: cursor x, y in app pixels and whether the button is down */
  a: [number, number, number][];
  b: [number, number, number][];
  /** per frame: zoom and the centre of the view in app pixels, already smoothed */
  az: [number, number, number][];
  bz: [number, number, number][];
}
const track = raw as unknown as Track;

export const TITLE = 66;
export const END = 96;
const OVERLAP = 10; // frames of cross-fade between the cards and the footage
const APP_W = 1440;
const APP_H = 900;

const ORANGE = '#E69F00';
const SKY = '#56B4E9';
const INK = '#F3F4F6';
const MUTED = '#9CA3AF';
const FONT = '"Inter Variable", sans-serif';

// Every frame waits for Inter, so no frame is drawn in a fallback face.
if (typeof document !== 'undefined') {
  const handle = delayRender('Loading Inter');
  Promise.all(['400', '500', '600'].map((w) => document.fonts.load(`${w} 40px "Inter Variable"`)))
    .then((faces) => {
      if (faces.some((f) => f.length === 0)) throw new Error('Inter did not load');
      continueRender(handle);
    })
    .catch((err) => {
      throw err;
    });
}

/** Type scale. Sizes and line heights sit on an 8 px grid. */
const type = (weight: number, size: number, line: number, tracking: number): CSSProperties => ({
  fontFamily: FONT,
  fontWeight: weight,
  fontSize: size,
  lineHeight: `${line}px`,
  letterSpacing: `${tracking}em`,
  fontOpticalSizing: 'auto',
  fontFeatureSettings: '"ss01", "cv11"',
  whiteSpace: 'nowrap',
});

const CAPTIONS: Record<string, string> = {
  open: 'Open any image with any mask',
  paint: 'Fix the mask by hand',
  fill: 'Paint three slices. Fill the rest.',
  refine: 'Grow, shrink, smooth, measure',
  room: 'Correct the same mask together, live',
  save: 'Save as NIfTI, MetaImage, NRRD or DICOM SEG',
};

const inOut = Easing.inOut(Easing.cubic);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const fade = (f: number, a: number, b: number, c: number, d: number) => interpolate(f, [a, b, c, d], [0, 1, 1, 0], { ...clamp, easing: inOut });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** One soft light in the mesh. It drifts on a slow ellipse; nothing moves more than a few pixels a second. */
const Glow = ({ color, size, x, y, rx, ry, period, phase }: { color: string; size: number; x: number; y: number; rx: number; ry: number; period: number; phase: number }) => {
  const frame = useCurrentFrame();
  const a = (frame / period) * 2 * Math.PI + phase;
  return (
    <div
      style={{
        position: 'absolute',
        left: x + Math.cos(a) * rx - size / 2,
        top: y + Math.sin(a) * ry - size / 2,
        width: size,
        height: size,
        borderRadius: '50%',
        background: `radial-gradient(closest-side, ${color}, transparent)`,
      }}
    />
  );
};

/** Graphite gradient mesh with a hint of the two brand colours, a vignette and a little grain. */
const Background = () => (
  <AbsoluteFill style={{ background: '#101216' }}>
    <AbsoluteFill style={{ background: 'linear-gradient(160deg, #191C22 0%, #111317 48%, #0C0D10 100%)' }} />
    <Glow color="rgba(72,80,96,0.50)" size={1500} x={520} y={160} rx={120} ry={60} period={900} phase={0} />
    <Glow color="rgba(230,159,0,0.13)" size={1100} x={210} y={900} rx={110} ry={70} period={760} phase={1.9} />
    <Glow color="rgba(86,180,233,0.14)" size={1200} x={1720} y={220} rx={100} ry={80} period={840} phase={3.6} />
    <Glow color="rgba(40,46,58,0.60)" size={1300} x={1380} y={980} rx={130} ry={50} period={1000} phase={5.1} />
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.07, mixBlendMode: 'overlay' }}>
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse 75% 70% at 50% 46%, transparent 55%, rgba(0,0,0,0.42) 100%)' }} />
  </AbsoluteFill>
);

const Cursor = ({ x, y, down, scale, since }: { x: number; y: number; down: boolean; scale: number; since: number }) => (
  <div style={{ position: 'absolute', left: x, top: y, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
    {since < 14 && (
      <div
        style={{
          position: 'absolute',
          left: -(8 + since * 2),
          top: -(8 + since * 2),
          width: 16 + since * 4,
          height: 16 + since * 4,
          borderRadius: '50%',
          border: `2px solid ${INK}`,
          opacity: 0.7 * (1 - since / 14),
        }}
      />
    )}
    <svg width="26" height="26" viewBox="0 0 26 26" style={{ position: 'absolute', left: -3, top: -2, transform: `scale(${down ? 0.88 : 1})`, transformOrigin: '3px 2px', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.5))' }}>
      <path d="M3 2 L3 20 L8 15.4 L11.4 23 L14.6 21.6 L11.3 14.2 L18 14.2 Z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  </div>
);

interface Rect {
  x: number;
  y: number;
  w: number;
  /** height of the title bar */
  bar: number;
}

const LIGHTS = ['#FF5F57', '#FEBC2E', '#28C840'];

/**
 * A window: a title bar, then the footage below it. The two never share pixels: the bar is its own strip
 * and the footage is clipped to the box under it. The camera zooms the footage inside that box, not the window.
 */
const AppWindow = ({ rect, title, cam, cursor, since, opacity = 1, children }: { rect: Rect; title: string; cam: number[]; cursor: number[]; since: number; opacity?: number; children: ReactNode }) => {
  const s = rect.w / APP_W;
  const [z, cx, cy] = cam;
  const vw = APP_W / z;
  const vh = APP_H / z;
  const left = Math.min(Math.max(cx - vw / 2, 0), APP_W - vw);
  const top = Math.min(Math.max(cy - vh / 2, 0), APP_H - vh);
  const k = rect.bar / 36;
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        opacity,
        borderRadius: 14,
        boxShadow: '0 0 0 1px rgba(255,255,255,0.10), 0 2px 6px rgba(0,0,0,0.30), 0 24px 48px rgba(0,0,0,0.38), 0 60px 120px rgba(0,0,0,0.42)',
      }}
    >
      <div style={{ borderRadius: 14, overflow: 'hidden', background: '#0B0C0F' }}>
        <div style={{ height: rect.bar, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(#2A2D34, #23262C)', boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)' }}>
          <div style={{ position: 'absolute', left: 14 * k, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 8 * k }}>
            {LIGHTS.map((c) => (
              <div key={c} style={{ width: 12 * k, height: 12 * k, borderRadius: '50%', background: c, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.25)' }} />
            ))}
          </div>
          <span style={{ ...type(500, 13 * k, 16 * k, 0), color: '#B4B9C2' }}>{title}</span>
        </div>
        <div style={{ position: 'relative', width: rect.w, height: rect.w * (APP_H / APP_W), overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: APP_W, height: APP_H, transformOrigin: '0 0', transform: `scale(${s * z}) translate(${-left}px, ${-top}px)` }}>
            {children}
            <Cursor x={cursor[0]} y={cursor[1]} down={cursor[2] === 1} scale={1.25 / (s * z)} since={since} />
          </div>
        </div>
      </div>
    </div>
  );
};

/** Frames since the button last went down in this window. */
function sinceDown(list: number[][], f: number): number {
  for (let i = f; i > 0 && f - i < 14; i--) if (list[i][2] === 1 && list[i - 1][2] === 0) return f - i;
  return 99;
}

const video: CSSProperties = { width: APP_W, height: APP_H, display: 'block' };

// The window sits in the top 950 px; the caption has the band below it to itself.
const SINGLE: Rect = { x: 256, y: 34, w: 1408, bar: 36 };
const LEFT: Rect = { x: 24, y: 184, w: 924, bar: 30 };
const RIGHT: Rect = { x: 972, y: 184, w: 924, bar: 30 };

const Caption = ({ f }: { f: number }) => {
  const shown = track.scenes.filter(([name]) => CAPTIONS[name]);
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 950, height: 130 }}>
      {shown.map(([name, from, to]) => {
        const o = fade(f, from + 2, from + 12, to - 8, to);
        if (o <= 0) return null;
        return (
          <div key={name} style={{ position: 'absolute', left: 0, right: 0, top: 30, textAlign: 'center', opacity: o, transform: `translateY(${(1 - o) * 8}px)`, ...type(500, 36, 48, -0.014), color: INK }}>
            {CAPTIONS[name]}
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 96, display: 'flex', justifyContent: 'center', gap: 8 }}>
        {shown.map(([name, from, to], i) => {
          const p = interpolate(f, [from, to], [0, 1], clamp);
          return (
            <div key={name} style={{ width: 36, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.16)', overflow: 'hidden' }}>
              <div style={{ width: `${p * 100}%`, height: '100%', background: i % 2 ? SKY : ORANGE }} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Footage = () => {
  const frame = useCurrentFrame();
  const f = Math.min(Math.max(frame, 0), track.n - 1);
  const d = track.dual;
  const t = d ? fade(f, d[0], d[0] + 14, d[1] - 14, d[1]) : 0;
  const a: Rect = { x: lerp(SINGLE.x, LEFT.x, t), y: lerp(SINGLE.y, LEFT.y, t), w: lerp(SINGLE.w, LEFT.w, t), bar: lerp(SINGLE.bar, LEFT.bar, t) };
  const b: Rect = { ...RIGHT, x: lerp(1920 + 40, RIGHT.x, t) };
  return (
    <AbsoluteFill>
      <AppWindow rect={a} title={t > 0.5 ? 'W Annotator — Mina' : 'W Annotator'} cam={track.az[f]} cursor={track.a[f]} since={sinceDown(track.a, f)}>
        <OffthreadVideo src={staticFile('footage-a.mp4')} style={video} muted />
      </AppWindow>
      {d && f >= d[0] && f < d[1] && (
        <AppWindow rect={b} title="W Annotator — Sam" cam={track.bz[f]} cursor={track.b[f]} since={sinceDown(track.b, f)} opacity={t}>
          <Sequence from={d[0]} layout="none">
            <OffthreadVideo src={staticFile('footage-b.mp4')} style={video} muted />
          </Sequence>
        </AppWindow>
      )}
      <Caption f={f} />
    </AbsoluteFill>
  );
};

const useRise = () => {
  const f = useCurrentFrame();
  return (from: number): CSSProperties => {
    const o = interpolate(f, [from, from + 14], [0, 1], { ...clamp, easing: inOut });
    return { opacity: o, transform: `translateY(${(1 - o) * 12}px)` };
  };
};

const TitleCard = () => {
  const rise = useRise();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <Img src={staticFile('logo.svg')} style={{ width: 176, height: 176, ...rise(2) }} />
      <div style={{ ...type(600, 104, 112, -0.035), color: INK, marginTop: 24, ...rise(7) }}>W Annotator</div>
      <div style={{ ...type(400, 36, 48, -0.012), color: MUTED, marginTop: 24, ...rise(13) }}>View and correct segmentation masks. Alone or together.</div>
    </AbsoluteFill>
  );
};

const EndCard = () => {
  const rise = useRise();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <Img src={staticFile('logo.svg')} style={{ width: 120, height: 120, ...rise(4) }} />
      <div style={{ ...type(600, 64, 72, -0.03), color: INK, marginTop: 16, ...rise(8) }}>W Annotator</div>
      <div style={{ ...type(500, 44, 56, -0.02), color: INK, marginTop: 56, ...rise(14) }}>Free for non-commercial use</div>
      <div style={{ ...type(500, 32, 40, -0.008), color: SKY, marginTop: 16, ...rise(20) }}>github.com/ArioMoniri/w-annotator</div>
      <div style={{ ...type(400, 22, 32, 0), color: MUTED, marginTop: 72, ...rise(26) }}>© Ariorad Moniri · PolyForm Noncommercial 1.0.0 · Not a medical device</div>
    </AbsoluteFill>
  );
};
export const Launch = () => {
  const frame = useCurrentFrame();
  const footEnd = TITLE + track.n;
  const titleO = interpolate(frame, [TITLE - OVERLAP, TITLE], [1, 0], { ...clamp, easing: inOut });
  const footO = fade(frame, TITLE - OVERLAP + 4, TITLE + 6, footEnd - OVERLAP, footEnd);
  const endO = interpolate(frame, [footEnd - 4, footEnd + 8], [0, 1], { ...clamp, easing: inOut });
  return (
    <AbsoluteFill>
      <Background />
      <AbsoluteFill style={{ opacity: titleO }}>
        <Sequence durationInFrames={TITLE} layout="none">
          <TitleCard />
        </Sequence>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: footO, transform: `scale(${0.985 + 0.015 * footO})` }}>
        <Sequence from={TITLE} durationInFrames={track.n} layout="none">
          <Footage />
        </Sequence>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: endO }}>
        <Sequence from={footEnd - 4} layout="none">
          <EndCard />
        </Sequence>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
