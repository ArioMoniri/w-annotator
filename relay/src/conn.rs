//! One protocol v2 websocket connection: `hello`, the handshake, then a reader
//! that feeds the room and a writer that drains this member's queue.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::auth::{
    b64, random, signing_input, unb64, verify_signature, KEY_LEN, NONCE_LEN, SIG_LEN,
};
use crate::faults::{Faults, Outbound};
use crate::invites::valid_id;
use crate::limits::RateLimit;
use crate::proto::{close, PROTO_VERSION};
use crate::rooms::{
    self, message_len, normalize_room_id, text, ConnCtl, ConnHandle, Exit, Handshake, Role,
    RoomType, SeedMember,
};
use crate::AppState;

/// Counts an open connection for as long as it lives.
struct Slot(AppState);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(crate) async fn connect(
    State(state): State<AppState>,
    Path(room): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Some(room) = normalize_room_id(&room) else {
        return (
            StatusCode::BAD_REQUEST,
            "room id must be 8-32 letters or digits",
        )
            .into_response();
    };
    let Ok(upgrade) = upgrade else {
        return (StatusCode::BAD_REQUEST, "expected a websocket upgrade").into_response();
    };
    if !state.ips.lock().unwrap().allow(peer.ip()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts. Try again in a minute.",
        )
            .into_response();
    }
    let limits = &state.cfg.limits;
    if state.connections.fetch_add(1, Ordering::Relaxed) >= limits.max_connections {
        state.connections.fetch_sub(1, Ordering::Relaxed);
        return (StatusCode::SERVICE_UNAVAILABLE, "The room server is busy.").into_response();
    }
    let slot = Slot(state.clone());
    upgrade
        .max_message_size(limits.max_message_bytes)
        .max_frame_size(limits.max_message_bytes)
        .on_upgrade(move |socket| connection(state, room, socket, slot))
}

async fn refuse(mut socket: WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: Utf8Bytes::from_static(reason),
        })))
        .await;
    // Read until the client answers the close, so the code is not lost to a reset.
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(Ok(_)) = socket.next().await {}
    })
    .await;
}

/// Waits for the first text message, skipping pings.
async fn first_text(socket: &mut WebSocket) -> Option<Utf8Bytes> {
    loop {
        match socket.next().await? {
            Ok(Message::Text(raw)) => return Some(raw),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            _ => return None,
        }
    }
}

type Refused = (u16, &'static str);

const BAD: Refused = (close::BAD_REQUEST, "bad handshake");

fn key_field(msg: &Value, field: &str) -> Result<Option<[u8; KEY_LEN]>, Refused> {
    match msg.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => unb64::<KEY_LEN>(s).map(Some).ok_or(BAD),
        Some(_) => Err(BAD),
    }
}

