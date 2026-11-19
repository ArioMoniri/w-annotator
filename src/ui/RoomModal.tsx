import { X } from 'lucide-react';
import { useState } from 'react';
import { formatCode } from '../collab/protocol';
import { copyText, isTauri, saveName, saveServer, savedName, savedServer } from '../platform';
import { joinRoom, startRoom, type RoomStarted } from '../session';
import { set, toast, useStore } from '../state/store';
import { Modal } from './common';

export function RoomModal() {
  const mode = useStore((s) => s.roomModal);
  const hasImage = useStore((s) => !!s.image);
  const [name, setName] = useState(savedName());
  const [invite, setInvite] = useState('');
  const [server, setServer] = useState(savedServer());
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [started, setStarted] = useState<RoomStarted | null>(null);
  if (!mode) return null;

  const close = () => set({ roomModal: null });
  const tab = (next: 'start' | 'join') => {
    setError('');
    set({ roomModal: next });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim().slice(0, 24);
    if (!clean) return setError('Enter a name.');
    if (mode === 'join' && !invite.trim()) return setError('Enter the room code or paste the invite link.');
    saveName(clean);
    saveServer(server);
    setError('');
    setWorking(true);
    const result = mode === 'start' ? await startRoom(clean) : await joinRoom(clean, invite);
    setWorking(false);
    if (typeof result === 'string') return setError(result);
    if (mode === 'start') setStarted(result);
    else close();
  };

  if (started) {
    return (
      <Modal key="started" title="Room started" onClose={close}>
        <button className="iconbtn close" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
        <h2>Room started</h2>
        <p>Send the invite link to the people you want to work with. They paste it under Join a room.</p>
        <div className="form">
          <div className="code" data-testid="room-code">
            {formatCode(started.code)}
          </div>
          <div className="linkbox" data-testid="room-link">
            {started.link}
          </div>
          {started.link.startsWith('ws://') && isTauri && (
            <span className="help" data-testid="room-note">
              {started.localOnly
                ? 'No network was found, so this link only works on this computer. Connect to a network and start the room again to invite others.'
                : 'This room runs on your computer, so others need to be on the same network or VPN.'}
            </span>
          )}
        </div>
        <div className="footer">
          <button className="btn text lg" onClick={close}>
            Done
          </button>
          <button className="btn secondary lg" onClick={async () => (await copyText(formatCode(started.code))) && toast('success', 'Code copied')}>
            Copy code
          </button>
          <button className="btn primary lg" onClick={async () => (await copyText(started.link)) && toast('success', 'Invite link copied')}>
            Copy invite link
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={mode === 'start' ? 'Start a room' : 'Join a room'} onClose={close}>
      <button className="iconbtn close" aria-label="Close" onClick={close}>
        <X size={16} />
      </button>
      <div className="tabs">
        <div className="seg-control" role="tablist">
          <button role="tab" aria-selected={mode === 'start'} onClick={() => tab('start')}>
            Start a room
          </button>
          <button role="tab" aria-selected={mode === 'join'} onClick={() => tab('join')}>
            Join a room
          </button>
        </div>
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
            Invite link or room code
            <input
              type="text"
              value={invite}
              placeholder="Paste the invite link"
              disabled={working}
              onChange={(e) => (setInvite(e.target.value), setError(''))}
            />
          </label>
        )}
        {mode === 'start' && (
          <span className="help">
            {hasImage ? 'Anyone with the invite can view and edit this mask.' : 'Open an image first, then start a room.'}
          </span>
        )}
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
        <details>
          <summary>Server</summary>
          <label>
            <input
              type="text"
              value={server}
              placeholder="wss://rooms.example.org"
              disabled={working}
              onChange={(e) => setServer(e.target.value)}
            />
            <span className="help">
              {isTauri
                ? 'Leave empty to host the room on this computer for people on the same network. Enter a room server address to work over the internet.'
                : 'Address of the room server.'}
            </span>
          </label>
        </details>
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
