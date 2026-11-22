//! Helpers for protocol v2 tests: a relay on an ephemeral port with fault
//! hooks, member identities, invite links, and any number of real websocket
//! clients. Everything a client does here is built from the wire spec in
//! `docs/design/ROOMS-PROTOCOL.md`, not from the relay's own helpers.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use w_relay::proto::{Header, HEADER_LEN};
use w_relay::{Faults, Relay, RelayConfig};

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub const WAIT: Duration = Duration::from_secs(5);
pub const QUIET: Duration = Duration::from_millis(200);

pub const PATCH: u8 = 1;
pub const SEG_OP: u8 = 2;
pub const SYNC_SLAB: u8 = 3;
pub const IMAGE_SLAB: u8 = 4;
pub const PRESENCE: u8 = 5;
pub const SLICE_REQUEST: u8 = 6;
pub const SLICE: u8 = 7;
pub const KEY: u8 = 8;
pub const SYNC_REQUEST: u8 = 9;

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).unwrap();
    out
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// HKDF-SHA256 with an empty salt, one output block at most.
pub fn hkdf(secret: &[u8], info: &str, len: usize) -> Vec<u8> {
    let prk = hmac(&[0u8; 32], secret);
    let mut block = info.as_bytes().to_vec();
    block.push(1);
    hmac(&prk, &block)[..len].to_vec()
}

/// A member key pair for one room.
#[derive(Clone)]
pub struct Identity {
    signing: SigningKey,
}

impl Identity {
    pub fn new() -> Self {
        Self::from_seed(random::<32>())
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Identity {
            signing: SigningKey::from_bytes(&seed),
        }
    }

    pub fn key_bytes(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn key(&self) -> String {
        b64(&self.key_bytes())
    }

    /// First four bytes of SHA-256(public key), little-endian.
    pub fn id(&self) -> u32 {
        let hash = Sha256::digest(self.key_bytes());
        u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]])
    }

    pub fn sign(&self, op: &str, room: &str, nonce: &str) -> String {
        let message = format!("w-rooms/2 {op} {} {nonce}", room.to_ascii_uppercase());
        b64(&self.signing.sign(message.as_bytes()).to_bytes())
    }
}

/// The secret half of an invite link and what is derived from it.
#[derive(Clone)]
pub struct InviteLink {
    pub secret: [u8; 16],
    pub id: String,
    pub auth_key: [u8; 32],
}

impl InviteLink {
    pub fn new() -> Self {
        Self::from_secret(random::<16>())
    }

    pub fn from_secret(secret: [u8; 16]) -> Self {
        InviteLink {
            secret,
            id: b64(&hkdf(&secret, "w-rooms/2 invite id", 16)),
            auth_key: hkdf(&secret, "w-rooms/2 invite auth", 32)
                .try_into()
                .unwrap(),
        }
    }

    pub fn proof(&self, room: &str, nonce: &str, key: &str) -> String {
        let message = format!(
            "w-rooms/2 proof {} {nonce} {key}",
            room.to_ascii_uppercase()
        );
        b64(&hmac(&self.auth_key, message.as_bytes()))
    }

    /// The `invite-add` message for this link.
    pub fn registration(&self, extra: Value) -> Value {
        let mut msg = json!({
            "t": "invite-add",
            "id": self.id,
            "authKey": b64(&self.auth_key),
            "wrappedKey": "d3JhcHBlZC1yb29tLWtleQ",
        });
        msg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        msg
    }
}

/// How a connection attempt or a connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Closed {
    /// 0 when the socket broke without a close frame.
    pub code: u16,
    pub reason: String,
}

#[derive(Debug)]
pub enum Event {
    Text(Value),
    Frame(Header, Vec<u8>),
    Closed(Closed),
}

