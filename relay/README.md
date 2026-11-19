# w-relay

Room relay for W Annotator. It forwards messages between the peers of a room and stores nothing.

- **Run locally:** `cargo run -p w-relay -- --port 8787 --host 0.0.0.0` (or set `PORT`). Check it with `curl localhost:8787/health`.
- **Docker:** `docker build -t w-relay relay/ && docker run --rm -p 8787:8787 w-relay` (a static binary in a `scratch` image).
- **Fly.io:** in `relay/`, run `fly launch --no-deploy`, set `internal_port = 8787` and `force_https = true` in `fly.toml`, then `fly deploy`.
- **Render:** new Web Service, root directory `relay`, runtime Docker, health check path `/health`. Render sets `PORT`.
- **TLS:** the relay speaks plain `ws://`. A page served over https can only use `wss://`, so put it behind a TLS proxy (Fly and Render do this; otherwise Caddy: `reverse_proxy localhost:8787`). Allow 64 MiB messages and idle timeouts above 60 s.
- **Connect:** `ws(s)://host/r/<ROOM>?name=<name>`; room is 4–16 letters or digits, case-insensitive, at most 16 peers (the 17th is closed with code 4001).
- **Text frames:** JSON objects. The server sets `"from"` to the sender id; a numeric `"to"` sends to that peer only, otherwise to everyone else.
- **Binary frames:** the first 4 bytes are a little-endian `u32` target id (0 = everyone else); the server replaces them with the sender id.
- **Server messages:** `{"t":"welcome","id":1,"peers":[{"id":2,"name":"Bo"}]}`, `{"t":"join","id":3,"name":"Cy"}`, `{"t":"leave","id":3}`.
- **Liveness:** ping every 20 s; a peer silent for 60 s, or too slow to keep up with the room, is dropped.
