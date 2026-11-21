import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Easing, Img, OffthreadVideo, Sequence, continueRender, delayRender, interpolate, staticFile, useCurrentFrame } from 'remotion';
// Inter (SIL Open Font License 1.1), bundled from the package so the render needs no network.
import '@fontsource-variable/inter/opsz.css';
import raw from './track.json';

/** Written by scripts/build-footage.cjs from the recorded session. One entry per footage frame. */
interface Track {
  /** size of the app window in CSS pixels */
  w: number;
  h: number;
  n: number;
  /** [name, first frame, end frame) of each scene */
  scenes: [string, number, number][];
  /** [first frame, end frame) of the part with two windows */
  dual: [number, number] | null;
  /** frames at which the picture changes at once (the layout of windows, or what the app shows between two scenes): a plain cut */
  cuts: number[];
  /** per frame: cursor x, y in app pixels and whether the button is down */
  a: [number, number, number][];
  b: [number, number, number][];
  /** per frame: zoom and the centre of the view in app pixels, already smoothed */
  az: [number, number, number][];
  bz: [number, number, number][];
  /** per frame: the axial slice on screen, counted from 1 */
  slice: number[];
  /** per frame: '' or the keys that are pressed ('save') */
  key: string[];
  /** per frame: -1, or how far the two dropped files have come (0 to 1), then 1 to 2 while they land */
  drop: number[];
}
const track = raw as unknown as Track;

export const TITLE = 54;
export const END = 60;
const OVERLAP = 10; // frames of cross-fade between the cards and the footage
const APP_W = track.w;
const APP_H = track.h;

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

/** A key as it is drawn in a caption or over the window. */
const Key = ({ label, size, lit }: { label: string; size: number; lit: boolean }) => (
  <span
    style={{
      ...type(600, size * 0.56, size, 0),
      display: 'inline-block',
      height: size,
      minWidth: size,
      padding: `0 ${size * 0.3}px`,
      boxSizing: 'border-box',
      textAlign: 'center',
      borderRadius: size * 0.2,
      color: lit ? '#111317' : INK,
      background: lit ? SKY : '#2A2E36',
      boxShadow: lit ? `0 ${size * 0.03}px 0 #2B7FB0` : `inset 0 0 0 1px rgba(255,255,255,0.16), 0 ${size * 0.07}px 0 #15171B`,
      transform: `translateY(${lit ? size * 0.04 : 0}px)`,
    }}
  >
    {label}
  </span>
);

