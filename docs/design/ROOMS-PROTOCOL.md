# Rooms protocol v2 — wire spec

What a client sends to and gets from the relay (`relay/`), precisely enough to build a client without reading the Rust. The design and its reasons are in `ROOMS.md`; this file is the contract. Every rule here has a test in `relay/tests/v2_*.rs`, and those tests build their messages from this text, not from the relay's code.

Status: phase 1, relay and app. The relay never decrypts or inspects a payload; what is inside one is the app's layer, written down in §18.

## 1. Conventions

- Transport: one WebSocket per member per room. **Text** messages are JSON objects with a string field `"t"` (the type). **Binary** messages are frames: a 24-byte header, then an opaque payload.
- All integers in binary are **little-endian**.
- **base64** always means URL-safe base64 **without padding** (RFC 4648 §5, alphabet `A–Z a–z 0–9 - _`). Padding or the `+ /` alphabet is rejected.
- Room ids are 8–32 ASCII letters or digits, case-insensitive. The relay upper-cases them; **signatures and proofs use the upper-case form**.
- Unknown JSON fields are ignored. Unknown message types and unknown frame kinds are ignored without an error. Neither is ever fatal.
- JSON numbers that carry a `u64` (`cid`, `seq`, `head`, `after`, `expiresAt`) are plain JSON integers. A JavaScript client must keep its own `cid` values at or below 2^53 − 1.
- Times are milliseconds since the Unix epoch, by the relay's clock.

## 2. Connecting

| Request | Answer |
|---|---|
| `GET /v2/rooms/<ID>` with a WebSocket upgrade | 101, then `hello` (§3) |
| same, `<ID>` not 8–32 letters or digits | HTTP 400 |
| same, without an upgrade | HTTP 400 |
| same, more than 30 attempts per minute from one IP address | HTTP 429, body `Too many attempts. Try again in a minute.` |
| same, relay at its connection limit | HTTP 503 |
| `GET /j/<ID>` | A static page: "Open W Annotator, choose Join a room and paste this link." The same for every id; 404 if `<ID>` is not a valid room id |
| `GET /health` | `ok` |
| `GET /r/<CODE>?name=` | HTTP 426, unless the relay serves protocol v1 (§15) |
| a TCP connection that has not sent a whole request header after 10 s | closed, no answer |

A browser cannot read the status of a failed WebSocket upgrade. Treat a connection that fails before `hello` as "cannot reach the room server; try again in a minute".

Every answer that is not a websocket upgrade carries `Connection: close`. The relay holds at most twice its websocket limit plus 64 TCP connections at a time; more wait to be accepted.

Use `wss://` whenever the page is served over https. The relay itself speaks plain HTTP; TLS is the proxy's job (`relay/README.md`).

## 3. Handshake

```
relay  → client   hello
client → relay    create | auth | redeem        (one text message, within 10 s, at most 8 KiB)
relay  → client   welcome                        or a close frame with a code from §11
```

The relay takes the first message after `hello` as the handshake, whatever it is. A client sends nothing else, text or binary, until `welcome` has arrived on that connection, on every reconnect as on the first; anything else first is closed with 4400 `bad handshake`.

### 3.1 `hello` (relay → client)

```json
{"t":"hello","proto":[2,2],"nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
 "limits":{"maxMessage":2097152,"maxControl":16384,"maxMembers":16,"messagesPerSec":200,
           "bytesPerSec":20971520,"queueBytes":16777216,"logFrames":2048,"logBytes":8388608}}
```

| Field | Meaning |
|---|---|
| `proto` | `[min, max]` protocol versions this relay speaks. Today `[2,2]` |
| `nonce` | base64 of 32 random bytes, new for every connection. It is signed in the next message |
| `limits` | The relay's limits (§13), so a client can pace itself |

### 3.2 Signature

