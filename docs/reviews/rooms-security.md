# Rooms: security review

Date: 2026-11-22. Reviewed: rooms as shipped in 0.1.2 (`origin/main` at `6a9f410`). Fixes are on the branch `fix/rooms-hardening`.

Update, same day, branch `feat/rooms-keys` (for 0.1.4): the accepted findings A1, A2 and A6 are closed and A5 is narrowed. See "Closed in 0.1.4" below; the text under "Accepted" is kept as it was written, with a note on each.

This is the project's own review of its own code, done by reading the code and writing a failing test for each weakness before fixing it. It is not an independent review, and `SECURITY.md` still says so.

## What was reviewed

`src/collab/` (protocol, client, crypto, identity, oplog, transfer, hostview, segops, rooms), the room parts of `src/session.ts`, the room dialogs, `relay/src`, `src-tauri/src/hosting.rs`, and the content security policy and capabilities in `src-tauri/`.

## Threat model, in short

| Who | What they have | What they must not be able to do |
| --- | --- | --- |
| Whoever runs the room server, or sits on the network to it | Every frame's header and ciphertext, the member list, the right to order, drop and delay frames | Read names, voxels or segment names; make up or change an edit; act as a member or the host; learn the room key |
| A guest with a valid invite | The room key, and whatever their role allows | Crash, hang or exhaust another member or the relay; write outside the mask; do what only the host may; come back after being removed; get the file in a view-through-host room |
| A stranger who can reach the relay | A TCP connection | Read anything; join a room; tie up the relay for nothing |
| Someone with the device | The app's local storage | Find more than `SECURITY.md` says is kept |

One thing was outside what the design defended up to 0.1.3: **every member of a room held the same room key**. From 0.1.4 that is no longer so; see "Closed in 0.1.4".

## Findings

Severity is for a room used as intended: a few people who know each other, on a relay one of them runs or on the host's own computer.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | High | The kind of room and who its host is were taken from the relay at every sign-in | Fixed, `47e2524` |
| 2 | Medium | The relay could stamp one member's frame as another's | Fixed, `47e2524` |
| 3 | Medium | The relay could send an old edit again as a new one | Fixed, `47e2524` |
| 4 | Medium | Compressed data from a member was unpacked without a size limit, and collected without one | Fixed, `47e2524` |
| 5 | Medium | A transfer with slabs missing was opened as if complete; its place in the order and its request id were not checked | Fixed, `47e2524` |
| 6 | Medium | A member could make another send the image many times at once; a large edit or transfer could run into the relay's rate limit and be closed, again and again | Fixed, `47e2524` |
| 7 | Medium | Relay: a replay longer than a member's queue closed that member, on every attempt | Fixed, `5083367` |
| 8 | Medium | Relay: one member could get another closed as "too slow" by sending them file frames; an honest transfer to a slow connection did the same | Fixed, `5083367` and `47e2524` |
| 9 | Medium | Relay: a TCP connection that never finished its request was kept for ever, and there was no limit on how many | Fixed, `5083367` |
| 10 | Low | A patch with one run outside the mask was half applied | Fixed, `47e2524` |
| 11 | Low | Edits arriving while the mask was still on its way were kept without limit | Fixed, `47e2524` |
| 12 | Low | An invite link with `user@host`, a query or other odd host was accepted | Fixed, `47e2524` |
| 13 | Low | Names could carry control and direction characters; a guest could become "Mina" and turn the host into "Mina 2" | Fixed, `47e2524` |
| 14 | Low | Text and lists from the relay were used unchecked: the 4426 reason was shown as it came; `welcome` and `roster` were not validated; cursor positions were not checked | Fixed, `47e2524` |
| 15 | Low | Relay: pings did not count towards the rate limit | Fixed, `5083367` |
| 16 | Low | View-through-host: an old answer to a slice request could stand in for a new one | Fixed, `47e2524` |
| 17 | Low | The relay inside the desktop app listens on every network interface | Partly fixed, `5083367`; the rest accepted |
| A1 | Medium | One shared room key | **Closed in 0.1.4**: pair keys, signed frames, a new room key on removal |
| A2 | Medium | The relay orders the edits, so it can drop, delay and reorder them, and show different members different things | **Detected since 0.1.4** (dropping, reordering, showing different things). Delay and refusal to deliver stay accepted |
| A3 | Medium | Anyone who can reach a relay can create rooms; after a relay restart a room id can be taken by someone else | Accepted; keep a relay private |
| A4 | Low | A member is trusted for content | Accepted |
| A5 | Low | Member keys and room keys are kept in local storage as they are | Still accepted. Since 0.1.4 a removal makes the stored room key of a removed device useless for anything sent later |
| A6 | Info | The desktop app sets no content security policy | **Closed in 0.1.4** |
| A7 | Info | The new checks on what the relay does cover frames from up-to-date apps only | **Gone in 0.1.4**: protocol 3 has no room with an older app in it |

