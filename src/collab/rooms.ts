/**
 * "My rooms": the shared-copy rooms this device is a member of, so a person can come
 * back to one later. Each entry holds the member key made for that room and the room's
 * key. View-through-host rooms are never written here: they last one session and
 * leave nothing on a guest's device.
 */

import type { Role } from './protocol';

export interface SavedRoom {
  id: string;
  /** `ws://` or `wss://` address of the room server. */
  server: string;
  role: Role;
  /** The member's private key for this room, base64. */
  seed: string;
  /** The room's keys as `RoomKeys.dump` writes them (`keys.ts`). Up to 0.1.3: the one room key; such a room is not reopened. */
  key: string;
  /** The host's name when last seen, to tell rooms apart. Null for a room hosted here. */
  host: string | null;
  /** When this device last connected. */
  at: number;
}

/** The relay forgets a member who has not connected for this long. */
export const MEMBERSHIP_DAYS = 30;
const STORAGE_KEY = 'w-annotator:rooms';

export function upsertRoom(list: SavedRoom[], entry: SavedRoom): SavedRoom[] {
  return [entry, ...list.filter((r) => r.id !== entry.id)];
}

export function withoutRoom(list: SavedRoom[], id: string): SavedRoom[] {
  return list.filter((r) => r.id !== id);
}

export function pruneRooms(list: SavedRoom[], now: number): SavedRoom[] {
  return list.filter((r) => now - r.at < MEMBERSHIP_DAYS * 86_400_000);
}

const isRoom = (r: unknown): r is SavedRoom => {
  const x = r as SavedRoom | null;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.server === 'string' &&
    ['host', 'editor', 'viewer'].includes(x.role) &&
    typeof x.seed === 'string' &&
    typeof x.key === 'string' &&
    (x.host === null || typeof x.host === 'string') &&
    typeof x.at === 'number'
  );
};

export function parseRooms(raw: string | null): SavedRoom[] {
  try {
    const list: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(list) ? list.filter(isRoom) : [];
  } catch {
    return [];
  }
}

function read(): SavedRoom[] {
  try {
    return pruneRooms(parseRooms(localStorage.getItem(STORAGE_KEY)), Date.now());
  } catch {
    return [];
  }
}

function write(list: SavedRoom[]): void {
  try {
    if (list.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage is off: the room still works, it just cannot be come back to */
  }
}

export const savedRooms = (): SavedRoom[] => read();
export const rememberRoom = (entry: SavedRoom): void => write(upsertRoom(read(), entry));
export const forgetRoom = (id: string): void => write(withoutRoom(read(), id));
