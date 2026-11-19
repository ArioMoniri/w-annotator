//! Protocol v1: the original dumb relay, kept unchanged for apps that have
//! not moved to rooms v2. Peers join a room and the server forwards what they
//! send to the other peers of that room. No history, no identity, no roles.
//!
//! * `GET /r/<ROOM>?name=<display name>` upgrades to a websocket.
//! * The server sends `welcome` to the newcomer and `join` / `leave` to the rest.
//! * Text frames are JSON objects; the server stamps `"from"` and routes on `"to"`.
//! * Binary frames start with a little-endian `u32` target id (0 = everyone
//!   else), which the server replaces with the sender id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bytes::{Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};

use crate::AppState;

/// Largest websocket message the relay accepts.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
/// Most peers a room holds; the next one is closed with [`CLOSE_ROOM_FULL`].
pub const MAX_PEERS_PER_ROOM: usize = 16;
/// Display names are cut to this many characters.
pub const MAX_NAME_CHARS: usize = 40;
/// Close code sent to a peer that tries to join a full room.
pub const CLOSE_ROOM_FULL: u16 = 4001;
/// How often the server pings each peer.
pub const PING_INTERVAL: Duration = Duration::from_secs(20);
/// A peer that sends nothing (not even a pong) for this long is dropped.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Outbound queue bounds per peer. A peer that falls behind either one is dropped.
const QUEUE_MESSAGES: usize = 512;
const QUEUE_BYTES: usize = 4 * MAX_MESSAGE_BYTES;

struct Peer {
    name: String,
    tx: mpsc::Sender<Message>,
    queued_bytes: Arc<AtomicUsize>,
    /// Wakes the peer's connection task so it disconnects.
    kick: Arc<Notify>,
}

impl Peer {
    /// Queues a message without waiting. A peer whose queue is full is kicked.
    fn send(&self, msg: Message) {
        let len = message_len(&msg);
        let queued = self.queued_bytes.load(Ordering::Relaxed);
        if queued > 0 && queued + len > QUEUE_BYTES {
            self.kick.notify_one();
            return;
        }
        self.queued_bytes.fetch_add(len, Ordering::Relaxed);
        if self.tx.try_send(msg).is_err() {
            self.queued_bytes.fetch_sub(len, Ordering::Relaxed);
            self.kick.notify_one();
        }
    }
}

#[derive(Default)]
pub(crate) struct Room {
    last_id: u32,
    peers: HashMap<u32, Peer>,
}

pub(crate) type Rooms = Mutex<HashMap<String, Room>>;

#[derive(Deserialize)]
pub(crate) struct JoinQuery {
    name: Option<String>,
}

/// Upper-cases a room code, or `None` if it is not 4–16 ASCII letters or digits.
pub fn normalize_room(raw: &str) -> Option<String> {
    let ok = (4..=16).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then(|| raw.to_ascii_uppercase())
}

/// Trims a display name, cuts it to [`MAX_NAME_CHARS`] and falls back to "Guest".
pub fn normalize_name(raw: Option<&str>) -> String {
    let name: String = raw
        .unwrap_or("")
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    let name = name.trim_end();
    if name.is_empty() {
        "Guest".to_owned()
    } else {
        name.to_owned()
    }
}

pub(crate) async fn join(
    State(state): State<AppState>,
    Path(room): Path<String>,
    Query(query): Query<JoinQuery>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    if !state.cfg.v1 {
        return (
            StatusCode::UPGRADE_REQUIRED,
            "Update W Annotator to join this room",
        )
            .into_response();
    }
    let Some(room) = normalize_room(&room) else {
        return (
            StatusCode::BAD_REQUEST,
            "room code must be 4-16 letters or digits",
        )
            .into_response();
    };
    let Ok(upgrade) = upgrade else {
        return (StatusCode::BAD_REQUEST, "expected a websocket upgrade").into_response();
    };
    let name = normalize_name(query.name.as_deref());
    upgrade
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(state, room, name, socket))
}

fn message_len(msg: &Message) -> usize {
    match msg {
        Message::Text(t) => t.len(),
        Message::Binary(b) | Message::Ping(b) | Message::Pong(b) => b.len(),
        Message::Close(_) => 0,
    }
}

