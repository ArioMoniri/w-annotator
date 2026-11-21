import { keepRooms, takeMine } from '../session';
import { useStore } from '../state/store';

/** What a guest of a view-through-host room is told for as long as they are in it (`ROOMS.md` B). */
export function guestBanner(hostName: string | null): string {
  return `Viewing through ${hostName ?? 'the host'}'s computer. Nothing is saved on this device.`;
}

/** What is left to decide after offline work was merged (`ROOMS.md` C6, rule 3). */
export function reviewText(review: { slices: number; voxels: number }): string {
  const slices = `${review.slices.toLocaleString('en-US')} ${review.slices === 1 ? 'slice' : 'slices'}`;
  const voxels = `${review.voxels.toLocaleString('en-US')} ${review.voxels === 1 ? 'voxel' : 'voxels'}`;
  return `Your version differs from the room's on ${slices} (${voxels}). The room's version is shown; yours is kept until you choose.`;
}

/** One line above the views while a room has something to say. Shares its place and look with the recovery bar. */
export function RoomBar() {
  const room = useStore((s) => s.room);
  if (!room) return null;
  if (room.review) {
    return (
      <div className="recoverybar" role="region" aria-label="Merge review" data-testid="merge-review">
        <span className="text">{reviewText(room.review)}</span>
        <button className="btn primary" onClick={takeMine}>
          Use mine
        </button>
        <button className="btn secondary" onClick={keepRooms}>
          Keep the room's
        </button>
      </div>
    );
  }
  if (room.kind === 'host-view' && room.role !== 'host') {
    return (
      <div className="recoverybar" role="status" data-testid="guest-banner">
        <span className="text">{guestBanner(room.hostName)}</span>
      </div>
    );
  }
  return null;
}