pub struct TestRelay {
    pub addr: SocketAddr,
    pub faults: Faults,
    pub relay: Relay,
    pub stop: Option<oneshot::Sender<()>>,
    pub task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl TestRelay {
    pub async fn start() -> Self {
        Self::with(|_| {}).await
    }

    /// A relay with fault hooks and no per-address join limit, then `tweak`.
    pub async fn with(tweak: impl FnOnce(&mut RelayConfig)) -> Self {
        let faults = Faults::new();
        let mut config = RelayConfig {
            faults: Some(faults.clone()),
            ..RelayConfig::default()
        };
        config.limits.joins_per_minute = 1_000_000;
        tweak(&mut config);
        let relay = Relay::new(config);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel::<()>();
        let serving = relay.clone();
        let task = tokio::spawn(async move {
            serving
                .serve(listener, async {
                    let _ = stopped.await;
                })
                .await
        });
        TestRelay {
            addr,
            faults,
            relay,
            stop: Some(stop),
            task,
        }
    }

    pub fn url(&self, room: &str) -> String {
        format!("ws://{}/v2/rooms/{room}", self.addr)
    }

    /// Connects and reads `hello`.
    pub async fn open(&self, room: &str) -> (Ws, Value) {
        let (mut ws, _) = connect_async(self.url(room)).await.unwrap();
        let hello = match next_event(&mut ws).await {
            Event::Text(v) => v,
            other => panic!("expected hello, got {other:?}"),
        };
        assert_eq!(hello["t"], "hello");
        (ws, hello)
    }

    /// Sends a handshake built from the nonce and waits for `welcome` or a close.
    pub async fn handshake(
        &self,
        room: &str,
        me: &Identity,
        build: impl FnOnce(&str) -> Value,
    ) -> Result<Client, Closed> {
        let (mut ws, hello) = self.open(room).await;
        let nonce = hello["nonce"].as_str().unwrap().to_owned();
        ws.send(Message::text(build(&nonce).to_string()))
            .await
            .unwrap();
        match next_event(&mut ws).await {
            Event::Text(welcome) => {
                assert_eq!(welcome["t"], "welcome", "{welcome}");
                assert_eq!(welcome["self"]["id"], me.id());
                Ok(Client {
                    ws,
                    me: me.clone(),
                    id: me.id(),
                    room: room.to_ascii_uppercase(),
                    welcome,
                    texts: VecDeque::new(),
                    frames: VecDeque::new(),
                    next_rid: 1,
                })
            }
            Event::Closed(closed) => Err(closed),
            other => panic!("expected welcome or close, got {other:?}"),
        }
    }

    pub async fn try_create(
        &self,
        room: &str,
        kind: &str,
        me: &Identity,
    ) -> Result<Client, Closed> {
        self.handshake(room, me, |nonce| {
            json!({ "t": "create", "proto": 3, "app": "test", "type": kind,
                    "key": me.key(), "sig": me.sign("create", room, nonce) })
        })
        .await
    }

    /// Creates a room and returns its host.
    pub async fn create(&self, room: &str, kind: &str) -> Client {
        self.try_create(room, kind, &Identity::new()).await.unwrap()
    }

    pub async fn try_auth(&self, room: &str, me: &Identity) -> Result<Client, Closed> {
        self.handshake(room, me, |nonce| {
            json!({ "t": "auth", "proto": 3, "key": me.key(), "sig": me.sign("auth", room, nonce) })
        })
        .await
    }

    pub async fn auth(&self, room: &str, me: &Identity) -> Client {
        self.try_auth(room, me).await.unwrap()
    }

    /// Signs in and asks for the edits after `after`.
    pub async fn resume(&self, room: &str, me: &Identity, after: u64) -> Client {
        self.handshake(room, me, |nonce| {
            json!({ "t": "auth", "proto": 3, "key": me.key(), "resume": after,
                    "sig": me.sign("auth", room, nonce) })
        })
        .await
        .unwrap()
    }

    pub async fn try_redeem(
        &self,
        room: &str,
        link: &InviteLink,
        me: &Identity,
    ) -> Result<Client, Closed> {
        self.handshake(room, me, |nonce| {
            json!({ "t": "redeem", "proto": 3, "invite": link.id, "key": me.key(),
                    "proof": link.proof(room, nonce, &me.key()),
                    "sig": me.sign("redeem", room, nonce) })
        })
        .await
    }

    /// A room with a host and `guests` more members, each through their own
    /// single-use invite. Every client has seen everyone arrive.
    pub async fn room(&self, room: &str, kind: &str, guests: usize) -> (Client, Vec<Client>) {
        let mut host = self.create(room, kind).await;
        let mut members = Vec::new();
        for _ in 0..guests {
            let guest = host.invite(self, json!({})).await;
            members.push(guest);
        }
        host.drain().await;
        for member in &mut members {
            member.drain().await;
        }
        (host, members)
    }

    pub async fn http_get(&self, path: &str) -> String {
        let mut s = TcpStream::connect(self.addr).await.unwrap();
        s.write_all(
            format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
        let mut out = String::new();
        tokio::time::timeout(WAIT, s.read_to_string(&mut out))
            .await
            .unwrap()
            .unwrap();
        out
    }
}

/// The next thing on a socket that is not a ping or a pong.
pub async fn next_event(ws: &mut Ws) -> Event {
    loop {
        let next = tokio::time::timeout(WAIT, ws.next())
            .await
            .expect("timed out waiting for a message");
        return match next {
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Text(t))) => Event::Text(serde_json::from_str(t.as_str()).unwrap()),
            Some(Ok(Message::Binary(b))) => {
                let header = Header::parse(&b).expect("the relay sent a frame without a v2 header");
                Event::Frame(header, b[HEADER_LEN..].to_vec())
            }
            Some(Ok(Message::Close(Some(frame)))) => Event::Closed(Closed {
                code: frame.code.into(),
                reason: frame.reason.as_str().to_owned(),
            }),
            Some(Ok(Message::Close(None))) => Event::Closed(Closed {
                code: 1005,
                reason: String::new(),
            }),
            Some(Ok(other)) => panic!("unexpected {other:?}"),
            Some(Err(_)) | None => Event::Closed(Closed {
                code: 0,
                reason: String::new(),
            }),
        };
    }
}

