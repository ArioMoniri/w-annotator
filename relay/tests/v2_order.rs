//! Total order for edits: sequence numbers, acks, the replay log, and the
//! unordered frame classes in a shared-copy room.

mod common;

use std::collections::BTreeMap;

use common::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use w_relay::proto::Header;

/// Everything one client learns about the order: its own acks and others' frames.
async fn collect(client: Client, expect: usize) -> (u32, Vec<(u64, u32, Vec<u8>)>) {
    let mut seen: Vec<(u64, u32, Vec<u8>)> = Vec::new();
    let mut sent: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
    for cid in 0..50u64 {
        sent.insert(cid, format!("{}:{cid}", client.id).into_bytes());
    }
    let (mut tx, mut rx) = client.ws.split();
    let to_send: Vec<Vec<u8>> = sent
        .iter()
        .map(|(cid, payload)| {
            encode_frame(if cid % 5 == 0 { SEG_OP } else { PATCH }, 0, *cid, payload)
        })
        .collect();
    let sender = tokio::spawn(async move {
        for (i, frame) in to_send.into_iter().enumerate() {
            tx.send(Message::binary(frame)).await.unwrap();
            if i % 7 == 0 {
                tokio::task::yield_now().await;
            }
        }
        tx
    });
    let mut last = 0u64;
    while seen.len() < expect {
        let msg = tokio::time::timeout(WAIT, rx.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let (seq, from, payload) = match msg {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                assert_eq!(v["t"], "ack", "{v}");
                let cid = v["cid"].as_u64().unwrap();
                (v["seq"].as_u64().unwrap(), client.id, sent[&cid].clone())
            }
            Message::Binary(b) => {
                let header = Header::parse(&b).unwrap();
                assert_eq!(header.to, 0);
                (header.seq, header.from, b[24..].to_vec())
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("{other:?}"),
        };
        // Acks and other members' frames interleave in sequence order.
        assert!(seq > last, "seq {seq} after {last}");
        last = seq;
        seen.push((seq, from, payload));
    }
    let _tx = sender.await.unwrap();
    (client.id, seen)
}

#[tokio::test]
async fn three_concurrent_senders_all_see_the_same_sequence() {
    let relay = TestRelay::start().await;
    let (host, mut members) = relay.room("ORDER001", "shared", 2).await;
    let b = members.pop().unwrap();
    let a = members.pop().unwrap();
    let ids = [host.id, a.id, b.id];

    let (one, two, three) = tokio::join!(
        tokio::spawn(collect(host, 150)),
        tokio::spawn(collect(a, 150)),
        tokio::spawn(collect(b, 150)),
    );
    let views = [one.unwrap(), two.unwrap(), three.unwrap()];

    let reference = &views[0].1;
    let seqs: Vec<u64> = reference.iter().map(|(seq, _, _)| *seq).collect();
    assert_eq!(seqs, (1..=150).collect::<Vec<u64>>(), "gapless from 1");
    for (id, view) in &views {
        assert_eq!(view, reference, "member {id} saw a different order");
    }
    // Every sender's own frames keep the order they were sent in.
    for id in ids {
        let own: Vec<&Vec<u8>> = reference
            .iter()
            .filter(|(_, from, _)| *from == id)
            .map(|(_, _, payload)| payload)
            .collect();
        let expected: Vec<Vec<u8>> = (0..50)
            .map(|cid| format!("{id}:{cid}").into_bytes())
            .collect();
        assert_eq!(own, expected.iter().collect::<Vec<_>>());
    }
}

#[tokio::test]
async fn an_edit_is_acked_to_its_sender_and_stamped_for_everyone_else() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("ORDER002", "shared", 2).await;
    let (a, rest) = members.split_first_mut().unwrap();
    let b = &mut rest[0];

    // The client's op id travels in the seq field and comes back in the ack.
    let cid = 9_007_199_254_740_991u64; // 2^53 - 1, the largest a JSON client should use
    a.send_frame(PATCH, 0, cid, b"first").await;
    assert_eq!(
        a.text("ack").await,
        json!({ "t": "ack", "cid": cid, "seq": 1 })
    );
    for other in [&mut host, &mut *b] {
        let (header, payload) = other.frame().await;
        assert_eq!(
            header,
            Header {
                version: 3,
                kind: PATCH,
                flags: 0,
                from: a.id,
                to: 0,
                seq: 1,
                epoch: 1
            }
        );
        assert_eq!(payload, b"first");
    }
    // The sender does not get its own frame back.
    a.no_frames().await;

    // An edit goes to everyone even if it names a target, and a seg-op shares the sequence.
    host.send_frame(SEG_OP, b.id, 1, b"rename").await;
    assert_eq!(host.text("ack").await["seq"], 2);
    let (header, _) = a.frame().await;
    assert_eq!(
        (header.kind, header.seq, header.to, header.from),
        (SEG_OP, 2, 0, host.id)
    );
    assert_eq!(b.frame().await.0.seq, 2);
}

