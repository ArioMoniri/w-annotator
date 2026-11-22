import { DURATIONS, LABEL_CHARS, USES, type InviteDuration, type InviteOptions, type InviteUses } from '../collab/invites';
import type { RoomKind } from '../collab/protocol';

/**
 * The choices for the next invite link, folded away until asked for: how long it works,
 * for how many people, and a note for the host's own list. The room server keeps the
 * time and counts the uses; the note never leaves this device.
 */
export function InviteOptionsFields(props: { value: InviteOptions; kind: RoomKind; onChange: (next: InviteOptions) => void }) {
  const { value, kind, onChange } = props;
  const uses = USES.find((u) => u.id === value.uses) ?? USES[0];
  return (
    <details className="linkoptions" data-testid="link-options">
      <summary>Link options</summary>
      <div className="fields">
        <label>
          Stops working after
          <select className="select" value={value.duration} onChange={(e) => onChange({ ...value, duration: e.target.value as InviteDuration })}>
            {DURATIONS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {kind === 'shared' ? (
          <label>
            Works for
            <select className="select" value={value.uses} onChange={(e) => onChange({ ...value, uses: e.target.value as InviteUses })}>
              {USES.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
            <span className="help" data-testid="link-uses-help">
              {uses.help}
            </span>
          </label>
        ) : (
          <span className="help">In this kind of room each link works for one person.</span>
        )}
        <label>
          Note for your own list
          <input
            type="text"
            value={value.label}
            maxLength={LABEL_CHARS}
            placeholder="For example: for Sam"
            onChange={(e) => onChange({ ...value, label: e.target.value })}
          />
          <span className="help">Only you see the note.</span>
        </label>
      </div>
    </details>
  );
}
