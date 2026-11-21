# Rooms, next version — design

Panel: backend (realtime, Rust), full-stack (React/Tauri), security/privacy (medical data). Status: phase 1 built, relay and app, with the cuts listed under "Decisions made during implementation" at the end.
Requirements: **R1a** shared-copy room, **R1b** view-through-host room, **R2** host deletes room / removes people, **R3** links expire, **R4** autosave interplay. **S** = safety or correctness regardless of requirement.

## A. Gap analysis (today's code)

| # | Gap | Where | Sev. | Blocks |
|---|---|---|---|---|
| 1 | No room record. A room is "whoever is connected"; it vanishes when the last socket closes, and anyone who then connects to the same code silently creates a new one | `relay/src/lib.rs` `enter`/`leave` | Blocker | R1a R2 |
| 2 | No identity. Peer ids are per-connection counters that change on every reconnect; names are free text and can collide | `enter`, `client.ts` | Blocker | R1a R2 R3 |
| 3 | No roles. Every peer can send any message to anyone, including a fake `snapshot` or `segments` that replaces everyone's work | `route`, `onPeerMessage` | Blocker | R1b R2 |
| 4 | No removal, ban or room deletion | — | Blocker | R2 |
| 5 | Links never expire. The 6-character code (30 bits) is the only secret, is reusable for ever, and there is no rate limit on guessing | `makeCode`, `join` | Blocker | R3 |
| 6 | Relay and network see everything in plaintext: voxels, mask, segment names, display names (name is in the query string, so proxies log it). LAN rooms are plain `ws://` | `roomUrl`, `sendSnapshot` | Blocker | S |
| 7 | Image and mask go to anyone who joins; no room type; guests can save both | `sendSnapshot`, `finishSnapshot` | Blocker | R1b |
| 8 | Contradiction with `GOAL.md` AC-11 and "out of scope: sharing the image". The owner's new requirements supersede it; GOAL must be updated | docs | High | — |
| 9 | Snapshot source is "lowest peer id". That peer may itself be loading (`no-snapshot` leaves the joiner with nothing and no retry) or be on a slow link | `connect` → `onWelcome` | High | R1a |
| 10 | Same-image check compares dimensions only. Two different scans of equal size share a mask silently | `finishSnapshot` | High | S |
| 11 | Concurrent edits: no order. Divergence is repaired by a whole-mask digest every 1.2 s (O(voxels) on the UI thread) and a full snapshot from the lower id; the higher id's voxels are dropped without notice | `scheduleDigest`, `digest` case | High | R1a S |
| 12 | Rejoin and reconnect overwrite local work with the room's mask, no question asked (tester M8). Offline edits are lost | `onWelcome(reconnected)` | Blocker | R1a |
| 13 | Edits made while "reconnecting" are dropped: `send` is a no-op when the socket is closed | `client.ts` `send`/`sendFrame` | High | R1a |
| 14 | Split brain: after a partition or relay restart, the first side to come back becomes the room; the other side's work is replaced on join | `enter`, `onWelcome` | High | R1a |
| 15 | Reconnect gives up after 6 tries (~23 s) and leaves the room; no jitter, so a relay restart brings all clients back at the same instants | `RETRY_DELAYS` | Medium | R1a |
| 16 | Undo in rooms is safe per voxel but whole-list `segments` messages are last-writer-wins: a rename and an add at the same time lose one. Two people can create "segment 3" with different meanings | `sendSegments`, `ensureSegments` | High | S |
| 17 | No protocol version. A new app and an old app in one room misread each other's frames | `protocol.ts` | High | S |
| 18 | Large volumes: whole image gzipped in memory, `.slice()` copies, receiver allocates the total; 512×512×300 int16 is ~157 MB raw, several copies live at once. No resume | `sendSnapshot`, `Assembler` | High | R1a |
| 19 | Relay memory: 64 MiB messages, 256 MiB queue per peer, 16 peers, unlimited rooms, no per-IP or rate limits → trivial memory exhaustion | `MAX_MESSAGE_BYTES`, `QUEUE_BYTES` | High | S |
| 20 | Backpressure: a slow peer is disconnected (good) but then rejoins and pulls a full snapshot again (bad); sender pacing only looks at its own socket buffer | `Peer::send` | Medium | R1a |
| 21 | No persistence: when everyone is offline the room and its state are gone | relay | High (phase 2) | R1a |
| 22 | LAN hosting: binds `0.0.0.0` on every interface; the link uses the first private IPv4, which may be a VPN, Docker or WSL adapter; no NAT traversal, so it never works across the internet | `hosting.rs`, `platform.hostRoom` | Medium | R1a R1b |
| 23 | Firewall: the first listen triggers a Windows Defender prompt; if dismissed, guests cannot connect and the host sees no error. macOS 15 asks guests for "Local Network" permission | `Host::start` | Medium | all |
| 24 | `ws://` from the desktop webview: Windows serves the app from `http://tauri.localhost` (allowed); macOS/Linux use `tauri://localhost`, where WebKit may treat `ws://` to a LAN address as mixed content. **Unverified — must be tested on all three OSes.** A web build served over https can never reach a `ws://` relay. CSP is `null` | `tauri.conf.json`, `client.ts` | High | all |
| 25 | When the embedded relay is the room server, the host closing the app kills the room for everyone — the opposite of R1a | `leaveRoom` → `stopHosting` | High | R1a |
| 26 | Nothing separates "host left" from "host's network blinked"; no host liveness | relay | High | R1b |
| 27 | Autosave has no room awareness: a guest in a view-through-host room would get a recovery copy on disk | autosave (in progress) | Blocker | R1b R4 |
| 28 | "Cannot download" is not enforceable once voxels are on another machine (see B) | — | Blocker | R1b |
| 29 | Relay has no admin deletion, no metrics; `/health` only | relay | Low | R2 |

