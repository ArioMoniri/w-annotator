import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SERVER_HELP, openExternal } from '../platform';
import { SAMPLE_SOURCES } from '../sample';
import { setDisplayName } from '../session';
import { NAME_MAX, parseReferenceLines, setSetting, useSettings, type ReferenceLines } from '../state/settings';
import { get, set, useStore, type SettingsSection } from '../state/store';
import { startTour } from '../tour/state';
import { checkForUpdates, type UpdateStatus } from '../updates';
import { Choice, MOD, Modal, Slider, Switch } from './common';
import { ShortcutsList } from './Shortcuts';
import { ThemeControl } from './ThemeControl';

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'mouse', label: 'Mouse and trackpad' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'files', label: 'Files' },
  { id: 'help', label: 'Help' },
];

/** A label and one line of explanation on the left, the control on the right. */
function Row(props: { label: string; help?: string; children: (ids: { label: string; help?: string }) => ReactNode }) {
  const id = useId();
  const help = props.help ? `${id}-help` : undefined;
  return (
    <div className="setting">
      <div className="text">
        <span id={id}>{props.label}</span>
        {props.help && (
          <span className="help" id={help}>
            {props.help}
          </span>
        )}
      </div>
      {props.children({ label: id, help })}
    </div>
  );
}

function Profile() {
  // Kept as typed, so a space between two words is not trimmed away mid-word.
  const [name, setName] = useState(() => useSettings.getState().displayName);
  const inRoom = useStore((s) => !!s.room);
  return (
    <div className="form">
      <label>
        Your name in rooms
        <input
          type="text"
          value={name}
          maxLength={NAME_MAX}
          placeholder="How others will see you"
          onChange={(e) => {
            setName(e.target.value);
            setDisplayName(e.target.value);
          }}
        />
        <span className="help">
          {inRoom ? 'People in this room see the change straight away.' : 'Shown to others when you start or join a room.'}
        </span>
      </label>
    </div>
  );
}

const REFERENCE_LINES: { id: ReferenceLines; label: string }[] = [
  { id: 'always', label: 'Always' },
  { id: 'hover', label: 'On hover' },
  { id: 'crosshair', label: 'With crosshair tool only' },
];