fn text(value: &Value) -> Message {
    Message::Text(Utf8Bytes::from(value.to_string()))
}

struct Joined {
    id: u32,
    rx: mpsc::Receiver<Message>,
    queued_bytes: Arc<AtomicUsize>,
    kick: Arc<Notify>,
}

/// Adds a peer to a room, queues its `welcome` and tells the others.
/// Returns `None` when the room is full.
fn enter(state: &Rooms, room_code: &str, name: &str) -> Option<Joined> {
    let mut rooms = state.lock().unwrap();
    let room = rooms.entry(room_code.to_owned()).or_default();
    if room.peers.len() >= MAX_PEERS_PER_ROOM {
        return None;
    }
    room.last_id += 1;
    let id = room.last_id;

    let mut existing: Vec<(u32, &str)> = room
        .peers
        .iter()
        .map(|(id, p)| (*id, p.name.as_str()))
        .collect();
    existing.sort_unstable_by_key(|(id, _)| *id);
    let peers: Vec<Value> = existing
        .into_iter()
        .map(|(id, name)| json!({ "id": id, "name": name }))
        .collect();

    let (tx, rx) = mpsc::channel(QUEUE_MESSAGES);
    let peer = Peer {
        name: name.to_owned(),
        tx,
        queued_bytes: Arc::new(AtomicUsize::new(0)),
        kick: Arc::new(Notify::new()),
    };
    // Queued before the peer is visible to others, so `welcome` is always first.
    peer.send(text(&json!({ "t": "welcome", "id": id, "peers": peers })));

    let joined = text(&json!({ "t": "join", "id": id, "name": name }));
    for other in room.peers.values() {
        other.send(joined.clone());
    }
    let handle = Joined {
        id,
        rx,
        queued_bytes: peer.queued_bytes.clone(),
        kick: peer.kick.clone(),
    };
    room.peers.insert(id, peer);
    Some(handle)
}

/// Removes a peer, tells the others and drops the room once it is empty.
fn leave(state: &Rooms, room_code: &str, id: u32) {
    let mut rooms = state.lock().unwrap();
    let Some(room) = rooms.get_mut(room_code) else {
        return;
    };
    if room.peers.remove(&id).is_none() {
        return;
    }
    if room.peers.is_empty() {
        rooms.remove(room_code);
        return;
    }
    let left = text(&json!({ "t": "leave", "id": id }));
    for other in room.peers.values() {
        other.send(left.clone());
    }
}

/// Sends to one peer (`to` > 0) or to everyone but the sender.
fn route(state: &Rooms, room_code: &str, from: u32, to: Option<u32>, msg: Message) {
    let rooms = state.lock().unwrap();
    let Some(room) = rooms.get(room_code) else {
        return;
    };
    match to {
        Some(target) => {
            if target != from {
                if let Some(peer) = room.peers.get(&target) {
                    peer.send(msg);
                }
            }
        }
        None => {
            for (id, peer) in &room.peers {
                if *id != from {
                    peer.send(msg.clone());
                }
            }
        }
    }
}

/// Stamps `"from"` on a JSON object and returns it with its target, if any.
/// Anything that is not a JSON object yields `None`.
fn stamp_text(raw: &str, from: u32) -> Option<(Option<u32>, Message)> {
    let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    obj.insert("from".to_owned(), Value::from(from));
    let to = match obj.get("to") {
        Some(Value::Number(n)) => {
            // A numeric target that is not a valid id reaches nobody.
            Some(
                n.as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .unwrap_or(from),
            )
        }
        _ => None,
    };
    Some((to, text(&Value::Object(obj))))
}

/// Reads the target from the 4-byte header and replaces it with the sender id.
/// Frames shorter than the header yield `None`.
fn stamp_binary(data: Bytes, from: u32) -> Option<(Option<u32>, Message)> {
    if data.len() < 4 {
        return None;
    }
    let target = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let mut data = BytesMut::from(data);
    data[..4].copy_from_slice(&from.to_le_bytes());
    Some((
        (target != 0).then_some(target),
        Message::Binary(data.freeze()),
    ))
}