## B. Honest limits of "view-through-host"

Anything sent to a guest's computer can be captured by a determined guest (modified client, memory dump, screen recording, a phone camera). Software can only decide **how much** leaves the host.

| Option | What reaches the guest | Interaction | Cost | Strength |
|---|---|---|---|---|
| (i) Host-rendered frames (JPEG/WebP over the relay, or WebCodecs/WebRTC video); input events back | Screen pixels of what is shown | Every brush stroke waits a round trip: ~30–60 ms LAN, 100–250 ms internet, unless strokes are previewed locally. Independent guest views need one off-screen render per guest on the host (GPU/CPU ×N); otherwise guests follow the host's view. 2–8 Mbit/s per guest for video | L–XL. WebRTC adds signalling, STUN, and TURN for the 10–25 % of connections (most hospital networks) that cannot go direct — a relay is needed anyway | Strongest. Still screen-recordable |
| (ii) Host-windowed slices on demand | 8-bit, already windowed slices the guest scrolls to, plus that slice's labels; memory only. Never the 16-bit values, never the file, never DICOM tags | Local, immediate brushing and pan/zoom; a slice change or window change costs one round trip (~20–150 KB) | L | Medium. A guest who visits every slice can rebuild an 8-bit copy |
| (iii) Full data, UI hides save/export | Everything | As today | S | None. A label, not a control |

**Recommendation.** v1: **(ii)**, hardened: host is the only data source and authority, per-guest rate limit (30 slices/s burst, 600/min), guest cache capped and wiped, no save/export/autosave/3D/clipboard on the guest, and the host sees per guest "viewed 212 of 300 slices". Later (phase 3): **(i)** as an optional "Strict" setting, built on WebCodecs frames over the existing relay first; WebRTC only if latency demands it.

**UI wording (must ship with v1).**
- Type picker — *Shared copy*: "Everyone gets the image and the mask and keeps a copy. They can keep working without you." *View through my computer*: "Others see and edit the mask through your computer. They don't receive the files and can't save. The room ends when you close the app."
- Under the second option, always visible: "This limits what leaves your computer; it can't stop someone photographing or recording their screen."
- Guest banner: "Viewing through Mina's computer. Nothing is saved on this device."
- Never use "secure", "protected" or "cannot be copied".

## C. Target architecture

### C1. Decisions in one table

| Topic | Decision | Why |
|---|---|---|
| Transport | Keep the WebSocket relay. No peer-to-peer | WebRTC still needs signalling plus TURN for a large share of hospital networks; one relay path is simpler to secure and test |
| Ordering | The relay stamps a per-room sequence number on every edit frame; clients apply in that order (Figma and tldraw do the same: a central order, last write wins, no full CRDT) | Fixes divergence without digests; works on ciphertext |
| Raster conflicts | Online: last writer wins per voxel in relay order. After offline: three-way merge against the member's own base | Per-voxel Lamport clocks cost 4–8 bytes × 78 M voxels; CRDT libraries are built for text/JSON, not 100 MB rasters |
| Segment list | Small ordered ops, last writer wins per field. No Yjs/Automerge | One log already gives order; a library adds 60–100 KB and a second sync model |
| Enforcement | The relay enforces membership, roles, invites and room type from cleartext frame headers; payloads are end-to-end encrypted | Relay controls access; the key controls confidentiality; neither alone is trusted with both |
| Codebase | One `w-relay` crate, embedded by the desktop app with a `RelayConfig` (storage off, LAN bind) | Already the case; keep it |

### C2. Identity, roles, permissions

- **Member key.** On creating or joining, the client makes a fresh key pair **for that room** (Ed25519 to sign in, X25519 to receive keys), kept in a local "my rooms" list. No per-install key, so a relay operator cannot link a person across rooms. Use `@noble/curves` in the app (WebCrypto Ed25519 is unverified in WKWebView/WebKitGTK) and `ed25519-dalek` in the relay.
- **Member id** = short hash of the public key; stable across reconnects. Display name travels encrypted; duplicate names get a suffix ("Ana 2").
- **Roles:** host (exactly one, the creator), editor, viewer.

| Action | Host | Editor | Viewer |
|---|---|---|---|
| See image and mask | yes | yes | yes |
| Edit mask; add/rename/delete segments | yes | yes | no |
| Save/export, keep offline copy (shared copy) | yes | yes | yes |
| Save/export, keep any copy (view-through-host) | yes | **no** | **no** |
| Create and revoke invite links | yes | shared copy only, if the host ticked "can invite" | no |
| Change roles, remove people, delete room | yes | no | no |

Viewers' edit frames are dropped by the relay (frame kind is in the cleartext header).

### C3. Lifecycle

**Shared copy:** `created → active ⇄ host-away ⇄ dormant → deleted`
- *active*: host online. *host-away*: host offline, others keep editing through the relay; no new invites or removals unless an editor "can invite". *dormant*: nobody online; phase 1 keeps the record in relay memory only (a relay restart loses it and the host re-registers the room from their local record on return); phase 2 stores it. *deleted*: host action; relay erases data, keeps a 30-day tombstone so returning members are told "deleted by host". Their local copies stay — they were given them.
- On the **embedded LAN relay** the host's computer is the server: host-away means the relay is gone. Others drop to offline work on their own copies and merge when the host returns. The UI says so at creation and recommends a room server for teams.