function Appearance() {
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const referenceLines = parseReferenceLines(useSettings((s) => s.referenceLines));
  return (
    <>
      <Row label="Theme">{() => <ThemeControl />}</Row>
      <Row label="Show reference lines" help="Lines in each view that mark where the other two views cut it. Drag one to scroll that view.">
        {(ids) => (
          <div className="seg-control" role="group" aria-labelledby={ids.label} aria-describedby={ids.help}>
            {REFERENCE_LINES.map((o) => (
              <button key={o.id} aria-pressed={referenceLines === o.id} onClick={() => setSetting('referenceLines', o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        )}
      </Row>
      <Row label="Reduce motion" help="Turns off transitions and animated hints.">
        {(ids) => <Switch on={reduceMotion} labelledBy={ids.label} describedBy={ids.help} onChange={(v) => setSetting('reduceMotion', v)} />}
      </Row>
    </>
  );
}

function Mouse() {
  const s = useSettings();
  return (
    <>
      <Row label="Scroll direction" help="Natural follows your system: scrolling down goes to the next slice.">
        {(ids) => (
          <Choice
            label="Scroll direction"
            labelledBy={ids.label}
            value={s.scrollDirection}
            options={[
              { value: 'natural', label: 'Natural' },
              { value: 'reversed', label: 'Reversed' },
            ]}
            onChange={(v) => setSetting('scrollDirection', v)}
          />
        )}
      </Row>
      <Row label="Two-finger scroll" help="On a trackpad. When it pans, hold Shift to change slice. With the Window / Level tool it changes brightness and contrast, and Shift changes slice.">
        {(ids) => (
          <Choice
            label="Two-finger scroll"
            labelledBy={ids.label}
            value={s.twoFingerScroll}
            options={[
              { value: 'slice', label: 'Change slice' },
              { value: 'pan', label: 'Pan' },
            ]}
            onChange={(v) => setSetting('twoFingerScroll', v)}
          />
        )}
      </Row>
      <Row label="Trackpad scroll speed" help="How far a scroll moves through the slices.">
        {() => (
          <span className="speed">
            <span aria-hidden>Slow</span>
            <Slider label="Trackpad scroll speed" min={1} max={10} value={s.trackpadSpeed} onChange={(v) => setSetting('trackpadSpeed', v)} />
            <span aria-hidden>Fast</span>
          </span>
        )}
      </Row>
      <Row label="Pinch to zoom">
        {(ids) => <Switch on={s.pinchZoom} labelledBy={ids.label} onChange={(v) => setSetting('pinchZoom', v)} />}
      </Row>
      <Row label="Mouse wheel zooms" help={`The wheel zooms instead of changing slice. ${MOD}+wheel then changes slice.`}>
        {(ids) => <Switch on={s.wheelZooms} labelledBy={ids.label} describedBy={ids.help} onChange={(v) => setSetting('wheelZooms', v)} />}
      </Row>
      <Row label="Zoom speed">
        {() => (
          <span className="speed">
            <span aria-hidden>Slow</span>
            <Slider label="Zoom speed" min={1} max={10} value={s.zoomSpeed} onChange={(v) => setSetting('zoomSpeed', v)} />
            <span aria-hidden>Fast</span>
          </span>
        )}
      </Row>
    </>
  );
}

function Files() {
  const autosave = useSettings((s) => s.autosave);
  const guest = useStore((s) => s.room?.kind === 'host-view' && s.room.role !== 'host');
  const server = useSettings((s) => s.server);
  return (
    <>
      {guest ? (
        <Row label="Autosave" help="Off in this room. Nothing is kept on this device; the host's computer keeps the mask.">
          {(ids) => <Switch on={false} labelledBy={ids.label} describedBy={ids.help} onChange={() => undefined} />}
        </Row>
      ) : (
        <Row label="Autosave" help="Keeps a recovery copy of unsaved mask edits on this device.">
          {(ids) => <Switch on={autosave} labelledBy={ids.label} describedBy={ids.help} onChange={(v) => setSetting('autosave', v)} />}
        </Row>
      )}
      <div className="form">
        <label>
          Room server
          <input
            type="text"
            value={server}
            placeholder="wss://rooms.example.org"
            spellCheck={false}
            onChange={(e) => setSetting('server', e.target.value.trim())}
          />
          <span className="help">{SERVER_HELP}</span>
        </label>
      </div>
    </>
  );
}

/** A link that opens in the user's browser, in the desktop app too. */
function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function Help({ go }: { go: (section: SettingsSection) => void }) {
  return (
    <>
      <div className="linklist">
        <button
          className="btn secondary"
          onClick={() => {
            set({ settings: null });
            startTour();
          }}
        >
          Replay the welcome tour
        </button>
        <button className="btn secondary" onClick={() => go('shortcuts')}>
          Keyboard shortcuts
        </button>
        <button className="btn secondary" onClick={() => set({ settings: null, report: 'bug' })}>
          Report a problem
        </button>
        <UpdateCheck />
      </div>
      <p className="about">
        W Annotator, version {__APP_VERSION__}
        <br />
        Free for non-commercial use. © Ariorad Moniri.
        <br />
        <span>
          Sample data: <External href={SAMPLE_SOURCES.luna16}>LUNA16</External> (<External href={SAMPLE_SOURCES.licence}>CC BY 4.0</External>), a subset of{' '}
          <External href={SAMPLE_SOURCES.lidc}>LIDC-IDRI</External> (<External href={SAMPLE_SOURCES.licenceLidc}>CC BY 3.0</External>)
        </span>
      </p>
    </>
  );
}

function updateText(s: UpdateStatus): string {
  switch (s.kind) {
    case 'idle':
      return '';
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return `Downloading version ${s.version}…`;
    case 'latest':
      return 'You have the latest version.';
    case 'ready':
      return `Version ${s.version} is ready.`;
    case 'failed':
      return "Couldn't check for updates. Check your connection and try again.";
  }
}

/** Looks for a new release now; only in the desktop app, which can update itself. */
function UpdateCheck() {
  const updater = useStore((s) => s.updater);
  const update = useStore((s) => s.update);
  const status = useStore((s) => s.updateStatus);
  if (!updater) return null;
  const busy = status.kind === 'checking' || status.kind === 'downloading';
  return (
    <div className="update-check">
      {update ? (
        <button className="btn secondary" onClick={() => void update.install()}>
          Restart to update
        </button>
      ) : (
        <button className="btn secondary" disabled={busy} onClick={() => void checkForUpdates()}>
          {busy ? 'Checking…' : 'Check for updates'}
        </button>
      )}
      <span role="status">{updateText(status)}</span>
    </div>
  );
}

function Dialog({ section }: { section: SettingsSection }) {
  const tabs = useRef<HTMLDivElement>(null);
  const go = (next: SettingsSection) => set({ settings: next });
  // Esc belongs to the shortcut being captured, if there is one.
  const close = () => !get().capturingShortcut && set({ settings: null });

  useEffect(() => {
    tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);

  const onKey = (e: KeyboardEvent) => {
    const at = SECTIONS.findIndex((s) => s.id === section);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (at + 1) % SECTIONS.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (at - 1 + SECTIONS.length) % SECTIONS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SECTIONS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    go(SECTIONS[next].id);
    tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  const label = SECTIONS.find((s) => s.id === section)!.label;
  return (
    <Modal title="Settings" onClose={close} className="settings">
      <nav>
        <h2>Settings</h2>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" ref={tabs} onKeyDown={onKey}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              role="tab"
              id={`settings-tab-${s.id}`}
              aria-selected={s.id === section}
              aria-controls="settings-pane"
              tabIndex={s.id === section ? 0 : -1}
              onClick={() => go(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </nav>
      <section className="pane" role="tabpanel" id="settings-pane" aria-labelledby={`settings-tab-${section}`} data-section={section}>
        <h3>{label}</h3>
        {section === 'profile' && <Profile />}
        {section === 'appearance' && <Appearance />}
        {section === 'mouse' && <Mouse />}
        {section === 'shortcuts' && <ShortcutsList />}
        {section === 'files' && <Files />}
        {section === 'help' && <Help go={go} />}
      </section>
      <button className="iconbtn close" aria-label="Close" onClick={close}>
        <X size={16} />
      </button>
    </Modal>
  );
}

/** The one place for preferences. Changes apply as they are made; there is nothing to save. */
export function SettingsDialog() {
  const section = useStore((s) => s.settings);
  return section ? <Dialog section={section} /> : null;
}
