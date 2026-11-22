//! Room records for protocol v2: members, roles, invites, the ordered edit
//! log, routing and lifecycle. Everything here runs under one lock and never
//! waits, so a slow client cannot stall a room.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, Utf8Bytes};
use bytes::{Bytes, BytesMut};
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Notify};

use crate::auth::{b64, member_id, proof_input, random, unb64, KEY_LEN};
use crate::invites::{Invite, Refusal};
use crate::limits::{Bucket, Limits, RateLimit};
use crate::persist::{ImportError, SavedMember, SavedRelay, SavedRoom, SavedTombstone, FORMAT};
use crate::proto::{close, FrameError, Header, Kind, HEADER_LEN, PROTO_VERSION};
use crate::Shared;

/// The two kinds of room.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoomType {
    /// Everyone gets the image and the mask and keeps a copy.
    Shared,
    /// Guests see and edit through the host's computer; no files leave it.
    HostView,
}

impl RoomType {
    pub fn as_str(self) -> &'static str {
        match self {
            RoomType::Shared => "shared",
            RoomType::HostView => "host-view",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "shared" => Some(RoomType::Shared),
            "host-view" => Some(RoomType::HostView),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Host,
    Editor,
    Viewer,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "host" => Some(Role::Host),
            "editor" => Some(Role::Editor),
            "viewer" => Some(Role::Viewer),
            _ => None,
        }
    }
}

/// How a connection is told to stop, shared by its reader, its writer and the room.
#[derive(Default)]
pub(crate) struct ConnCtl {
    pub kick: Notify,
    close: Mutex<Option<(u16, &'static str)>>,
    /// Set by the kill fault: drop the socket without a close frame.
    pub hard: AtomicBool,
}

impl ConnCtl {
    /// Records why the connection is being closed (first reason wins) and wakes it.
    pub fn close(&self, code: u16, reason: &'static str) {
        self.close.lock().unwrap().get_or_insert((code, reason));
        self.kick.notify_one();
    }

    pub fn close_reason(&self) -> Option<(u16, &'static str)> {
        *self.close.lock().unwrap()
    }
}

/// The room's end of one connection: a bounded queue to its writer.
pub(crate) struct ConnHandle {
    pub id: u64,
    pub tx: mpsc::Sender<Message>,
    pub queued_bytes: Arc<AtomicUsize>,
    pub ctl: Arc<ConnCtl>,
    pub queue_bytes: usize,
}

impl ConnHandle {
    /// Queues a message without waiting. A connection whose queue is full is
    /// closed with 4002.
    fn send(&self, msg: Message) {
        let len = message_len(&msg);
        let queued = self.queued_bytes.load(Ordering::Relaxed);
        if queued > 0 && queued + len > self.queue_bytes {
            self.ctl.close(close::TOO_SLOW, "too slow");
            return;
        }
        self.queued_bytes.fetch_add(len, Ordering::Relaxed);
        if self.tx.try_send(msg).is_err() {
            self.queued_bytes.fetch_sub(len, Ordering::Relaxed);
            self.ctl.close(close::TOO_SLOW, "too slow");
        }
    }

    /// More than half of the queue is waiting to be written.
    fn busy(&self) -> bool {
        self.queued_bytes.load(Ordering::Relaxed) > self.queue_bytes / 2
            || self.tx.capacity() < self.tx.max_capacity() / 2
    }

    /// Queues a message only if the queue is less than half full; otherwise
    /// the message is dropped and the connection stays.
    fn send_droppable(&self, msg: Message) {
        if !self.busy() {
            self.send(msg);
        }
    }

    /// Whether `messages` more messages of `bytes` in all fit the queue now.
    fn has_room_for(&self, messages: usize, bytes: usize) -> bool {
        messages <= self.tx.capacity()
            && self.queued_bytes.load(Ordering::Relaxed) + bytes <= self.queue_bytes
    }
}

pub(crate) fn message_len(msg: &Message) -> usize {
    match msg {
        Message::Text(t) => t.len(),
        Message::Binary(b) | Message::Ping(b) | Message::Pong(b) => b.len(),
        Message::Close(_) => 0,
    }
}

pub(crate) fn text(value: &Value) -> Message {
    Message::Text(Utf8Bytes::from(value.to_string()))
}

struct Member {
    key: [u8; KEY_LEN],
    xkey: Option<[u8; KEY_LEN]>,
    role: Role,
    /// The invite this member came in through, revoked when they are removed.
    invite: Option<String>,
    last_seen_ms: u64,
    conn: Option<ConnHandle>,
    slice_requests: Bucket,
}

pub(crate) struct Room {
    kind: RoomType,
    /// Random per room record; changes if the relay lost the room and it was made again.
    session: String,
    epoch: u32,
    host: u32,
    members: BTreeMap<u32, Member>,
    removed: VecDeque<[u8; KEY_LEN]>,
    invites: HashMap<String, Invite>,
    /// The last sequence number given out.
    seq: u64,
    log: VecDeque<(u64, Bytes)>,
    log_bytes: usize,
    /// Highest sequence number no longer in the log. Replay works after this.
    log_floor: u64,
    last_active_ms: u64,
    /// Counts host disconnects, so an old grace timer can tell it is stale.
    host_losses: u64,
    rate: RateLimit,
}

struct Tombstone {
    at_ms: u64,
    reason: &'static str,
}

#[derive(Default)]
pub(crate) struct V2 {
    rooms: HashMap<String, Room>,
    tombstones: HashMap<String, Tombstone>,
}

/// A parsed, signature-checked first message.
pub(crate) enum Handshake {
    Create {
        kind: RoomType,
        key: [u8; KEY_LEN],
        xkey: Option<[u8; KEY_LEN]>,
        members: Vec<SeedMember>,
    },
    Auth {
        key: [u8; KEY_LEN],
        resume: Option<u64>,
    },
    Redeem {
        key: [u8; KEY_LEN],
        key_text: String,
        xkey: Option<[u8; KEY_LEN]>,
        invite: String,
        proof: [u8; 32],
        nonce: String,
    },
}

pub(crate) struct SeedMember {
    pub key: [u8; KEY_LEN],
    pub xkey: Option<[u8; KEY_LEN]>,
    pub role: Role,
}

pub(crate) struct Entered {
    pub member: u32,
    pub kind: RoomType,
    pub is_host: bool,
}

/// Why a connection ended, as far as the room cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Exit {
    /// The client sent a websocket close frame.
    Clean,
    /// The socket broke or ended without a close frame.
    Lost,
    /// Nothing was heard for the liveness timeout.
    TimedOut,
    /// The relay closed it.
    Closed,
}