**View-through-host:** `created → active → host-away (≤ 15 s) → closed`
- Clean close of the host app sends `room-close`: guests are out at once. Hard loss (lid shut, crash, network) is detected by relay ping (5 s interval, 15 s timeout, this room type only). During host-away the guest view is blanked immediately; on `closed` the guest's memory is wiped and the relay deletes the record, members and invites. A new session is a new room with new links. If the relay itself disappears (embedded relay), the guest client treats the lost socket the same way.

### C4. Invites (capability links)

- Link: `https://rooms.example.org/j/K7Q2M9XA4TDP#Zx3…22 chars` (LAN: `http://192.168.1.20:8787/j/…#…`). The relay serves a small page at `/j/` saying "Open W Annotator and paste this link". The part after `#` is a 128-bit invite secret `s`; browsers and proxies never send it. Bare codes are retired: a code cannot carry the key.
- The host (authenticated socket) registers each invite with the relay: `{inviteId = H(s), authKey = HKDF(s,"auth"), wrappedRoomKey = AES-GCM(HKDF(s,"wrap"), roomKey), role, expiresAt, maxUses}`. The relay can check a redeemer's proof (HMAC over a nonce and their new public key) but cannot unwrap the room key.
- **Defaults:** one link per person (max uses 1), expires 24 h after creation if unused. Options: 1 h / 24 h / 7 days; uses 1 / 5 / unlimited until expiry. View-through-host links are always single-use.
- Redeeming adds the person's public key to the member list. From then on they sign in with their key; the link is spent. Membership lapses after 30 days without connecting (shared copy) or when the room closes (view-through-host).
- Host sees a list: label (local only, e.g. "for Ben"), role, expiry, used/unused, **Revoke**. Revoked and expired ids are kept until expiry + 1 day, then forgotten.
- Why relay-registered instead of a host-signed token in the link: shorter link, use counting and revocation need relay state anyway, and the host is always connected when making a link. A host signature would only help a relay that enforces nothing.

### C5. Remove and ban

| | Dumb relay (today) | Enforcing relay (chosen) |
|---|---|---|
| Remove a person | Impossible; only changing the key and telling everyone else works, and the person can still connect and flood | Relay drops their sockets, deletes their key from the member list, refuses it afterwards (close code 4403) |
| Ban | — | Removal is the ban: the old key never works again. The dialog offers "Also revoke 2 unused links" (ticked) because a ban by key is defeated by any open link |
| Future data | Readable if they kept the key | View-through-host: each guest has a pairwise key with the host (X25519 + invite secret); the host forgets it, nothing to rotate. Shared copy: room key rotated (phase 2) |
| What they keep | Everything | Shared copy: the copy already on their disk — the confirm dialog says "Ben keeps the copy already on his computer. He won't get further changes." View-through-host: nothing on disk; their client wipes memory |

### C6. Sync, offline work and reconciliation (shared copy)

**Online.** Each edit is a voxel-run patch (unchanged format) with a client op id. The relay assigns `seq`, forwards it, and returns `ack{cid, seq}` to the sender in stream order. A client keeps its unacknowledged patches; when a remote patch arrives it is applied and the pending patches are re-applied on top of the overlap (they will get a later `seq`, so they win). Undo keeps today's rule: only voxels that still hold the value my stroke left. Each client tracks `head` and a per-axial-slice version (`seq` of the last patch touching it). The whole-mask digest and "lower id is the reference" are deleted; a per-slice checksum exchanged when idle stays as a safety net that refetches one slice and logs a bug.

**Segments.** Ops `seg-add{id,index,…}`, `seg-set{id,field,value}`, `seg-del{id}` in the same ordered stream. Segments get a random stable id. If two people add the same label index, the later one (by `seq`) is renumbered by its creator before its voxels are sent.

**Join and catch-up** use one mechanism: `sync-req{baseSeq}` to the online member with the highest `head` (next one after 5 s); the reply is the slices whose version is newer than `baseSeq`, in 16-slice compressed slabs of ≤ 1 MiB chunks, resumable by slab index. A new member has `baseSeq = 0`. The image is sent the same way once, identified by a SHA-256 of voxels + geometry; a member who already has that image open skips the transfer, a different image is refused with a clear message.

**Going offline.** On disconnect the client stores a compressed **base** (the mask at `baseSeq`, with unacknowledged patches backed out) and keeps working; edits accumulate locally. Status: "Offline — your changes will be merged when you reconnect". Reconnect retries for ever with jittered backoff (1 s → 30 s) plus a "Reconnect now" button.

**Coming back** (room head is ahead of or equal to my base): fetch changed slices = *theirs*; per voxel:

| base → mine | base → theirs | Result |
|---|---|---|
| unchanged | changed | take theirs |
| changed | unchanged | keep mine; sent to the room as one "offline changes" patch |
| changed | changed, same value | nothing to do |
| changed | changed, different value | **conflict** |

**Conflict rules (what a radiologist is told and can rely on):**
1. Changes to different voxels are always both kept.
2. Both online, same voxel: the later edit wins; both people saw it happen.
3. After offline work, same voxel: **the room's version stays**, yours is kept aside, never discarded. A panel lists the slices ("3 slices, 412 voxels differ") with your version as an outline; "Use mine" per slice or for all turns it into a normal edit everyone sees and can undo.
4. A segment locked or deleted in the room while you were away: your offline voxels in it are conflicts under rule 3; "Use mine" restores the segment. An offline-created segment whose index was taken is renumbered, keeping its name.
5. Nothing merges silently. Every return shows a summary: "Merged your offline work: 1,240 voxels on 6 slices added. 3 slices need review." The pre-merge mask is kept as a recovery copy for 7 days.