### 1. Kind of room and host taken from the relay (high)

`welcome` carries `room.type` and `self.role`, and the app copied both on every sign-in, including each reconnect. The host of a view-through-host room whose relay answered a reconnect with `"type":"shared"` would from then on answer any member's request for the image (`serveSync` only checked the kind it had just been told). A guest working with the relay operator would have received the full 16-bit image from a room made so that the file never leaves the host.

Fix: the device that makes a room knows its kind and that it is the host; a device that comes back to a remembered room knows both too. The first `welcome` fills in what a new guest cannot know, and from then on neither may change. A `welcome` that disagrees, or that gives the device another member's id, ends the room on that device with "The room server sent something that does not fit this room, so you left it." The host also says the kind of its room inside its encrypted greeting; a guest whom the relay told otherwise leaves and forgets the room.

Tests: `client.test.ts` ("knows a room that is not what this device joined"), `e2e/room-hostile.spec.ts` ("a room server that calls a view-through-host room a shared copy is not believed").

Since 0.1.4 the kind of room is sealed into the invite by the host, so a newcomer no longer has only the relay's word for it. As it was in 0.1.3: a guest joining for the first time has only the relay's word for the kind until the host's greeting arrives, a moment later. In that moment a lying relay can make a view-through-host guest write the room's id and keys to local storage; they are removed when the greeting arrives. A host on 0.1.2 sends no kind, so its guests keep relying on the relay.

### 2. The relay could re-label frames (medium)

The associated data of a frame bound the room id, the key epoch and the frame kind, but not the sender or the recipient, which the relay writes into the clear header. The relay alone, without the key, could deliver one member's frame as coming from another: a guest's greeting as the host's (the host's greeting is believed for other people's names), or in a view-through-host room a guest's edit as an ordered edit of the host.

Fix: every frame now repeats its sender (`f`) and, when it is for one member, its recipient (`d`) inside the encrypted part. A frame whose inner sender is not the one the relay stamped, or that is for someone else, is treated like one that failed to open. Old apps ignore the two fields; frames without them are still accepted (see A7).

Tests: `client.test.ts` ("who a frame is from and for"), `e2e/room-hostile.spec.ts` ("the room server cannot pass one member off as the host").

### 3. The relay could replay edits (medium)

`ROOMS.md` C7 said replays "are rejected by op id". They were not: an op id was only used to recognise one's own edit coming back. The relay could send a recorded patch again under a new sequence number, and everyone applied it: a stroke that had been undone came back, on every screen, with nobody having made it.

Fix: an edit names, inside the encrypted part, the sender's tag for this visit to the room (`s`, random) next to its number in that visit (`c`). Everyone keeps, per sender and visit, the highest number taken (`ReplayGuard`), and leaves out an edit that is not above it. Because everyone leaves out the same edits, masks still agree. Someone joining gets the list with the mask (`seen` in `begin` and in the view-through-host `room` answer), so they refuse the same repeats.

