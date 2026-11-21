//! Protocol v2 skeleton: connect, version negotiation, the binary header,
//! close codes, malformed input, and v1 next to v2.

mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use w_relay::proto::Header;

#[tokio::test]
async fn hello_announces_the_protocol_range_a_fresh_nonce_and_the_limits() {
    let relay = TestRelay::start().await;
    let (_a, hello_a) = relay.open("HELLO123").await;
    let (_b, hello_b) = relay.open("HELLO123").await;
    assert_eq!(hello_a["proto"], json!([2, 2]));
    let nonce = hello_a["nonce"].as_str().unwrap();
    assert_eq!(nonce.len(), 43, "32 bytes of unpadded base64url");
    assert_ne!(hello_a["nonce"], hello_b["nonce"]);
    assert_eq!(
        hello_a["limits"],
        json!({
            "maxMessage": 2 * 1024 * 1024,
            "maxControl": 16 * 1024,
            "maxMembers": 16,
            "messagesPerSec": 200,
            "bytesPerSec": 20 * 1024 * 1024,
            "queueBytes": 16 * 1024 * 1024,
            "logFrames": 2048,
            "logBytes": 8 * 1024 * 1024,
        })
    );
}

#[tokio::test]
async fn create_answers_with_a_welcome_that_describes_the_room_and_the_host() {
    let relay = TestRelay::start().await;
    let me = Identity::new();
    let host = relay.try_create("made0001", "shared", &me).await.unwrap();
    let w = &host.welcome;
    assert_eq!(w["self"], json!({ "id": me.id(), "role": "host" }));
    assert_eq!(w["room"]["id"], "MADE0001");
    assert_eq!(w["room"]["type"], "shared");
    assert_eq!(w["room"]["state"], "active");
    assert_eq!(w["room"]["proto"], 2);
    assert_eq!(w["room"]["epoch"], 1);
    assert_eq!(w["room"]["head"], 0);
    assert_eq!(w["room"]["logFloor"], 0);
    assert!(w["room"]["session"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(
        w["roster"],
        json!([{ "id": me.id(), "key": me.key(), "xkey": null, "role": "host", "online": true }])
    );
    assert!(w.get("invite").is_none());

    let other = relay.create("MADE0002", "host-view").await;
    assert_eq!(other.welcome["room"]["type"], "host-view");
}

#[tokio::test]
async fn a_wrong_protocol_number_is_closed_with_4426_and_the_text_to_show() {
    let relay = TestRelay::start().await;
    relay.create("VERSION1", "shared").await;
    let me = Identity::new();
    for (proto, text) in [
        (1, "Update W Annotator to join this room"),
        (3, "The host is on an older version"),
    ] {
        let closed = relay
            .handshake("VERSION1", &me, |nonce| {
                json!({ "t": "auth", "proto": proto, "key": me.key(), "sig": me.sign("auth", "VERSION1", nonce) })
            })
            .await
            .err()
            .unwrap();
        assert_eq!(
            closed,
            Closed {
                code: 4426,
                reason: text.into()
            }
        );
    }
}

#[tokio::test]
async fn malformed_handshakes_are_closed_with_4400() {
    let relay = TestRelay::start().await;
    let me = Identity::new();
    let long = "x".repeat(20_000);
    let texts = [
        "",
        "not json",
        "[1,2,3]",
        r#"{"t":"auth"}"#,
        r#"{"t":"nope","proto":2}"#,
        r#"{"t":"auth","proto":2,"key":"short","sig":"short"}"#,
        r#"{"t":"create","proto":2,"type":"shared"}"#,
        long.as_str(),
    ];
    for text in texts {
        let (mut ws, _) = relay.open("MALFORM1").await;
        ws.send(Message::text(text)).await.unwrap();
        match next_event(&mut ws).await {
            Event::Closed(c) => assert_eq!(c.code, 4400, "{text:.40}"),
            other => panic!("{text:.40}: {other:?}"),
        }
    }
    // A binary frame is not a handshake.
    let (mut ws, _) = relay.open("MALFORM1").await;
    ws.send(Message::binary(encode_frame(PATCH, 0, 1, b"x")))
        .await
        .unwrap();
    assert!(matches!(next_event(&mut ws).await, Event::Closed(c) if c.code == 4400));
    // A create with an unknown room type, properly signed.
    let closed = relay
        .try_create("MALFORM1", "public", &me)
        .await
        .err()
        .unwrap();
    assert_eq!(closed.code, 4400);
    // None of that made a room.
    assert_eq!(relay.relay.stats().rooms, 0);
}

#[tokio::test]
async fn a_connection_that_never_sends_its_handshake_is_closed() {
    let relay = TestRelay::with(|c| {
        c.timing.handshake_timeout = std::time::Duration::from_millis(150);
    })
    .await;
    let (mut ws, _) = relay.open("SILENT01").await;
    match next_event(&mut ws).await {
        Event::Closed(c) => assert_eq!(
            c,
            Closed {
                code: 4400,
                reason: "handshake timed out".into()
            }
        ),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn bad_room_ids_and_plain_requests_get_http_400() {
    let relay = TestRelay::start().await;
    let too_long = "A".repeat(33);
    for room in ["short", "has-dash1", "sp%20ace12", too_long.as_str()] {
        assert_eq!(
            http_status(connect_async(relay.url(room)).await),
            400,
            "{room}"
        );
    }
    let res = relay.http_get("/v2/rooms/ABCDEFGH").await;
    assert!(res.starts_with("HTTP/1.1 400"), "{res}");
}

#[tokio::test]
async fn sign_in_fails_for_a_missing_room_and_create_for_a_taken_one() {
    let relay = TestRelay::start().await;
    let me = Identity::new();
    let closed = relay.try_auth("NOSUCH01", &me).await.err().unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4404,
            reason: "no such room".into()
        }
    );

    let _host = relay.try_create("TAKEN001", "shared", &me).await.unwrap();
    // Even the host cannot create it twice; it signs in instead.
    let closed = relay
        .try_create("taken001", "shared", &me)
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4409,
            reason: "room id taken".into()
        }
    );
}

