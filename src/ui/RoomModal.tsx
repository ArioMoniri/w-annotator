import { X } from 'lucide-react';
import { useState } from 'react';
import type { RoomKind } from '../collab/protocol';
import { savedRooms, type SavedRoom } from '../collab/rooms';
import { SERVER_HELP, copyText, isTauri, saveName, saveServer, savedName, savedServer } from '../platform';
import { createInvite, forgetSavedRoom, joinRoom, rejoinRoom, startRoom, type RoomStarted } from '../session';
import { set, toast, useStore } from '../state/store';
import { Modal } from './common';

/** Once a room is running, its pill in the top bar is where this dialog came from. */
const ROOM_PILL = '[data-testid="room-pill"]';

/** The two kinds of room, in the words of `docs/design/ROOMS.md` B. Never "secure" or "cannot be copied". */
export const ROOM_KINDS: { kind: RoomKind; title: string; text: string; note?: string }[] = [
  {
    kind: 'shared',
    title: 'Shared copy',
    text: 'Everyone gets the image and the mask and keeps a copy. They can keep working without you.',
  },
  {
    kind: 'host-view',
    title: 'View through my computer',
    text: "Others see and edit the mask through your computer. They don't receive the files and can't save. The room ends when you close the app.",
    note: "This limits what leaves your computer; it can't stop someone photographing or recording their screen.",
  },
];

/** What every invite link does, said wherever one is handed out. */
export const LINK_RULE = 'Each link works for one person and stops working after 24 hours.';

/** Mounted afresh each time it opens, so the name and server always come from Settings. */
export function RoomModal() {
  const open = useStore((s) => !!s.roomModal);
  return open ? <RoomDialog /> : null;
}