async fn connection(state: AppState, room_code: String, name: String, mut socket: WebSocket) {
    let Some(Joined {
        id,
        mut rx,
        queued_bytes,
        kick,
    }) = enter(&state.v1, &room_code, &name)
    else {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: CLOSE_ROOM_FULL,
                reason: Utf8Bytes::from_static("room full"),
            })))
            .await;
        return;
    };

    let (mut sink, mut stream) = socket.split();

    // Writer: drains this peer's queue and keeps the connection alive with pings.
    let writer = tokio::spawn(async move {
        let mut ping =
            tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    let Some(msg) = msg else { break };
                    let len = message_len(&msg);
                    let sent = sink.send(msg).await;
                    queued_bytes.fetch_sub(len, Ordering::Relaxed);
                    if sent.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = sink.close().await;
    });

    let mut shutdown = state.shutdown.clone();
    loop {
        let frame = tokio::select! {
            frame = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => frame,
            _ = kick.notified() => break,
            _ = shutdown.wait_for(|stop| *stop) => break,
        };
        let stamped = match frame {
            // Silent for too long, stream ended, or a protocol error.
            Err(_) | Ok(None) | Ok(Some(Err(_))) => break,
            Ok(Some(Ok(Message::Close(_)))) => break,
            Ok(Some(Ok(Message::Text(raw)))) => stamp_text(raw.as_str(), id),
            Ok(Some(Ok(Message::Binary(data)))) => stamp_binary(data, id),
            // Pings are answered by the websocket layer; pongs only reset the timer.
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => None,
        };
        if let Some((to, msg)) = stamped {
            route(&state.v1, &room_code, id, to, msg);
        }
    }

    leave(&state.v1, &room_code, id);
    // `leave` dropped the queue's sender, so the writer flushes and closes.
    let mut writer = writer;
    if tokio::time::timeout(Duration::from_secs(5), &mut writer)
        .await
        .is_err()
    {
        // A peer that will not take its last frames is cut off.
        writer.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_codes_are_validated_and_upper_cased() {
        assert_eq!(normalize_room("abcd").as_deref(), Some("ABCD"));
        assert_eq!(
            normalize_room("Room1234Room1234").as_deref(),
            Some("ROOM1234ROOM1234")
        );
        assert_eq!(normalize_room("abc"), None);
        assert_eq!(normalize_room("abcdefghijklmnopq"), None);
        assert_eq!(normalize_room("ab-cd"), None);
        assert_eq!(normalize_room("abcé"), None);
    }

    #[test]
    fn names_are_trimmed_cut_and_defaulted() {
        assert_eq!(normalize_name(None), "Guest");
        assert_eq!(normalize_name(Some("   ")), "Guest");
        assert_eq!(normalize_name(Some("  Ada  ")), "Ada");
        let long = "é".repeat(60);
        assert_eq!(normalize_name(Some(&long)).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn text_gets_from_and_keeps_numeric_to() {
        let (to, msg) = stamp_text(r#"{"t":"x","from":99,"to":3}"#, 7).unwrap();
        assert_eq!(to, Some(3));
        let Message::Text(out) = msg else {
            panic!("not text")
        };
        let v: Value = serde_json::from_str(out.as_str()).unwrap();
        assert_eq!(v["from"], 7);
        assert_eq!(v["t"], "x");

        let (to, _) = stamp_text(r#"{"to":"3"}"#, 7).unwrap();
        assert_eq!(to, None);
        assert!(stamp_text("[1,2]", 7).is_none());
        assert!(stamp_text("not json", 7).is_none());
    }

    #[test]
    fn binary_header_is_rewritten() {
        let (to, msg) = stamp_binary(Bytes::from_static(&[2, 0, 0, 0, 9, 8]), 5).unwrap();
        assert_eq!(to, Some(2));
        assert_eq!(
            msg,
            Message::Binary(Bytes::from_static(&[5, 0, 0, 0, 9, 8]))
        );
        let (to, _) = stamp_binary(Bytes::from_static(&[0, 0, 0, 0]), 5).unwrap();
        assert_eq!(to, None);
        assert!(stamp_binary(Bytes::from_static(&[1, 2, 3]), 5).is_none());
    }
}
