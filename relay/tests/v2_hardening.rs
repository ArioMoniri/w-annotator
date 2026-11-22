//! What a member, or a stranger, could do to the relay or through it to another
//! member. One test for each weakness found in the security review of rooms
//! (`docs/reviews/rooms-security.md`).

mod common;

use std::time::Duration;

use common::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

const ROOM: &str = "HARDEN123456";

/// A member that was away for more edits than its queue has places must still
/// get them back. Before, the relay queued the whole log in one go, overflowed
/// the member's own queue and closed it with 4002 — on every attempt.
#[tokio::test]
async fn a_long_replay_does_not_close_the_member_asking_for_it() {
    let relay = TestRelay::start().await;
    let (mut host, mut guests) = relay.room(ROOM, "shared", 1).await;
    let guest = guests.remove(0);
    let me = guest.me.clone();
    drop(guest);
    // More frames than a queue held (1024), fewer than the log keeps (2048).
    let frames = 1500u64;
    for cid in 1..=frames {
        host.send_frame(PATCH, 0, cid, b"edit").await;
        if cid % 100 == 0 {
            // Stay under the per-connection rate.
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
    }
    host.sync().await;

    let mut back = relay.resume(ROOM, &me, 0).await;
    let begin = back.text("replay-begin").await;
    assert_eq!(begin["head"], frames);
    for seq in 1..=frames {
        let (header, payload) = back.frame().await;
        assert_eq!(header.seq, seq);
        assert_eq!(payload, b"edit");
    }
    assert_eq!(back.text("replay-end").await["head"], frames);
}

/// A replay that cannot fit the member's queue is refused as too old, so the
/// client falls back to a snapshot instead of being closed.
#[tokio::test]
async fn a_replay_larger_than_the_queue_is_refused_not_fatal() {
    let relay = TestRelay::with(|c| {
        c.limits.queue_messages = 64;
        c.limits.log_frames = 500;
    })
    .await;
    let (mut host, mut guests) = relay.room(ROOM, "shared", 1).await;
    let mut guest = guests.remove(0);
    for cid in 1..=200u64 {
        host.send_frame(PATCH, 0, cid, b"edit").await;
        if cid % 50 == 0 {
            host.sync().await;
            // Let the guest keep up with the live frames.
            for _ in 0..50 {
                guest.frame().await;
            }
        }
    }
    let reply = guest.request(json!({ "t": "replay", "after": 0 })).await;
    assert_eq!(reply["t"], "error", "{reply}");
    assert_eq!(reply["code"], "replay-too-old");
    // Still connected and still served.
    guest.sync().await;
    // A replay that does fit is given.
    let reply = guest.request(json!({ "t": "replay", "after": 190 })).await;
    assert_eq!(reply["t"], "replay-begin", "{reply}");
}

/// Anyone in a shared-copy room may send file frames to one member. A member
/// that sends them faster than the other can take them must not get the other
/// closed as "too slow": the frames are refused instead, and the sender is told.
#[tokio::test]
async fn flooding_one_member_with_file_frames_does_not_get_them_closed() {
    let relay = TestRelay::with(|c| {
        c.limits.queue_bytes = 4 * 1024 * 1024;
    })
    .await;
    let (mut host, mut guests) = relay.room(ROOM, "shared", 2).await;
    let mut flooder = guests.remove(0);
    let mut victim = guests.remove(0);
    // The victim stops reading, as a slow connection would.
    let slab = vec![7u8; 1024 * 1024];
    let mut refused = 0;
    // Far more than the victim's queue and the sockets in between can hold.
    for cid in 1..=48u64 {
        flooder.send_frame(SYNC_SLAB, victim.id, cid, &slab).await;
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    while let Ok(Some(Ok(msg))) =
        tokio::time::timeout(Duration::from_millis(500), flooder.ws.next()).await
    {
        if let Message::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
            if v["t"] == "error" {
                assert_eq!(v["code"], "busy", "{v}");
                assert_eq!(v["kind"], SYNC_SLAB);
                assert_eq!(v["to"], victim.id);
                refused += 1;
            }
        }
    }
    assert!(refused >= 6, "only {refused} frames were refused");

    // The victim starts reading again: it is still connected and the room still works for it.
    host.send_frame(PATCH, 0, 1, b"edit").await;
    let mut slabs = 0;
    loop {
        let (header, payload) = victim.frame().await;
        if header.kind == SYNC_SLAB {
            slabs += 1;
            continue;
        }
        assert_eq!(header.kind, PATCH);
        assert_eq!(payload, b"edit");
        break;
    }
    // What was queued before the queue was half full did arrive, the rest did not.
    assert!((1..48).contains(&slabs), "{slabs} slabs");
    assert_eq!(slabs + refused, 48);
    victim.sync().await;
}

/// Pings are answered by the websocket layer. They count towards the rate like
/// any message, so a member cannot keep the relay busy with them for free.
#[tokio::test]
async fn pings_count_towards_the_rate() {
    let relay = TestRelay::start().await;
    let (_host, mut guests) = relay.room(ROOM, "shared", 1).await;
    let mut guest = guests.remove(0);
    for _ in 0..600 {
        if guest
            .ws
            .send(Message::Ping(vec![0u8; 100].into()))
            .await
            .is_err()
        {
            break;
        }
    }
    let closed = tokio::time::timeout(WAIT, guest.closed()).await.unwrap();
    assert_eq!(closed.code, 4429);
}

/// A connection that sends nothing, or half a request, is not kept for ever.
#[tokio::test]
async fn a_connection_that_never_finishes_its_request_is_dropped() {
    let relay = TestRelay::with(|c| {
        c.timing.request_timeout = Duration::from_millis(400);
    })
    .await;
    for start in ["", "GET /v2/rooms/HARDEN123456 HTTP/1.1\r\nHost: x\r\n"] {
        let mut s = TcpStream::connect(relay.addr).await.unwrap();
        s.write_all(start.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        // The relay hangs up; without the limit this read would wait for ever.
        let read = tokio::time::timeout(Duration::from_secs(3), s.read_to_end(&mut out)).await;
        assert!(read.is_ok(), "still open after 3 s (sent {start:?})");
    }
    // An ordinary request is still served.
    assert!(relay.http_get("/health").await.ends_with("ok"));
}

/// A websocket that connects and then says nothing is closed after the
/// handshake timeout, and until then holds one of a bounded number of places.
#[tokio::test]
async fn a_silent_websocket_is_closed_after_the_handshake_timeout() {
    let relay = TestRelay::with(|c| {
        c.timing.handshake_timeout = Duration::from_millis(300);
    })
    .await;
    let (mut ws, _hello) = relay.open(ROOM).await;
    match next_event(&mut ws).await {
        Event::Closed(closed) => assert_eq!(closed.code, 4400),
        other => panic!("expected a close, got {other:?}"),
    }
    // Its place is free again once the close has been answered.
    for _ in 0..40 {
        if relay.relay.stats().connections == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the silent connection still holds its place");
}

/// Network input never panics the relay: after every malformed thing a member
/// can send, the relay still serves.
#[tokio::test]
async fn malformed_input_after_sign_in_is_survived() {
    let relay = TestRelay::start().await;
    let (mut host, mut guests) = relay.room(ROOM, "shared", 1).await;
    let mut guest = guests.remove(0);
    let texts = [
        "",
        "null",
        "[]",
        "{",
        "{\"t\":5}",
        "{\"t\":\"replay\"}",
        "{\"t\":\"replay\",\"after\":-1}",
        "{\"t\":\"replay\",\"after\":1e99}",
        "{\"t\":\"replay\",\"after\":18446744073709551615}",
        "{\"t\":\"member-remove\",\"member\":4294967296}",
        "{\"t\":\"invite-add\",\"id\":5}",
        "{\"t\":\"invite-add\",\"ttl\":\"x\"}",
        "{\"t\":\"ping\",\"rid\":{\"a\":[1,2,3]}}",
        "\u{0}\u{1}\u{2}",
    ];
    for raw in texts {
        guest.ws.send(Message::text(raw)).await.unwrap();
        host.ws.send(Message::text(raw)).await.unwrap();
    }
    let frames: [&[u8]; 6] = [&[], &[2], &[2, 1, 0, 0], &[9; 24], &[2; 23], &[0xFF; 64]];
    for raw in frames {
        guest.send_raw(raw.to_vec()).await;
        host.send_raw(raw.to_vec()).await;
    }
    // Every header field at its extreme.
    let mut extreme = vec![0xFFu8; 24];
    extreme[0] = 3;
    for kind in 0..=255u8 {
        extreme[1] = kind;
        guest.send_raw(extreme.clone()).await;
        if kind % 64 == 63 {
            // Stay under the per-connection rate: this test is about content, not volume.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    guest.sync().await;
    host.sync().await;
    assert!(relay.http_get("/health").await.ends_with("ok"));
}
