// A second person in a room, played from Node: a small client for rooms protocol 3
// (docs/design/ROOMS-PROTOCOL.md) written apart from the app's own, so the desktop test
// checks what is on the wire rather than the app against itself.

import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const utf8 = (text) => new TextEncoder().encode(text);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const derive = (secret, info, length) => hkdf(sha256, secret, new Uint8Array(0), utf8(info), length);
const idOf = (key) => new DataView(sha256(key).buffer).getUint32(0, true);
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));

/** Frame kinds (§5.2). */
export const KIND = { patch: 1, segOp: 2, syncSlab: 3, imageSlab: 4, presence: 5, key: 8, syncRequest: 9 };

/** `nonce ‖ AES-256-GCM(key, plain)` with the associated data as text (§19.3). */
function seal(key, aad, plain) {
  const nonce = new Uint8Array(randomBytes(12));
  return concat(nonce, gcm(key, nonce, utf8(aad)).encrypt(plain));
}

function open(key, aad, sealed) {
  return gcm(key, sealed.subarray(0, 12), utf8(aad)).decrypt(sealed.subarray(12));
}

/**
 * Redeems an invite link, is let in by the host and says a name. Resolves once the bot holds
 * the room key. `frames` collects every frame received and opened: `{ kind, from, seq, meta, body }`.
 */