/** One statement per scene: what the viewer is looking at. */
const CAPTIONS: Record<string, string> = {
  open: 'Open an image and its mask — MHA, NIfTI, NRRD or DICOM',
  paint: 'Paint to correct the mask',
  cut: 'Cut with a freehand loop',
  fill: 'Paint a few slices, preview the fill, apply',
  window: 'Pick a window: lung, abdomen, bone…',
  kinds: 'Share a copy, or let others view through your computer',
  room: 'Work on the same mask at the same time',
  save: 'Save it back as .nii.gz, .mha, .nrrd or DICOM SEG',
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

/** The pointer. `since` is the number of frames since the button went down: a soft ring spreads from the click. */
const Cursor = ({ x, y, down, scale, since }: { x: number; y: number; down: boolean; scale: number; since: number }) => (
  <div style={{ position: 'absolute', left: x, top: y, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
    {since < 16 && (
      <div
        style={{
          position: 'absolute',
          left: -(10 + since * 2.2),
          top: -(10 + since * 2.2),
          width: 20 + since * 4.4,
          height: 20 + since * 4.4,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.10)',
          border: `2px solid ${INK}`,
          opacity: 0.75 * (1 - since / 16),
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

/** The part of the app a camera shows: its left and top edge in app pixels. */
function view(cam: number[]): [number, number] {
  const [z, cx, cy] = cam;
  const vw = APP_W / z;
  const vh = APP_H / z;
  return [Math.min(Math.max(cx - vw / 2, 0), APP_W - vw), Math.min(Math.max(cy - vh / 2, 0), APP_H - vh)];
}

/** Where a point of the app is on the 1920 x 1080 frame. */
function onFrame(rect: Rect, cam: number[], x: number, y: number): [number, number] {
  const k = (rect.w / APP_W) * cam[0];
  const [left, top] = view(cam);
  return [rect.x + (x - left) * k, rect.y + rect.bar + (y - top) * k];
}

const LIGHTS = ['#FF5F57', '#FEBC2E', '#28C840'];

/**
 * A window: a title bar, then the footage below it. The two never share pixels: the bar is its own strip
 * and the footage is clipped to the box under it. The camera zooms the footage inside that box, not the window.
 */
const AppWindow = ({ rect, cam, cursor, since, pointer = true, children, over }: { rect: Rect; cam: number[]; cursor: number[]; since: number; pointer?: boolean; children: ReactNode; over?: ReactNode }) => {
  const s = rect.w / APP_W;
  const z = cam[0];
  const [left, top] = view(cam);
  const k = rect.bar / 36;
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
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
          <span style={{ ...type(500, 13 * k, 16 * k, 0), color: '#B4B9C2' }}>W Annotator</span>
        </div>
        <div style={{ position: 'relative', width: rect.w, height: rect.w * (APP_H / APP_W), overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: APP_W, height: APP_H, transformOrigin: '0 0', transform: `scale(${s * z}) translate(${-left}px, ${-top}px)` }}>
            {children}
            {pointer && <Cursor x={cursor[0]} y={cursor[1]} down={cursor[2] === 1} scale={1.5 / (s * z)} since={since} />}
          </div>
          {over}
        </div>
      </div>
    </div>
  );
};

/** Frames since the button last went down in this window. */
function sinceDown(list: number[][], f: number): number {
  for (let i = f; i > 0 && f - i < 16; i--) if (list[i][2] === 1 && list[i - 1][2] === 0) return f - i;
  return 99;
}

const video: CSSProperties = { width: APP_W, height: APP_H, display: 'block' };

// The window sits in the top 900 px; the caption has the band below it to itself.
const SINGLE: Rect = { x: 288, y: 22, w: 1344, bar: 36 };
const LEFT: Rect = { x: 24, y: 190, w: 924, bar: 30 };
const RIGHT: Rect = { x: 972, y: 190, w: 924, bar: 30 };

const sceneAt = (f: number) => track.scenes.find(([, from, to]) => f >= from && f < to);

const Caption = ({ f }: { f: number }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 916, height: 164 }}>
    {track.scenes.map(([name, from, to]) => {
      const o = fade(f, from + 1, from + 9, to - 7, to - 1);
      if (o <= 0 || !CAPTIONS[name]) return null;
      return (
        <div key={name} style={{ position: 'absolute', left: 0, right: 0, top: 0, textAlign: 'center', opacity: o, transform: `translateY(${(1 - o) * 8}px)` }}>
          <div style={{ ...type(500, 42, 56, -0.016), color: INK }}>{CAPTIONS[name]}</div>
          {name === 'fill' && (
            <div style={{ ...type(500, 30, 40, 0), color: MUTED, marginTop: 14, fontVariantNumeric: 'tabular-nums' }}>
              Slice <span style={{ color: SKY, fontWeight: 600 }}>{track.slice[f]}</span>
            </div>
          )}
        </div>
      );
    })}
  </div>
);

/** A file as it is carried to the window: an icon and its name. */
const FileChip = ({ name, color }: { name: string; color: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 56, padding: '0 20px 0 16px', borderRadius: 12, background: '#23262D', boxShadow: '0 0 0 1px rgba(255,255,255,0.14), 0 12px 28px rgba(0,0,0,0.5)' }}>
    <svg width="24" height="28" viewBox="0 0 24 28">
      <path d="M3 1.5 H14.5 L21 8 V24.5 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <path d="M14 2 V8.5 H20.5" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
    <span style={{ ...type(500, 28, 32, -0.005), color: INK }}>{name}</span>
  </div>
);

/** The two files on their way to the empty window. A drag between applications cannot be recorded, so it is drawn. */
const Drop = ({ f }: { f: number }) => {
  const d = track.drop[f];
  if (d < 0) return null;
  const end = onFrame(SINGLE, track.az[f], track.a[f][0], track.a[f][1]);
  const p = inOut(Math.min(d, 1));
  const x = lerp(-200, end[0], p);
  const y = lerp(760, end[1], p) - Math.sin(Math.PI * p) * 40;
  const land = Math.max(0, d - 1); // 0 to 1 once the files are let go
  return (
    <>
      <div style={{ position: 'absolute', left: x + 22, top: y + 26, opacity: 1 - Math.min(1, land * 1.6), transform: `scale(${1 - land * 0.35})`, transformOrigin: '0 0' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, transform: 'rotate(-2deg)' }}>
          <FileChip name="chest_ct.mha" color={ORANGE} />
        </div>
        <div style={{ position: 'absolute', left: 34, top: 66, transform: 'rotate(1.5deg)' }}>
          <FileChip name="lungs.nii.gz" color={SKY} />
        </div>
      </div>
      {d <= 1 && <Cursor x={x} y={y} down scale={1.5} since={99} />}
    </>
  );
};

/** Ctrl and S over the window while the mask is saved. */
const SaveKeys = ({ f }: { f: number }) => {
  const from = track.key.indexOf('save');
  if (from < 0) return null;
  const to = track.key.lastIndexOf('save') + 1;
  const o = fade(f, from - 8, from, to + 6, to + 16);
  if (o <= 0) return null;
  const lit = f >= from + 6 && f < to;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: '24%', display: 'flex', justifyContent: 'center', opacity: o }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '22px 30px 26px', borderRadius: 24, background: 'rgba(14,16,20,0.88)', boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 0 20px 50px rgba(0,0,0,0.5)' }}>
        <Key label="Ctrl" size={84} lit={lit} />
        <span style={{ ...type(500, 44, 84, 0), color: MUTED }}>+</span>
        <Key label="S" size={84} lit={lit} />
      </div>
    </div>
  );
};

const Person = ({ rect, name, color, opacity }: { rect: Rect; name: string; color: string; opacity: number }) => (
  <div style={{ position: 'absolute', left: rect.x, width: rect.w, top: rect.y - 84, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, opacity }}>
    <div style={{ ...type(600, 26, 48, 0), width: 48, height: 48, borderRadius: 24, textAlign: 'center', background: color, color: '#111317' }}>{name[0]}</div>
    <div style={{ ...type(500, 38, 48, -0.012), color: INK }}>{name}’s computer</div>
  </div>
);

const Footage = () => {
  const frame = useCurrentFrame();
  const f = Math.min(Math.max(frame, 0), track.n - 1);
  const d = track.dual;
  const two = d !== null && f >= d[0] && f < d[1];
  const scene = sceneAt(f);
  const firstDrop = track.drop.findIndex((v) => v >= 0);
  const carrying = scene?.[0] === 'open' && (track.drop[f] < 0 ? f < firstDrop : track.drop[f] <= 1);
  const landed = track.drop.findIndex((v) => v > 1);
  return (
    <AbsoluteFill>
      <AbsoluteFill>
        <AppWindow rect={two ? LEFT : SINGLE} cam={track.az[f]} cursor={track.a[f]} since={landed >= 0 && f >= landed && f - landed < 16 ? f - landed : sinceDown(track.a, f)} pointer={!carrying} over={two ? null : <SaveKeys f={f} />}>
          <OffthreadVideo src={staticFile('footage-a.mp4')} style={video} muted />
        </AppWindow>
        {two && d && (
          <>
            <AppWindow rect={RIGHT} cam={track.bz[f]} cursor={track.b[f]} since={sinceDown(track.b, f)}>
              <Sequence from={d[0]} layout="none">
                <OffthreadVideo src={staticFile('footage-b.mp4')} style={video} muted />
              </Sequence>
            </AppWindow>
            <Person rect={LEFT} name="Mina" color={SKY} opacity={1} />
            <Person rect={RIGHT} name="Sam" color={ORANGE} opacity={1} />
          </>
        )}
      </AbsoluteFill>
      <Drop f={f} />
      <Caption f={f} />
    </AbsoluteFill>
  );
};

const useRise = () => {
  const f = useCurrentFrame();
  return (from: number): CSSProperties => {
    const o = interpolate(f, [from, from + 10], [0, 1], { ...clamp, easing: inOut });
    return { opacity: o, transform: `translateY(${(1 - o) * 12}px)` };
  };
};

const TitleCard = () => {
  const rise = useRise();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <Img src={staticFile('logo.svg')} style={{ width: 176, height: 176, ...rise(0) }} />
      <div style={{ ...type(600, 104, 112, -0.035), color: INK, marginTop: 24, ...rise(3) }}>W Annotator</div>
      <div style={{ ...type(400, 40, 48, -0.012), color: MUTED, marginTop: 24, ...rise(6) }}>Open a scan and its mask. Fix the mask. Together.</div>
    </AbsoluteFill>
  );
};

const EndCard = () => {
  const rise = useRise();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <Img src={staticFile('logo.svg')} style={{ width: 120, height: 120, ...rise(2) }} />
      <div style={{ ...type(600, 64, 72, -0.03), color: INK, marginTop: 16, ...rise(4) }}>W Annotator</div>
      <div style={{ ...type(500, 40, 56, -0.016), color: INK, marginTop: 56, ...rise(7) }}>Free for non-commercial use · macOS, Windows, Linux</div>
      <div style={{ ...type(500, 34, 40, -0.008), color: SKY, marginTop: 20, ...rise(10) }}>github.com/ArioMoniri/w-annotator</div>
      <div style={{ ...type(400, 26, 32, 0), color: MUTED, marginTop: 64, ...rise(13) }}>© Ariorad Moniri</div>
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