/// A room as the embedding app sees it. No keys, no invite ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomInfo {
    pub id: String,
    pub room_type: RoomType,
    pub members: usize,
    pub online: usize,
    /// Sequence number of the last ordered edit.
    pub head: u64,
}

/// A v2 room id: 8 to 32 ASCII letters or digits, upper-cased.
pub fn normalize_room_id(raw: &str) -> Option<String> {
    let ok = (8..=32).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then(|| raw.to_ascii_uppercase())
}

impl Room {
    fn new(kind: RoomType, limits: &Limits, now_ms: u64) -> Self {
        Room {
            kind,
            session: b64(&random::<8>()),
            epoch: 1,
            host: 0,
            members: BTreeMap::new(),
            removed: VecDeque::new(),
            invites: HashMap::new(),
            seq: 0,
            log: VecDeque::new(),
            log_bytes: 0,
            log_floor: 0,
            last_active_ms: now_ms,
            host_losses: 0,
            rate: RateLimit::new(
                limits.room_messages_per_sec,
                limits.room_bytes_per_sec,
                limits.max_message_bytes,
            ),
        }
    }

    fn new_member(
        &self,
        key: [u8; KEY_LEN],
        xkey: Option<[u8; KEY_LEN]>,
        role: Role,
        limits: &Limits,
    ) -> Member {
        Member {
            key,
            xkey,
            role,
            invite: None,
            last_seen_ms: self.last_active_ms,
            conn: None,
            slice_requests: Bucket::new(
                f64::from(limits.slice_requests_burst),
                f64::from(limits.slice_requests_per_minute) / 60.0,
            ),
        }
    }

    fn host_online(&self) -> bool {
        self.members
            .get(&self.host)
            .is_some_and(|m| m.conn.is_some())
    }

    fn online(&self) -> usize {
        self.members.values().filter(|m| m.conn.is_some()).count()
    }

    fn state(&self) -> &'static str {
        if self.host_online() {
            "active"
        } else {
            "host-away"
        }
    }

    fn roster(&self) -> Value {
        Value::Array(
            self.members
                .iter()
                .map(|(id, m)| {
                    json!({
                        "id": id,
                        "key": b64(&m.key),
                        "xkey": m.xkey.as_ref().map(|k| b64(k)),
                        "role": m.role.as_str(),
                        "online": m.conn.is_some(),
                    })
                })
                .collect(),
        )
    }

    fn describe(&self, id: &str) -> Value {
        json!({
            "id": id,
            "type": self.kind.as_str(),
            "state": self.state(),
            "proto": PROTO_VERSION,
            "epoch": self.epoch,
            "head": self.seq,
            "logFloor": self.log_floor,
            "session": self.session,
        })
    }

    fn broadcast(&self, except: Option<u32>, msg: &Message) {
        for (id, member) in &self.members {
            if Some(*id) != except {
                if let Some(conn) = &member.conn {
                    conn.send(msg.clone());
                }
            }
        }
    }

    fn send_to(&self, member: u32, msg: Message) {
        if let Some(conn) = self.members.get(&member).and_then(|m| m.conn.as_ref()) {
            conn.send(msg);
        }
    }

    fn remember_removed(&mut self, key: [u8; KEY_LEN], limits: &Limits) {
        if self.removed.len() >= limits.removed_keys {
            self.removed.pop_front();
        }
        self.removed.push_back(key);
    }

    /// Queues the ordered frames after `after` for one member, or says why not.
    fn replay(&self, member: u32, after: u64, rid: Option<Value>) {
        let Some(conn) = self.members.get(&member).and_then(|m| m.conn.as_ref()) else {
            return;
        };
        let refuse = |code: &str| {
            let mut msg = error(code, rid.clone());
            msg["head"] = json!(self.seq);
            msg["logFloor"] = json!(self.log_floor);
            conn.send(text(&msg));
        };
        if after > self.seq {
            return refuse("replay-ahead");
        }
        if after < self.log_floor {
            return refuse("replay-too-old");
        }
        // The frames are queued in one go. If they do not fit, the member would
        // be closed as too slow and ask again: say "too old" instead, and the
        // client gets the mask from a peer.
        let (count, bytes) = self
            .log
            .iter()
            .filter(|(seq, _)| *seq > after)
            .fold((0, 0), |(n, b), (_, frame)| (n + 1, b + frame.len()));
        if !conn.has_room_for(count + 2, bytes + 256) {
            return refuse("replay-too-old");
        }
        conn.send(text(&with_rid(
            json!({ "t": "replay-begin", "after": after, "head": self.seq }),
            rid.clone(),
        )));
        for (seq, frame) in &self.log {
            if *seq > after {
                conn.send(Message::Binary(frame.clone()));
            }
        }
        conn.send(text(&with_rid(
            json!({ "t": "replay-end", "head": self.seq }),
            rid,
        )));
    }
}

fn with_rid(mut msg: Value, rid: Option<Value>) -> Value {
    if let Some(rid) = rid {
        msg["rid"] = rid;
    }
    msg
}