Tests: `hardening.test.ts` (ReplayGuard), `e2e/room-hostile.spec.ts` ("an edit the room server sends a second time is not applied a second time").

Limits: the list holds 16 visits for each of 64 senders; older ones are forgotten. Presence frames (names, cursors) are not covered: a relay can replay an old greeting and so put back a name someone has since changed.

### 4. Decompression bombs and endless parts (medium)

A slab of a transfer and a plane of a view-through-host room arrive gzip-compressed. Both were unpacked with no limit: a frame of 2 MiB can unpack to about 2 GiB, on the main thread for a plane. A slab is sent in parts and the sender says how many; the receiver collected them without limit. The sender is whoever the joiner asked: the host first, any other member when the host is away or slow to answer.

Fix: `gunzipExactly` unpacks in small steps into a buffer of the size the slab or plane must have and gives up the moment more comes out (a few milliseconds for a bomb, measured in the test). A slab being collected may not grow past the slab's raw size plus a small allowance.

Tests: `hardening.test.ts` ("compressed data from someone else", "PartAssembler limits").

### 5. Transfers: holes, place in the order, request ids (medium)

- `end` was accepted without checking that every slab had come. A dropped frame, or a relay that left frames out, gave the joiner an image with blank slices and no warning. Now every expected slab must be there, counted from the dimensions, not from what the sender says.
- The sender names the edit number its mask stands at. A number ahead of anything the room has reached made the joiner ignore every later edit. It must now be at or below the highest number the relay has shown the joiner.
- Request ids were 1, 2, 3 …, so a recorded answer to an earlier joiner could be replayed to a later one. They are random now.
- A second `begin`, a slab that is not a slab of this volume, or a slab that does not unpack to its size sends the joiner to the next member instead of taking what was sent.

### 6. Many transfers at once; sending faster than the relay allows (medium)

Each request for the image started its own transfer, each with its own allowance of 8 MiB a second. A member sending twenty requests made the host compress and send the scan twenty times at once and pushed the host over the relay's limit of 20 MiB a second, at which the relay closes the connection (4429). The same limit was hit without any attacker by a single large edit: an edit is cut into pieces of 1 MiB and all were sent at once. The app then reconnected, merged, sent the same edit again and was closed again.

Fix: one transfer per member (a new request replaces the earlier one) and two at a time; everything a connection sends goes through one pace of half the relay's limits (`Pace` in `client.ts`), in the order it was given.

Tests: `client.test.ts` (Pace), `e2e/room-hostile.spec.ts` ("asking for the image over and over gets one transfer, not twenty"), `e2e/room-scale.spec.ts` (large edits each way without losing the connection).

### 7. Relay: replay overflowed the asker's queue (medium)

The log keeps 2048 frames; a member's queue had 1024 places. A member who had missed between about 1000 and 2048 small edits asked for a replay, the relay queued the whole log at once, the queue overflowed and the relay closed the member as "too slow" (4002). The app reconnected, asked again, and was closed again, until enough new edits had pushed the log past what it had missed.

Fix: the queue has 4096 places, and a replay that still would not fit is answered `replay-too-old`, on which the app gets the mask from a member.

Tests: `relay/tests/v2_hardening.rs` (two tests on replay).

### 8. Relay: closed by someone else's frames (medium)

Any member of a shared-copy room may address file frames to any other. The relay queued them for the recipient without limit until the queue was full, then closed the recipient. A member could keep another out of the room this way. The same happened by accident: a transfer is paced by the sender, so a joiner on a connection slower than the sender was flooded, closed, and started again from nothing.

Fix, relay: file frames for a member whose queue is over half full are refused; the sender gets the new error `busy`. Fix, app: the receiver reports how much has arrived and the sender keeps at most 4 MiB on the way (`flow` in the request and in `begin`); a sender told `busy` stops that transfer.

Tests: `relay/tests/v2_hardening.rs` ("flooding one member…"), `e2e/room-scale.spec.ts`.