Every handshake message carries `key` (the member's Ed25519 public key for this room, base64 of 32 bytes) and `sig` (base64 of the 64-byte Ed25519 signature) over these UTF-8 bytes, single spaces, no newline:

```
w-rooms/2 <op> <ROOMID> <nonce>
```

`<op>` is `create`, `auth` or `redeem`, matching `"t"`. `<ROOMID>` is upper-case. `<nonce>` is the string from `hello`, as received. A signature is good for one connection only.

### 3.3 `create` (client → relay) — make a room and become its host

```json
{"t":"create","proto":2,"app":"0.9.0","type":"shared","key":"<base64 32>","xkey":"<base64 32>","sig":"<base64 64>"}
```

| Field | Required | Meaning |
|---|---|---|
| `proto` | yes | `2` |
| `app` | no | App version; ignored by the relay |
| `type` | yes | `"shared"` (shared copy) or `"host-view"` (view through host). Fixed for the life of the room |
| `key`, `sig` | yes | §3.2 with op `create` |
| `xkey` | no | The member's X25519 public key, base64 of 32 bytes. Stored and shown in the roster; the relay does nothing else with it |
| `members` | no | Up to 15 `{ "key", "xkey"?, "role": "editor"｜"viewer" }`. Only for a host re-registering a room after the relay lost its state (`ROOMS.md` C3): those keys are members again without invites |

The room id is chosen by the client (path). Use at least 12 random characters. `create` fails with 4409 if the id is in use or was deleted or closed in the last 30 days, and 4001 `relay full` if the relay holds its maximum number of rooms.

### 3.4 `auth` (client → relay) — sign in as an existing member

```json
{"t":"auth","proto":2,"key":"<base64 32>","sig":"<base64 64>","resume":41}
```

| Field | Required | Meaning |
|---|---|---|
| `key`, `sig` | yes | §3.2 with op `auth` |
| `resume` | no | The last sequence number this client applied. The relay replays what came after it right after `welcome` (§6) |

### 3.5 `redeem` (client → relay) — become a member through an invite

```json
{"t":"redeem","proto":2,"invite":"o7XlWLz18---2w9iH1Eibg","key":"<base64 32>","xkey":"<base64 32>",
 "proof":"<base64 32>","sig":"<base64 64>"}
```

| Field | Required | Meaning |
|---|---|---|
| `invite` | yes | The invite id (§9), 16–64 base64 characters |
| `key`, `sig` | yes | The **new** member key and §3.2 with op `redeem` |
| `xkey` | no | As in `create` |
| `proof` | yes | base64 of HMAC-SHA256, keyed with the invite's `authKey` (§9), over the UTF-8 bytes `w-rooms/2 proof <ROOMID> <nonce> <key>` where `<key>` is the `key` string exactly as sent |

If `key` is already a member, `redeem` behaves like `auth`: no proof is checked and no use is spent. So a client whose connection died before `welcome` can simply retry.

### 3.6 `welcome` (relay → client)

```json
{"t":"welcome",
 "self":{"id":630768347,"role":"editor"},
 "room":{"id":"K7Q2M9XA4TDP","type":"shared","state":"active","proto":2,"epoch":1,
         "head":41,"logFloor":0,"session":"q83vEjRWeJA"},
 "roster":[{"id":1802201963,"key":"<base64>","xkey":null,"role":"host","online":true},
           {"id":630768347,"key":"<base64>","xkey":"<base64>","role":"editor","online":true}],
 "invite":{"wrappedKey":"<what the host registered>"}}
```

| Field | Meaning |
|---|---|
| `self.id` | This member's id (§4) |
| `self.role` | `host`, `editor` or `viewer` |
| `room.type` | `shared` or `host-view` |
| `room.state` | `active` (host connected) or `host-away` (§10) |
| `room.proto` | The protocol the room is pinned to: `2` |
| `room.epoch` | Key epoch every frame must carry. `1` in phase 1 |
| `room.head` | Sequence number of the last ordered edit; `0` if none |
| `room.logFloor` | Replay is possible after any `seq ≥ logFloor` (§6) |
| `room.session` | Random per room record. If it differs from the one the client remembers, the relay lost the room and it was made again: sequence numbers restarted, use the two-way comparison in `ROOMS.md` C6 |
| `roster` | Every member, sorted by id, with `online` |
| `invite` | Only in the answer to a `redeem` that created the membership: the wrapped room key |

`welcome` is always the first message after the handshake. `replay-begin` or a replay error follows at once if `resume` was sent.

### 3.7 Version rule

`proto` in the handshake must be `2`. Lower closes with 4426 and the reason `Update W Annotator to join this room`; higher closes with 4426 and `The host is on an older version`. Show the reason text as is. There is no partial join.

## 4. Identity

- A member is an **Ed25519 key pair made for one room** and kept by the client in its "my rooms" list. Never reuse a key across rooms.
- **Member id** = the first four bytes of `SHA-256(public key)` read as a little-endian `u32`. It is stable across reconnects and relay restarts, and the client can compute it before connecting. `0` means "everyone" in a frame header, so a key whose id is `0`, or collides with another member of the room, is refused with 4400 `key not usable`: generate another key and try again (the invite is not spent).
- Display names never reach the relay in v2. They travel inside encrypted payloads.
- One connection per member. A second sign-in with the same key replaces the first, which is closed with 4003.

## 5. Binary frames

### 5.1 Header (24 bytes, cleartext)

| Offset | Size | Field | Client sets | Relay forwards |
|---|---|---|---|---|
| 0 | 1 | `version` | `2` | unchanged |
| 1 | 1 | `kind` | §5.2 | unchanged |
| 2 | 2 | `flags` | anything; reserved for the client | unchanged |
| 4 | 4 | `from` | anything (ignored) | **the sender's member id** |
| 8 | 4 | `to` | `0` = everyone else, or a member id | the member it was delivered for, `0` for a broadcast |
| 12 | 8 | `seq` | the client's own id for this frame (`cid`) | ordered frames: **the room sequence number**. Others: unchanged |
| 20 | 4 | `epoch` | `room.epoch` | unchanged |
| 24 | … | payload | opaque (ciphertext) | unchanged |

Example. A member with id 630768347 (`0x2598C2DB`) sends a patch with `cid` 7 and the payload `68 69`:

```
client → relay   02 01 00 00  00 00 00 00  00 00 00 00  07 00 00 00 00 00 00 00  01 00 00 00  68 69
relay  → others  02 01 00 00  db c2 98 25  00 00 00 00  29 00 00 00 00 00 00 00  01 00 00 00  68 69
relay  → sender  {"t":"ack","cid":7,"seq":41}
```

A frame may be at most `limits.maxMessage` bytes (2 MiB) including the header. A larger one ends the connection (the WebSocket layer closes it, usually with code 1009).

### 5.2 Kinds and who may send what

| # | Kind | Class | Notes |
|---|---|---|---|
| 1 | patch | edit, **ordered** | Voxel-run patch |
| 2 | seg-op | edit, **ordered** | Segment add / set / delete. Shares the sequence with patches |
| 3 | sync-slab | file | Mask slab for join and catch-up |
| 4 | image-slab | file | Image slab |
| 5 | presence | unordered, **droppable** | Cursor. The relay drops it for a recipient whose queue is more than half full |
| 6 | slice-request | view-through-host | Guest asks the host for a slice |
| 7 | slice | view-through-host | Host's answer: one windowed 8-bit slice |
| 8 | key | targeted | Key delivery |
| 9 | sync-request | file | A member asks another for slabs (`sync-req` in `ROOMS.md` C6) |

Kind 9 is new relative to the kind list in `ROOMS.md` C8; see the decisions there.

**Shared-copy room**

| Kind | Host | Editor | Viewer | `to` | Delivered to |
|---|---|---|---|---|---|
| 1, 2 | yes | yes | **refused** `forbidden` | ignored | everyone else, ordered |
| 3, 4, 9 | yes | yes | yes | required, else `needs-recipient` | that member |
| 5 | yes | yes | yes | `0` or a member | everyone else, or that member |
| 6, 7 | refused `wrong-room-type` | | | | |
| 8 | yes | refused `forbidden` | refused `forbidden` | required | that member |

**View-through-host room** (star: the host talks to guests, a guest only ever to the host)

| Kind | Host | Guest (editor) | Guest (viewer) | Delivered to |
|---|---|---|---|---|
| 1, 2 | yes, **ordered** | yes | refused `forbidden` | Host's: all guests. Guest's: **the host only**, not ordered, not acked |
| 5 | yes | yes | yes | Host's: all guests or the one in `to`. Guest's: the host only |
| 6 | refused `forbidden` | yes | yes | the host only; 30 burst, 600 per minute per guest, over that `rate-limited` |
| 7 | yes, `to` required | refused `forbidden` | refused `forbidden` | that guest |
| 8 | yes, `to` required | yes | yes | Host's: that guest. Guest's: the host only |
| 3, 4, 9 | refused `forbidden` | refused `forbidden` | refused `forbidden` | **nobody, ever** |

Whatever a guest puts in `to` is replaced by the host's id. In this room type the host is the authority for edits: a guest sends a patch to the host (the `seq` field carries the guest's `cid` through untouched), the host applies it and sends its own ordered patch to everyone. Guests apply edits only from ordered frames, which only the host can produce.