#[tokio::test]
async fn frames_keep_flags_and_payload_and_get_the_sender_stamped() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("HEADER01", "shared", 1).await;
    let guest = &mut members[0];

    let sent = Header {
        version: 2,
        kind: PRESENCE,
        flags: 0xBEEF,
        from: 0xDEAD_BEEF, // a forged sender is overwritten
        to: 0,
        seq: 77,
        epoch: 1,
    };
    let mut bytes = sent.encode().to_vec();
    bytes.extend_from_slice(b"cursor");
    guest.send_raw(bytes).await;

    let (header, payload) = host.frame().await;
    assert_eq!(
        header,
        Header {
            from: guest.id,
            ..sent
        },
        "only `from` changes on an unordered frame"
    );
    assert_eq!(payload, b"cursor");
}

#[tokio::test]
async fn unknown_frame_kinds_and_message_types_are_ignored_not_fatal() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("UNKNOWN1", "shared", 1).await;
    let guest = &mut members[0];

    for kind in [0u8, 10, 99, 255] {
        guest.send_frame(kind, 0, 1, b"from the future").await;
    }
    guest
        .send_json(json!({ "t": "something-new", "x": 1 }))
        .await;
    guest.sync().await;
    host.no_frames().await;
    // No error either: unknown is simply not ours to judge.
    assert!(tokio::time::timeout(QUIET, guest.event()).await.is_err());

    guest.send_frame(PATCH, 0, 2, b"still here").await;
    assert_eq!(host.frame().await.1, b"still here");
}

