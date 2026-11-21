//! End-to-end tests: a real server on an ephemeral port and real websocket clients.

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{
    connect_async, connect_async_with_config, MaybeTlsStream, WebSocketStream,
};

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

const WAIT: Duration = Duration::from_secs(5);
const QUIET: Duration = Duration::from_millis(200);

struct Server {
    addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel::<()>();
        // Protocol v1 is off unless a relay is asked to serve it.
        let relay = w_relay::Relay::new(w_relay::RelayConfig {
            v1: true,
            ..Default::default()
        });
        let task = tokio::spawn(async move {
            relay
                .serve(listener, async {
                    let _ = stopped.await;
                })
                .await
        });
        Server {
            addr,
            stop: Some(stop),
            task,
        }
    }

    fn url(&self, room: &str, name: &str) -> String {
        format!("ws://{}/r/{room}?name={name}", self.addr)
    }

    /// Connects and returns the client with its `welcome` message.
    async fn join(&self, room: &str, name: &str) -> (Client, Value) {
        // Lift the client library's own 16 MiB default so large frames can be tested.
        let config = WebSocketConfig::default()
            .max_message_size(Some(w_relay::MAX_MESSAGE_BYTES))
            .max_frame_size(Some(w_relay::MAX_MESSAGE_BYTES));
        let (mut ws, _) = connect_async_with_config(self.url(room, name), Some(config), false)
            .await
            .unwrap();
        let welcome = next_json(&mut ws).await;
        assert_eq!(welcome["t"], "welcome");
        (ws, welcome)
    }
}

async fn next_msg(ws: &mut Client) -> Message {
    loop {
        let msg = tokio::time::timeout(WAIT, ws.next())
            .await
            .expect("timed out waiting for a message")
            .expect("connection closed")
            .expect("websocket error");
        if !matches!(msg, Message::Ping(_) | Message::Pong(_)) {
            return msg;
        }
    }
}

async fn next_json(ws: &mut Client) -> Value {
    match next_msg(ws).await {
        Message::Text(t) => serde_json::from_str(t.as_str()).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

async fn next_binary(ws: &mut Client) -> Vec<u8> {
    match next_msg(ws).await {
        Message::Binary(b) => b.to_vec(),
        other => panic!("expected binary, got {other:?}"),
    }
}

/// Asserts that nothing but pings arrives for a short while.
async fn assert_quiet(ws: &mut Client) {
    let deadline = tokio::time::Instant::now() + QUIET;
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Err(_) => return,
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            Ok(other) => panic!("expected silence, got {other:?}"),
        }
    }
}

async fn send_json(ws: &mut Client, v: Value) {
    ws.send(Message::text(v.to_string())).await.unwrap();
}

async fn http_get(addr: SocketAddr, path: &str) -> String {
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut out = String::new();
    tokio::time::timeout(WAIT, s.read_to_string(&mut out))
        .await
        .unwrap()
        .unwrap();
    out
}

#[tokio::test]
async fn health_returns_ok() {
    let server = Server::start().await;
    let res = http_get(server.addr, "/health").await;
    assert!(res.starts_with("HTTP/1.1 200"), "{res}");
    assert!(res.ends_with("ok"), "{res}");
}

#[tokio::test]
async fn welcome_join_and_leave() {
    let server = Server::start().await;

    let (mut a, welcome_a) = server.join("ROOM1", "Ada%20L").await;
    assert_eq!(welcome_a, json!({ "t": "welcome", "id": 1, "peers": [] }));

    // Room codes are case-insensitive.
    let (mut b, welcome_b) = server.join("room1", "Bo").await;
    assert_eq!(
        welcome_b,
        json!({ "t": "welcome", "id": 2, "peers": [{ "id": 1, "name": "Ada L" }] })
    );
    assert_eq!(
        next_json(&mut a).await,
        json!({ "t": "join", "id": 2, "name": "Bo" })
    );

    b.close(None).await.unwrap();
    assert_eq!(next_json(&mut a).await, json!({ "t": "leave", "id": 2 }));

    // Ids are not reused while the room lives.
    let (_c, welcome_c) = server.join("Room1", "").await;
    assert_eq!(welcome_c["id"], 3);
    assert_eq!(
        next_json(&mut a).await,
        json!({ "t": "join", "id": 3, "name": "Guest" })
    );
}

#[tokio::test]
async fn a_dropped_connection_counts_as_leaving() {
    let server = Server::start().await;
    let (mut a, _) = server.join("DROP", "a").await;
    let (b, _) = server.join("DROP", "b").await;
    next_json(&mut a).await; // join
    drop(b);
    assert_eq!(next_json(&mut a).await, json!({ "t": "leave", "id": 2 }));
}