If the relay lost its state and a returning member's base is **ahead** of the re-seeded room, slices where that is true are compared two-way and every difference is listed as a conflict (rule 3). Phase 2 storage makes this case rare.

**Persistence when everyone is offline** (phase 2):

| Option | For | Against |
|---|---|---|
| A. Relay stores an encrypted snapshot (slabs) + encrypted op log since that snapshot | Room head always exists, so the simple merge above always applies; late joiners need no one online | Relay holds (encrypted) patient data at rest; needs quotas, retention and deletion |
| B. No server storage; members reconcile when they meet | Nothing at rest on a server | Members may hold different bases; pairwise merges; a new invitee cannot join until someone with data is online |

Choice: **A for the standalone relay** — default retention 30 days after last activity (1–365 configurable), 4 GiB per room, relay-wide cap, host delete erases immediately; a member is asked to upload a fresh snapshot when the log passes 64 MiB, then the log is truncated. **Embedded LAN relay:** persist only the room record (members, invites) in app data so the room survives an app restart; data lives in members' local copies (option B behaviour, covered by the two-way fallback).

### C7. End-to-end encryption

- Shared copy: one 256-bit room key per epoch, delivered through the invite (C4). View-through-host: pairwise host↔guest keys, relay forces star routing (guest frames reach only the host).
- Every payload: compress, then AES-256-GCM (WebCrypto) with a random 96-bit nonce; room id, epoch and frame kind as associated data. One encrypt queue per socket keeps order. Cost on a 100 MB snapshot is well under a second; gzip dominates.
- Rotation on removal (phase 2, shared copy): host creates the next-epoch key, sends it to each remaining member wrapped to their X25519 key, re-wraps open invites; the relay rejects older epochs. Stored snapshot is re-uploaded under the new key at the next compaction.
- Accepted residual risks: a member colluding with the relay can impersonate another member (shared symmetric key); the relay can drop, delay or replay frames (replays are rejected by op id); a leaked, still-valid link gives full access until used, expired or revoked.

### C8. Protocol v2

- Path `/v2/rooms/<id>`; `/r/…` answers HTTP 426 "update the app". First server frame `hello{proto:[2,2], limits}`; client `auth` or `redeem` carries `proto` and app version. A room pins its protocol at creation; mismatch closes with 4426 and the text "Update W Annotator to join this room" (or "The host is on an older version"). Unknown message types and frame kinds are ignored, never fatal.
- Binary header (cleartext): `u8 version, u8 kind, u16 flags, u32 from, u32 to, u64 seq, u32 epoch`, then ciphertext. Kinds: 1 patch, 2 seg-op, 3 sync-slab, 4 image-slab, 5 presence (cursor; unordered, droppable), 6 slice-request, 7 slice (view-through-host), 8 key delivery.
- Close codes: 4001 full, 4401 not a member, 4403 removed, 4404 no such room, 4410 room deleted/closed, 4408 invite expired/used/revoked, 4426 version, 4429 rate limited.

| Message | Direction | Purpose |
|---|---|---|
| `create{room,type,hostKey,proto}` | host → relay | Make a room record |
| `auth{key,signature}` / `redeem{inviteId,proof,key}` | client → relay | Sign in / become a member |
| `welcome{self,room{type,state,epoch,head},roster,online}` | relay → client | Replaces today's `welcome` |
| `presence{member,online}`, `roster{…}`, `room-state{…}` | relay → all | Replaces `join`/`leave` |
| `invite-add`, `invite-revoke`, `invite-list` | host ↔ relay | C4 |
| `member-remove`, `member-role`, `room-delete`, `room-close` | host → relay | C5, C3 |
| `ack{cid,seq}`, `error{code}` | relay → client | Ordering, refusals |
| Removed: `need-snapshot`, `snapshot`, `no-snapshot`, `digest`, whole-list `segments`, frame kind Snapshot | | Replaced by sync slabs and seg-ops |

### C9. Relay changes

Split `lib.rs` into `rooms`, `auth`, `invites`, `limits`, `storage`, `admin`. Limits: 2 MiB per message, 16 MiB queue per peer, 16 members, 20 MiB/s and 200 messages/s per connection, 10 join attempts per minute per IP, 5 failed invite proofs then a 10-minute lock on that invite, configurable room cap. Slow peer: dropped as today, then resumes by `baseSeq` instead of a full snapshot. Admin: `w-relay rooms list|delete <id>` and a token-protected `DELETE /admin/rooms/<id>`. `/health` stays; `/metrics` (rooms, connections, bytes, drops; no ids) behind the same token. Embedded: bind only the address the host picked, storage off, same code.

### C10. Failure cases

