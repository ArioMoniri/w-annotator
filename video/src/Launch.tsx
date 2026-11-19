import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Easing, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';
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

export const TITLE = 72;
export const END = 100;
const OVERLAP = 10; // frames of cross-fade between the cards and the footage
const APP_W = 1440;
const APP_H = 900;
const BAR = 34;

const ORANGE = '#E69F00';
const SKY = '#56B4E9';
const INK = '#F2F4F7';
const MUTED = '#A4ACB9';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const CAPTIONS: Record<string, string> = {
  open: 'Open MHA, NIfTI, NRRD, DICOM',
  paint: 'Paint and erase in any plane',
  fill: 'Fill between slices',
  segments: 'Lock, hide, rename segments',
  room: 'Edit together in a room',
  save: 'Save as .nii.gz, .mha, .nrrd',
};

const inOut = Easing.inOut(Easing.cubic);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const fade = (f: number, a: number, b: number, c: number, d: number) => interpolate(f, [a, b, c, d], [0, 1, 1, 0], { ...clamp, easing: inOut });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const Background = () => (
  <AbsoluteFill style={{ background: '#0F1115' }}>
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(900px 600px at 12% 8%, rgba(230,159,0,0.07), transparent 70%), radial-gradient(1000px 700px at 90% 96%, rgba(86,180,233,0.07), transparent 70%)',
      }}
    />
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
}

/** A window frame with the footage inside. The camera zooms the content, not the frame. */
const AppWindow = ({ rect, title, cam, cursor, since, opacity = 1, children }: { rect: Rect; title: string; cam: number[]; cursor: number[]; since: number; opacity?: number; children: ReactNode }) => {
  const s = rect.w / APP_W;
  const [z, cx, cy] = cam;
  const vw = APP_W / z;
  const vh = APP_H / z;
  const left = Math.min(Math.max(cx - vw / 2, 0), APP_W - vw);
  const top = Math.min(Math.max(cy - vh / 2, 0), APP_H - vh);
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        opacity,
        borderRadius: 14,
        overflow: 'hidden',
        background: '#14171C',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.09), 0 30px 90px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35)',
      }}
    >
      <div style={{ height: BAR, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', background: '#1B1F26', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ position: 'absolute', left: 14, display: 'flex', gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 11, height: 11, borderRadius: '50%', background: '#3A404B' }} />
          ))}
        </div>
        <span style={{ font: `500 14px ${FONT}`, color: MUTED, letterSpacing: 0.2 }}>{title}</span>
      </div>
      <div style={{ position: 'relative', width: rect.w, height: rect.w * (APP_H / APP_W), overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: APP_W, height: APP_H, transformOrigin: '0 0', transform: `scale(${s * z}) translate(${-left}px, ${-top}px)` }}>
          {children}
          <Cursor x={cursor[0]} y={cursor[1]} down={cursor[2] === 1} scale={1.25 / (s * z)} since={since} />
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

const Footage = () => {
  const frame = useCurrentFrame();
  const f = Math.min(Math.max(frame, 0), track.n - 1);
  const single: Rect = { x: (1920 - 1440) / 2, y: 28, w: 1440 };
  const leftRect: Rect = { x: 28, y: 196, w: 920 };
  const rightRect: Rect = { x: 972, y: 196, w: 920 };
  const d = track.dual;
  const t = d ? fade(f, d[0], d[0] + 12, d[1] - 12, d[1]) : 0;
  const a: Rect = { x: lerp(single.x, leftRect.x, t), y: lerp(single.y, leftRect.y, t), w: lerp(single.w, leftRect.w, t) };
  const b: Rect = { x: lerp(1920 + 40, rightRect.x, t), y: rightRect.y, w: rightRect.w };
  return (
    <AbsoluteFill>
      <AppWindow rect={a} title={t > 0.5 ? 'W Annotator · Mina' : 'W Annotator'} cam={track.az[f]} cursor={track.a[f]} since={sinceDown(track.a, f)}>
        <OffthreadVideo src={staticFile('footage-a.mp4')} style={video} muted />
      </AppWindow>
      {d && f >= d[0] && f < d[1] && (
        <AppWindow rect={b} title="W Annotator · Sam" cam={track.bz[f]} cursor={track.b[f]} since={sinceDown(track.b, f)} opacity={t}>
          <Sequence from={d[0]} layout="none">
            <OffthreadVideo src={staticFile('footage-b.mp4')} style={video} muted />
          </Sequence>
        </AppWindow>
      )}
      {track.scenes.map(([name, from, to], i) => {
        const o = fade(f, from + 2, from + 11, to - 9, to);
        if (o <= 0 || !CAPTIONS[name]) return null;
        return (
          <div key={name} style={{ position: 'absolute', left: 0, right: 0, bottom: 26, display: 'flex', justifyContent: 'center', opacity: o, transform: `translateY(${(1 - o) * 10}px)` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 26px 13px 22px', borderRadius: 999, background: 'rgba(24,27,33,0.94)', boxShadow: '0 0 0 1px rgba(255,255,255,0.10), 0 10px 30px rgba(0,0,0,0.45)' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: i % 2 ? SKY : ORANGE }} />
              <span style={{ font: `600 30px ${FONT}`, color: INK, letterSpacing: 0.1, whiteSpace: 'nowrap' }}>{CAPTIONS[name]}</span>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const TitleCard = () => {
  const f = useCurrentFrame();
  const up = (from: number) => interpolate(f, [from, from + 12], [0, 1], { ...clamp, easing: inOut });
  const line = (from: number): CSSProperties => ({ opacity: up(from), transform: `translateY(${(1 - up(from)) * 12}px)` });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', fontFamily: FONT }}>
      <Img src={staticFile('logo.svg')} style={{ width: 200, height: 200, ...line(2) }} />
      <div style={{ font: `650 92px ${FONT}`, color: INK, letterSpacing: -1.5, marginTop: 18, ...line(8) }}>W Annotator</div>
      <div style={{ font: `400 38px ${FONT}`, color: MUTED, marginTop: 22, ...line(16) }}>View and correct segmentation masks. Alone or together.</div>
    </AbsoluteFill>
  );
};

const EndCard = () => {
  const f = useCurrentFrame();
  const up = (from: number) => interpolate(f, [from, from + 12], [0, 1], { ...clamp, easing: inOut });
  const line = (from: number): CSSProperties => ({ opacity: up(from), transform: `translateY(${(1 - up(from)) * 12}px)` });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', fontFamily: FONT }}>
      <Img src={staticFile('logo.svg')} style={{ width: 132, height: 132, ...line(4) }} />
      <div style={{ font: `650 60px ${FONT}`, color: INK, letterSpacing: -0.8, marginTop: 10, ...line(8) }}>W Annotator</div>
      <div style={{ font: `500 44px ${FONT}`, color: INK, marginTop: 44, ...line(14) }}>Free for non-commercial use</div>
      <div style={{ font: `500 34px ${MONO}`, color: SKY, marginTop: 26, ...line(20) }}>github.com/ArioMoniri/w-annotator</div>
      <div style={{ font: `400 24px ${FONT}`, color: MUTED, marginTop: 56, ...line(26) }}>PolyForm Noncommercial 1.0.0 · © Ariorad Moniri · Not a medical device</div>
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
