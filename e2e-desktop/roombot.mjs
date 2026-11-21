// A second person in a room, played from Node: a small client for rooms protocol v2
// (docs/design/ROOMS-PROTOCOL.md) written apart from the app's own, so the desktop test
// checks what is on the wire rather than the app against itself.

import { gcm } from '@noble/ciphers/aes.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const utf8 = (text) => new TextEncoder().encode(text);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const derive = (secret, info, length) => hkdf(sha256, secret, new Uint8Array(0), utf8(info), length);
const aad = (room, epoch, kind) => utf8(`w-rooms/2 ${room} ${epoch} ${kind}`);

/** Frame kinds (§5.2). */
export const KIND = { patch: 1, segOp: 2, syncSlab: 3, imageSlab: 4, presence: 5, syncRequest: 9 };

/**
 * Redeems an invite link and says a name. Resolves once the relay has let the bot in.
 * `frames` collects every frame received, already opened: `{ kind, from, seq, meta, body }`.
 */
export async function joinRoom(link, name) {
  const url = new URL(link);
  const room = url.pathname.split('/').pop().toUpperCase();
  const secret = unb64(url.hash.slice(1));
  const seed = new Uint8Array(randomBytes(32));
  const key = b64(ed25519.getPublicKey(seed));
  const ws = new WebSocket(`ws://${url.host}/v2/rooms/${room}`);
  ws.binaryType = 'arraybuffer';
  const bot = { room, frames: [], texts: [], welcome: null, roomKey: null, closed: null };

  bot.send = (kind, meta, body = new Uint8Array(0), { to = 0, seq = 0 } = {}) => {
    const json = utf8(JSON.stringify(meta));
    const plain = new Uint8Array(4 + json.length + body.length);
    new DataView(plain.buffer).setUint32(0, json.length, true);
    plain.set(json, 4);
    plain.set(body, 4 + json.length);
    const nonce = new Uint8Array(randomBytes(12));
    const sealed = gcm(bot.roomKey, nonce, aad(room, 1, kind)).encrypt(plain);
    const out = new Uint8Array(24 + 12 + sealed.length);
    const view = new DataView(out.buffer);
    out[0] = 2;
    out[1] = kind;
    view.setUint32(8, to, true);
    view.setBigUint64(12, BigInt(seq), true);
    view.setUint32(20, 1, true);
    out.set(nonce, 24);
    out.set(sealed, 36);
    ws.send(out);
  };
  bot.close = () => ws.close();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No welcome from ${link}`)), 10_000);
    ws.addEventListener('close', (ev) => {
      bot.closed = { code: ev.code, reason: ev.reason };
      clearTimeout(timer);
      reject(new Error(`The relay closed the connection: ${ev.code} ${ev.reason}`));
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') {
        const bytes = new Uint8Array(ev.data);
        const view = new DataView(bytes.buffer);
        const kind = bytes[1];
        const plain = gcm(bot.roomKey, bytes.subarray(24, 36), aad(room, view.getUint32(20, true), kind)).decrypt(bytes.subarray(36));
        const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0, true);
        bot.frames.push({
          kind,
          from: view.getUint32(4, true),
          seq: Number(view.getBigUint64(12, true)),
          meta: JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n))),
          body: plain.subarray(4 + n),
        });
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
            proto: 2,
            invite,
            key,
            proof: b64(hmac(sha256, authKey, utf8(`w-rooms/2 proof ${room} ${msg.nonce} ${key}`))),
            sig: b64(ed25519.sign(utf8(`w-rooms/2 redeem ${room} ${msg.nonce}`), seed)),
          }),
        );
      } else if (msg.t === 'welcome') {
        // The room key comes wrapped with a key only the holder of the link can derive.
        const wrapped = unb64(msg.invite.wrappedKey);
        bot.roomKey = gcm(derive(secret, 'w-rooms/2 invite wrap', 32), wrapped.subarray(0, 12), utf8('w-rooms/2 room key')).decrypt(wrapped.subarray(12));
        bot.welcome = msg;
        bot.send(KIND.presence, { t: 'hi', name });
        clearTimeout(timer);
        resolve();
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