| Case | What the user sees |
|---|---|
| Link expired / used / revoked | "This invite link has expired (or was already used). Ask Mina for a new one." |
| Removed by host | "Mina removed you from this room." Shared copy adds "Your copy stays on this computer." |
| Room deleted | "Mina deleted this room." Same addition for shared copy |
| Host closes (view-through-host) | View blanks at once: "The host ended the session. Nothing was saved on this device." |
| Host unreachable ≤ 15 s (view-through-host) | Blank view, "Waiting for Mina…", then as above |
| Host offline (shared copy, room server) | Banner "Mina is offline. You can keep working." |
| Host closes (shared copy, LAN-hosted) | "This room runs on Mina's computer, which is off. You're working offline; changes merge when the room is back." |
| Own connection lost | "Offline — your changes will be merged when you reconnect" + Reconnect now |
| Back online | Merge summary and, if needed, the review panel (C6) |
| Relay restarted, room unknown | Members: "Waiting for the host to reopen the room." Host: re-registers automatically |
| App too old / host too old | Text from C8; no partial join |
| Different image open | "This room uses a different image. Close yours to join." |
| Image over the room limit or out of memory | "This image is too large to share in a room (limit 2 GB)." before any transfer |
| Guests can't reach a LAN host | Host dialog: "Nobody has connected yet. Others must be on the same network or VPN, and your firewall must allow W Annotator." with the address picker |
| Rate limited / room full | "Too many attempts. Try again in a minute." / "This room is full (16)." |

## D. Patient data and privacy

| | Shared copy | View-through-host |
|---|---|---|
| Host device | Files as before; recovery copy; room record and keys | Same |
| Member/guest device | Image + mask in memory; recovery copy with base and offline edits on disk until saved, "Forget this room", or 30 days unused; member key | **Memory only**: 8-bit slices viewed (cache ≤ 64 per plane), their labels, a pairwise key. Nothing on disk; wiped on close, removal or host loss |
| Relay, phase 1 | Room record in memory (public keys, roles, invite ids/expiry). No payloads stored | Same; erased on close |
| Relay, phase 2 | Plus encrypted snapshot + op log: 30 days after last activity, erased on delete | Never stores payloads |
| Relay operator can see | IP addresses, times, frame sizes and counts, room and member ids, roles, invite counts. **Not** names, voxels, masks or segment names | Same |

**Logging rules (relay and app):** never log payloads, names, invite ids, full room ids (first 4 characters only) or query strings; IP addresses only in in-memory rate counters; no telemetry (unchanged).

| Threat | Mitigation | Left over |
|---|---|---|
| Curious guest (view-through-host) | No file, no 16-bit data, no disk, rate limit, host sees slice counts, wording in B | 8-bit copy by visiting every slice; screen capture |
| Leaked link | Single use, 24 h, revoke, proof bound to the redeemer's key, 128-bit secret | Whoever uses it first within the window gets in; the host sees an unexpected name and can remove them |
| Malicious or breached relay | End-to-end encryption; secret only in the link fragment; relay stores no keys | Metadata; denial of service; can admit a non-member, who still cannot decrypt |
| Network eavesdropper on `ws://` LAN | Payloads encrypted above the transport | Metadata |
| Stolen laptop | Rely on OS disk encryption (say so); host removes the member so no new data arrives; "Forget this room"; 30-day expiry of idle copies | Copies already on that disk if the disk is not encrypted |

**Must be said in the UI and README:** which room type sends files and which does not (wording in B); "removing someone does not delete what they already have" (shared copy); who runs the room server and what it can see; voxel data can identify a person by itself (faces in head CT/MR, burned-in text) — de-identify before sharing; the app strips file names and DICOM tags from room traffic but cannot check pixels.

**Not a medical device.** W Annotator is not for diagnosis or treatment (README already says so; repeat in the room dialog footer). A hospital would additionally need: its own relay inside its network with TLS, a data-processing/BAA agreement with whoever operates it, sign-on tied to staff identity (SSO) instead of anonymous links, an audit trail of who saw which study, a retention and deletion policy, device management with disk encryption, a documented de-identification step, and an independent security review. None of that is in scope here.

## E. Delivery plan

Sizes: S ≤ 2 days, M ≤ 1 week, L ≤ 2 weeks, one engineer each. Tests named `unit` (vitest / cargo unit), `relay` (`relay/tests`), `e2e` (Playwright contexts), `fault` (relay test hooks).

### Phase 1 — shippable alone