/// A 24-byte v2 header followed by `payload`.
pub fn encode_frame(kind: u8, to: u32, cid: u64, payload: &[u8]) -> Vec<u8> {
    let header = Header {
        version: 3,
        kind,
        flags: 0,
        from: 0,
        to,
        seq: cid,
        epoch: 1,
    };
    let mut out = header.encode().to_vec();
    out.extend_from_slice(payload);
    out
}

/// A signed-in member with its socket.
pub struct Client {
    pub ws: Ws,
    pub me: Identity,
    pub id: u32,
    pub room: String,
    pub welcome: Value,
    texts: VecDeque<Value>,
    frames: VecDeque<(Header, Vec<u8>)>,
    next_rid: u64,
}

impl Client {
    pub async fn send_json(&mut self, value: Value) {
        self.ws
            .send(Message::text(value.to_string()))
            .await
            .unwrap();
    }

    pub async fn send_raw(&mut self, bytes: Vec<u8>) {
        self.ws.send(Message::binary(bytes)).await.unwrap();
    }

    pub async fn send_frame(&mut self, kind: u8, to: u32, cid: u64, payload: &[u8]) {
        self.send_raw(encode_frame(kind, to, cid, payload)).await;
    }

    /// The next message of any kind, stashed ones first.
    pub async fn event(&mut self) -> Event {
        if let Some((header, payload)) = self.frames.pop_front() {
            return Event::Frame(header, payload);
        }
        if let Some(text) = self.texts.pop_front() {
            return Event::Text(text);
        }
        next_event(&mut self.ws).await
    }

