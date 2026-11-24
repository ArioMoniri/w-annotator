import { ChevronDown, PanelRight, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { initials } from '../collab/protocol';
import { useSettings } from '../state/settings';
import type { ActionId } from '../state/shortcuts';
import { set, toast, useStore, type Peer } from '../state/store';
import { chooseLayout } from '../state/views';
import { LAYOUTS, paneRects, parseLayout, type LayoutId } from '../viewer/layout';
import { closeImage, createInvite, endRoom, leaveRoom, listInvites, reconnectRoom, removeMember, revokeInvite, saveMask, type InviteRow } from '../session';
import { copyText } from '../platform';
import { jumpTo } from '../viewer/engine';
import { useDismiss, useKeyHint } from './common';
import { pickDatasetFolder, pickDicomFolder, pickImage, pickMask } from './files';
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
          <button className="item" role="menuitem" onClick={run(pickDatasetFolder)}>
            Open dataset folder…
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

/** When an invite link stops working, in a few words. */
function expiresIn(ms: number): string {
  if (ms <= 0) return 'expired';
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 1) return `expires in ${hours} h`;
  return `expires in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

function RoomButton() {
  const room = useStore((s) => s.room);
  const peers = useStore((s) => s.peers);
  const hasImage = useStore((s) => !!s.image);
  const [open, setOpen] = useState(false);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  const host = room?.role === 'host';
  const refresh = useCallback(() => void listInvites().then(setInvites), []);
  useEffect(() => {
    if (open && host) refresh();
  }, [open, host, refresh, peers.length]);

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
  const shared = room.kind === 'shared';
  const kindName = shared ? 'Shared copy' : host ? 'View through your computer' : `View through ${room.hostName ?? 'the host'}'s computer`;
  const people = `${peers.length + 1} ${peers.length ? 'people' : 'person'}`;
  const state = room.status === 'online' ? null : room.status === 'connecting' ? 'Connecting…' : 'Offline';
  // Over the segments panel the popover takes the panel's inner width, so no piece of a row shows beside it.
  const panel = open ? document.querySelector('.panel .seglist')?.getBoundingClientRect() : null;
  const pill = open ? ref.current?.querySelector('.pill')?.getBoundingClientRect() : null;
  const place: React.CSSProperties =
    panel && pill && panel.width > 0
      ? { position: 'fixed', top: pill.bottom + 6, left: panel.left + 6, width: panel.width - 12 }
      : { right: 0, top: 34, width: 300 };
  const copy = async (text: string, done: string) => {
    if (await copyText(text)) toast('success', done);
  };
  const newLink = async () => {
    const link = await createInvite();
    if (!link) return toast('error', "Couldn't make a link. Check your connection and try again.");
    refresh();
    await copy(link, 'Invite link copied. It works for one person, for 24 hours.');
  };
  const remove = (p: Peer) => {
    setOpen(false);
    set({
      confirm: {
        title: `Remove ${p.name}?`,
        body: shared
          ? `${p.name} keeps the copy already on their computer. They won't get further changes, and the link they joined with stops working.`
          : `${p.name} stops seeing the image at once and can't come back with the same link.`,
        confirm: 'Remove',
        danger: true,
        run: () => void removeMember(p.id),
      },
    });
  };
  const leave = () => {
    setOpen(false);
    set({
      confirm: {
        title: 'Leave the room?',
        body: 'Others can keep working. Nobody can invite or remove people until you come back. Your copy of the mask stays open here.',
        confirm: 'Leave',
        run: () => leaveRoom(),
      },
    });
  };
  const end = () => {
    setOpen(false);
    set({
      confirm: {
        title: shared ? 'Delete this room?' : 'End the room?',
        body: shared
          ? 'The room closes for everyone and its links stop working. People keep the copies already on their computers.'
          : 'Everyone is disconnected at once. Nothing stays on their devices.',
        confirm: shared ? 'Delete room' : 'End room',
        danger: true,
        run: endRoom,
      },
    });
  };
  const usable = invites.filter((i) => !i.revoked && i.uses < i.maxUses && i.expiresAt > Date.now());
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
        aria-label={`Room, ${kindName}, ${people}`}
        data-tip={open ? undefined : `${kindName} · ${people}`}
        data-tip-align="end"
        onClick={() => setOpen(!open)}
        data-testid="room-pill"
      >
        <span className={`dot ${room.status === 'online' ? 'ok' : 'warn'}`} />
        <span>Room</span>
        {state && <span>{state}</span>}
      </button>
      {open && (
        <div className="menu roommenu" role="menu" style={place}>
          <div className="title" data-testid="room-kind">
            {kindName}
          </div>
          {room.status === 'offline' && (
            <>
              <div className="note">{shared ? 'Offline. Your changes are merged when you reconnect.' : 'Offline. Reconnecting…'}</div>
              <button className="item" onClick={reconnectRoom}>
                Reconnect now
              </button>
            </>
          )}
          {room.note && <div className="note">{room.note}</div>}
          {shared && !host && room.hostAway && room.status === 'online' && (
            <div className="note">{room.hostName ?? 'The host'} is offline. You can keep working.</div>
          )}
          {host && (
            <>
              <button className="item" onClick={() => void newLink()}>
                New invite link
              </button>
              {usable.length > 0 && (
                <div className="links" data-testid="room-links">
                  {usable.map((i, n) => (
                    <div key={i.id} className="link">
                      <span>
                        Link {n + 1} · {expiresIn(i.expiresAt - Date.now())}
                      </span>
                      {i.link && (
                        <button className="btn text" onClick={() => void copy(i.link!, 'Invite link copied')}>
                          Copy
                        </button>
                      )}
                      <button className="btn text" onClick={() => void revokeInvite(i.id).then(refresh)}>
                        Switch off
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <hr />
          <div className="title">People</div>
          <div className="people">
            <div className="person">
              <span className="avatar" style={{ background: 'var(--bg-active)', color: 'var(--text-1)' }}>
                {initials(room.name)}
              </span>
              {room.name}
              <span className="tag">{host ? 'You · host' : 'You'}</span>
            </div>
            {peers.map((p) => (
              <div key={p.id} className="person" data-testid="room-person">
                <button className="who" title={p.cursor ? `Go to ${p.name}'s view` : undefined} onClick={() => p.cursor && jumpTo(p.cursor.w)}>
                  <span className="avatar" style={{ background: p.color }}>
                    {initials(p.name)}
                  </span>
                  {p.name}
                </button>
                {p.role === 'host' && <span className="tag">Host</span>}
                {host && !shared && p.seen !== undefined && (
                  <span className="tag">
                    {p.seen} {p.seen === 1 ? 'slice' : 'slices'} seen
                  </span>
                )}
                {host && (
                  <button className="btn text" aria-label={`Remove ${p.name}`} onClick={() => remove(p)}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <hr />
          {host && !shared ? (
            <button className="item danger" onClick={end}>
              End room
            </button>
          ) : (
            <>
              {/* Leaving ends nothing for the others, so it is not drawn like Delete below it. A host is asked first. */}
              <button className={host ? 'item' : 'item danger'} onClick={host ? leave : () => (setOpen(false), leaveRoom())}>
                Leave room
              </button>
              {host && (
                <button className="item danger" onClick={end}>
                  Delete room
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A small picture of a layout, drawn from the same rectangles the views use. */
function LayoutIcon({ id }: { id: LayoutId }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      {paneRects(id, 14, 12).map((r, i) => (
        <rect key={i} x={r.x + 1} y={r.y + 2} width={r.w} height={r.h} rx="1" />
      ))}
    </svg>
  );
}

function LayoutSwitcher() {
  const layout = parseLayout(useSettings((s) => s.layout));
  const maximized = useStore((s) => !!s.maximized);
  const key = useKeyHint();
  return (
    <div className="seg-control layouts" role="group" aria-label="Layout">
      {LAYOUTS.map((l) => (
        <button
          key={l.id}
          aria-label={l.label}
          aria-pressed={!maximized && layout === l.id}
          data-tip={`${l.label}  ${key(`layout.${l.id}` as ActionId)}`.trimEnd()}
          onClick={() => chooseLayout(l.id)}
        >
          <LayoutIcon id={l.id} />
        </button>
      ))}
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
      {hasImage && <LayoutSwitcher />}
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