fn error(code: &str, rid: Option<Value>) -> Value {
    with_rid(json!({ "t": "error", "code": code }), rid)
}

/// A request id is echoed only if it is a number or a short string.
fn rid_of(msg: &Map<String, Value>) -> Option<Value> {
    match msg.get("rid") {
        Some(Value::Number(n)) => Some(Value::Number(n.clone())),
        Some(Value::String(s)) if s.len() <= 64 => Some(Value::String(s.clone())),
        _ => None,
    }
}

impl V2 {
    /// Ends a room for everyone and remembers that it is gone.
    fn close_room(&mut self, id: &str, reason: &'static str, now_ms: u64, limits: &Limits) -> bool {
        let Some(room) = self.rooms.remove(id) else {
            return false;
        };
        for member in room.members.values() {
            if let Some(conn) = &member.conn {
                conn.ctl.close(close::GONE, reason);
            }
        }
        if self.tombstones.len() >= limits.tombstones {
            let oldest = self
                .tombstones
                .iter()
                .min_by_key(|(_, t)| t.at_ms)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                self.tombstones.remove(&oldest);
            }
        }
        self.tombstones.insert(
            id.to_owned(),
            Tombstone {
                at_ms: now_ms,
                reason,
            },
        );
        true
    }
}

type Refused = (u16, &'static str);

/// Handles `create`, `auth` or `redeem`: on success the connection is attached
/// to its member and `welcome` is queued before anything else.
pub(crate) fn enter(
    shared: &Shared,
    room_id: &str,
    handshake: Handshake,
    conn: ConnHandle,
) -> Result<Entered, Refused> {
    let limits = &shared.cfg.limits;
    let now = shared.now_ms();
    let mut v2 = shared.v2.lock().unwrap();
    let v2 = &mut *v2;

    let mut wrapped_key: Option<String> = None;
    let mut joined = false;
    let mut resume = None;

    let me = match handshake {
        Handshake::Create {
            kind,
            key,
            xkey,
            members,
        } => {
            if v2.rooms.contains_key(room_id) || v2.tombstones.contains_key(room_id) {
                return Err((close::EXISTS, "room id taken"));
            }
            if v2.rooms.len() >= limits.max_rooms {
                return Err((close::FULL, "relay full"));
            }
            let me = member_id(&key);
            if me == 0 || members.len() >= limits.max_members {
                return Err((close::BAD_REQUEST, "bad handshake"));
            }
            let mut room = Room::new(kind, limits, now);
            room.host = me;
            let host = room.new_member(key, xkey, Role::Host, limits);
            room.members.insert(me, host);
            for seed in members {
                let id = member_id(&seed.key);
                if id == 0 || room.members.contains_key(&id) {
                    return Err((close::BAD_REQUEST, "bad handshake"));
                }
                let member = room.new_member(seed.key, seed.xkey, seed.role, limits);
                room.members.insert(id, member);
            }
            v2.rooms.insert(room_id.to_owned(), room);
            me
        }
        Handshake::Auth { key, resume: after } => {
            let room = find_room(v2, room_id)?;
            if room.removed.contains(&key) {
                return Err((close::REMOVED, "removed by host"));
            }
            let me = member_id(&key);
            if !room.members.get(&me).is_some_and(|m| m.key == key) {
                return Err((close::NOT_MEMBER, "not a member"));
            }
            resume = after;
            me
        }
        Handshake::Redeem {
            key,
            key_text,
            xkey,
            invite: invite_id,
            proof,
            nonce,
        } => {
            let room = find_room(v2, room_id)?;
            if room.removed.contains(&key) {
                return Err((close::REMOVED, "removed by host"));
            }
            let me = member_id(&key);
            let already = room.members.get(&me).is_some_and(|m| m.key == key);
            if !already {
                let Some(invite) = room.invites.get_mut(&invite_id) else {
                    return Err((close::INVITE, Refusal::NotValid.reason()));
                };
                let input = proof_input(room_id, &nonce, &key_text);
                invite
                    .check(&input, &proof, now, limits, &shared.cfg.timing)
                    .map_err(|refusal| match refusal {
                        Refusal::Locked => (close::RATE_LIMITED, refusal.reason()),
                        _ => (close::INVITE, refusal.reason()),
                    })?;
                if room.members.len() >= limits.max_members {
                    return Err((close::FULL, "room full"));
                }
                // A zero id or one that collides with another key cannot be routed.
                if me == 0 || room.members.contains_key(&me) {
                    return Err((close::BAD_REQUEST, "key not usable"));
                }
                let role = invite.role;
                wrapped_key = Some(invite.spend().to_owned());
                let mut member = room.new_member(key, xkey, role, limits);
                member.invite = Some(invite_id);
                room.members.insert(me, member);
                joined = true;
            }
            me
        }
    };

    let room = v2.rooms.get_mut(room_id).expect("the room was just found");
    let state_before = room.state();
    room.last_active_ms = now;
    let member = room
        .members
        .get_mut(&me)
        .expect("the member was just found");
    member.last_seen_ms = now;
    let was_online = match member.conn.replace(conn) {
        Some(old) => {
            old.ctl.close(close::REPLACED, "signed in elsewhere");
            true
        }
        None => false,
    };
    let role = member.role;

    let mut welcome = json!({
        "t": "welcome",
        "self": { "id": me, "role": role.as_str() },
        "room": room.describe(room_id),
        "roster": room.roster(),
    });
    if let Some(wrapped) = wrapped_key {
        welcome["invite"] = json!({ "wrappedKey": wrapped });
    }
    room.send_to(me, text(&welcome));

    if joined {
        room.broadcast(
            Some(me),
            &text(&json!({ "t": "roster", "members": room.roster() })),
        );
    } else if !was_online {
        room.broadcast(
            Some(me),
            &text(&json!({ "t": "presence", "member": me, "online": true })),
        );
    }
    if room.state() != state_before {
        room.broadcast(
            Some(me),
            &text(&json!({ "t": "room-state", "state": room.state() })),
        );
    }
    if let Some(after) = resume {
        room.replay(me, after, None);
    }
    Ok(Entered {
        member: me,
        kind: room.kind,
        is_host: me == room.host,
    })
}

fn find_room<'a>(v2: &'a mut V2, room_id: &str) -> Result<&'a mut Room, Refused> {
    if let Some(tombstone) = v2.tombstones.get(room_id) {
        return Err((close::GONE, tombstone.reason));
    }
    v2.rooms
        .get_mut(room_id)
        .ok_or((close::NO_ROOM, "no such room"))
}