function RoomDialog() {
  const mode = useStore((s) => s.roomModal);
  const hasImage = useStore((s) => !!s.image);
  const [name, setName] = useState(savedName());
  const [kind, setKind] = useState<RoomKind>('shared');
  const [invite, setInvite] = useState('');
  const [server, setServer] = useState(savedServer());
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [started, setStarted] = useState<RoomStarted | null>(null);
  const [mine, setMine] = useState<SavedRoom[]>(savedRooms);
  if (!mode) return null;

  const close = () => set({ roomModal: null });
  const tab = (next: 'start' | 'join') => {
    setError('');
    set({ roomModal: next });
  };

  /** The name is the only thing a room asks of anyone. It is kept in Settings. */
  const ready = (): string | null => {
    const clean = name.trim().slice(0, 24);
    if (!clean) {
      setError('Enter a name.');
      return null;
    }
    saveName(clean);
    saveServer(server);
    setError('');
    return clean;
  };

  const run = async (work: (clean: string) => Promise<RoomStarted | true | string>) => {
    const clean = ready();
    if (!clean) return;
    setWorking(true);
    const result = await work(clean);
    setWorking(false);
    if (typeof result === 'string') return setError(result);
    if (result === true) close();
    else setStarted(result);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'join' && !invite.trim()) return setError('Paste the invite link.');
    void run((clean) => (mode === 'start' ? startRoom(clean, kind) : joinRoom(clean, invite)));
  };

  if (started) return <Started started={started} onClose={close} />;

  return (
    <Modal title={mode === 'start' ? 'Start a room' : 'Join a room'} onClose={close} returnTo={ROOM_PILL}>
      {/* One row: the tabs take the width that is left beside the close button. */}
      <div className="tabs">
        <div className="seg-control" role="tablist">
          <button role="tab" aria-selected={mode === 'start'} onClick={() => tab('start')}>
            Start a room
          </button>
          <button role="tab" aria-selected={mode === 'join'} onClick={() => tab('join')}>
            Join a room
          </button>
        </div>
        <button className="iconbtn close" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>
      <form className="form" onSubmit={submit}>
        <label>
          Your name
          <input
            type="text"
            value={name}
            maxLength={24}
            placeholder="How others will see you"
            disabled={working}
            onChange={(e) => (setName(e.target.value), setError(''))}
          />
        </label>
        {mode === 'join' && (
          <label>
            Invite link
            <input
              type="text"
              value={invite}
              placeholder="Paste the invite link"
              spellCheck={false}
              disabled={working}
              onChange={(e) => (setInvite(e.target.value), setError(''))}
            />
          </label>
        )}
        {mode === 'start' && hasImage && (
          <div className="roomkinds" role="radiogroup" aria-label="Kind of room">
            {ROOM_KINDS.map((k) => (
              <label key={k.kind} className="roomkind" data-checked={kind === k.kind}>
                <input type="radio" name="room-kind" value={k.kind} checked={kind === k.kind} disabled={working} onChange={() => setKind(k.kind)} />
                <span className="words">
                  <span className="name">{k.title}</span>
                  <span className="help">{k.text}</span>
                  {k.note && <span className="help">{k.note}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
        {mode === 'start' && !hasImage && <span className="help">Open an image first, then start a room.</span>}
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
        {mode === 'join' && mine.length > 0 && (
          <div className="myrooms" data-testid="my-rooms">
            <span className="help">Rooms you have joined on this device</span>
            {mine.map((r) => (
              <div key={r.id} className="myroom">
                <span className="name">{r.role === 'host' ? 'Your room' : r.host ? `${r.host}'s room` : 'A room'}</span>
                <span className="help">last opened {new Date(r.at).toLocaleDateString()}</span>
                <button type="button" className="btn text" disabled={working} onClick={() => void run((clean) => rejoinRoom(clean, r.id))}>
                  Rejoin
                </button>
                <button
                  type="button"
                  className="btn text"
                  disabled={working}
                  onClick={() => {
                    forgetSavedRoom(r.id);
                    setMine(savedRooms());
                  }}
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        )}
        {mode === 'start' && (
          <details>
            <summary>Server</summary>
            <label>
              <input
                type="text"
                value={server}
                aria-label="Room server"
                placeholder="wss://rooms.example.org"
                disabled={working}
                onChange={(e) => setServer(e.target.value)}
              />
              <span className="help">{SERVER_HELP}</span>
            </label>
          </details>
        )}
        <span className="help">W Annotator is not for diagnosis or treatment. Remove anything that identifies a person before you share an image.</span>
        <div className="footer" style={{ marginTop: 8 }}>
          <button type="button" className="btn secondary lg" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary lg" disabled={working || (mode === 'start' && !hasImage)}>
            {working && <span className="spinner" />}
            {mode === 'start' ? (working ? 'Starting…' : 'Start') : working ? 'Joining…' : 'Join'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Started({ started, onClose }: { started: RoomStarted; onClose: () => void }) {
  const [link, setLink] = useState(started.link);
  const [count, setCount] = useState(1);
  const another = async () => {
    const next = await createInvite();
    if (!next) return toast('error', "Couldn't make a link. Check your connection and try again.");
    setLink(next);
    setCount(count + 1);
  };
  return (
    <Modal key="started" title="Room started" onClose={onClose} returnTo={ROOM_PILL}>
      {/* The title and the close button share a row, so neither sits on the other. */}
      <div className="tabs">
        <h2>Room started</h2>
        <button className="iconbtn close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <p>Send this link to one person. They paste it under Join a room. {LINK_RULE}</p>
      <div className="form">
        <div className="linkbox" data-testid="room-link" data-count={count}>
          {link}
        </div>
        {started.kind === 'host-view' && <span className="help">{ROOM_KINDS[1].note}</span>}
        {link.startsWith('http://') && isTauri && (
          <span className="help" data-testid="room-note">
            {started.localOnly
              ? 'No network was found, so this link only works on this computer. Connect to a network and start the room again to invite others.'
              : 'This room runs on your computer, so others need to be on the same network or VPN. It stops when you close the app.'}
          </span>
        )}
      </div>
      <div className="footer">
        <button className="btn text lg" onClick={onClose}>
          Done
        </button>
        <button className="btn secondary lg" onClick={() => void another()}>
          Link for another person
        </button>
        <button className="btn primary lg" onClick={async () => (await copyText(link)) && toast('success', 'Invite link copied')}>
          Copy invite link
        </button>
      </div>
    </Modal>
  );
}