### 9. Relay: connections that never finish (medium)

The HTTP layer the relay uses has no time limit for reading a request unless it is given a timer, and it was not. A connection that sent nothing, or half a request, stayed open for ever, and nothing limited how many there were. Anyone who could reach the port could use up the relay's file descriptors.

Fix: a connection must send a whole request header within 10 seconds, at most twice the websocket limit plus 64 are open at once, and every answer that is not a websocket upgrade closes its connection (`relay/src/listen.rs`). A websocket still has 10 seconds for its handshake and then the ping rules.

Tests: `relay/tests/v2_hardening.rs` ("a connection that never finishes its request is dropped").

### 10 to 16 (low)

- **10.** `applyPatch` wrote run after run and threw at the first run outside the mask, leaving the earlier runs written. A patch from someone else is now checked whole (`patchFits`) before anything is written.
- **11.** While a joiner waits for the mask, edits are queued. Past 64 MiB or 4096 edits the queue is dropped and the transfer starts again from a newer mask.
- **12.** `parseInvite` took anything up to the first `/` as the host, so `https://rooms.example.org@evil.example/j/…` connected to `evil.example`. The host must now be a plain name or address with an optional port.
- **13.** Names and segment names lose control characters and the invisible marks that reorder or hide letters. When two people have the same name the host is never the one given a number; before, the lower member id won, and a member id can be chosen by trying keys.
- **14.** The reason of close code 4426 is shown only if it is one of the two texts the protocol defines. `welcome` and `roster` are checked field by field. A cursor must be in a known view, at finite coordinates, with a radius of at most 500 mm.
- **15.** Pings and pongs count towards a connection's rate.
- **16.** A slice request carries a random number that comes back with the answer. An answer to a question not asked, or asked before the host changed its window, is dropped.

### 17. The embedded relay listens on every interface (low, partly fixed)

The relay inside the desktop app binds `0.0.0.0` while a room is hosted, so it can be reached from every network the computer is on, not only the one the invite names. Someone there cannot read or join a room. They can create up to 8 rooms and hold up to 128 connections, which can keep the host's guests out.

Fixed: with no network address to share, it now listens on this computer only. Accepted: with an address, it still listens on all interfaces. Binding the one address in the link needs the address picker of `ROOMS.md` task 1.12, which is not built, and a wrong guess would make hosting fail on computers with a VPN or virtual adapters. The relay stops when the room ends.

## Accepted

As written for 0.1.3. A1, A2, A6 and A7 are answered under "Closed in 0.1.4".

**A1. One shared room key.** Everyone who has been given the key can read everything sent under it. So:

- A guest who works with whoever runs the relay can read what the host sends other guests, and can make frames that pass as another member's (they need not include the sender check of finding 2).
- Removing someone stops the relay delivering to them. It does not change the key. A removed person who can still see the traffic reads it: with the relay operator's help, or on their own on a network without TLS. That includes the usual case of a room hosted by the desktop app on a local network, which is plain `ws://`.
- A view-through-host guest who works with the relay operator sees the pictures sent to other guests. They do not get the file: after finding 1 the host no longer sends it.

Changing this needs keys per pair in view-through-host rooms and a new key on removal in shared-copy rooms (`ROOMS.md` C7, tasks 2.3). Until then: run the relay yourself, use `wss://`, and start a new room after removing someone you no longer trust.

**A2. The relay orders the edits.** It can drop or delay any frame, order edits made at the same moment as it likes, stop delivering to one member, and show two members different things. None of that needs the key and none of it can be told from a bad connection. What it can no longer do is make up an edit, change one, apply one twice, or pass one member's edit off as another's. It can also add a member of its own, who has no key and can read nothing.

**A3. Open relays.** Anyone who can reach a relay can create rooms until its limit (1024) is reached, and an unused room stays for 30 days. After a relay restart rooms exist only on the members' devices; whoever first asks to create a known room id gets it, and the real host and members are then turned away. Neither gives access to data. Keep a relay on a private network or behind a proxy that asks for a password; an admin token is phase 2.