export async function joinRoom(link, name) {
  const url = new URL(link);
  const room = url.pathname.split('/').pop().toUpperCase();
  const secret = unb64(url.hash.slice(1));
  const seed = new Uint8Array(randomBytes(32));
  const pub = ed25519.getPublicKey(seed);
  const key = b64(pub);
  const self = idOf(pub);
  // The key agreement key follows from the same seed (§19.1).
  const xSecret = derive(seed, 'w-rooms/3 x25519', 32);
  const xkey = b64(x25519.getPublicKey(xSecret));
  const ws = new WebSocket(`ws://${url.host}/v2/rooms/${room}`);
  ws.binaryType = 'arraybuffer';
  const bot = { room, self, frames: [], texts: [], welcome: null, closed: null, epoch: 0, relayEpoch: 1, host: null, hostId: 0 };
  /** Room keys by epoch, and the members the host has signed for, by id. */
  const epochs = new Map();
  let members = new Map();

  const pairKey = (peerX) => {
    const mine = unb64(xkey);
    const theirs = unb64(peerX);
    const [lo, hi] = Buffer.compare(Buffer.from(mine), Buffer.from(theirs)) < 0 ? [mine, theirs] : [theirs, mine];
    return derive(x25519.getSharedSecret(xSecret, theirs), `w-rooms/3 pair ${room} ${b64(lo)} ${b64(hi)}`, 32);
  };
  const xOf = (id) => (id === bot.hostId ? bot.host.x : members.get(id)?.x);

  bot.send = (kind, meta, body = new Uint8Array(0), { to = 0, seq = 0 } = {}) => {
    // Sender and recipient are repeated inside (§18.1).
    const json = utf8(JSON.stringify({ ...meta, f: self, ...(to ? { d: to } : {}) }));
    const plain = new Uint8Array(4 + json.length + body.length);
    new DataView(plain.buffer).setUint32(0, json.length, true);
    plain.set(json, 4);
    plain.set(body, 4 + json.length);
    let payload;
    if (to) payload = seal(pairKey(xOf(to)), `w-rooms/3 one ${room} ${kind} ${self} ${to}`, plain);
    else {
      const sealed = seal(epochs.get(bot.epoch), `w-rooms/3 all ${room} ${bot.epoch} ${kind} ${self}`, plain);
      const sig = ed25519.sign(concat(utf8(`w-rooms/3 frame ${room} ${bot.epoch} ${kind} ${self} `), sha256(sealed)), seed);
      payload = concat(sealed, sig);
    }
    const out = new Uint8Array(24 + payload.length);
    const view = new DataView(out.buffer);
    out[0] = 3;
    out[1] = kind;
    view.setUint32(8, to, true);
    view.setBigUint64(12, BigInt(seq), true);
    // A frame for everyone names the epoch of its key; one for a single member the epoch the relay takes frames for.
    view.setUint32(20, to ? bot.relayEpoch : bot.epoch, true);
    out.set(payload, 24);
    ws.send(out);
  };
  bot.close = () => ws.close();

  /** The host's list of members and the room keys under it (§19.4). Taken only with the host's signature. */
  const takeKeys = (meta) => {
    const r = meta.r;
    const input = `w-rooms/3 roster ${room} ${r.e} ${r.n}` + r.m.map((m) => ` ${m.k},${m.x},${m.since},${m.until ?? 0}`).join('');
    if (!ed25519.verify(unb64(r.sig), utf8(input), unb64(bot.host.k))) throw new Error('The member list is not signed by the host');
    members = new Map(r.m.map((m) => [idOf(unb64(m.k)), m]));
    for (const [epoch, value] of Object.entries(meta.k)) epochs.set(Number(epoch), unb64(value));
    bot.epoch = Math.max(...epochs.keys());
  };

  const openFrame = (bytes) => {
    const view = new DataView(bytes.buffer);
    const kind = bytes[1];
    const from = view.getUint32(4, true);
    const to = view.getUint32(8, true);
    const epoch = view.getUint32(20, true);
    const payload = bytes.subarray(24);
    let plain;
    if (to) plain = open(pairKey(xOf(from)), `w-rooms/3 one ${room} ${kind} ${from} ${to}`, payload);
    else {
      const sealed = payload.subarray(0, payload.length - 64);
      const sender = members.get(from);
      const signed = concat(utf8(`w-rooms/3 frame ${room} ${epoch} ${kind} ${from} `), sha256(sealed));
      if (!sender || !ed25519.verify(payload.subarray(payload.length - 64), signed, unb64(sender.k))) throw new Error('Not signed by its sender');
      plain = open(epochs.get(epoch), `w-rooms/3 all ${room} ${epoch} ${kind} ${from}`, sealed);
    }
    const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0, true);
    return { kind, from, seq: Number(view.getBigUint64(12, true)), meta: JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n))), body: plain.subarray(4 + n) };
  };

  /**
   * Whether the bot can read a frame it was not sent: one somebody who sees the room's traffic
   * handed to it. `from` is the sender the relay would have stamped.
   */
  bot.canRead = (bytes, from) => {
    const copy = new Uint8Array(bytes);
    new DataView(copy.buffer).setUint32(4, from, true);
    try {
      openFrame(copy);
      return true;
    } catch {
      return false;
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Not let into ${link}`)), 10_000);
    ws.addEventListener('close', (ev) => {
      bot.closed = { code: ev.code, reason: ev.reason };
      clearTimeout(timer);
      reject(new Error(`The relay closed the connection: ${ev.code} ${ev.reason}`));
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') {
        let frame;
        try {
          frame = openFrame(new Uint8Array(ev.data));
        } catch {
          // Not for the bot to read, or not yet: a frame for everyone from before the host let it in.
          return;
        }
        if (frame.kind === KIND.key && frame.meta.t === 'keys') {
          const first = bot.epoch === 0;
          takeKeys(frame.meta);
          if (first) {
            bot.send(KIND.presence, { t: 'hi', name });
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        bot.frames.push(frame);
        return;
      }
      const msg = JSON.parse(ev.data);
      bot.texts.push(msg);
      if (msg.t === 'hello') {
        const invite = b64(derive(secret, 'w-rooms/2 invite id', 16));
        const authKey = derive(secret, 'w-rooms/2 invite auth', 32);
        ws.send(
          JSON.stringify({
            t: 'redeem',
            proto: 3,
            invite,
            key,
            xkey,
            proof: b64(hmac(sha256, authKey, utf8(`w-rooms/2 proof ${room} ${msg.nonce} ${key}`))),
            sig: b64(ed25519.sign(utf8(`w-rooms/2 redeem ${room} ${msg.nonce}`), seed)),
          }),
        );
      } else if (msg.t === 'epoch') bot.relayEpoch = msg.epoch;
      else if (msg.t === 'welcome') {
        bot.relayEpoch = msg.room.epoch;
        // The invite says who the host is, sealed with a key only the holder of the link can derive (§19.2).
        bot.host = JSON.parse(new TextDecoder().decode(open(derive(secret, 'w-rooms/2 invite wrap', 32), 'w-rooms/3 invite', unb64(msg.invite.wrappedKey))));
        bot.hostId = idOf(unb64(bot.host.k));
        bot.welcome = msg;
        // Ask the host to be let in, with proof of holding the link and of which keys are the bot's.
        const bind = derive(secret, 'w-rooms/3 invite bind', 32);
        const mac = b64(hmac(sha256, bind, utf8(`w-rooms/3 join ${room} ${key} ${xkey} ${bot.host.k}`)));
        bot.send(KIND.key, { t: 'join', inv: b64(derive(secret, 'w-rooms/2 invite id', 16)), k: key, x: xkey, mac }, undefined, { to: bot.hostId });
      }
    });
  });
  return bot;
}

/** Puts the slabs of one kind back together: parts in order, each slab unzipped, slabs by first slice. */
export function assemble(frames, kind, rid) {
  const slabs = new Map();
  for (const f of frames) {
    if (f.kind !== kind || f.meta.rid !== rid || typeof f.meta.z0 !== 'number') continue;
    if (!slabs.has(f.meta.z0)) slabs.set(f.meta.z0, []);
    slabs.get(f.meta.z0)[f.meta.part] = f.body;
  }
  return Buffer.concat([...slabs.keys()].sort((a, b) => a - b).map((z0) => gunzipSync(Buffer.concat(slabs.get(z0)))));
}