/// Where an accepted frame goes.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// To everyone else, with the next sequence number, an ack and a log entry.
    Ordered,
    /// To everyone else, unordered.
    Broadcast,
    /// To one member.
    To(u32),
    /// Refused; the sender gets an `error` with this code.
    Refuse(&'static str),
}

/// The permission matrix for binary frames, the part the relay can enforce.
fn decide(room: RoomType, role: Role, kind: Kind, to: u32, host: u32) -> Route {
    let targeted = |to: u32| {
        if to == 0 {
            Route::Refuse("needs-recipient")
        } else {
            Route::To(to)
        }
    };
    let can_edit = role != Role::Viewer;
    match room {
        RoomType::Shared => match kind {
            Kind::Patch | Kind::SegOp if can_edit => Route::Ordered,
            Kind::Patch | Kind::SegOp => Route::Refuse("forbidden"),
            Kind::SyncSlab | Kind::ImageSlab | Kind::SyncRequest => targeted(to),
            Kind::Presence if to == 0 => Route::Broadcast,
            Kind::Presence => Route::To(to),
            Kind::SliceRequest | Kind::Slice => Route::Refuse("wrong-room-type"),
            Kind::Key if role == Role::Host => targeted(to),
            Kind::Key => Route::Refuse("forbidden"),
        },
        // Star routing: the host talks to guests, a guest only ever to the host.
        RoomType::HostView if role == Role::Host => match kind {
            Kind::Patch | Kind::SegOp => Route::Ordered,
            Kind::Presence if to == 0 => Route::Broadcast,
            Kind::Presence => Route::To(to),
            Kind::Slice | Kind::Key => targeted(to),
            Kind::SliceRequest => Route::Refuse("forbidden"),
            Kind::SyncSlab | Kind::ImageSlab | Kind::SyncRequest => Route::Refuse("forbidden"),
        },
        RoomType::HostView => match kind {
            Kind::Patch | Kind::SegOp if can_edit => Route::To(host),
            Kind::Patch | Kind::SegOp => Route::Refuse("forbidden"),
            Kind::Presence | Kind::SliceRequest | Kind::Key => Route::To(host),
            Kind::Slice => Route::Refuse("forbidden"),
            Kind::SyncSlab | Kind::ImageSlab | Kind::SyncRequest => Route::Refuse("forbidden"),
        },
    }
}

/// Handles one binary frame from a signed-in member.
pub(crate) fn frame(shared: &Shared, room_id: &str, me: u32, conn_id: u64, data: Bytes) {
    let limits = &shared.cfg.limits;
    let mut v2 = shared.v2.lock().unwrap();
    let Some(room) = v2.rooms.get_mut(room_id) else {
        return;
    };
    let Some(sender) = room.members.get_mut(&me) else {
        return;
    };
    if sender.conn.as_ref().map(|c| c.id) != Some(conn_id) {
        return;
    }
    let role = sender.role;

    let header = match Header::parse(&data) {
        Ok(header) => header,
        Err(FrameError::Truncated) => return room.send_to(me, text(&error("bad-frame", None))),
        Err(FrameError::Version(_)) => return room.send_to(me, text(&error("bad-version", None))),
    };
    // Unknown kinds are ignored, so a newer app does not break an older relay.
    let Some(kind) = Kind::from_u8(header.kind) else {
        return;
    };
    let refuse = |room: &Room, code: &str| {
        let mut msg = error(code, None);
        msg["kind"] = json!(header.kind);
        msg["cid"] = json!(header.seq);
        if header.to != 0 {
            msg["to"] = json!(header.to);
        }
        room.send_to(me, text(&msg));
    };
    if header.epoch != room.epoch {
        return refuse(room, "bad-epoch");
    }
    if kind == Kind::SliceRequest && !sender.slice_requests.take(1.0) {
        return refuse(room, "rate-limited");
    }
    if !room.rate.allow(data.len()) {
        return refuse(room, "rate-limited");
    }

    let route = decide(room.kind, role, kind, header.to, room.host);
    let mut out = header;
    out.from = me;
    let stamped = |out: &Header, data: Bytes| {
        let mut buf = BytesMut::from(data);
        buf[..HEADER_LEN].copy_from_slice(&out.encode());
        buf.freeze()
    };
    match route {
        Route::Refuse(code) => refuse(room, code),
        Route::Ordered => {
            room.seq += 1;
            out.seq = room.seq;
            out.to = 0;
            let bytes = stamped(&out, data);
            room.log_bytes += bytes.len();
            room.log.push_back((room.seq, bytes.clone()));
            while room.log.len() > limits.log_frames || room.log_bytes > limits.log_bytes {
                let Some((seq, old)) = room.log.pop_front() else {
                    break;
                };
                room.log_bytes -= old.len();
                room.log_floor = seq;
            }
            // The ack is queued under the same lock as the stamp, so the sender
            // sees acks and other members' frames in sequence order.
            room.send_to(
                me,
                text(&json!({ "t": "ack", "cid": header.seq, "seq": room.seq })),
            );
            room.broadcast(Some(me), &Message::Binary(bytes));
        }
        Route::Broadcast => {
            out.to = 0;
            let msg = Message::Binary(stamped(&out, data));
            for (id, member) in &room.members {
                if *id != me {
                    if let Some(conn) = &member.conn {
                        conn.send_droppable(msg.clone());
                    }
                }
            }
        }
        Route::To(target) => {
            if target == me {
                return;
            }
            out.to = target;
            match room.members.get(&target).and_then(|m| m.conn.as_ref()) {
                Some(conn) if kind == Kind::Presence => {
                    conn.send_droppable(Message::Binary(stamped(&out, data)));
                }
                // One member must not be able to fill another's queue and get
                // them closed as too slow: past half, file frames are refused
                // and the sender is told to wait.
                Some(conn) if kind.is_file() && conn.busy() => {
                    let mut msg = error("busy", None);
                    msg["kind"] = json!(header.kind);
                    msg["cid"] = json!(header.seq);
                    msg["to"] = json!(target);
                    room.send_to(me, text(&msg));
                }
                Some(conn) => conn.send(Message::Binary(stamped(&out, data))),
                None if kind == Kind::Presence => {}
                None => {
                    let mut msg = error("offline", None);
                    msg["kind"] = json!(header.kind);
                    msg["cid"] = json!(header.seq);
                    msg["to"] = json!(target);
                    room.send_to(me, text(&msg));
                }
            }
        }
    }
}