#[tokio::test]
async fn unordered_frames_get_no_sequence_number_and_no_ack() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("ORDER003", "shared", 2).await;
    let (a, rest) = members.split_first_mut().unwrap();
    let b = &mut rest[0];

    // Presence to everyone: the seq field is passed through as the sender set it.
    a.send_frame(PRESENCE, 0, 42, b"cursor").await;
    assert_eq!(host.frame().await.0.seq, 42);
    assert_eq!(b.frame().await.0.seq, 42);

    // File-class frames go to exactly one member.
    a.send_frame(SYNC_REQUEST, host.id, 7, b"base 0").await;
    let (header, payload) = host.frame().await;
    assert_eq!(
        (header.kind, header.from, header.to, header.seq),
        (SYNC_REQUEST, a.id, host.id, 7)
    );
    assert_eq!(payload, b"base 0");
    host.send_frame(SYNC_SLAB, a.id, 7, b"slab 0").await;
    host.send_frame(IMAGE_SLAB, a.id, 8, b"image 0").await;
    assert_eq!(a.frame().await.0.kind, SYNC_SLAB);
    assert_eq!(a.frame().await.0.kind, IMAGE_SLAB);
    b.no_frames().await;

    // Without a target they are refused; to someone offline the sender is told.
    for kind in [SYNC_REQUEST, SYNC_SLAB, IMAGE_SLAB, KEY] {
        host.send_frame(kind, 0, 3, b"to whom?").await;
        assert_eq!(
            host.text("error").await,
            json!({ "t": "error", "code": "needs-recipient", "kind": kind, "cid": 3 })
        );
    }
    host.send_frame(SYNC_SLAB, 123_456, 4, b"nobody").await;
    assert_eq!(
        host.text("error").await,
        json!({ "t": "error", "code": "offline", "kind": SYNC_SLAB, "cid": 4, "to": 123_456 })
    );
    // Keys travel between any two members of a shared-copy room (protocol 3).
    host.send_frame(KEY, a.id, 5, b"wrapped").await;
    assert_eq!(a.frame().await.0.kind, KEY);
    a.send_frame(KEY, b.id, 6, b"passed on").await;
    assert_eq!(b.frame().await.0.from, a.id);
    // Slice frames belong to the other room type.
    a.send_frame(SLICE_REQUEST, host.id, 1, b"z=3").await;
    assert_eq!(a.text("error").await["code"], "wrong-room-type");

    // None of that moved the sequence or was acked.
    a.sync().await;
    assert!(tokio::time::timeout(QUIET, a.text("ack")).await.is_err());
    a.send_frame(PATCH, 0, 1, b"edit").await;
    assert_eq!(a.text("ack").await["seq"], 1);
}

#[tokio::test]
async fn a_reconnecting_member_gets_the_edits_it_missed_in_order() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("REPLAY01", "shared", 1).await;
    let mut ben = members.pop().unwrap();
    let who = ben.me.clone();

    host.send_frame(PATCH, 0, 1, b"one").await;
    assert_eq!(ben.frame().await.0.seq, 1);
    ben.send_frame(PATCH, 0, 1, b"ben's own").await;
    assert_eq!(ben.text("ack").await["seq"], 2);
    drop(ben);

    for (cid, payload) in [(2u64, &b"three"[..]), (3, b"four"), (4, b"five")] {
        host.send_frame(PATCH, 0, cid, payload).await;
    }
    host.sync().await;

    // Ben had applied up to seq 1; his own edit's ack may have been lost.
    let mut ben = relay.resume("REPLAY01", &who, 1).await;
    assert_eq!(ben.welcome["room"]["head"], 5);
    assert_eq!(
        ben.text("replay-begin").await,
        json!({ "t": "replay-begin", "after": 1, "head": 5 })
    );
    let mut got = Vec::new();
    for _ in 0..4 {
        let (header, payload) = ben.frame().await;
        got.push((header.seq, header.from, payload));
    }
    assert_eq!(
        got,
        vec![
            // His own frame comes back, so he can settle the pending op.
            (2, who.id(), b"ben's own".to_vec()),
            (3, host.id, b"three".to_vec()),
            (4, host.id, b"four".to_vec()),
            (5, host.id, b"five".to_vec()),
        ]
    );
    assert_eq!(
        ben.text("replay-end").await,
        json!({ "t": "replay-end", "head": 5 })
    );

    // Live edits follow the replay.
    host.send_frame(PATCH, 0, 5, b"six").await;
    assert_eq!(ben.frame().await.0.seq, 6);

    // Asking again later works the same way, with a request id.
    let begin = ben.request(json!({ "t": "replay", "after": 4 })).await;
    assert_eq!(begin["t"], "replay-begin");
    assert_eq!(ben.frame().await.0.seq, 5);
    assert_eq!(ben.frame().await.0.seq, 6);
    assert_eq!(ben.text("replay-end").await["head"], 6);
    // Nothing missed: an empty replay.
    let begin = ben.request(json!({ "t": "replay", "after": 6 })).await;
    assert_eq!(begin["t"], "replay-begin");
    assert_eq!(ben.text("replay-end").await["head"], 6);
    ben.no_frames().await;
}

