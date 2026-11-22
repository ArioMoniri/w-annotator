/**
 * "My rooms": the shared-copy rooms this device is a member of, so a person can come
 * back to one later. Each entry holds the member key made for that room and the room
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
  /** The room key, base64. */
  key: string;
  /** The host's name when last seen, to tell rooms apart. Null for a room hosted here. */
  host: string | null;
  /** When this device last connected. */
  at: number;
  /**
   * The room runs on the host's own computer (the desktop app's built-in room server), so it
   * is only there while the host has it open. For the host: reopening it starts that server again.
   */
  hosted?: boolean;
  /** Host only: the host's own notes for invite links, by invite id ("for Sam"). Never sent anywhere. */
  labels?: Record<string, string>;
  /** Host of a room on this computer: the fingerprint of its image, to open the room again on the same one. */
  image?: string;
}

/** A room keeps at most this many links (`ROOMS-PROTOCOL.md` §13), so at most this many notes. */
const MAX_LABELS = 64;

/** The notes as stored: strings of sensible length only, the newest kept when there are too many. */
export function cleanLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0 && e[1].length <= 24 && e[0].length <= 64,
  );
  return Object.fromEntries(entries.slice(-MAX_LABELS));
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

/** Only what this version knows is taken on trust; the optional parts are checked one by one. */
const tidy = (r: SavedRoom): SavedRoom => {
  const { hosted, labels, image, ...rest } = r;
  const notes = cleanLabels(labels);
  return {
    ...rest,
    ...(hosted === true ? { hosted: true } : {}),
    ...(Object.keys(notes).length ? { labels: notes } : {}),
    ...(typeof image === 'string' && /^[a-f0-9]{16,64}$/.test(image) ? { image } : {}),
  };
};

export function parseRooms(raw: string | null): SavedRoom[] {
  try {
    const list: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(list) ? list.filter(isRoom).map(tidy) : [];
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