/// Handles one JSON control message from a signed-in member.
pub(crate) fn control(shared: &Shared, room_id: &str, me: u32, conn_id: u64, raw: &str) {
    let limits = &shared.cfg.limits;
    let timing = &shared.cfg.timing;
    let now = shared.now_ms();
    let mut v2 = shared.v2.lock().unwrap();
    let v2 = &mut *v2;
    let Some(room) = v2.rooms.get_mut(room_id) else {
        return;
    };
    let Some(sender) = room.members.get(&me) else {
        return;
    };
    if sender.conn.as_ref().map(|c| c.id) != Some(conn_id) {
        return;
    }
    let is_host = me == room.host;

    if raw.len() > limits.max_control_bytes {
        return room.send_to(me, text(&error("too-large", None)));
    }
    let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(raw) else {
        return room.send_to(me, text(&error("bad-message", None)));
    };
    let rid = rid_of(&msg);
    let Some(kind) = msg.get("t").and_then(Value::as_str) else {
        return room.send_to(me, text(&error("bad-message", rid)));
    };
    let reply = |room: &Room, value: Value| room.send_to(me, text(&with_rid(value, rid.clone())));
    let fail = |room: &Room, code: &str| room.send_to(me, text(&error(code, rid.clone())));
    let ok = |room: &Room| reply(room, json!({ "t": "ok", "re": kind }));
    let member_arg = || {
        msg.get("member")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };

    match kind {
        "ping" => reply(room, json!({ "t": "pong" })),
        "replay" => match msg.get("after").and_then(Value::as_u64) {
            Some(after) => room.replay(me, after, rid.clone()),
            None => fail(room, "bad-message"),
        },
        "invite-add" | "invite-revoke" | "invite-list" | "member-remove" | "member-role"
        | "room-delete" | "room-close"
            if !is_host =>
        {
            fail(room, "forbidden")
        }
        "invite-add" => {
            let single_use = room.kind == RoomType::HostView;
            let (id, invite) =
                match Invite::from_request(&Value::Object(msg.clone()), single_use, now, timing) {
                    Ok(parsed) => parsed,
                    Err(_field) => return fail(room, "bad-message"),
                };
            if room.invites.contains_key(&id) {
                return fail(room, "exists");
            }
            if room.invites.len() >= limits.max_invites {
                // Make space by forgetting a link that can no longer be used.
                let spent = room
                    .invites
                    .iter()
                    .filter(|(_, i)| !i.live(now))
                    .min_by_key(|(_, i)| i.expires_ms)
                    .map(|(id, _)| id.clone());
                match spent {
                    Some(spent) => room.invites.remove(&spent),
                    None => return fail(room, "limit"),
                };
            }
            let public = invite.public(&id);
            room.invites.insert(id, invite);
            reply(room, json!({ "t": "invite-added", "invite": public }));
        }
        "invite-revoke" => {
            let found = msg
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| room.invites.get_mut(id));
            match found {
                Some(invite) => {
                    invite.revoked = true;
                    ok(room);
                }
                None => fail(room, "not-found"),
            }
        }
        "invite-list" => {
            let mut list: Vec<(&String, &Invite)> = room.invites.iter().collect();
            list.sort_by_key(|(id, invite)| (invite.expires_ms, id.as_str()));
            let list: Vec<Value> = list.into_iter().map(|(id, i)| i.public(id)).collect();
            reply(room, json!({ "t": "invites", "list": list }));
        }
        "member-remove" => {
            let Some(target) = member_arg() else {
                return fail(room, "bad-message");
            };
            if target == room.host {
                return fail(room, "forbidden");
            }
            let Some(removed) = room.members.remove(&target) else {
                return fail(room, "not-found");
            };
            if let Some(conn) = &removed.conn {
                conn.ctl.close(close::REMOVED, "removed by host");
            }
            room.remember_removed(removed.key, limits);
            // The link they came in through must not let them back in.
            if let Some(invite) = removed
                .invite
                .as_ref()
                .and_then(|id| room.invites.get_mut(id))
            {
                invite.revoked = true;
            }
            if msg.get("revokeInvites").and_then(Value::as_bool) == Some(true) {
                for invite in room.invites.values_mut() {
                    invite.revoked = true;
                }
            }
            room.broadcast(
                None,
                &text(&json!({ "t": "roster", "members": room.roster() })),
            );
            ok(room);
        }
        "member-role" => {
            let role = match msg
                .get("role")
                .and_then(Value::as_str)
                .and_then(Role::parse)
            {
                Some(Role::Host) | None => return fail(room, "bad-message"),
                Some(role) => role,
            };
            let Some(target) = member_arg() else {
                return fail(room, "bad-message");
            };
            if target == room.host {
                return fail(room, "forbidden");
            }
            match room.members.get_mut(&target) {
                Some(member) => member.role = role,
                None => return fail(room, "not-found"),
            }
            room.broadcast(
                None,
                &text(&json!({ "t": "roster", "members": room.roster() })),
            );
            ok(room);
        }
        "room-delete" => {
            v2.close_room(room_id, "room deleted", now, limits);
        }
        "room-close" => {
            if room.kind != RoomType::HostView {
                return fail(room, "wrong-room-type");
            }
            v2.close_room(room_id, "room closed", now, limits);
        }
        // Unknown message types are ignored, never fatal.
        _ => {}
    }
}