#[tokio::test]
async fn malformed_frames_get_an_error_and_never_take_the_room_down() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("FUZZ0001", "shared", 1).await;
    let guest = &mut members[0];

    // Truncated headers, one for every length below 24.
    let good = encode_frame(PATCH, 0, 1, b"");
    for len in 0..good.len() {
        guest.send_raw(good[..len].to_vec()).await;
        assert_eq!(
            guest.text("error").await["code"],
            "bad-frame",
            "length {len}"
        );
    }
    // Wrong versions, including v1's layout (a little-endian target id first).
    for version in [0u8, 1, 3, 200] {
        let mut frame = good.clone();
        frame[0] = version;
        guest.send_raw(frame).await;
        assert_eq!(guest.text("error").await["code"], "bad-version");
    }
    // A wrong epoch.
    let mut frame = encode_frame(PATCH, 0, 9, b"old key");
    frame[20..24].copy_from_slice(&7u32.to_le_bytes());
    guest.send_raw(frame).await;
    let error = guest.text("error").await;
    assert_eq!(
        error,
        json!({ "t": "error", "code": "bad-epoch", "kind": 1, "cid": 9 })
    );

    // Pseudo-random garbage of many lengths. Whatever the relay makes of each
    // one, it must still be standing afterwards.
    let mut x: u32 = 0x1234_5678;
    for i in 0..300usize {
        let len = (i * 7) % 96;
        let bytes: Vec<u8> = (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        guest.send_raw(bytes).await;
        if i % 100 == 99 {
            // Stay under the per-connection message rate.
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        }
    }
    // Text that is not a JSON object.
    for text in ["", "null", "[]", "{", "\"t\""] {
        guest.ws.send(Message::text(text)).await.unwrap();
    }
    guest.send_json(json!({ "no": "type" })).await;
    guest.sync().await;
    host.drain().await;
    guest.drain().await;

    // The room still works in both directions.
    guest.send_frame(PATCH, 0, 5, b"after the storm").await;
    let ack = guest.text("ack").await;
    assert_eq!(ack["cid"], 5);
    let (header, payload) = host.frame().await;
    assert_eq!(payload, b"after the storm");
    assert_eq!(header.seq, ack["seq"].as_u64().unwrap());
}

#[tokio::test]
async fn an_oversized_message_ends_that_connection_only() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("TOOBIG01", "shared", 2).await;
    let (first, rest) = members.split_first_mut().unwrap();
    let second = &mut rest[0];

    // Just over the 2 MiB limit: the websocket layer refuses to read it.
    let _ = first
        .ws
        .send(Message::binary(encode_frame(
            SYNC_SLAB,
            second.id,
            1,
            &vec![0u8; 2 * 1024 * 1024],
        )))
        .await;
    let closed = first.closed().await;
    assert_ne!(closed.code, 1000);
    second.no_frames().await;
    assert_eq!(
        host.text("presence").await,
        json!({ "t": "presence", "member": first.id, "online": false })
    );

    // Exactly at the limit goes through.
    let payload = vec![7u8; 2 * 1024 * 1024 - 24];
    host.send_frame(SYNC_SLAB, second.id, 2, &payload).await;
    let (header, got) = second.frame().await;
    assert_eq!(
        (header.kind, header.from, got.len()),
        (SYNC_SLAB, host.id, payload.len())
    );

    // A control message over 16 KiB is refused, the connection stays.
    host.send_json(json!({ "t": "ping", "pad": "x".repeat(17_000) }))
        .await;
    assert_eq!(host.text("error").await["code"], "too-large");
    host.sync().await;
}

#[tokio::test]
async fn ping_is_answered_with_pong_and_the_request_id() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("PINGPONG", "shared").await;
    host.send_json(json!({ "t": "ping", "rid": "abc" })).await;
    assert_eq!(
        host.text("pong").await,
        json!({ "t": "pong", "rid": "abc" })
    );
    host.send_json(json!({ "t": "ping", "rid": 12 })).await;
    assert_eq!(host.text("pong").await, json!({ "t": "pong", "rid": 12 }));
    // A request id that is neither a number nor a short string is not echoed.
    host.send_json(json!({ "t": "ping", "rid": { "a": 1 } }))
        .await;
    assert_eq!(host.text("pong").await, json!({ "t": "pong" }));
}