**A4. A member is trusted for content.** An editor can change any voxel, including a locked segment's (locks are kept by each app, not by the room), add segments up to 255, and send large edits as fast as the rate allows. A member asked for the mask can send a wrong one. The host sees who is in the room and can remove them; A1 says what removal does not do.

**A5. Local storage.** For each shared-copy room a device is a member of, the member key and the room key are in the app's local storage, unencrypted, until the room is forgotten, deleted, or unused for 30 days. A view-through-host room writes nothing (but see the note under finding 1).

**A6. No content security policy.** `tauri.conf.json` has `"csp": null`. No way to inject markup was found: names, segment names and link text go through React, nothing is set as HTML, and the relay's `/j/` page has a strict policy and no script. A policy would still limit the damage of a future mistake. It is not added here because it can only be tried against the built app on all three systems; it should be its own change.

**A7. Mixed versions.** Findings 2, 3 and 16 work by the sender adding fields that old apps do not send. A frame made by a 0.1.2 app can still be re-labelled or replayed by the relay, and a 0.1.2 app applies none of the new checks to what it receives. Nothing breaks when versions are mixed; the room is as strong as it was. The wire protocol version stays 2.

## Closed in 0.1.4

Branch `feat/rooms-keys`. The design is `ROOMS-PROTOCOL.md` §19; the code is `src/collab/keys.ts`, `src/collab/chain.ts` and their use in `client.ts` and `session.ts`. This is still the project's own work reviewed by itself.

### A1. No single room key any more

- **For one person.** A frame for one member is sealed under a key only that member and the sender can make (X25519 between keys each made for this room). That covers the image and mask slabs of a join, slice pictures and room descriptions in a view-through-host room, requests, and key deliveries. A guest who is handed every frame by the relay opens none that were for someone else.
- **For everyone.** Edits, names and cursors are sealed under the room key of the current epoch and signed by their sender. A member who holds the room key and makes a frame in another member's name fails the signature check on every device.
- **Who the members are** is a list the host signs. The relay's roster is used to know who is connected, never whom to trust. A newcomer learns the host's keys from the invite (sealed with a key from the link) and proves to the host, with another key from the link, which keys are its own. The relay has neither key, so it cannot stand between the two at first contact, and it cannot add a member who is then handed keys.
- **Removal.** The host makes a new room key and hands it, under each pair key, to the people who stay. Frames carry the epoch. A removed person holds the old key and reads nothing sealed under the new one. Someone who was away gets the new key on return from the host, or from another member when the host is away; the member checks against the host's signed list, so nobody removed is ever handed it.
- The invite no longer carries a room key, so a link that is never used, or the relay that stores it, holds nothing that opens the room.