/// Detaches a connection from its member. Does nothing if the member has
/// already moved to a newer connection or is gone.
pub(crate) fn leave(shared: &Arc<Shared>, room_id: &str, me: u32, conn_id: u64, exit: Exit) {
    let limits = &shared.cfg.limits;
    let now = shared.now_ms();
    let mut v2 = shared.v2.lock().unwrap();
    let Some(room) = v2.rooms.get_mut(room_id) else {
        return;
    };
    let Some(member) = room.members.get_mut(&me) else {
        return;
    };
    if member.conn.as_ref().map(|c| c.id) != Some(conn_id) {
        return;
    }
    member.conn = None;
    member.last_seen_ms = now;
    room.last_active_ms = now;
    room.broadcast(
        None,
        &text(&json!({ "t": "presence", "member": me, "online": false })),
    );
    if me != room.host {
        return;
    }
    match (room.kind, exit) {
        // The host is the room: leaving ends it at once.
        (RoomType::HostView, Exit::Clean) => {
            v2.close_room(room_id, "room closed", now, limits);
        }
        (RoomType::HostView, Exit::TimedOut) => {
            v2.close_room(room_id, "host lost", now, limits);
        }
        (RoomType::HostView, Exit::Lost | Exit::Closed) => {
            room.host_losses += 1;
            let losses = room.host_losses;
            let session = room.session.clone();
            room.broadcast(
                None,
                &text(&json!({ "t": "room-state", "state": "host-away" })),
            );
            let shared = shared.clone();
            let room_id = room_id.to_owned();
            let grace = shared.cfg.timing.host_grace;
            tokio::spawn(async move {
                tokio::time::sleep(grace).await;
                host_grace_over(&shared, &room_id, &session, losses);
            });
        }
        (RoomType::Shared, _) => {
            room.broadcast(
                None,
                &text(&json!({ "t": "room-state", "state": "host-away" })),
            );
        }
    }
}

/// Closes a view-through-host room whose host did not come back in time.
fn host_grace_over(shared: &Shared, room_id: &str, session: &str, losses: u64) {
    let now = shared.now_ms();
    let mut v2 = shared.v2.lock().unwrap();
    let stale = match v2.rooms.get(room_id) {
        Some(room) => room.session != session || room.host_losses != losses || room.host_online(),
        None => true,
    };
    if !stale {
        v2.close_room(room_id, "host lost", now, &shared.cfg.limits);
    }
}

/// Expiry: spent invites, idle members, idle rooms, old tombstones.
pub(crate) fn sweep(shared: &Shared) {
    let timing = &shared.cfg.timing;
    let now = shared.now_ms();
    let older_than =
        |at_ms: u64, ttl: std::time::Duration| now.saturating_sub(at_ms) >= ttl.as_millis() as u64;
    let mut v2 = shared.v2.lock().unwrap();
    v2.tombstones
        .retain(|_, t| !older_than(t.at_ms, timing.tombstone_ttl));
    v2.rooms.retain(|_, room| {
        room.online() > 0 || !older_than(room.last_active_ms, timing.room_idle_ttl)
    });
    for room in v2.rooms.values_mut() {
        room.invites.retain(|_, i| !i.forgettable(now, timing));
        let host = room.host;
        let before = room.members.len();
        room.members.retain(|id, m| {
            *id == host || m.conn.is_some() || !older_than(m.last_seen_ms, timing.member_idle_ttl)
        });
        if room.members.len() != before {
            room.broadcast(
                None,
                &text(&json!({ "t": "roster", "members": room.roster() })),
            );
        }
    }
    drop(v2);
    shared.ips.lock().unwrap().prune();
}

/// Fault hook: cut one member's connection without a close frame.
pub(crate) fn kill(shared: &Shared, room_id: &str, member: u32) -> bool {
    let v2 = shared.v2.lock().unwrap();
    let conn = v2
        .rooms
        .get(room_id)
        .and_then(|room| room.members.get(&member))
        .and_then(|m| m.conn.as_ref());
    match conn {
        Some(conn) => {
            conn.ctl.hard.store(true, Ordering::Relaxed);
            conn.ctl.kick.notify_one();
            true
        }
        None => false,
    }
}

/// Fault hook: lose all v2 state, as a restart would.
pub(crate) fn wipe(shared: &Shared) {
    let mut v2 = shared.v2.lock().unwrap();
    for room in v2.rooms.values() {
        for member in room.members.values() {
            if let Some(conn) = &member.conn {
                conn.ctl.hard.store(true, Ordering::Relaxed);
                conn.ctl.kick.notify_one();
            }
        }
    }
    v2.rooms.clear();
    v2.tombstones.clear();
}

pub(crate) fn delete_room(shared: &Shared, room_id: &str) -> bool {
    let now = shared.now_ms();
    let mut v2 = shared.v2.lock().unwrap();
    v2.close_room(room_id, "room deleted", now, &shared.cfg.limits)
}