#[tokio::test]
async fn v1_and_v2_rooms_live_side_by_side_on_one_relay() {
    let relay = TestRelay::with(|c| c.v1 = true).await;
    // Same characters as a v1 code and as a v2 room id: two different rooms.
    let room = "MIXED123";
    let v1_url = |name: &str| format!("ws://{}/r/{room}?name={name}", relay.addr);
    let (mut old_a, _) = connect_async(v1_url("Ada")).await.unwrap();
    let (mut old_b, _) = connect_async(v1_url("Bo")).await.unwrap();
    let v1_json = |msg: Message| -> Value {
        match msg {
            Message::Text(t) => serde_json::from_str(t.as_str()).unwrap(),
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(
        v1_json(old_a.next().await.unwrap().unwrap()),
        json!({ "t": "welcome", "id": 1, "peers": [] })
    );
    assert_eq!(
        v1_json(old_b.next().await.unwrap().unwrap()),
        json!({ "t": "welcome", "id": 2, "peers": [{ "id": 1, "name": "Ada" }] })
    );
    assert_eq!(
        v1_json(old_a.next().await.unwrap().unwrap()),
        json!({ "t": "join", "id": 2, "name": "Bo" })
    );

    let (mut host, mut members) = relay.room(room, "shared", 1).await;
    let guest = &mut members[0];

    // v1 traffic stays in v1, in v1's format.
    old_a
        .send(Message::text(r#"{"t":"cursor"}"#))
        .await
        .unwrap();
    let mut v1_frame = 0u32.to_le_bytes().to_vec();
    v1_frame.extend_from_slice(&[1, 9, 9]);
    old_a.send(Message::binary(v1_frame)).await.unwrap();
    assert_eq!(
        v1_json(old_b.next().await.unwrap().unwrap()),
        json!({ "t": "cursor", "from": 1 })
    );
    assert_eq!(
        old_b.next().await.unwrap().unwrap(),
        Message::binary(vec![1u8, 0, 0, 0, 1, 9, 9])
    );

    // v2 traffic stays in v2.
    host.send_frame(PATCH, 0, 1, b"v2 patch").await;
    assert_eq!(
        host.text("ack").await,
        json!({ "t": "ack", "cid": 1, "seq": 1 })
    );
    assert_eq!(guest.frame().await.1, b"v2 patch");

    // Neither side heard the other.
    host.no_frames().await;
    guest.no_frames().await;
    assert!(tokio::time::timeout(QUIET, old_b.next()).await.is_err());

    let stats = relay.relay.stats();
    assert_eq!((stats.v1_rooms, stats.rooms, stats.connections), (1, 1, 2));
    assert!(relay.http_get("/health").await.ends_with("ok"));
}

#[tokio::test]
async fn v1_is_off_by_default_and_then_answers_426() {
    let relay = TestRelay::start().await;
    let url = format!("ws://{}/r/ABCDEF?name=x", relay.addr);
    assert_eq!(http_status(connect_async(url).await), 426);
    let res = relay.http_get("/r/ABCDEF").await;
    assert!(
        res.ends_with("Update W Annotator to join this room"),
        "{res}"
    );
    // v2 is unaffected.
    relay.create("STILLV2A", "shared").await;
}

#[tokio::test]
async fn the_invite_page_is_static_and_tells_nothing_about_rooms() {
    let relay = TestRelay::start().await;
    relay.create("PAGE0001", "shared").await;
    let real = relay.http_get("/j/PAGE0001").await;
    let unknown = relay.http_get("/j/NOTAROOM").await;
    assert!(real.starts_with("HTTP/1.1 200"), "{real}");
    let body = |res: &str| res.split("\r\n\r\n").nth(1).unwrap().to_owned();
    assert_eq!(body(&real), body(&unknown));
    assert!(body(&real).contains("Open W Annotator, choose Join a room and paste this link."));
    assert!(!body(&real).contains("PAGE0001"));
    let lower = real.to_ascii_lowercase();
    assert!(lower.contains("cache-control: no-store"));
    assert!(lower.contains("referrer-policy: no-referrer"));
    assert!(lower.contains("content-security-policy: default-src 'none'"));
    assert!(relay.http_get("/j/x").await.starts_with("HTTP/1.1 404"));
    assert!(relay
        .http_get("/j/%3Cscript%3E")
        .await
        .starts_with("HTTP/1.1 404"));
}

#[tokio::test]
async fn shutdown_closes_v2_connections_and_returns() {
    let mut relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("STOP0001", "host-view", 1).await;
    let (_pending, _) = relay.open("STOP0001").await; // connected, not signed in
    relay.stop.take().unwrap().send(()).unwrap();
    // Everyone is let go; a shutdown is not "host lost" or "room closed".
    assert_ne!(host.closed().await.code, 4410);
    assert_ne!(members[0].closed().await.code, 4410);
    let result = tokio::time::timeout(WAIT, &mut relay.task)
        .await
        .expect("the relay did not stop")
        .unwrap();
    assert!(result.is_ok());
}