    /// The next JSON message of type `t`. Other JSON messages before it are
    /// dropped; binary frames are kept for [`frame`](Self::frame).
    pub async fn text(&mut self, t: &str) -> Value {
        while let Some(text) = self.texts.pop_front() {
            if text["t"] == t {
                return text;
            }
        }
        loop {
            match next_event(&mut self.ws).await {
                Event::Text(v) if v["t"] == t => return v,
                Event::Text(_) => {}
                Event::Frame(h, p) => self.frames.push_back((h, p)),
                Event::Closed(c) => panic!("closed with {c:?} while waiting for {t}"),
            }
        }
    }

    /// The next binary frame. JSON messages before it are kept for [`text`](Self::text).
    pub async fn frame(&mut self) -> (Header, Vec<u8>) {
        if let Some(frame) = self.frames.pop_front() {
            return frame;
        }
        loop {
            match next_event(&mut self.ws).await {
                Event::Frame(h, p) => return (h, p),
                Event::Text(v) => self.texts.push_back(v),
                Event::Closed(c) => panic!("closed with {c:?} while waiting for a frame"),
            }
        }
    }

    /// Sends a request with a fresh `rid` and returns the message that echoes it.
    pub async fn request(&mut self, mut msg: Value) -> Value {
        let rid = self.next_rid;
        self.next_rid += 1;
        msg["rid"] = json!(rid);
        self.send_json(msg).await;
        loop {
            match next_event(&mut self.ws).await {
                Event::Text(v) if v["rid"] == rid => return v,
                Event::Text(v) => self.texts.push_back(v),
                Event::Frame(h, p) => self.frames.push_back((h, p)),
                Event::Closed(c) => panic!("closed with {c:?} while waiting for a reply"),
            }
        }
    }

    /// Reads until the connection ends and says how.
    pub async fn closed(&mut self) -> Closed {
        loop {
            if let Event::Closed(closed) = next_event(&mut self.ws).await {
                return closed;
            }
        }
    }

    /// Asserts that no binary frame arrives for a short while. JSON is kept.
    pub async fn no_frames(&mut self) {
        assert!(
            self.frames.is_empty(),
            "frames already waiting: {:?}",
            self.frames
        );
        let deadline = tokio::time::Instant::now() + QUIET;
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Err(_) => return,
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
                Ok(Some(Ok(Message::Text(t)))) => {
                    self.texts
                        .push_back(serde_json::from_str(t.as_str()).unwrap());
                }
                Ok(other) => panic!("expected no frames, got {other:?}"),
            }
        }
    }

    /// Reads whatever is already on its way and forgets it.
    pub async fn drain(&mut self) {
        self.texts.clear();
        self.frames.clear();
        while let Ok(Some(Ok(_))) =
            tokio::time::timeout(Duration::from_millis(50), self.ws.next()).await
        {}
    }

    /// Round trip to the relay: everything this client sent before has been handled.
    pub async fn sync(&mut self) {
        let pong = self.request(json!({ "t": "ping" })).await;
        assert_eq!(pong["t"], "pong");
    }

    /// As host: registers a link and returns it.
    pub async fn add_invite(&mut self, extra: Value) -> InviteLink {
        let link = InviteLink::new();
        let reply = self.request(link.registration(extra)).await;
        assert_eq!(reply["t"], "invite-added", "{reply}");
        link
    }

    /// As host: registers a link and lets a new member in through it.
    pub async fn invite(&mut self, relay: &TestRelay, extra: Value) -> Client {
        let link = self.add_invite(extra).await;
        let room = self.room.clone();
        relay
            .try_redeem(&room, &link, &Identity::new())
            .await
            .unwrap()
    }
}

pub fn http_status(
    result: Result<(Ws, tungstenite::handshake::client::Response), tungstenite::Error>,
) -> u16 {
    match result {
        Err(tungstenite::Error::Http(res)) => res.status().as_u16(),
        other => panic!("expected an HTTP error, got {:?}", other.map(|_| ())),
    }
}