| ID | Size | Scope | Files | Acceptance | Tests |
|---|---|---|---|---|---|
| 1.0 | S | Fault-injection hooks in the relay behind a test-only config: drop a member's socket, pause delivery, restart with empty state; Playwright helpers for 3 clients | `relay/src/lib.rs`, `relay/tests/`, `e2e/helpers.ts` | A test can cut and restore one client's link deterministically | relay: hooks work; e2e: helper smoke test |
| 1.1 | M | Protocol v2 skeleton: path, `hello`, version pin, binary header, close codes, typed catalogue; `/r/` → 426 | `src/collab/protocol.ts`, `client.ts`, `relay/src/*`, `relay/README.md` | Old client gets a clear refusal; unknown kinds ignored | unit: header round trip, version negotiation; relay: 426, 4426 |
| 1.2 | L | Room records, member keys, sign-in, roles enforced by frame kind, limits (C9); split relay into modules | `relay/src/{rooms,auth,limits}.rs`, new `src/collab/identity.ts`, `client.ts` | Unknown key → 4401; viewer edit frames dropped; limits hold under load; member id stable across reconnect | unit: signatures; relay: auth matrix, each limit, flood; e2e: reconnect keeps identity |
| 1.3 | M | Invites: register/list/revoke, proof on redeem, expiry, use counts, link format and parser, `/j/` page, invite UI with expiry/uses/label | `relay/src/invites.rs`, `protocol.ts` (`parseInvite`), `src/ui/RoomModal.tsx` | Expired, reused and revoked links refused with 4408 and the right text; relay never receives the fragment | unit: link parse, HKDF vectors; relay: clock-driven expiry, use count race (two redeemers, one wins), lockout; e2e: revoke then join fails |
| 1.4 | M | Room type at creation; people list with role change, remove person, delete room; tombstones; local "my rooms" list | `RoomModal.tsx`, new `src/ui/PeoplePanel.tsx`, `src/state/store.ts`, `session.ts`, `relay/src/rooms.rs` | Removed member is disconnected within 1 s and cannot return; delete ends the room for all with the C10 texts | relay: remove, delete, tombstone; e2e (3 clients): remove one, others continue; delete |
| 1.5 | L | Ordered edits: relay `seq` + `ack`, pending-patch rebase, per-slice versions, seg-ops with stable ids; delete digest resync | `relay/src/rooms.rs`, `session.ts` (rooms + `flushEdits`, `writeOwn`), `src/mask/patch.ts`, new `src/collab/oplog.ts` | 200 simultaneous overlapping strokes from 3 clients end byte-identical with no snapshot transfer; concurrent rename + add both survive | unit: rebase property test (random interleavings converge); relay: seq monotonic, ack order; e2e: tester B1 scenario ×20, same-index segment add |
| 1.6 | M | Slab transfer for join: image hash, 16-slice slabs, resumable, memory ceiling (one extra slab, not one extra volume), size limit, source = highest head with fallback | `session.ts`, new `src/collab/transfer.ts`, `protocol.ts` | 512×512×300 joins with peak extra memory < 64 MB over the volume itself; source dying mid-transfer resumes from another member | unit: slab codec; e2e: large phantom join; fault: kill source at 50 % |
| 1.7 | L | Offline work and rejoin (shared copy, someone stayed online): outbox, base capture, endless jittered reconnect, `sync-req`, three-way merge, summary and review panel | new `src/mask/merge.ts`, `session.ts`, `client.ts`, new `src/ui/MergeReview.tsx` | Rules 1–5 of C6 hold; no local voxel is lost without appearing in the summary or review; M8 fixed | unit: merge table incl. renumbering, lock, delete; e2e: A offline paints, B and C paint (disjoint and overlapping), A returns; fault: disconnect mid-stroke, relay restart |
| 1.8 | M | Relay rules for view-through-host: star routing, host ping 5 s/15 s, host-away, close on host loss, record erased | `relay/src/rooms.rs` | Guest frames never reach another guest; guests closed ≤ 15 s after host loss, at once on clean close | relay: routing, timed close with paused clock; fault: host socket killed |
| 1.9 | L | View-through-host client: host slice server (window in a worker, WebP, rate limit, counters), guest sparse 8-bit volume and sparse mask, 2D tools only, save/export/autosave/3D disabled at the function level, blank and wipe, all wording from B | new `src/collab/hostview.ts`, `session.ts` (save paths), `src/viewer/engine.ts`, `src/platform.ts`, `TopBar.tsx`, `StatusBar.tsx` | Guest network capture contains no 16-bit data and no slice it did not request; nothing written to `localStorage`/IndexedDB/disk; edits on host and guest converge; view blank ≤ 1 s after host-away | unit: windowing, rate limiter, save guards throw; e2e: guest paints, host sees; storage empty after session; host closes → guest wiped |
| 1.10 | M | Encryption: AES-GCM envelope, room key via invite, pairwise keys for view-through-host, encrypted names | new `src/collab/crypto.ts`, `client.ts`, `identity.ts` | Relay test double sees no plaintext name, segment name or voxel run; tampered frame rejected | unit: vectors, tamper, nonce uniqueness; relay: payload opaque; e2e: full room flow still passes |
| 1.11 | S | Autosave gate and room metadata (R4): no recovery copy for guests; shared-copy recovery copy carries room id, `baseSeq`, base | autosave module, `session.ts` | See R4 below | unit: gate; e2e: crash-reload in each room type |
| 1.12 | M | Desktop transport and LAN hosting: test `ws://` from the webview on macOS/Windows/Linux and, if blocked, move the socket into Rust behind the same `RoomClient` interface; address picker; bind one address; firewall help text; set a CSP | `src-tauri/src/{hosting,lib}.rs`, `tauri.conf.json`, `platform.ts`, `RoomModal.tsx` | A LAN room works between any two of the three OSes; the link shows the picked address | cargo: bind selection; manual matrix recorded in `docs/reviews/` |

**R4, autosave per room type.** Solo: unchanged. Shared copy: every member autosaves; the recovery copy is the offline version (mask, base, `baseSeq`, room id), so a crash or an offline day both end in the same merge on rejoin. View-through-host: the host autosaves normally and is the only copy — guests' strokes are protected by the host's autosave; guests have autosave forced off and the setting shown as "Off in this room".

### Phase 2 — rooms that outlive their members

| ID | Size | Scope | Acceptance / tests |
|---|---|---|---|
| 2.1 | M | Relay disk storage for room records (`--data-dir`), tombstones, retention sweeper, admin CLI + `DELETE /admin/rooms/<id>`, `/metrics` | relay: restart keeps rooms; sweeper with fake clock; admin delete erases files |
| 2.2 | L | Encrypted snapshot + op log on the relay, compaction request, quotas, join with nobody online | relay: quota, truncation, crash during compaction; e2e: all leave, one returns with offline work, a new invitee joins alone |
| 2.3 | M | Key rotation on removal (shared copy), X25519 key delivery, epoch enforcement | unit: rotation; e2e: removed member's old key cannot decrypt later frames (test double relay leaks them) |
| 2.4 | S | Embedded relay keeps room records in app data; two-way fallback when a base is ahead | e2e: host restarts app, room and members return |
| 2.5 | S | "Can invite" for editors; membership idle expiry sweeper | relay + e2e |