/// Parses the first client message and checks its signature against this
/// connection's nonce. Nothing here touches room state.
pub(crate) fn parse_handshake(
    raw: &str,
    room_id: &str,
    nonce: &str,
    max_bytes: usize,
    max_members: usize,
) -> Result<Handshake, Refused> {
    if raw.len() > max_bytes {
        return Err(BAD);
    }
    let msg: Value = serde_json::from_str(raw).map_err(|_| BAD)?;
    if !msg.is_object() {
        return Err(BAD);
    }
    match msg.get("proto").and_then(Value::as_u64) {
        Some(v) if v == u64::from(PROTO_VERSION) => {}
        Some(v) if v < u64::from(PROTO_VERSION) => {
            return Err((close::VERSION, "Update W Annotator to join this room"))
        }
        Some(_) => return Err((close::VERSION, "The host is on an older version")),
        None => return Err(BAD),
    }
    let op = match msg.get("t").and_then(Value::as_str) {
        Some(op @ ("create" | "auth" | "redeem")) => op,
        _ => return Err(BAD),
    };
    let key_text = msg.get("key").and_then(Value::as_str).ok_or(BAD)?;
    let key = unb64::<KEY_LEN>(key_text).ok_or(BAD)?;
    let sig = msg
        .get("sig")
        .and_then(Value::as_str)
        .and_then(unb64::<SIG_LEN>)
        .ok_or(BAD)?;
    if !verify_signature(&key, &signing_input(op, room_id, nonce), &sig) {
        return Err((close::NOT_MEMBER, "bad signature"));
    }
    let xkey = key_field(&msg, "xkey")?;
    match op {
        "create" => {
            let kind = msg
                .get("type")
                .and_then(Value::as_str)
                .and_then(RoomType::parse)
                .ok_or(BAD)?;
            let mut members = Vec::new();
            match msg.get("members") {
                None | Some(Value::Null) => {}
                Some(Value::Array(list)) if list.len() < max_members => {
                    for entry in list {
                        let key = key_field(entry, "key")?.ok_or(BAD)?;
                        let xkey = key_field(entry, "xkey")?;
                        let role = match entry
                            .get("role")
                            .and_then(Value::as_str)
                            .and_then(Role::parse)
                        {
                            Some(Role::Host) | None => return Err(BAD),
                            Some(role) => role,
                        };
                        members.push(SeedMember { key, xkey, role });
                    }
                }
                Some(_) => return Err(BAD),
            }
            Ok(Handshake::Create {
                kind,
                key,
                xkey,
                members,
            })
        }
        "auth" => {
            let resume = match msg.get("resume") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_u64().ok_or(BAD)?),
            };
            Ok(Handshake::Auth { key, resume })
        }
        _ => {
            let invite = msg.get("invite").and_then(Value::as_str).ok_or(BAD)?;
            if !valid_id(invite) {
                return Err(BAD);
            }
            let proof = msg
                .get("proof")
                .and_then(Value::as_str)
                .and_then(unb64::<32>)
                .ok_or(BAD)?;
            Ok(Handshake::Redeem {
                key,
                key_text: key_text.to_owned(),
                xkey,
                invite: invite.to_owned(),
                proof,
                nonce: nonce.to_owned(),
            })
        }
    }
}