Tests: `keys.test.ts` (ten groups, with vectors), `e2e/room-hostile.spec.ts` ("what the host sends one person cannot be read by another, and a removed person reads nothing sent after": the relay's view of the traffic is handed to another guest and to a removed member), `relay/tests/v2_keys.rs`.

What is left:

| Who | Can still |
| --- | --- |
| A member, alone or with the relay operator | Read what is sent to everyone while a member; pass on what they read; change any voxel; send a wrong mask to someone who asks them for it; raise a false alarm about the relay |
| A removed person who still sees the traffic | Read what is sent to everyone until each remaining app has received the new key: with an honest relay they are disconnected first; with a dishonest one this is the moment between the removal and the key change, typically well under a second. Keep everything received before |
| Whoever holds a valid invite link | Come in as the person it was meant for. Trust at first contact rests on the link |
| Whoever has the host's device or its stored keys | Everything the host can: sign lists, let people in |
| The relay | Replay an old greeting or cursor of a member under the same room key (they are signed but carry no counter), so a name someone has since changed can be put back until the next key change |

The price: nobody can come in while the host is offline (they wait and are told), and every frame to everyone costs a signature and a check (`rooms-scale.md`).

### A2. A relay that does not keep to its order is noticed

Each member keeps a hash chain over the ordered frames it took, in order, whether or not they opened, and every edit carries the sender's place in it; a short note does the same a moment after the room goes quiet. Members who were given different frames under the same numbers have different chains, and the first frame that passes between them shows it. Each then says "This room's server delivered different edits to different people. Your copy is kept. Leave and start a new room.", tells the others once, and takes and sends nothing more. The mask on screen stays.

Noticed: an edit left out for one member with the numbering closed up, two edits swapped, an edit changed or made unreadable for one member, an edit sent to one member a second time, a wrong `ack`.

Not noticed, and accepted: delay; refusing to deliver at all (the app sees a gap or silence, as with a bad connection); keeping two groups of members wholly apart, so that no frame passes between them; the order the relay chooses for edits made at the same moment, which is its job.

No false alarms from: a gap filled by replay, a reconnect, offline work merged on return, a catch-up cut and started again, the mask taken from another member, a relay restart with the room made again (`ROOMS-PROTOCOL.md` §19.6 says how the chain follows each). The whole room suite, with its reconnect, offline and restart cases, runs with the check on.

Tests: `chain.test.ts`, `e2e/room-hostile.spec.ts` ("an edit the room server keeps from one person is noticed, and nobody loses their own work"; "an edit the room server sends a second time is not applied a second time", which now also expects the notice).

### A5. Keys on the device

Unchanged in kind: the member's seed and the room's keys are in the app's local storage, not encrypted, in the desktop app too. Looked at for the desktop app: Tauri's first-party secret store is the Stronghold plugin, which encrypts a file under a password the app must supply; with no user password that password would sit next to the file, and the plugin is a large dependency. There is no first-party plugin for the system keychain. So nothing was added.

What changed: the keys of a room are removed when the room is deleted (4410), when the member is removed (4403) or is no longer a member (4401), and on "Forget this room"; and because removal changes the room key, the stored key of a removed or lost device opens nothing sent after the host removed it. Remove a lost device from the room.

### A6. Content security policy

`src-tauri/tauri.conf.json` now sets:

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:;
font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost ws: wss:;
object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

- **Scripts** come from the app only. There is no `unsafe-inline` and no `unsafe-eval`; Tauri adds the hash of the one inline script in `index.html` (the theme, before first paint) when it builds the app. `wasm-unsafe-eval` is for the decoders of compressed DICOM, which are WebAssembly.
- **Styles** allow inline, and Tauri is told not to add its nonce to `style-src` (`dangerousDisableAssetCspModification: ["style-src"]`), because a nonce there switches `unsafe-inline` off. The reason is Cornerstone3D: it adds a `<style>` element of its own when a view is set up, which a policy with `style-src 'self'` refused (the first run of the self-test under the policy failed on exactly that). An inline style cannot run code, and with `img-src`, `font-src` and `connect-src` as they are it has nowhere to send anything.
- **Connections**: the app's own files, Tauri's bridge to the Rust side (`ipc:`, `http://ipc.localhost`), and `ws:` and `wss:` to any host, because a room server is an address the user types in or receives in a link. Nothing else: no `http:` or `https:` from the page. The update check and download are made by the Rust side, not the page, so GitHub is not in the policy and does not need to be.
- **Workers** from the app and from `blob:` (Cornerstone3D and the app's own workers).

Checked on the built app, Linux (WebKitGTK), debug build, under a virtual display:

| Run | Covers | Result |
| --- | --- | --- |
| `pnpm selftest:desktop` | image and mask opened from the command line, a stroke, a room hosted by the app and joined through its link by a second client in the same webview (`ws://`), save, the 3D view, all four WebAssembly decoders loaded, an update check | passes; the new step "nothing refused by the content security policy" reads the `securitypolicyviolation` events the app collected and fails on any |
| `pnpm e2e:desktop` | every tool, segments, save, a room hosted by the app and joined by the room bot | 13 of 13, with a last test that the list of refusals is empty |
| `W_APP=target/debug/w-annotator node e2e-webkit/check.mjs` | 45 checks of the built app, a room among them, and "nothing logged an error" | 45 of 45 |

Not verified: Windows (WebView2) and macOS (WKWebView). The self-test with its new step runs on both in CI, and `e2e:desktop` on Windows. Opening a compressed DICOM series from disk in the built app was not run; the decoders it needs were loaded and compiled under the policy. A release build was not tried, only the debug build CI uses.

### A7. Mixed versions

Protocol 3 cannot share a room with protocol 2, so there is no room in which some frames lack the checks. The fields that were optional for the sake of 0.1.2 (`f`, `d`) are now required.

## Checked and found sound

- **The relay never sees the room key or the link's secret.** The secret is only in the link's fragment. The app sends the relay an id and an auth key derived from it with HKDF-SHA256 (separate `info` strings, 128 bits of secret), and the room key wrapped under a third derived key that the relay never gets. The `/j/` page is the same for every id, has no script, and sets `Referrer-Policy: no-referrer`.
- **Nonces.** Every frame has a fresh random 96-bit nonce from `crypto.getRandomValues`. One key is used by all members across all reconnects, so uniqueness rests on chance: after 2^32 frames under one key the chance of a repeat is about 2^-32. A room at the relay's full rate for a room (800 frames a second) would take about two months to get there. The wrap key of an invite is used once.
- **Associated data** binds room id, epoch and kind, so a frame cannot be moved to another room or read as another kind. Sender and recipient are now bound inside (finding 2).
- **Sign-in.** The relay sends 32 random bytes per connection; the member signs `w-rooms/2 <op> <ROOM> <nonce>` with an Ed25519 key made for that room and used for nothing else. The relay checks with `verify_strict`. A signature is good for one connection, one room and one operation.
- **Invites are enforced by the relay**, not the app: single use and expiry are checked under the room's lock (two people racing for one link: one wins), the proof is an HMAC over the room, the connection's nonce and the redeemer's key, compared in constant time, and five wrong proofs lock the invite for ten minutes. Only the host can add, list or revoke invites, remove people, or end the room. A removed key is refused from then on and the link it came through is revoked.
- **View-through-host.** The relay refuses file frames in such a room whoever sends them, sends a guest's frames to the host only, and counts slice requests per guest. The host app answers only requests for planes inside the volume, in its own window, 8 bits, at most 30 at once and 600 a minute per guest. A guest's device keeps nothing and is wiped when the room ends (`e2e/room.spec.ts`).
- **Randomness.** Keys, secrets, nonces and room ids come from the operating system (`crypto.getRandomValues`, `getrandom`). `Math.random` is used only to spread reconnect attempts.
- **Relay input handling.** No `unwrap` on anything from the network; malformed text, short frames, every frame kind and every header extreme are survived (`malformed_input_after_sign_in_is_survived`). Message size, control size, handshake size and time, per-connection and per-room rates, queue size, members, invites, rooms and connections are all bounded.
- **Logs.** The relay prints its listening address and nothing else. The app logs no keys, links or names.
- **Tauri capabilities** are narrow: dialogs, the updater, restart, and opening four fixed URLs.

## Not verified

- macOS and Windows: nothing here was run on either. The fixes are in TypeScript and in portable Rust, and the unit tests do not depend on the platform, but "not verified" stands for both.
- WebKit (the engine of the macOS and Linux apps): the Playwright tests were run in Chromium only.
- The built desktop app was not run. `cargo test` covers `hosting.rs`; hosting a room from the app between two computers was not tried.
- Behaviour against a 0.1.2 app in the same room was checked only through the room bot (`e2e-desktop/roombot.mjs`), which speaks the protocol as 0.1.2 does.