pub(crate) fn list(shared: &Shared) -> Vec<RoomInfo> {
    let v2 = shared.v2.lock().unwrap();
    let mut rooms: Vec<RoomInfo> = v2
        .rooms
        .iter()
        .map(|(id, room)| RoomInfo {
            id: id.clone(),
            room_type: room.kind,
            members: room.members.len(),
            online: room.online(),
            head: room.seq,
        })
        .collect();
    rooms.sort_by(|a, b| a.id.cmp(&b.id));
    rooms
}

pub(crate) fn count(shared: &Shared) -> usize {
    shared.v2.lock().unwrap().rooms.len()
}

/// The reasons a tombstone can carry, as the static texts the close frames use.
fn tombstone_reason(text: &str) -> Option<&'static str> {
    ["room deleted", "room closed", "host lost"]
        .into_iter()
        .find(|known| *known == text)
}

/// What an embedding app stores to bring rooms back after a restart (`persist`).
pub(crate) fn export(shared: &Shared) -> SavedRelay {
    let v2 = shared.v2.lock().unwrap();
    let mut rooms: Vec<SavedRoom> = v2
        .rooms
        .iter()
        .filter(|(_, room)| room.kind == RoomType::Shared)
        .filter_map(|(id, room)| {
            let host = room.members.get(&room.host)?;
            let mut invites: Vec<_> = room.invites.iter().map(|(id, i)| i.to_saved(id)).collect();
            invites.sort_by(|a, b| a.id.cmp(&b.id));
            Some(SavedRoom {
                id: id.clone(),
                kind: room.kind.as_str().to_owned(),
                epoch: room.epoch,
                host: b64(&host.key),
                members: room
                    .members
                    .iter()
                    .filter(|(id, _)| **id != room.host)
                    .map(|(_, m)| SavedMember {
                        key: b64(&m.key),
                        xkey: m.xkey.as_ref().map(|k| b64(k)),
                        role: m.role.as_str().to_owned(),
                        invite: m.invite.clone(),
                        last_seen: m.last_seen_ms,
                    })
                    .collect(),
                removed: room.removed.iter().map(|k| b64(k)).collect(),
                invites,
                last_active: room.last_active_ms,
            })
        })
        .collect();
    rooms.sort_by(|a, b| a.id.cmp(&b.id));
    let mut tombstones: Vec<SavedTombstone> = v2
        .tombstones
        .iter()
        .map(|(id, t)| SavedTombstone {
            id: id.clone(),
            at: t.at_ms,
            reason: t.reason.to_owned(),
        })
        .collect();
    tombstones.sort_by(|a, b| a.id.cmp(&b.id));
    SavedRelay {
        version: FORMAT,
        rooms,
        tombstones,
    }
}

/// One saved room as a record, or `None` when any part of it is not what it
/// should be. Members and invites that are damaged are left out one by one.
fn room_from_saved(saved: &SavedRoom, limits: &Limits, now_ms: u64) -> Option<(String, Room)> {
    let id = normalize_room_id(&saved.id)?;
    if RoomType::parse(&saved.kind) != Some(RoomType::Shared) || saved.epoch == 0 {
        return None;
    }
    let host_key = unb64::<KEY_LEN>(&saved.host)?;
    let host = member_id(&host_key);
    if host == 0 {
        return None;
    }
    let mut room = Room::new(RoomType::Shared, limits, now_ms);
    room.epoch = saved.epoch;
    room.host = host;
    // An idle room is judged by when someone was last there, not by this start.
    room.last_active_ms = saved.last_active.min(now_ms);
    let mut member = room.new_member(host_key, None, Role::Host, limits);
    member.last_seen_ms = room.last_active_ms;
    room.members.insert(host, member);
    for m in saved
        .members
        .iter()
        .take(limits.max_members.saturating_sub(1))
    {
        let Some(key) = unb64::<KEY_LEN>(&m.key) else {
            continue;
        };
        let role = match Role::parse(&m.role) {
            Some(Role::Host) | None => continue,
            Some(role) => role,
        };
        let member_id = member_id(&key);
        if member_id == 0 || room.members.contains_key(&member_id) {
            continue;
        }
        let xkey = m.xkey.as_deref().and_then(unb64::<KEY_LEN>);
        let mut member = room.new_member(key, xkey, role, limits);
        member.invite = m.invite.clone();
        member.last_seen_ms = m.last_seen.min(now_ms);
        room.members.insert(member_id, member);
    }
    for key in saved.removed.iter().filter_map(|k| unb64::<KEY_LEN>(k)) {
        room.remember_removed(key, limits);
    }
    for (id, invite) in saved
        .invites
        .iter()
        .filter_map(Invite::from_saved)
        .take(limits.max_invites)
    {
        room.invites.insert(id, invite);
    }
    Some((id, room))
}

