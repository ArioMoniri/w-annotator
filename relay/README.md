# w-relay

Room relay for W Annotator. It lets the people in a room reach each other, decides who is in the room, and puts edits in one order. It never looks inside what they send and writes nothing to disk.

It speaks two protocols on one port:

- **v2** at `/v2/rooms/<ID>`: rooms with a host, member keys, roles, invite links, ordered edits and the view-through-host rules. The wire format is `docs/design/ROOMS-PROTOCOL.md`; the design is `docs/design/ROOMS.md`.
- **v1** at `/r/<CODE>?name=<name>`: the original relay, for apps from before rooms had kinds and expiring links. Off unless started with `--v1`; otherwise `/r/…` answers HTTP 426 so an old app tells its user to update. See the end of this file.

## Run it

- **Locally:** `cargo run -p w-relay -- --port 8787 --host 0.0.0.0` (or set `PORT`). Check it with `curl localhost:8787/health`.
- **Docker:** `docker build -t w-relay relay/ && docker run --rm -p 8787:8787 w-relay` (a static binary in a `scratch` image).
- **Fly.io:** in `relay/`, run `fly launch --no-deploy`, set `internal_port = 8787` and `force_https = true` in `fly.toml`, then `fly deploy`.
- **Render:** new Web Service, root directory `relay`, runtime Docker, health check path `/health`. Render sets `PORT`.

| Option | Default | What it does |
|---|---|---|
| `--port <PORT>` | `$PORT`, else 8787 | Port to listen on |
| `--host <ADDR>` | `0.0.0.0` | Address to bind |
| `--max-rooms <N>` | 1024 | v2 rooms held at once |
| `--joins-per-minute <N>` | 30 | Connection attempts to `/v2/` per IP address per minute |
| `--v1` | off | Also serve protocol v1 at `/r/…`. Without it, `/r/…` answers HTTP 426 so old apps tell their user to update |

## Behind TLS

The relay speaks plain HTTP and `ws://`. A page served over https can only use `wss://`, and invite links should be `https://`, so put the relay behind a TLS proxy. Fly and Render do this for you. With Caddy:

```
rooms.example.org {
    reverse_proxy localhost:8787
}
```

With nginx, pass the upgrade headers and lift the timeouts:

```
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
```

What the proxy must allow:

- WebSocket upgrades on `/v2/rooms/` and `/r/`.
- Messages of 2 MiB for v2, 64 MiB while v1 is on.
- Idle time above 60 s (the relay pings every 20 s, and every 5 s for the host of a view-through-host room).
- **Do not log the query string.** v1 puts the display name in it. v2 puts nothing there, and the secret of an invite link is in the `#fragment`, which browsers never send.

Behind a proxy every client has the proxy's address, so the per-address limit counts everyone together: raise `--joins-per-minute` (for example to 600) or rate-limit by client address in the proxy instead. Bind the relay to `127.0.0.1` when the proxy is on the same machine.

## What the relay stores, and for how long

Everything is in memory. There is no database, no file, no log. A restart forgets every room; the host's app then makes the room again from its own record.

| What | Kept | Until |
|---|---|---|
| Room record: id, type, the host's and members' public keys and roles, when each last connected | memory | the host deletes the room; a view-through-host room ends when its host leaves; a shared-copy room nobody has connected to for 30 days is forgotten |
| Membership | memory | removed by the host, or 30 days without connecting (the host never lapses) |
| Removed keys (so they stay out) | memory, last 256 per room | the room is gone |
| Invites: id, a key to check the redeemer's proof, the room key **wrapped** (the relay cannot unwrap it), role, expiry, use count | memory | one day after the invite's expiry |
| Replay log: the last ordered edit frames, **encrypted payloads as sent** | memory, at most 2048 frames and 8 MiB per room | pushed out by newer edits; the room is gone; restart |
| Messages on their way to a slow member | memory, at most 16 MiB per connection | delivered, or the member is dropped |
| Deleted and closed room ids (so returning members hear "deleted", not "unknown") | memory, id and reason only | 30 days |
| IP addresses | memory, in the connection-attempt counter only | about a minute after the last attempt |

Never stored or seen: the image, the mask, segment names, display names (v2), the secret in an invite link, the room key.

What whoever runs the relay can see: IP addresses, connection times, frame sizes and counts, room ids, member public keys and roles, how many invites exist and when they expire. Not names, voxels, masks or segment names — provided the app encrypts its payloads, which is the app's job (`ROOMS.md` C7), not the relay's.