### Phase 3 — optional

| ID | Size | Scope |
|---|---|---|
| 3.1 | L | Strict view-through-host: per-guest off-screen render, WebCodecs frames over the relay, input events back, local stroke preview |
| 3.2 | M | WebRTC video path for 3.1 if measured latency over the relay is above 150 ms |
| 3.3 | M | LAN relay hand-over: another desktop member takes over hosting when the host leaves a shared-copy room |

## F. Open questions for the owner

| # | Question | Recommended default |
|---|---|---|
| 1 | Is "host-windowed slices" (B ii) acceptable for view-through-host v1, knowing a determined guest who visits every slice can rebuild an 8-bit copy? | Yes, with the wording in B; strict frame streaming in phase 3 |
| 2 | After offline work, when the same voxels were changed by both sides: room's version stays and yours waits for review — or ask before merging anything? | Room stays, yours kept for review (C6 rule 3) |
| 3 | Invite defaults: single use, 24 h? And does membership itself expire? | Single use, 24 h; membership lapses after 30 days without connecting |
| 4 | Is a view-through-host room one session (new links every time) or can the host reopen it for the same guests? | One session |
| 5 | A LAN-hosted shared-copy room stops syncing when the host closes the app (others work offline and merge later). Acceptable for v1? | Yes; recommend a room server for teams; hand-over is 3.3 |
| 6 | Phase 2 server storage: 30 days after last activity and 4 GB per room? Will the project run a public relay? | Those limits; no public relay — self-host only |

## Sources

- Excalidraw, end-to-end encryption with the key in the link fragment: https://plus.excalidraw.com/blog/end-to-end-encryption
- Figma, server-ordered last-writer-wins instead of OT/CRDT: https://madebyevan.com/figma/how-figmas-multiplayer-technology-works/
- tldraw sync, one authoritative room per document with stored snapshots: https://tldraw.dev/docs/sync
- WebCrypto Ed25519/X25519 availability: https://blogs.igalia.com/jfernandez/?p=1913 , https://blog.ipfs.tech/2025-08-ed25519/
- WKWebView and `ws://` mixed content: https://developer.apple.com/forums/thread/120869
- TURN relay share (vendor estimates, 10–25 % typical, higher on corporate networks): https://www.forasoft.com/learn/video-streaming/articles-streaming/ice-stun-turn-deep-dive

## Decisions made during implementation

Relay side of phase 1 (1.0, 1.1, 1.2, 1.3, relay half of 1.5, 1.8). The owner answered every question in F with the recommended default. Where the design left a detail open, the simpler option was taken; where the implementation differs from the text above, this section wins. The wire contract is `ROOMS-PROTOCOL.md`.

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | `/r/…` → 426 (C8) | **Done with the app's v2 client:** v1 is off unless the relay is started with `--v1` (`RelayConfig.v1 = true`) | The app no longer speaks v1 |
| 2 | Member id | First 4 bytes of SHA-256(public key), little-endian `u32`. A key whose id is 0 or collides inside the room is refused; the client makes another | The header has 32 bits for `from`/`to`; a hash keeps the id stable across reconnects and relay restarts without relay state |
| 3 | Sign-in | Ed25519 signature over `w-rooms/2 <op> <ROOM> <nonce>`, the nonce fresh per connection in `hello` | No replay across connections, rooms or operations |
| 4 | Invite proof | HMAC-SHA256 with `authKey` over room, nonce and the redeemer's key. `redeem` also carries a signature by the new key | Proof is bound to the key and the connection |
| 5 | Invite derivations | HKDF-SHA256, empty salt, `info` = `w-rooms/2 invite id` / `invite auth` / `invite wrap`; invite id is 16 bytes. Expiry is `ttl` seconds counted by the relay's clock, not a timestamp from the host | Fixed so two apps agree; relay time avoids client clock skew |
| 6 | Redeem twice with the same key | Signs in, spends nothing | A client that lost `welcome` must be able to retry a single-use link |
| 7 | Removal and links | Removing a member also revokes the invite they came in through; `revokeInvites: true` revokes all | A ban by key is defeated by a multi-use link (C5) |
| 8 | `cid` | The client's op id travels in the header's `seq` field; the relay overwrites it with the sequence number and returns `ack{cid,seq}` | No extra header field. On unordered frames the field passes through and can carry a request id |
| 9 | Own frames in replay | Replay includes the asker's own frames | Lets a client settle ops whose ack was lost; the relay does not deduplicate |
| 10 | Replay | `resume` in `auth`, or a `replay{after}` message; `replay-too-old` / `replay-ahead` errors; log bound 2048 frames and 8 MiB | One mechanism for reconnect and for gaps; the log must fit a member's queue |
| 11 | `room.session` | A random value per room record in `welcome` | Tells a client that the relay lost the room and sequence numbers restarted |
| 12 | Frame kind 9, `sync-request` | Added. Kinds 3, 4, 9 must name one recipient | C6 needs a member-to-member request and C8's kind list had none for shared-copy rooms |
| 13 | Kind 8 (key) | Shared copy: host only. View-through-host: host ↔ guest | Matches C7; tighter is easier to loosen later |
| 14 | Ordering in view-through-host | Only the host's edit frames are ordered. A guest's patch goes to the host alone, unstamped; the host applies and re-sends | Star routing means other guests never see a guest's frame, so stamping it would leave gaps |
| 15 | Host leaves (view-through-host) | `room-close`, or a clean WebSocket close by the host, ends the room at once. A broken socket gives `host-away` and 15 s to sign in again. Silence is caught by ping after 15 s and ends the room directly | "Close at once on clean exit, within 15 s on hard loss". A silent host cannot be told apart from a slow one earlier than the timeout, so there is no `host-away` phase in that case |
| 16 | Who gets the 5 s ping | Only the host of a view-through-host room; guests and shared-copy members keep 20 s / 60 s | Only the host's loss must be noticed within seconds |
| 17 | Rates | Host of a view-through-host room gets the room allowance (800 msg/s) instead of 200. Slice requests are also counted by the relay (30 burst, 600/min per guest). Over the room allowance frames are dropped, not connections | The host answers up to 15 guests. The relay's count backs up the host app's own |
| 18 | Joins per IP | 30 per minute, not 10 | 16 people behind one NAT reconnect together after a blip |
| 19 | Tombstones | Deleted **and closed** ids answer 4410 for 30 days and cannot be re-created; at most 4096 remembered | A closed view-through-host session must not be reopened under the same links |
| 20 | Dormant rooms, idle members | Kept in memory; members lapse after 30 idle days, rooms after 30 days with nobody connected. The sweeper (2.5) is done now | Owner's answer to F3; bounded memory needs it anyway |
| 21 | Re-registering after a restart | `create` may carry `members` (keys and roles) | C3 says the host re-registers from its local record; without this every member would need a new invite |
| 22 | Close codes added | 4002 too slow, 4003 signed in elsewhere, 4400 bad handshake, 4409 room id taken | The design's list had no code for these |
| 23 | Editors inviting, role `viewer` | "Can invite" is not built (2.5). `viewer` is built: its edit frames are refused | Cheap, and the matrix in C2 needs it |
| 24 | Fault hooks | A `Faults` handle in `RelayConfig`, not a cargo feature and not an HTTP endpoint | Works in integration tests without feature flags; nothing reachable from the network. Playwright-side helpers come with the v2 client |
| 25 | Modules | `v1`, `proto`, `auth`, `invites`, `limits`, `rooms`, `conn`, `faults`. No `storage` or `admin` yet | Those are phase 2 |
| 26 | Not built here | `/metrics`, admin delete, key rotation, storage; TypeScript client | Phase 2, or the client engineer's work |