#[tokio::test]
async fn when_the_log_no_longer_reaches_back_the_member_is_told_so() {
    let relay = TestRelay::with(|c| c.limits.log_frames = 4).await;
    let (mut host, mut members) = relay.room("REPLAY02", "shared", 1).await;
    let ben = members.pop().unwrap();
    let who = ben.me.clone();
    drop(ben);

    for cid in 1..=10u64 {
        host.send_frame(PATCH, 0, cid, b"edit").await;
    }
    host.sync().await;

    // The log holds 7..=10; replay works after 6 and later.
    let mut ben = relay.resume("REPLAY02", &who, 5).await;
    assert_eq!(ben.welcome["room"]["head"], 10);
    assert_eq!(ben.welcome["room"]["logFloor"], 6);
    assert_eq!(
        ben.text("error").await,
        json!({ "t": "error", "code": "replay-too-old", "head": 10, "logFloor": 6 })
    );
    // He is signed in all the same and falls back to a snapshot from a peer.
    ben.send_frame(SYNC_REQUEST, host.id, 1, b"base 5").await;
    assert_eq!(host.frame().await.0.kind, SYNC_REQUEST);

    let reply = ben.request(json!({ "t": "replay", "after": 6 })).await;
    assert_eq!(reply["t"], "replay-begin");
    let seqs = [
        ben.frame().await.0.seq,
        ben.frame().await.0.seq,
        ben.frame().await.0.seq,
        ben.frame().await.0.seq,
    ];
    assert_eq!(seqs, [7, 8, 9, 10]);

    // A member whose head is past the room's (the relay lost its state) hears that too.
    let reply = ben.request(json!({ "t": "replay", "after": 11 })).await;
    assert_eq!(reply["code"], "replay-ahead");
    assert_eq!(reply["head"], 10);
    let reply = ben.request(json!({ "t": "replay", "after": "x" })).await;
    assert_eq!(reply["code"], "bad-message");
}

#[tokio::test]
async fn the_log_is_bounded_in_bytes_as_well_as_frames() {
    let relay = TestRelay::with(|c| c.limits.log_bytes = 10 * 1024).await;
    let (mut host, mut members) = relay.room("REPLAY03", "shared", 1).await;
    let ben = &mut members[0];
    let payload = vec![0u8; 4 * 1024 - 24];
    for cid in 1..=5u64 {
        host.send_frame(PATCH, 0, cid, &payload).await;
    }
    host.sync().await;
    ben.drain().await;
    // Two 4 KiB frames fit in 10 KiB; the third pushed the oldest out.
    let reply = ben.request(json!({ "t": "replay", "after": 2 })).await;
    assert_eq!(reply["code"], "replay-too-old");
    assert_eq!(reply["logFloor"], 3);
    let reply = ben.request(json!({ "t": "replay", "after": 3 })).await;
    assert_eq!(reply["t"], "replay-begin");
    assert_eq!(ben.frame().await.0.seq, 4);
    assert_eq!(ben.frame().await.0.seq, 5);
}

#[tokio::test]
async fn a_frame_lost_on_the_way_shows_as_a_gap_that_replay_fills() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("REPLAY04", "shared", 1).await;
    let ben = &mut members[0];

    host.send_frame(PATCH, 0, 1, b"one").await;
    assert_eq!(ben.frame().await.0.seq, 1);
    relay.faults.drop_outbound("REPLAY04", ben.id, 1);
    host.send_frame(PATCH, 0, 2, b"two").await;
    host.send_frame(PATCH, 0, 3, b"three").await;

    // Ben's head is 1 and the next frame says 3: he asks for what is after 1.
    let (header, _) = ben.frame().await;
    assert_eq!(header.seq, 3);
    let reply = ben.request(json!({ "t": "replay", "after": 1 })).await;
    assert_eq!(reply["t"], "replay-begin");
    let (header, payload) = ben.frame().await;
    assert_eq!((header.seq, payload.as_slice()), (2, &b"two"[..]));
    assert_eq!(ben.frame().await.0.seq, 3);
}