The relay prints one line when it starts and nothing afterwards.

## Limits (v2)

| Limit | Value |
|---|---|
| Message | 2 MiB |
| Members per room | 16 |
| Per connection | 200 messages/s and 20 MiB/s; over that it is closed with 4429 |
| Per room | 800 frames/s and 80 MiB/s; over that frames are dropped |
| Outbound queue per connection | 16 MiB or 4096 messages; a member that falls behind is closed with 4002 and catches up by sequence number. From half full, file frames from other members are refused (`busy`) |
| New TCP connection | 10 s to send a whole request; at most 8256 open at once (twice the connection limit plus 64) |
| Invites per room | 64; default 24 h and single use, at most 7 days |
| Wrong invite proofs | 5, then that invite is locked for 10 minutes |
| Connection attempts | 30 per minute per IP address |
| Rooms | 1024 (`--max-rooms`) |
| Connections | 4096 |
| Memory per room, worst case | 8 MiB of log plus the queues of its connected members (16 MiB each). Measured with a 512 x 512 x 300 scan going to a guest: 7 MB idle, 15 to 20 MB at the peak (`docs/reviews/rooms-scale.md`) |

Anyone who can reach the relay can create a room. Until admin controls exist (phase 2), run it where only your people can reach it, or keep `--max-rooms` at what you need: rooms left behind by strangers take up to 30 days to expire.

## Embedded in the desktop app

`src-tauri` runs the same crate for LAN hosting. `w_relay::serve(listener, shutdown)` is unchanged. For v2 the host app can use:

```rust
let relay = w_relay::Relay::new(w_relay::RelayConfig::embedded()); // 8 rooms, 128 connections
let handle = relay.clone();
tokio::spawn(async move { relay.serve(listener, shutdown).await });
handle.stats();                 // rooms and connections, for a status line
handle.rooms();                 // id, type, members, online, head — no keys
handle.delete_room("K7Q2M9XA4TDP");
```

The relay itself never touches a disk. A program that embeds it can keep shared-copy rooms across its own restarts:

```rust
let saved: w_relay::persist::SavedRelay = handle.export();   // before stopping, or whenever it changed
// ... store `saved` (it is serde) ... and in the next run, before anyone connects:
relay.import(saved)?;                                        // Err only for a record from a newer relay
```

`export` gives the room records of shared-copy rooms: members' public keys and roles, when each last connected, removed keys, invites (id, proof key, wrapped room key, role, expiry, uses, revoked), the key epoch, and the ids of deleted rooms. No payload, no replay log, no name. `import` takes them back and then drops what lapsed meanwhile. A room that comes back this way has a new `session` and `head` 0, exactly like a room its host made again after a restart; members sign in with the keys they have. The record carries a `version`; a reader ignores fields it does not know and refuses a higher version whole. A view-through-host room is never exported.

The desktop app stores the record in `rooms/hosted.json` in its data folder, for the user only (`src-tauri/README.md`). The standalone `w-relay` does not store anything: it has no `--data-dir` yet (`ROOMS.md` task 2.1).

## Testing with faults

`RelayConfig { faults: Some(Faults::new()), .. }` gives a test handle that can drop, delay or reorder one member's frames, cut or silence a connection, pause a room, move the clock and wipe the relay as a restart would. The binary and the desktop app never set it, and none of it is reachable from the network. `relay/tests/common/mod.rs` has helpers for any number of real WebSocket clients.

## Protocol v1 (old apps, only with `--v1`)

- **Connect:** `ws(s)://host/r/<ROOM>?name=<name>`; room is 4–16 letters or digits, case-insensitive, at most 16 peers (the 17th is closed with code 4001).
- **Text frames:** JSON objects. The server sets `"from"` to the sender id; a numeric `"to"` sends to that peer only, otherwise to everyone else.
- **Binary frames:** the first 4 bytes are a little-endian `u32` target id (0 = everyone else); the server replaces them with the sender id.
- **Server messages:** `{"t":"welcome","id":1,"peers":[{"id":2,"name":"Bo"}]}`, `{"t":"join","id":3,"name":"Cy"}`, `{"t":"leave","id":3}`.
- **Liveness:** ping every 20 s; a peer silent for 60 s, or too slow to keep up with the room, is dropped.
- **Limits:** 64 MiB messages, no identity, no roles, no expiry: a v1 room is whoever is connected. That is why v2 exists.