### App side of phase 1

What the app does, task by task. Where it differs from the text above, this table wins; the reasons are in `docs/process/DECISIONS.md` (2026-11-21).

| Task | Built | Not built, or built differently |
|---|---|---|
| 1.0 | Playwright helpers that cut and restore one page's connection (`e2e/helpers.ts`, `cuttable`) | They work in the browser, not through the relay's fault hooks, so they close a connection cleanly; a broken connection of the host is covered by the relay's own tests |
| 1.1 | `src/collab/protocol.ts`: header, links, close-code texts; the v1 client is gone | — |
| 1.2 | `identity.ts` (per-room Ed25519 key, member id), `client.ts` (sign-in, endless jittered reconnect, re-open after a relay restart) | Role `viewer` and "can invite" have no control in the app. No X25519 key |
| 1.3 | Invite links made, listed and switched off by the host; single use, 24 h | No expiry or use-count options, no label |
| 1.4 | Kind of room at creation; people list with Remove; Delete room / End room; "Rooms you have joined" | No role change. The people list is in the room menu, not a separate panel. Remove has no "also revoke unused links" |
| 1.5 | `oplog.ts`: relay order, ack, rebase of unconfirmed edits, gap replay; per-segment ops; the whole-mask digest is gone | Segments are keyed by label value, not a random id; no renumbering on a same-value add; no per-slice checksum safety net |
| 1.6 | `transfer.ts`: 16-slice slabs, parts of at most 1 MiB, paced; host first, next member after 5 s; 2 GB limit | Same-image check by the autosave fingerprint; a cut transfer starts again instead of resuming |
| 1.7 | Offline work, endless reconnect with "Reconnect now", three-way merge (`src/mask/merge.ts`), summary, "Use mine" / "Keep the room's" | Conflicts are decided all at once, with no per-slice panel and no outline; no 7-day pre-merge copy; segment conflicts are last-writer-wins |
| 1.9 | `hostview.ts`: host answers plane requests with 8-bit windowed planes and labels, counts planes per guest, rate-limits; guest holds no file, cannot save, gets no recovery copy, is blanked while the host is unreachable and wiped when the room ends | Lossless gzip instead of WebP in a worker; no cache cap; 3D view not disabled; the host's window, re-fetched when it changes |
| 1.10 | `crypto.ts`: AES-256-GCM, room key wrapped in the invite, names inside encrypted frames | One room key for both kinds; no pairwise keys |
| 1.11 | No recovery copy for a view-through-host guest; Settings shows autosave as off in that room | The shared-copy recovery copy does not carry the room id and base, so after an app restart a return is merged two-way |
| 1.12 | The embedded relay speaks v2 with the embedded limits; links carry the LAN address | **Not verified** on macOS, Windows or Linux desktop builds: `ws://` from the webview, address picker, binding one address, firewall text and a CSP are not done |

Open risk: anyone who can reach a relay can create rooms up to its cap, and an abandoned room lives 30 days. Until phase 2 adds an admin token, keep a relay private or keep `--max-rooms` low (`relay/README.md`).
