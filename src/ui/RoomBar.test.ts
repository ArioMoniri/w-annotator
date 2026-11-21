import { describe, expect, it } from 'vitest';
import { guestBanner, reviewText } from './RoomBar';
import { LINK_RULE, ROOM_KINDS } from './RoomModal';

describe('room copy', () => {
  it('tells a guest whose computer they are looking through, and that nothing is kept', () => {
    expect(guestBanner('Mina')).toBe("Viewing through Mina's computer. Nothing is saved on this device.");
    expect(guestBanner(null)).toBe("Viewing through the host's computer. Nothing is saved on this device.");
  });

  it('counts what a merge left to review', () => {
    expect(reviewText({ slices: 3, voxels: 412 })).toBe(
      "Your version differs from the room's on 3 slices (412 voxels). The room's version is shown; yours is kept until you choose.",
    );
    expect(reviewText({ slices: 1, voxels: 1 })).toContain('1 slice (1 voxel)');
  });

  it('describes exactly two kinds of room, and says which one sends the files', () => {
    expect(ROOM_KINDS.map((k) => k.kind)).toEqual(['shared', 'host-view']);
    expect(ROOM_KINDS[0].text).toContain('gets the image and the mask');
    expect(ROOM_KINDS[1].text).toContain("don't receive the files");
    expect(ROOM_KINDS[1].text).toContain('The room ends when you close the app');
    expect(ROOM_KINDS[1].note).toContain("can't stop someone photographing or recording their screen");
  });

  it('promises nothing software cannot keep, and stays calm', () => {
    const all = [LINK_RULE, guestBanner('Mina'), reviewText({ slices: 2, voxels: 2 }), ...ROOM_KINDS.flatMap((k) => [k.title, k.text, k.note ?? ''])].join(' ');
    expect(all).not.toMatch(/secure|protected|cannot be copied|!/i);
  });

  it('says a link is for one person and for a day', () => {
    expect(LINK_RULE).toBe('Each link works for one person and stops working after 24 hours.');
  });
});
