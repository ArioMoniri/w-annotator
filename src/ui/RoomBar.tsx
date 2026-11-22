import { ChevronLeft, ChevronRight } from 'lucide-react';
import { goToReviewSlice, keepRooms, reviewDirection, reviewShownSlice, reviewSliceNumbers, stepReview, takeMine } from '../session';
import { useStore, type MergeReview } from '../state/store';
import { useKeyHint } from './common';

/** What a guest of a view-through-host room is told for as long as they are in it (`ROOMS.md` B). */
export function guestBanner(hostName: string | null): string {
  return `Viewing through ${hostName ?? 'the host'}'s computer. Nothing is saved on this device.`;
}

const count = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

/** What is left to decide after offline work was merged (`ROOMS.md` C6, rule 3). */
export function reviewText(review: { slices: number; voxels: number }): string {
  return `Your version differs from the room's on ${count(review.slices, 'slice')} (${count(review.voxels, 'voxel')}). The room's version is shown; yours is the white outline, kept until you choose.`;
}

const VIEW_NAMES: Record<string, string> = { axial: 'Axial', sagittal: 'Sagittal', coronal: 'Coronal' };

/** One slice in the list of slices to review, by the number its view shows for it. */
export function sliceLabel(view: string, number: number, voxels: number): string {
  return `${VIEW_NAMES[view] ?? 'Axial'} slice ${number} · ${count(voxels, 'voxel')}`;
}

/** Why the buttons for one slice are off. */
export const GO_TO_A_SLICE = 'Go to a slice that differs to choose for it.';

/**
 * The slices where a merge kept my version aside: go from one to the next, and for each take
 * mine or keep the room's. With one slice there is nothing to go through, and the bar is two buttons.
 */
function ReviewBar({ review }: { review: MergeReview }) {
  // Which slice is on screen decides what the buttons for one slice act on, so the bar follows the views.
  useStore((s) => s.slices);
  const key = useKeyHint();
  const shown = reviewShownSlice();
  const numbers = reviewSliceNumbers();
  // Listed in the order the view counts them, whichever way the file stores its slices.
  const listed = reviewDirection() < 0 ? [...review.slices].reverse() : review.slices;
  const many = review.slices.length > 1;
  const here = review.slices.find((s) => s.z === shown) ?? null;
  // With a single slice the choice is the same wherever the views are.
  const target = here ?? (many ? null : review.slices[0]);
  const tip = (text: string, id: Parameters<typeof key>[0]) => `${text}  ${key(id)}`.trimEnd();
  return (
    <div className="recoverybar reviewbar" role="region" aria-label="Merge review" data-testid="merge-review">
      <span className="text">
        {reviewText({ slices: review.slices.length, voxels: review.voxels })}
        {many && here && ` This slice: ${count(here.voxels, 'voxel')}.`}
      </span>
      {many ? (
        <>
          <select
            className="select"
            aria-label="Slices to review"
            value={here ? String(here.z) : ''}
            onChange={(e) => {
              if (e.target.value !== '') goToReviewSlice(Number(e.target.value));
              // Give the keyboard back to the shortcuts.
              e.target.blur();
            }}
          >
            {!here && <option value="">{count(review.slices.length, 'slice')} to review</option>}
            {listed.map((s) => (
              <option key={s.z} value={s.z}>
                {sliceLabel(review.view, numbers[s.z] ?? s.z + 1, s.voxels)}
              </option>
            ))}
          </select>
          <button className="iconbtn" aria-label="Previous slice to review" data-tip={tip('Previous slice to review', 'review.previous')} data-tip-side="bottom" onClick={() => stepReview(-1)}>
            <ChevronLeft size={16} />
          </button>
          <button className="iconbtn" aria-label="Next slice to review" data-tip={tip('Next slice to review', 'review.next')} data-tip-side="bottom" onClick={() => stepReview(1)}>
            <ChevronRight size={16} />
          </button>
        </>
      ) : (
        !here && (
          <button className="btn text" onClick={() => goToReviewSlice(review.slices[0].z)}>
            Go to the slice
          </button>
        )
      )}
      <button
        className="btn primary"
        aria-disabled={!target}
        data-tip={target ? undefined : GO_TO_A_SLICE}
        data-tip-side="bottom"
        onClick={() => target && takeMine(target.z)}
      >
        Use mine
      </button>
      <button
        className="btn secondary"
        aria-disabled={!target}
        data-tip={target ? undefined : GO_TO_A_SLICE}
        data-tip-side="bottom"
        onClick={() => target && keepRooms(target.z)}
      >
        Keep the room's
      </button>
      {many && (
        <>
          <button className="btn text" onClick={() => takeMine()}>
            Use mine for all
          </button>
          <button className="btn text" onClick={() => keepRooms()}>
            Keep the room's for all
          </button>
        </>
      )}
    </div>
  );
}

/** One line above the views while a room has something to say. Shares its place and look with the recovery bar. */
export function RoomBar() {
  const room = useStore((s) => s.room);
  const review = useStore((s) => s.review);
  if (review) return <ReviewBar review={review} />;
  if (room && room.kind === 'host-view' && room.role !== 'host') {
    return (
      <div className="recoverybar" role="status" data-testid="guest-banner">
        <span className="text">{guestBanner(room.hostName)}</span>
      </div>
    );
  }
  return null;
}
