import { ChevronDown, PanelRight, Users } from 'lucide-react';
import { useCallback, useState } from 'react';
import { formatCode, initials } from '../collab/protocol';
import { set, toast, useStore } from '../state/store';
import { closeImage, leaveRoom, saveMask } from '../session';
import { copyText } from '../platform';
import { jumpTo } from '../viewer/engine';
import { useDismiss, useKeyHint } from './common';
import { pickDicomFolder, pickImage, pickMask } from './files';
import { ThemeControl } from './ThemeControl';

function FileMenu() {
  const image = useStore((s) => s.image);
  const maskName = useStore((s) => s.maskName);
  const dirty = useStore((s) => s.dirty);
  const update = useStore((s) => s.update);
  const key = useKeyHint();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0 }}>
      <button
        className="filebtn"
        data-tour="file"
        aria-haspopup="menu"
        aria-expanded={open}
        title={maskName ? `${image?.name} · ${maskName}` : image?.name}
        onClick={() => setOpen(!open)}
      >
        <span className="name">{image?.name ?? 'No image'}</span>
        {maskName && <span className="sub">· {maskName}</span>}
        {dirty && <span className="dot" title="Unsaved changes" />}
        <ChevronDown size={14} color="var(--text-3)" />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ left: 0, top: 34, minWidth: 240 }}>
          <button className="item" role="menuitem" onClick={run(pickImage)}>
            Open image… {key('file.openImage') && <kbd>{key('file.openImage')}</kbd>}
          </button>
          <button className="item" role="menuitem" onClick={run(pickDicomFolder)}>
            Open DICOM folder…
          </button>
          <button className="item" role="menuitem" onClick={run(pickMask)}>
            Open mask… {key('file.openMask') && <kbd>{key('file.openMask')}</kbd>}
          </button>
          <hr />
          <button className="item" role="menuitem" onClick={run(() => void saveMask())}>
            Save mask… {key('file.save') && <kbd>{key('file.save')}</kbd>}
          </button>
          <hr />
          <button className="item" role="menuitem" onClick={run(() => set({ settings: 'profile' }))}>
            Settings… {key('app.settings') && <kbd>{key('app.settings')}</kbd>}
          </button>
          <div className="row">
            Appearance
            <ThemeControl />
          </div>
          <hr />
          <button className="item" role="menuitem" onClick={run(() => set({ report: 'bug' }))}>
            Report a problem…
          </button>
          {update && (
            <button className="item" role="menuitem" onClick={run(() => void update.install())}>
              Restart to update
            </button>
          )}
          <button className="item" role="menuitem" onClick={run(closeImage)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

function RoomButton() {
  const room = useStore((s) => s.room);
  const peers = useStore((s) => s.peers);
  const hasImage = useStore((s) => !!s.image);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);

  if (!room) {
    return (
      <button
        className="btn secondary"
        data-tour="share"
        data-tip="Start or join a room"
        data-tip-align="end"
        onClick={() => set({ roomModal: hasImage ? 'start' : 'join' })}
      >
        <Users size={14} /> Share
      </button>
    );
  }
  const code = formatCode(room.code);
  const copy = async (text: string, done: string) => {
    if (await copyText(text)) toast('success', done);
  };
  return (
    <div ref={ref} data-tour="share" style={{ position: 'relative' }}>
      <div className="avatars" style={{ display: 'inline-flex', marginRight: 8, verticalAlign: 'middle' }}>
        {peers.slice(0, 4).map((p) => (
          <button
            key={p.id}
            className="avatar"
            style={{ background: p.color }}
            title={p.name}
            aria-label={`Go to ${p.name}'s view`}
            onClick={() => p.cursor && jumpTo(p.cursor.w)}
          >
            {initials(p.name)}
          </button>
        ))}
        {peers.length > 4 && <span className="avatar more">+{peers.length - 4}</span>}
      </div>
      <button
        className="pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Room ${code}, ${peers.length + 1} people`}
        data-tip={open ? undefined : `Room ${code} · ${peers.length + 1} ${peers.length ? 'people' : 'person'}`}
        data-tip-align="end"
        onClick={() => setOpen(!open)}
        data-testid="room-pill"
      >
        <span className={`dot ${room.status === 'online' ? 'ok' : 'warn'}`} />
        <span className="num">{code}</span>
        {room.status !== 'online' && <span>{room.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>}
      </button>
      {open && (
        <div className="menu" role="menu" style={{ right: 0, top: 34, width: 280 }}>
          <div className="title">Room {code}</div>
          <button className="item" onClick={() => void copy(room.link, 'Invite link copied')}>
            Copy invite link
          </button>
          <button className="item" onClick={() => void copy(code, 'Code copied')}>
            Copy code
          </button>
          <hr />
          <div className="title">People</div>
          <div className="people">
            <div className="person">
              <span className="avatar" style={{ background: 'var(--bg-active)', color: 'var(--text-1)' }}>
                {initials(room.name)}
              </span>
              {room.name}
              <span className="tag">You</span>
            </div>
            {peers.map((p) => (
              <button
                key={p.id}
                className="person"
                title={p.cursor ? `Go to ${p.name}'s view` : undefined}
                onClick={() => p.cursor && jumpTo(p.cursor.w)}
              >
                <span className="avatar" style={{ background: p.color }}>
                  {initials(p.name)}
                </span>
                {p.name}
              </button>
            ))}
          </div>
          <hr />
          <button className="item danger" onClick={() => (setOpen(false), leaveRoom())}>
            Leave room
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const hasImage = useStore((s) => !!s.image);
  const panelOpen = useStore((s) => s.panelOpen);
  const key = useKeyHint();
  return (
    <header className="topbar" data-tauri-drag-region>
      {hasImage ? <FileMenu /> : <span className="brand">W Annotator</span>}
      <div className="spacer" data-tauri-drag-region />
      <RoomButton />
      {hasImage && (
        <button
          className="iconbtn"
          aria-label={panelOpen ? 'Hide segments' : 'Show segments'}
          aria-pressed={panelOpen}
          data-tip={`${panelOpen ? 'Hide' : 'Show'} segments  ${key('view.panel')}`.trimEnd()}
          data-tip-align="end"
          onClick={() => set({ panelOpen: !panelOpen })}
        >
          <PanelRight size={16} />
        </button>
      )}
    </header>
  );
}