async fn connection(state: AppState, room_id: String, mut socket: WebSocket, _slot: Slot) {
    let limits = &state.cfg.limits;
    let timing = &state.cfg.timing;
    let mut shutdown = state.shutdown.clone();

    let nonce = b64(&random::<NONCE_LEN>());
    let hello = json!({
        "t": "hello",
        "proto": [PROTO_VERSION, PROTO_VERSION],
        "nonce": nonce,
        "limits": {
            "maxMessage": limits.max_message_bytes,
            "maxControl": limits.max_control_bytes,
            "maxMembers": limits.max_members,
            "messagesPerSec": limits.messages_per_sec,
            "bytesPerSec": limits.bytes_per_sec,
            "queueBytes": limits.queue_bytes,
            "logFrames": limits.log_frames,
            "logBytes": limits.log_bytes,
        },
    });
    if socket.send(text(&hello)).await.is_err() {
        return;
    }
    let first = tokio::select! {
        first = tokio::time::timeout(timing.handshake_timeout, first_text(&mut socket)) => first,
        _ = shutdown.wait_for(|stop| *stop) => return,
    };
    let raw = match first {
        Ok(Some(raw)) => raw,
        Ok(None) => return refuse(socket, close::BAD_REQUEST, "bad handshake").await,
        Err(_) => return refuse(socket, close::BAD_REQUEST, "handshake timed out").await,
    };
    let handshake = match parse_handshake(
        raw.as_str(),
        &room_id,
        &nonce,
        limits.max_handshake_bytes,
        limits.max_members,
    ) {
        Ok(handshake) => handshake,
        Err((code, reason)) => return refuse(socket, code, reason).await,
    };

    let (tx, rx) = mpsc::channel(limits.queue_messages);
    let ctl = Arc::new(ConnCtl::default());
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let conn_id = state.next_conn.fetch_add(1, Ordering::Relaxed);
    let handle = ConnHandle {
        id: conn_id,
        tx,
        queued_bytes: queued_bytes.clone(),
        ctl: ctl.clone(),
        queue_bytes: limits.queue_bytes,
    };
    let entered = match rooms::enter(&state, &room_id, handshake, handle) {
        Ok(entered) => entered,
        Err((code, reason)) => return refuse(socket, code, reason).await,
    };
    let me = entered.member;
    let host_view = entered.kind == RoomType::HostView;
    // Only the host of a view-through-host room is watched closely: the room
    // must end within seconds of losing it. Everyone else gets the slow ping.
    let (ping_every, idle) = if host_view && entered.is_host {
        (timing.host_ping_interval, timing.host_timeout)
    } else {
        (timing.ping_interval, timing.idle_timeout)
    };
    // The host of a view-through-host room answers every guest, so it gets the
    // room's allowance rather than one member's.
    let mut rate = if host_view && entered.is_host {
        RateLimit::new(
            limits.room_messages_per_sec,
            limits.room_bytes_per_sec,
            limits.max_message_bytes,
        )
    } else {
        RateLimit::new(
            limits.messages_per_sec,
            limits.bytes_per_sec,
            limits.max_message_bytes,
        )
    };
    let faults = state.cfg.faults.clone();

    let (sink, mut stream) = socket.split();
    let writer = tokio::spawn(write_loop(Writer {
        sink,
        rx,
        queued_bytes,
        ctl: ctl.clone(),
        ping_every,
        faults: faults.clone(),
        room_id: room_id.clone(),
        member: me,
    }));

    let mut last_heard = Instant::now();
    let exit = loop {
        let frame = tokio::select! {
            frame = tokio::time::timeout_at(last_heard + idle, stream.next()) => frame,
            _ = ctl.kick.notified() => {
                break if ctl.hard.load(Ordering::Relaxed) { Exit::Lost } else { Exit::Closed };
            }
            _ = shutdown.wait_for(|stop| *stop) => break Exit::Closed,
        };
        let msg = match frame {
            Err(_) => break Exit::TimedOut,
            Ok(None) | Ok(Some(Err(_))) => break Exit::Lost,
            Ok(Some(Ok(msg))) => msg,
        };
        if faults.as_ref().is_some_and(|f| f.is_silent(&room_id, me)) {
            // As if the bytes never arrived.
            continue;
        }
        last_heard = Instant::now();
        let over_rate = |rate: &mut RateLimit, len: usize| {
            let over = !rate.allow(len);
            if over {
                ctl.close(close::RATE_LIMITED, "rate limited");
            }
            over
        };
        match msg {
            Message::Close(_) => break Exit::Clean,
            Message::Text(raw) => {
                if over_rate(&mut rate, raw.len()) {
                    break Exit::Closed;
                }
                rooms::control(&state, &room_id, me, conn_id, raw.as_str());
            }
            Message::Binary(data) => {
                if over_rate(&mut rate, data.len()) {
                    break Exit::Closed;
                }
                if faults
                    .as_ref()
                    .is_some_and(|f| f.drops_inbound(&room_id, me))
                {
                    continue;
                }
                rooms::frame(&state, &room_id, me, conn_id, data);
            }
            // Pings are answered by the websocket layer; pongs only reset the timer.
            // Both count towards the rate, like anything else a member sends.
            Message::Ping(data) | Message::Pong(data) => {
                if over_rate(&mut rate, data.len()) {
                    break Exit::Closed;
                }
            }
        }
    };

    rooms::leave(&state, &room_id, me, conn_id, exit);
    let mut writer = writer;
    if ctl.hard.load(Ordering::Relaxed) {
        // Killed by a fault hook: no flush, no close frame.
        writer.abort();
        return;
    }
    // The room dropped the queue's sender, so the writer flushes and closes.
    // Keep reading meanwhile: closing a socket with unread bytes resets it,
    // and the client would never see the close code.
    let drain = async {
        while let Some(Ok(msg)) = stream.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    };
    let finish = async {
        let _ = tokio::join!(&mut writer, drain);
    };
    if tokio::time::timeout(Duration::from_secs(5), finish)
        .await
        .is_err()
    {
        // A peer that will not take its last frames is cut off.
        writer.abort();
    }
}

struct Writer {
    sink: SplitSink<WebSocket, Message>,
    rx: mpsc::Receiver<Message>,
    queued_bytes: Arc<AtomicUsize>,
    ctl: Arc<ConnCtl>,
    ping_every: Duration,
    faults: Option<Faults>,
    room_id: String,
    member: u32,
}