A file frame (kinds 3, 4, 9) for a member whose outbound queue is more than half full is refused with `busy`, so that one member cannot fill another's queue and have them closed with 4002. A sender told `busy` should stop and let the receiver ask again; a sender that waits for the receiver's reports (§18.4) never gets there.

A refused frame produces `{"t":"error","code":…,"kind":<kind>,"cid":<the seq field>}` (plus `"to"` when a target was named) to the sender and reaches nobody. A targeted frame whose target is a member but not connected, or not a member, produces `error` `offline` with `"to"` (presence frames are dropped silently instead). A frame addressed to oneself is dropped silently.

### 5.3 Ordered frames

- The relay gives every accepted edit frame the next sequence number of the room: 1, 2, 3, … with no gaps, per room, never reused while the room record lives.
- Everyone else receives the frame with `seq` set and `to` = 0. The sender receives `{"t":"ack","cid":<cid>,"seq":<seq>}` instead of its own frame.
- **One stream, one order.** On every connection, acks and other members' ordered frames arrive in increasing `seq`. A client applies them in arrival order.
- Client rule for an ordered frame or ack with sequence number `s`, given the last applied `head`:
  - `s == head + 1`: apply (for an ack: the pending op with that `cid` now has its place), set `head = s`.
  - `s <= head`: already applied; ignore.
  - `s > head + 1`: a gap. Do not apply. Send `replay` with `after: head` (§6) and ignore ordered frames until the replay has filled the gap.
- The relay does not deduplicate. A client that re-sends an unacknowledged op after reconnecting must first look at the replay: the relay replays the member's **own** frames too (with `from` = itself), so an op id inside the encrypted payload tells the client which pending ops were already accepted. Re-send only the others.

## 6. Replay

The relay keeps the last ordered frames of each room in memory: at most `limits.logFrames` (2048) frames and `limits.logBytes` (8 MiB), whichever is hit first. Nothing is written to disk and the log is gone if the relay restarts.

Ask with `resume` in `auth` (§3.4), or at any time with:

```json
{"t":"replay","after":41,"rid":3}
```