#[tokio::test]
async fn names_are_trimmed_to_forty_characters() {
    let server = Server::start().await;
    let (mut a, _) = server.join("NAMES", "a").await;
    let long = "x".repeat(60);
    let (_b, _) = server.join("NAMES", &format!("%20%20{long}")).await;
    let join = next_json(&mut a).await;
    assert_eq!(join["name"], "x".repeat(40));
}

#[tokio::test]
async fn text_is_broadcast_or_targeted_and_stamped_with_from() {
    let server = Server::start().await;
    let (mut a, _) = server.join("TEXT", "a").await;
    let (mut b, _) = server.join("TEXT", "b").await;
    let (mut c, _) = server.join("TEXT", "c").await;
    next_json(&mut a).await; // join b
    next_json(&mut a).await; // join c
    next_json(&mut b).await; // join c

    // Broadcast: everyone but the sender, with a forged `from` overwritten.
    send_json(&mut a, json!({ "t": "edit", "from": 99, "v": [1, 2] })).await;
    let expected = json!({ "t": "edit", "from": 1, "v": [1, 2] });
    assert_eq!(next_json(&mut b).await, expected);
    assert_eq!(next_json(&mut c).await, expected);
    assert_quiet(&mut a).await;

    // Targeted: only peer 3.
    send_json(&mut a, json!({ "t": "sync", "to": 3 })).await;
    assert_eq!(
        next_json(&mut c).await,
        json!({ "t": "sync", "to": 3, "from": 1 })
    );
    assert_quiet(&mut b).await;

    // Non-object JSON and non-JSON are ignored, and the connection survives.
    a.send(Message::text("[1,2,3]")).await.unwrap();
    a.send(Message::text("hello")).await.unwrap();
    send_json(&mut a, json!({ "t": "after" })).await;
    assert_eq!(next_json(&mut b).await, json!({ "t": "after", "from": 1 }));
    assert_eq!(next_json(&mut c).await, json!({ "t": "after", "from": 1 }));
}

#[tokio::test]
async fn binary_header_is_rewritten_with_the_sender_id() {
    let server = Server::start().await;
    let (mut a, _) = server.join("BYTES", "a").await;
    let (mut b, _) = server.join("BYTES", "b").await;
    let (mut c, _) = server.join("BYTES", "c").await;
    next_json(&mut a).await;
    next_json(&mut a).await;
    next_json(&mut b).await;

    // Target 0: everyone else.
    let mut frame = 0u32.to_le_bytes().to_vec();
    frame.extend_from_slice(b"mask");
    b.send(Message::binary(frame)).await.unwrap();
    let mut expected = 2u32.to_le_bytes().to_vec();
    expected.extend_from_slice(b"mask");
    assert_eq!(next_binary(&mut a).await, expected);
    assert_eq!(next_binary(&mut c).await, expected);
    assert_quiet(&mut b).await;

    // Target 1: only peer 1.
    let mut frame = 1u32.to_le_bytes().to_vec();
    frame.extend_from_slice(&[7, 7]);
    c.send(Message::binary(frame)).await.unwrap();
    assert_eq!(next_binary(&mut a).await, [3, 0, 0, 0, 7, 7]);
    assert_quiet(&mut b).await;

    // Too short to carry a header: ignored.
    c.send(Message::binary(vec![1u8, 2, 3])).await.unwrap();
    assert_quiet(&mut a).await;
}

#[tokio::test]
async fn a_large_binary_frame_gets_through() {
    let server = Server::start().await;
    let (mut a, _) = server.join("LARGE", "a").await;
    let (mut b, _) = server.join("LARGE", "b").await;
    next_json(&mut a).await;

    let mut frame = vec![0u8; 20 * 1024 * 1024];
    frame[4..8].copy_from_slice(&[1, 2, 3, 4]);
    a.send(Message::binary(frame)).await.unwrap();
    let got = tokio::time::timeout(Duration::from_secs(30), next_binary(&mut b))
        .await
        .unwrap();
    assert_eq!(got.len(), 20 * 1024 * 1024);
    assert_eq!(&got[..8], &[1, 0, 0, 0, 1, 2, 3, 4]);
}

#[tokio::test]
async fn rooms_are_isolated() {
    let server = Server::start().await;
    let (mut a, _) = server.join("AAAA", "a").await;
    let (mut b, welcome_b) = server.join("BBBB", "b").await;
    // Each room numbers its own peers and does not see the other.
    assert_eq!(welcome_b, json!({ "t": "welcome", "id": 1, "peers": [] }));
    assert_quiet(&mut a).await;

    send_json(&mut a, json!({ "t": "edit" })).await;
    a.send(Message::binary(vec![0u8, 0, 0, 0, 1]))
        .await
        .unwrap();
    assert_quiet(&mut b).await;
}