async fn write_loop(mut w: Writer) {
    let mut ping = tokio::time::interval_at(Instant::now() + w.ping_every, w.ping_every);
    // A frame held back by the reorder fault.
    let mut held: Option<Message> = None;
    loop {
        tokio::select! {
            msg = w.rx.recv() => {
                let Some(msg) = msg else { break };
                w.queued_bytes.fetch_sub(message_len(&msg), Ordering::Relaxed);
                let binary = matches!(msg, Message::Binary(_));
                if let Some(faults) = &w.faults {
                    faults.wait_unpaused(&w.room_id).await;
                    match faults.outbound(&w.room_id, w.member, binary, held.is_some()) {
                        Outbound::Pass => {}
                        Outbound::Drop => continue,
                        Outbound::Delay(delay) => tokio::time::sleep(delay).await,
                        Outbound::Hold => {
                            held = Some(msg);
                            continue;
                        }
                    }
                }
                if w.sink.send(msg).await.is_err() {
                    break;
                }
                if binary {
                    if let Some(late) = held.take() {
                        if w.sink.send(late).await.is_err() {
                            break;
                        }
                    }
                }
            }
            _ = ping.tick() => {
                let silent = w.faults.as_ref().is_some_and(|f| f.is_silent(&w.room_id, w.member));
                if !silent && w.sink.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
        }
    }
    if let Some(late) = held.take() {
        let _ = w.sink.send(late).await;
    }
    match w.ctl.close_reason() {
        Some((code, reason)) => {
            let _ = w
                .sink
                .send(Message::Close(Some(CloseFrame {
                    code,
                    reason: Utf8Bytes::from_static(reason),
                })))
                .await;
        }
        None => {
            let _ = w.sink.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "ROOM1234";
    const NONCE: &str = "bm9uY2U";

    fn code(raw: &str) -> u16 {
        match parse_handshake(raw, ROOM, NONCE, 8192, 16) {
            Ok(_) => 0,
            Err((code, _)) => code,
        }
    }

    #[test]
    fn version_is_checked_before_anything_else() {
        assert_eq!(code(r#"{"t":"auth","proto":2}"#), close::VERSION);
        assert_eq!(code(r#"{"t":"auth","proto":4,"key":5}"#), close::VERSION);
        assert_eq!(code(r#"{"t":"auth"}"#), close::BAD_REQUEST);
        assert_eq!(code(r#"{"t":"auth","proto":"3"}"#), close::BAD_REQUEST);
        assert_eq!(code(r#"{"t":"auth","proto":3.5}"#), close::BAD_REQUEST);
        let old = parse_handshake(r#"{"proto":2}"#, ROOM, NONCE, 8192, 16)
            .err()
            .unwrap();
        assert_eq!(old.1, "Update W Annotator to join this room");
        let new = parse_handshake(r#"{"proto":9}"#, ROOM, NONCE, 8192, 16)
            .err()
            .unwrap();
        assert_eq!(new.1, "The host is on an older version");
    }

    #[test]
    fn malformed_handshakes_are_refused_without_panicking() {
        let key = "A".repeat(43);
        let sig = "A".repeat(86);
        let cases = [
            String::new(),
            "null".into(),
            "[]".into(),
            "{".into(),
            "\"auth\"".into(),
            r#"{"proto":3}"#.into(),
            r#"{"proto":3,"t":"join"}"#.into(),
            r#"{"proto":3,"t":"auth"}"#.into(),
            r#"{"proto":3,"t":"auth","key":7,"sig":7}"#.into(),
            r#"{"proto":3,"t":"auth","key":"","sig":""}"#.into(),
            format!(r#"{{"proto":3,"t":"auth","key":"{key}"}}"#),
            format!(r#"{{"proto":3,"t":"auth","key":"{key}=","sig":"{sig}"}}"#),
            format!(
                r#"{{"proto":3,"t":"auth","key":"{}","sig":"{sig}"}}"#,
                "A".repeat(100_000)
            ),
            "\u{0}".repeat(100),
            "{\"proto\":3,\"t\":\"auth\",\"key\":\"".to_owned() + &"é".repeat(43) + "\"}",
        ];
        for raw in &cases {
            let got = code(raw);
            assert_eq!(got, close::BAD_REQUEST, "{raw:.60}");
        }
        // Well-formed but signed by nobody.
        let unsigned = format!(r#"{{"proto":3,"t":"auth","key":"{key}","sig":"{sig}"}}"#);
        assert_eq!(code(&unsigned), close::NOT_MEMBER);
        // Too large is refused before it is parsed.
        let huge = format!(r#"{{"proto":3,"pad":"{}"}}"#, "x".repeat(9000));
        assert_eq!(code(&huge), close::BAD_REQUEST);
    }
}