| Case | Answer |
|---|---|
| `logFloor ≤ after ≤ head` | `{"t":"replay-begin","after":41,"head":44,"rid":3}`, then every ordered frame with `seq > after` as binary frames exactly as first sent (including the asker's own), in order, then `{"t":"replay-end","head":44,"rid":3}` |
| `after < logFloor`, or the frames asked for do not fit the asker's outbound queue right now | `{"t":"error","code":"replay-too-old","head":44,"logFloor":43,"rid":3}`. The client stays signed in and falls back to a snapshot from a peer (`sync-request`, kind 9) |
| `after > head` | `{"t":"error","code":"replay-ahead","head":44,"logFloor":43,"rid":3}`. The relay lost state; compare `room.session` |

`rid` is absent when the replay was asked for with `resume`. Frames sent by others while a replay is being written are queued after `replay-end`, so the stream stays in order. In a view-through-host room the log holds the host's ordered frames; a guest that cannot be replayed asks the host for slices again.

## 7. Control messages (client → relay)

Text messages after `welcome`, at most `limits.maxControl` (16 KiB) each; a longer one gets `error` `too-large`. Any request may carry `"rid"`: a JSON number or a string of at most 64 characters, echoed in the answer. Text that is not a JSON object with a string `"t"` gets `error` `bad-message`.

"Host only" requests from anyone else get `error` `forbidden`.

| Message | Who | Fields | Success | Errors |
|---|---|---|---|---|
| `ping` | anyone | — | `{"t":"pong"}` | — |
| `replay` | anyone | `after` | §6 | `bad-message`, `replay-too-old`, `replay-ahead` |
| `invite-add` | host | §9.2 | `{"t":"invite-added","invite":{…}}` | `bad-message`, `exists`, `limit` |
| `invite-revoke` | host | `id` | `{"t":"ok","re":"invite-revoke"}` | `not-found` |
| `invite-list` | host | — | `{"t":"invites","list":[{…}]}` sorted by expiry | — |
| `member-remove` | host | `member`, `revokeInvites`? | `{"t":"ok","re":"member-remove"}`; `roster` to everyone left; the removed member is closed with 4403 | `bad-message`, `not-found`, `forbidden` (the host itself) |
| `member-role` | host | `member`, `role`: `editor`｜`viewer` | `{"t":"ok","re":"member-role"}`; `roster` to everyone | `bad-message`, `not-found`, `forbidden` (the host's own role) |
| `room-delete` | host | — | everyone, the host included, is closed with 4410 `room deleted` | — |
| `room-close` | host, view-through-host only | — | everyone is closed with 4410 `room closed` | `wrong-room-type` |

`member-remove` also revokes the invite the removed member came in through, so a multi-use link cannot let them back in with a new key. With `"revokeInvites": true` it revokes **every** invite of the room in the same step (the "Also revoke unused links" tick box of `ROOMS.md` C5).

## 8. Relay → client messages

| Message | When | Shape |
|---|---|---|
| `hello` | first, on connect | §3.1 |
| `welcome` | after a good handshake | §3.6 |
| `presence` | a member connected or disconnected | `{"t":"presence","member":630768347,"online":false}` |
| `roster` | the member list or a role changed (redeem, remove, role, lapse) | `{"t":"roster","members":[…]}`, entries as in `welcome.roster` |
| `room-state` | the host came or went | `{"t":"room-state","state":"host-away"}` |
| `ack` | the sender's ordered frame was accepted | `{"t":"ack","cid":7,"seq":41}` |
| `replay-begin`, `replay-end` | §6 | |
| `invite-added`, `invites`, `ok`, `pong` | answers, §7 | |
| `error` | a frame or request was refused; the connection stays open | `{"t":"error","code":"…"}` plus `rid`, or `kind`/`cid`/`to`, or `head`/`logFloor` |

A new member's arrival is announced with `roster` (not `presence`); a returning member's with `presence`. When several of these are caused by one event they come in the order `presence`/`roster`, then `room-state`.

## 9. Invites

### 9.1 Link format and derivations

```
https://rooms.example.org/j/K7Q2M9XA4TDP#AAECAwQFBgcICQoLDA0ODw
http://192.168.1.20:8787/j/K7Q2M9XA4TDP#AAECAwQFBgcICQoLDA0ODw
```

- Path: `/j/<ROOMID>`. Fragment: base64 of the 16-byte invite secret `s` (22 characters). Browsers and proxies never send the fragment, and the relay never sees `s`.
- To join, the app turns `http(s)://host/j/<ROOMID>` into `ws(s)://host/v2/rooms/<ROOMID>`.
- From `s` both sides derive, with HKDF-SHA256 (RFC 5869), an **empty salt**, and these `info` strings:

| Value | `info` | Length | Goes to |
|---|---|---|---|
| invite id | `w-rooms/2 invite id` | 16 bytes → 22 base64 characters | relay, in `invite-add` and `redeem` |
| `authKey` | `w-rooms/2 invite auth` | 32 bytes | relay, in `invite-add` only; the redeemer keys the proof with it |
| wrap key | `w-rooms/2 invite wrap` | 32 bytes | nobody; wraps the room key client-side |

The relay only needs the id and `authKey` to be what the host registered; the derivation is a convention between clients. It is fixed here so that the host's app and the guest's app agree.

### 9.2 `invite-add`

```json
{"t":"invite-add","rid":1,"id":"o7XlWLz18---2w9iH1Eibg","authKey":"<base64 32>",
 "wrappedKey":"<base64, at most 512 characters>","role":"editor","ttl":86400,"maxUses":1}
```

| Field | Required | Default | Rules |
|---|---|---|---|
| `id` | yes | | 16–64 base64 characters, unique in the room (`exists` otherwise) |
| `authKey` | yes | | base64 of 32 bytes |
| `wrappedKey` | no | `""` | Opaque to the relay; returned to the redeemer in `welcome.invite` |
| `role` | no | `editor` | `editor` or `viewer` |
| `ttl` | no | `86400` (24 h) | Seconds from now, 1 to 604800 (7 days) |
| `maxUses` | no | `1` | `0` = any number until expiry. **Must be 1 in a view-through-host room** |

Answer: `{"t":"invite-added","rid":1,"invite":{"id":"…","role":"editor","expiresAt":1790000000000,"maxUses":1,"uses":0,"revoked":false}}`. `invites` lists the same objects. The relay never sends `authKey` or `wrappedKey` back to the host.

A room holds at most 64 invites. When it is full, registering a new one silently forgets one that can no longer be used (spent, expired or revoked); if all 64 are still usable the answer is `error` `limit`.

### 9.3 Redeeming

On `redeem` the relay checks, in this order, and closes with:

| Check | Close |
|---|---|
| room was deleted or closed | 4410 |
| no such room | 4404 |
| the key was removed from this room | 4403 |
| the key is already a member | — signs in (§3.5) |
| no such invite | 4408 `invite not valid` |
| revoked | 4408 `invite revoked` |
| past `expiresAt` | 4408 `invite expired` |
| all uses spent | 4408 `invite already used` |
| locked after 5 wrong proofs (10 minutes) | 4429 `too many attempts` |
| wrong proof | 4408 `invite not valid` |
| room has 16 members | 4001 `room full` (no use spent) |
| key id is 0 or taken | 4400 `key not usable` (no use spent) |

Otherwise the key becomes a member with the invite's role, one use is spent, and `welcome` carries `invite.wrappedKey`. Two people racing for a single-use invite: exactly one wins, the other gets `invite already used`.

Spent, expired and revoked invites stay in `invites` until one day after their expiry, then they are forgotten (and read as `invite not valid`).

## 10. Lifecycle

**Shared copy.** `room.state` is `active` while the host is connected and `host-away` otherwise; the others keep editing either way. When nobody is connected the record stays in the relay's memory (dormant): members, roles, invites, `head`, the log. A member that has not connected for 30 days stops being a member (`roster` is sent; a later `auth` gets 4401). A room nobody has connected to for 30 days is forgotten (4404). The host never lapses.

**View-through-host.** The room exists while its host does:

| Event | What guests see | When |
|---|---|---|
| Host sends `room-close` | close 4410 `room closed` | at once |
| Host's WebSocket closes cleanly (a close frame) | close 4410 `room closed` | at once |
| Host's connection breaks without a close frame | `room-state` `host-away` at once — **blank the view**; then close 4410 `host lost` unless the host signs in again | 15 s later |
| Host goes silent (lid shut, cable pulled) | close 4410 `host lost` | when the relay has heard nothing from the host for 15 s (it pings the host every 5 s) |
| Host signs in again during `host-away` | `presence`, then `room-state` `active` | |

When the room closes, the relay erases its members, invites and log. The id answers 4410 for 30 days and cannot be created again in that time: a new session is a new room id with new links. A guest that loses its socket to the relay itself must treat that like `host-away` and then closed.

**Removal.** The removed member's connection is closed with 4403 `removed by host` at once; `auth` and `redeem` with that key answer 4403 from then on (the relay remembers the last 256 removed keys per room; older ones answer 4401, which is just as final).

**Deletion.** `room-delete` closes everyone with 4410 `room deleted` and frees the room. The id answers 4410 to `auth` and `redeem`, and 4409 to `create`, for 30 days.

**Relay restart.** All of the above is in memory. After a restart every room is unknown (4404). The host re-creates the room under the same id with `create` and `members` (§3.3); `room.session` changes and `head` restarts at 0.

## 11. Close codes

| Code | Reason text | Meaning | What the client should do |
|---|---|---|---|
| 4001 | `room full` / `relay full` | 16 members already, or no space for another room | Say so; do not retry automatically |
| 4002 | `too slow` | The outbound queue (16 MiB or 4096 messages) overflowed | Reconnect with `resume` |
| 4003 | `signed in elsewhere` | The same key signed in on another connection | Do not reconnect automatically |
| 4400 | `bad handshake` / `handshake timed out` / `key not usable` | Malformed or late first message | `handshake timed out` for a member already welcomed: reconnect, it was a slow network. Otherwise a bug, or regenerate the key |
| 4401 | `not a member` / `bad signature` | Unknown key or wrong signature | "You are not a member of this room" |
| 4403 | `removed by host` | | `ROOMS.md` C10 text; never retry |
| 4404 | `no such room` | | Members: "Waiting for the host to reopen the room." Host: `create` again |
| 4408 | `invite expired` / `invite already used` / `invite revoked` / `invite not valid` | | `ROOMS.md` C10 text |
| 4409 | `room id taken` | `create` for an id in use or recently deleted | Pick another id (or `auth` if it is yours) |
| 4410 | `room deleted` / `room closed` / `host lost` | The room is gone | `ROOMS.md` C10 text; wipe memory in a view-through-host room |
| 4426 | see §3.7 | Version mismatch | Show the reason |
| 4429 | `rate limited` / `too many attempts` | Over the per-connection rate, or the invite is locked | Back off; "Too many attempts. Try again in a minute." |

A member whose connection the relay stops hearing from is closed without a code (the client sees 1005 or 1006). A relay shutting down closes without a code as well.

## 12. Error codes (`{"t":"error","code":…}`)

| Code | Cause |
|---|---|
| `bad-message` | Text that is not a JSON object with `"t"`, or a request with a missing or invalid field |
| `too-large` | Control message over 16 KiB |
| `bad-frame` | Binary message shorter than the 24-byte header |
| `bad-version` | Header version byte is not 2 |
| `bad-epoch` | Header epoch is not `room.epoch` |
| `forbidden` | The role or the room type does not allow this (§5.2, §7) |
| `wrong-room-type` | Slice frames in a shared-copy room; `room-close` in one |
| `needs-recipient` | A kind that must name one member was sent with `to` = 0 |
| `offline` | The named member is not connected or not a member |
| `busy` | A file frame for a member whose queue is more than half full; the frame was dropped (§5.2) |
| `rate-limited` | The room's or the guest's allowance is used up; the frame was dropped |
| `not-found` | No such member or invite |
| `exists` | Invite id already registered |
| `limit` | 64 usable invites already |
| `replay-too-old`, `replay-ahead` | §6 |

Errors never close the connection.

## 13. Limits

| Limit | Value | When exceeded |
|---|---|---|
| Message size | 2 MiB | Connection ends |
| Control message | 16 KiB | `too-large` |
| Handshake message | 8 KiB, within 10 s | 4400 |
| Per connection | 200 messages/s and 20 MiB/s, one second of burst | 4429 `rate limited` |
| Host of a view-through-host room | 800 messages/s and 80 MiB/s | 4429 |
| Per room, all members together | 800 frames/s and 80 MiB/s | frame dropped, `rate-limited` |
| Slice requests per guest | 30 burst, 600 per minute | frame dropped, `rate-limited` |
| Outbound queue per connection | 16 MiB, 4096 messages (more than the replay log holds) | 4002; file frames are refused with `busy` from half full |
| Request header of a new TCP connection | 10 s | Connection closed |
| Members per room | 16 | 4001 |
| Invites per room | 64 | `limit` |
| Wrong invite proofs | 5, then locked for 10 minutes | 4429 |
| Connection attempts per IP | 30 per minute | HTTP 429 |
| Replay log per room | 2048 frames, 8 MiB | older frames leave the log |
| Rooms per relay | 1024 | 4001 `relay full` |
| Connections per relay | 4096 websockets; 8256 TCP connections | HTTP 503; further TCP connections wait |

Every number is a relay setting; `hello.limits` carries the ones a client needs. A client should stay under half of the per-connection rate. The app does: everything a connection sends goes out in order through one pace of half of `messagesPerSec` and `bytesPerSec` (four times that for the host of a view-through-host room), with a burst of a quarter of a second of messages and a fifth of a second of bytes.

Pings and pongs count towards the per-connection rate like any other message.

## 14. Liveness

The relay sends WebSocket pings: every 20 s to ordinary connections, every 5 s to the host of a view-through-host room. Browsers and WebSocket libraries answer them without help. A connection the relay hears nothing from (no message, no pong) for 60 s — 15 s for that host — is dropped. For its own check of the relay, a client can send `{"t":"ping"}` and expect `{"t":"pong"}`.

## 15. Protocol v1 next to v2

The app speaks v2 only. A relay answers `/r/…` with HTTP 426 and the body `Update W Annotator to join this room`. Started with `--v1` it also serves v1 at `/r/<CODE>?name=<name>` as before (`relay/README.md`); a v1 room and a v2 room are then different rooms even if their ids look the same, and nothing crosses over.

## 16. Test vectors

All checked by `the_documented_test_vectors_hold` in `relay/tests/v2_invites.rs`.

```
invite secret s (hex)         000102030405060708090a0b0c0d0e0f
link fragment                 AAECAwQFBgcICQoLDA0ODw
invite id                     o7XlWLz18---2w9iH1Eibg
authKey                       Ev6xTmVvi_PF1s4sBZ0574I-WYcQptT7s2zTWr1B0wk
wrap key                      KzS7nbWnBhOGTNPJJh0PNDD9km4D4s4nyLiwjLD5nLk

room                          K7Q2M9XA4TDP
nonce (32 bytes of 0x02)      AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI
redeemer key (32 × 0x01)      AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE
proof input                   w-rooms/2 proof K7Q2M9XA4TDP AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE
proof                         Ee54exLwUMB302Rnxij9CVCOLifBmAQwuL4ObJ1v_RE

Ed25519 seed (32 × 0x09)
public key                    _RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg
SHA-256(public key) starts    db c2 98 25
member id                     630768347
signing input                 w-rooms/2 auth K7Q2M9XA4TDP AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI
signature                     RA6G6hqKeo4SjyGYi2a-HgiEhanc_D8SKC80umU9m0jJD2E46pzO7s8g-dLWlRrVU65LYnMXsHFcHOIqR-TbDQ
```

Header bytes for `version 2, kind 1, flags 0x0102, from 0x0A0B0C0D, to 7, seq 0x1122334455667788, epoch 1`:

```
02 01 02 01 0d 0c 0b 0a 07 00 00 00 88 77 66 55 44 33 22 11 01 00 00 00
```

## 17. What the relay does not do

- **Encrypt or decrypt.** Payloads, names and segment names are the client's to protect (`ROOMS.md` C7, task 1.10). Bind room id, epoch and frame kind as associated data, and repeat the sender and the recipient inside the payload (§18.1), since the relay could otherwise re-label a frame.
- **Vouch for what it says about the room.** `room.type`, `self.role` and `self.id` in `welcome` are the relay's word. A client must hold on to what it knows itself (§18.6).
- **Deduplicate ops.** See §5.3.
- **Store anything on disk**, or keep a payload beyond the replay log.
- **Choose a snapshot source, pace slabs or resume transfers.** Kinds 3, 4 and 9 are delivered to the member named in `to`; the rest is the client's protocol inside the payload (`ROOMS.md` C6, task 1.6).
- **Rate-limit slices by content.** It counts slice requests per guest; "viewed 212 of 300 slices" is the host app's count.
- **Let editors invite** ("can invite", task 2.5) or **rotate keys** (task 2.3). `epoch` is always 1 in phase 1.

## 18. Inside a payload (the app's layer)

Everything here is invisible to the relay. It is what `src/collab/` sends; a second client must do the same to share a room with the app. `e2e-desktop/roombot.mjs` is such a client.

### 18.1 Encryption

- A room has one 32-byte **room key**, made by the host. In `invite-add`, `wrappedKey` is base64 of `nonce ‖ AES-256-GCM(wrap key, room key)` with the 12-byte nonce in front and the associated data `w-rooms/2 room key`; the wrap key is the one of §9.1.
- Every frame payload is `nonce (12 random bytes) ‖ AES-256-GCM ciphertext and tag`, keyed with the room key, with the associated data `w-rooms/2 <ROOMID> <epoch> <kind>` (decimal numbers, single spaces). A frame that does not open is ignored, but an ordered one still takes its place in the order.
- The plaintext is `u32 n` (little-endian), then `n` bytes of UTF-8 JSON (an object, called *meta* below), then raw bytes (*body*).
- Every meta carries `"f"`: the sender's member id, and, in a frame for one member, `"d"`: that member's id. The relay writes `from` and `to` in the clear header and could write anything; a receiver drops a frame whose `f` is not the header's `from`, or whose `d` is neither 0 nor its own id, exactly as it drops one that does not open. Apps up to 0.1.2 send neither field, and a frame without them is taken as before.

### 18.2 Edits (kinds 1 and 2)

| Kind | meta | body |
|---|---|---|
| 1 patch | `{"c": <cid>}` | `u32` run count, then `u32 start, u32 length` per run, then the new label values of all runs back to back. At most 1 MiB; a larger edit is sent as several patches |
| 2 seg-op | `{"c": <cid>, "op": "set", "seg": {"index": 1–255, "name", "color": "#rrggbb", "locked"}}` or `{"c", "op": "del", "index"}` | — |
| 2 seg-op, view-through-host, host only | `{"c", "op": "window"}`: the host changed its window; guests fetch their planes again | — |

Every edit also carries `"s"`: a tag the sender made at random for this visit to the room (at most 24 characters), under which `c` only goes up. A receiver keeps, for each sender and tag, the highest `c` it has applied, and leaves out an edit that is not above it: the relay sending an old edit again under a new sequence number. The edit still takes its place in the order. Everyone leaves out the same edits, so masks agree. In a view-through-host room the host applies the same rule to what guests send it. An edit without `s` (an app up to 0.1.2) is not checked.

`c` is the same number as the header's `seq` on the way in. A client recognises its own edit in a replay by `from` = itself and `c`. In a view-through-host room the host re-sends a guest's edit as its own ordered frame with `"o": [<guest id>, <guest cid>]` added, which tells that guest its edit has its place.

A client applies ordered edits in sequence, then puts its own not yet numbered edits back on top (§5.3).

### 18.3 Presence (kind 5)

`{"t": "hi", "name": "<at most 24 characters>"}` after `welcome` and whenever someone new appears; in a view-through-host room the host adds `"names": [[<member id>, "<name>"], …]` so guests learn each other's names. The host of either kind of room adds `"kind": "shared"|"host-view"`: what it made, to set against what the relay says (§18.6). A receiver removes control characters and invisible direction and joining marks from names before showing them. `{"t": "cursor", "vp": "axial"|"sagittal"|"coronal"|null, "w": [x, y, z], "r": <brush radius, mm>}` at most about 16 times a second.

### 18.4 Joining and coming back in a shared-copy room (kinds 9, 3, 4)

```
asker  → member   9  {"rid", "image": true|false, "fp": "<fingerprint of the open image>"|null, "flow": 1, "skip": [z0, …]}
member → asker    3  {"rid", "t": "begin", "head", "dims": [x,y,z], "slabs", "segments": [...],
                      "image": {"dims","spacing","origin","direction","dtype"} | null, "flow": 1, "seen": [...]}
member → asker    4  {"rid", "z0", "part", "parts"} + part of gzip(image slices z0 … z0+15)     (only when asked for)
member → asker    3  {"rid", "t": "slab", "z0", "part", "parts"} + part of gzip(mask slices z0 … z0+15)
asker  → member   9  {"rid", "t": "ack", "n": <packed bytes received so far>}                   (only after "flow": 1 in begin)
member → asker    3  {"rid", "t": "end"}
```

Instead of `begin` a member may answer `{"rid","t":"no"}` (not ready, or already sending to two others; ask someone else) or `{"rid","t":"different"}` (the asker's image is not the room's). The mask is the room's confirmed state at sequence number `head`; the asker applies ordered frames after `head` on top. No file name, path or tag is sent, and the asker names the image `Room image`.

- `rid` is a random number below 2^53, so an answer recorded from an earlier transfer cannot be passed off as this one's.
- **Pacing by the receiver.** An asker that sends `"flow": 1` reports what has arrived. A member that understands it says `"flow": 1` in `begin` and then keeps at most 4 MiB sent and not yet reported; it gives up on a receiver that reports nothing for 20 s. An asker sends `ack` only after such a `begin`: an older member would read it as a new request. Without `flow` the member sends at its own pace, as before.
- **Picking up after a cut.** `skip` lists the first slices of the image slabs the asker still holds from a transfer that was interrupted; the member leaves those out. The mask is always sent whole, since it may have changed. An older member ignores `skip` and sends everything.
- `seen` is the member's list of `[sender id, tag, highest c]` (§18.2), so the asker refuses the same repeated edits as everyone else.
- A member runs one transfer per asker (a new request replaces the earlier one) and sends to at most two askers at once.

What the asker checks before it takes anything: `dims` are three whole numbers from 1 to 65535 and match the open image, if any; `head` is not above the highest sequence number the relay has shown it; there is one `begin`; each slab starts on a multiple of 16 inside the volume, is collected to at most its raw size plus 0.1 % and 1024 bytes, and unpacks to exactly its raw size (unpacking stops the moment more comes out); and at `end` every slab of the volume is there. If any of this fails the asker turns to the next member.

### 18.5 View through the host (kinds 6 and 7)

```
guest → host   6  {"t": "describe", "q"}
host  → guest  7  {"t": "room", "dims", "spacing", "origin", "direction", "segments": [...], "head", "seen": [...], "q"}
guest → host   6  {"axis": 0|1|2, "index": <plane along that axis>, "q"}
host  → guest  7  {"t": "slice", "axis", "index", "q"} + gzip(8-bit picture of the plane ‖ its labels)
```

The picture is the plane mapped through the host's current window to 0–255 and clipped. Plane order: axis 2 is `x` within `y`; axis 1 is `x` within `z`; axis 0 is `y` within `z`. The host answers at most 30 requests at once and 600 a minute per guest, and sends nothing a guest did not ask for. The app asks for the plane each view shows and the one on each side: a view is drawn from a thin slab around its plane, and a missing neighbour would darken it.

`q` is a random number the guest makes for each question; the host sends it back. A guest drops an answer whose `q` is not the one it is waiting for, so an old answer (one the relay kept, or one made before the host changed its window) cannot stand in for a new one. An answer without `q` (an older host) is taken as before. A plane is unpacked only up to the size it must have.

### 18.6 What a client holds on to

The relay says what kind a room is and what role a member has, in `welcome`. Neither ever changes, and a client knows some of it without being told:

| The client | knows |
|---|---|
| made the room (`create`) | its kind, and that it is the host |
| comes back to a room it remembers | that the room is a shared copy, and whether it is the host |
| joins with a link for the first time | that it is not the host; the kind only from the first `welcome`, and then from the host's `hi` (§18.3) |

After the first `welcome` the kind and "host or not" are fixed for as long as the client stays in the room. A `welcome` that disagrees with what the client knows, or whose `self.id` is not the id of the client's own key, is not followed: the client leaves the room and says "The room server sent something that does not fit this room, so you left it." The same when the host's `hi` names another kind than `welcome` did. Without this, a relay could tell the host of a view-through-host room that the room is a shared copy, and the host would send the image to whoever asked.