#[tokio::test]
async fn an_empty_room_is_dropped_and_starts_over() {
    let server = Server::start().await;
    let (mut a, _) = server.join("FRESH", "a").await;
    let (mut b, _) = server.join("FRESH", "b").await;
    a.close(None).await.unwrap();
    assert_eq!(next_json(&mut b).await, json!({ "t": "leave", "id": 1 }));
    b.close(None).await.unwrap();
    // Wait for the server to see both closes.
    while let Some(Ok(_)) = b.next().await {}
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (_c, welcome) = server.join("FRESH", "c").await;
    assert_eq!(welcome, json!({ "t": "welcome", "id": 1, "peers": [] }));
}

#[tokio::test]
async fn the_seventeenth_peer_is_told_the_room_is_full() {
    let server = Server::start().await;
    let mut peers = Vec::new();
    for i in 0..16 {
        peers.push(server.join("FULL", &format!("p{i}")).await.0);
    }
    let (mut late, _) = connect_async(server.url("FULL", "late")).await.unwrap();
    match next_msg(&mut late).await {
        Message::Close(Some(frame)) => {
            assert_eq!(u16::from(frame.code), 4001);
            assert_eq!(frame.reason.as_str(), "room full");
        }
        other => panic!("expected close 4001, got {other:?}"),
    }
    // Nobody in the room hears about the rejected peer.
    for _ in 0..15 {
        next_json(&mut peers[0]).await; // joins of peers 2..=16
    }
    assert_quiet(&mut peers[0]).await;

    // A seat frees up once someone leaves.
    peers.pop().unwrap().close(None).await.unwrap();
    assert_eq!(
        next_json(&mut peers[0]).await,
        json!({ "t": "leave", "id": 16 })
    );
    let (_ok, welcome) = server.join("FULL", "again").await;
    assert_eq!(welcome["id"], 17);
}

#[tokio::test]
async fn bad_room_names_get_http_400() {
    let server = Server::start().await;
    for room in ["abc", "abcdefghijklmnopq", "ab-cd", "ab%20cd"] {
        match connect_async(server.url(room, "x")).await {
            Err(tungstenite::Error::Http(res)) => assert_eq!(res.status(), 400, "room {room}"),
            other => panic!("room {room}: expected HTTP 400, got {other:?}"),
        }
    }
    // A plain GET on a valid room is not a websocket request.
    let res = http_get(server.addr, "/r/ABCD").await;
    assert!(res.starts_with("HTTP/1.1 400"), "{res}");
}

#[tokio::test]
async fn shutdown_closes_connections_and_returns() {
    let mut server = Server::start().await;
    let (mut a, _) = server.join("STOP", "a").await;
    server.stop.take().unwrap().send(()).unwrap();
    let ended = tokio::time::timeout(WAIT, async {
        loop {
            match a.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "client was not disconnected");
    let result = tokio::time::timeout(WAIT, &mut server.task)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_ok());
}

#[tokio::test]
async fn a_peer_that_stops_reading_is_dropped_without_stalling_the_room() {
    let server = Server::start().await;
    let (mut a, _) = server.join("SLOW", "a").await;
    let (_stalled, _) = server.join("SLOW", "stalled").await; // never reads again
    let (mut c, _) = server.join("SLOW", "c").await;
    next_json(&mut a).await; // join 2
    next_json(&mut a).await; // join 3

    // The healthy peer keeps reading and counts what it gets.
    let reader = tokio::spawn(async move {
        let mut frames = 0u32;
        loop {
            match next_msg(&mut c).await {
                Message::Binary(_) => frames += 1,
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    assert_eq!(v, json!({ "t": "leave", "id": 2 }));
                    return frames;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
    });

    // Flood until the relay gives up on the stalled peer and says so.
    let (mut a_tx, mut a_rx) = a.split();
    let saw_leave = tokio::spawn(async move {
        loop {
            match a_rx.next().await.unwrap().unwrap() {
                Message::Text(t) => return serde_json::from_str::<Value>(t.as_str()).unwrap(),
                Message::Ping(_) | Message::Pong(_) => {}
                other => panic!("unexpected {other:?}"),
            }
        }
    });
    let frame = vec![0u8; 256 * 1024];
    let mut sent = 0u32;
    while !saw_leave.is_finished() {
        a_tx.send(Message::binary(frame.clone())).await.unwrap();
        sent += 1;
        assert!(sent < 20_000, "the stalled peer was never dropped");
    }
    let left = saw_leave.await.unwrap();
    assert_eq!(left, json!({ "t": "leave", "id": 2 }));
    let delivered = tokio::time::timeout(Duration::from_secs(30), reader)
        .await
        .unwrap()
        .unwrap();
    assert!(
        delivered > 0,
        "the healthy peer got nothing while one was stalled"
    );
}