/// Brings saved rooms back, then lets lapse what ran out while the relay was off.
pub(crate) fn import(shared: &Shared, saved: SavedRelay) -> Result<usize, ImportError> {
    if saved.version > FORMAT {
        return Err(ImportError::Newer(saved.version));
    }
    let limits = &shared.cfg.limits;
    let now = shared.now_ms();
    let mut taken = Vec::new();
    {
        let mut v2 = shared.v2.lock().unwrap();
        for t in &saved.tombstones {
            let (Some(id), Some(reason)) = (normalize_room_id(&t.id), tombstone_reason(&t.reason))
            else {
                continue;
            };
            if v2.rooms.contains_key(&id) || v2.tombstones.len() >= limits.tombstones {
                continue;
            }
            v2.tombstones.entry(id).or_insert(Tombstone {
                at_ms: t.at.min(now),
                reason,
            });
        }
        // The most recently used first: when there are more than may come
        // back, the ones left out are those nobody has been in for longest.
        let mut newest: Vec<&SavedRoom> = saved.rooms.iter().collect();
        newest.sort_by(|a, b| b.last_active.cmp(&a.last_active).then(a.id.cmp(&b.id)));
        let room_for_kept = (limits.max_rooms / 2).max(1);
        for room in newest {
            let Some((id, room)) = room_from_saved(room, limits, now) else {
                continue;
            };
            if taken.len() >= room_for_kept
                || v2.rooms.len() >= limits.max_rooms
                || v2.rooms.contains_key(&id)
                || v2.tombstones.contains_key(&id)
            {
                continue;
            }
            v2.rooms.insert(id.clone(), room);
            taken.push(id);
        }
    }
    sweep(shared);
    let v2 = shared.v2.lock().unwrap();
    Ok(taken.iter().filter(|id| v2.rooms.contains_key(*id)).count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_ids_are_8_to_32_letters_or_digits_upper_cased() {
        assert_eq!(
            normalize_room_id("k7q2m9xa4tdp").as_deref(),
            Some("K7Q2M9XA4TDP")
        );
        assert_eq!(normalize_room_id("abcdefg"), None);
        assert_eq!(normalize_room_id(&"a".repeat(33)), None);
        assert_eq!(normalize_room_id("abcd-efgh"), None);
        assert_eq!(normalize_room_id("abcdefgé"), None);
        assert!(normalize_room_id(&"a".repeat(32)).is_some());
    }

    const HOST: u32 = 1;

    fn shared(role: Role, kind: Kind, to: u32) -> Route {
        decide(RoomType::Shared, role, kind, to, HOST)
    }

    fn host_view(role: Role, kind: Kind, to: u32) -> Route {
        decide(RoomType::HostView, role, kind, to, HOST)
    }

    #[test]
    fn shared_copy_matrix() {
        for kind in [Kind::Patch, Kind::SegOp] {
            assert_eq!(shared(Role::Host, kind, 0), Route::Ordered);
            // An edit is for everyone, whatever the header says.
            assert_eq!(shared(Role::Editor, kind, 9), Route::Ordered);
            assert_eq!(shared(Role::Viewer, kind, 0), Route::Refuse("forbidden"));
        }
        for kind in [Kind::SyncSlab, Kind::ImageSlab, Kind::SyncRequest] {
            for role in [Role::Host, Role::Editor, Role::Viewer] {
                assert_eq!(shared(role, kind, 5), Route::To(5));
                assert_eq!(shared(role, kind, 0), Route::Refuse("needs-recipient"));
            }
        }
        assert_eq!(shared(Role::Viewer, Kind::Presence, 0), Route::Broadcast);
        assert_eq!(shared(Role::Viewer, Kind::Presence, 4), Route::To(4));
        assert_eq!(shared(Role::Host, Kind::Key, 4), Route::To(4));
        assert_eq!(
            shared(Role::Host, Kind::Key, 0),
            Route::Refuse("needs-recipient")
        );
        assert_eq!(
            shared(Role::Editor, Kind::Key, 4),
            Route::Refuse("forbidden")
        );
        for kind in [Kind::SliceRequest, Kind::Slice] {
            assert_eq!(
                shared(Role::Host, kind, 4),
                Route::Refuse("wrong-room-type")
            );
        }
    }

    #[test]
    fn view_through_host_matrix_is_a_star() {
        // The host reaches guests.
        assert_eq!(host_view(Role::Host, Kind::Patch, 0), Route::Ordered);
        assert_eq!(host_view(Role::Host, Kind::SegOp, 0), Route::Ordered);
        assert_eq!(host_view(Role::Host, Kind::Slice, 5), Route::To(5));
        assert_eq!(
            host_view(Role::Host, Kind::Slice, 0),
            Route::Refuse("needs-recipient")
        );
        assert_eq!(host_view(Role::Host, Kind::Key, 5), Route::To(5));
        assert_eq!(host_view(Role::Host, Kind::Presence, 0), Route::Broadcast);
        // A guest reaches only the host, whatever target it names.
        for to in [0, HOST, 5] {
            assert_eq!(host_view(Role::Editor, Kind::Patch, to), Route::To(HOST));
            assert_eq!(host_view(Role::Editor, Kind::Presence, to), Route::To(HOST));
            assert_eq!(
                host_view(Role::Editor, Kind::SliceRequest, to),
                Route::To(HOST)
            );
            assert_eq!(
                host_view(Role::Viewer, Kind::SliceRequest, to),
                Route::To(HOST)
            );
            assert_eq!(host_view(Role::Editor, Kind::Key, to), Route::To(HOST));
        }
        assert_eq!(
            host_view(Role::Viewer, Kind::Patch, 0),
            Route::Refuse("forbidden")
        );
        assert_eq!(
            host_view(Role::Editor, Kind::Slice, 5),
            Route::Refuse("forbidden")
        );
        // File-class frames do not exist in this room type, for anyone.
        for role in [Role::Host, Role::Editor, Role::Viewer] {
            for kind in [Kind::SyncSlab, Kind::ImageSlab, Kind::SyncRequest] {
                assert!(kind.is_file());
                assert_eq!(host_view(role, kind, 5), Route::Refuse("forbidden"));
            }
        }
    }

    #[test]
    fn no_guest_frame_can_be_routed_to_another_guest() {
        for role in [Role::Editor, Role::Viewer] {
            for kind in 1..=9u8 {
                let kind = Kind::from_u8(kind).unwrap();
                for to in [0, HOST, 5, u32::MAX] {
                    match host_view(role, kind, to) {
                        Route::To(target) => assert_eq!(target, HOST),
                        Route::Refuse(_) => {}
                        other => panic!("{role:?} {kind:?} to {to}: {other:?}"),
                    }
                }
            }
        }
    }
}
