//! Protocol 3: the key epoch moves when the host says so, key frames travel
//! between any two members of a shared-copy room, and an app that still speaks
//! protocol 2 is told to update (`docs/design/ROOMS-PROTOCOL.md` §3.7, §7, §19).

mod common;

use common::*;
use serde_json::json;

const PATCH: u8 = 1;
const KEY: u8 = 8;

fn at_epoch(mut frame: Vec<u8>, epoch: u32) -> Vec<u8> {
    frame[20..24].copy_from_slice(&epoch.to_le_bytes());
    frame
}

#[tokio::test]
async fn an_app_on_protocol_2_is_told_to_update() {
    let relay = TestRelay::start().await;
    let me = Identity::new();
    let closed = relay
        .handshake("OLDAPP0001", &me, |nonce| {
            json!({ "t": "create", "proto": 2, "type": "shared", "key": me.key(),
                    "sig": me.sign("create", "OLDAPP0001", nonce) })
        })
        .await
        .err()
        .expect("protocol 2 is refused");
    assert_eq!(closed.code, 4426);
    assert_eq!(closed.reason, "Update W Annotator to join this room");
}

#[tokio::test]
async fn the_host_moves_the_room_to_a_new_key_epoch() {
    let relay = TestRelay::start().await;
    let (mut host, mut guests) = relay.room("REKEY00001", "shared", 2).await;
    let mut b = guests.pop().unwrap();
    let mut a = guests.pop().unwrap();

    // Only the host may, and only forwards.
    assert_eq!(
        a.request(json!({ "t": "rekey", "epoch": 2 })).await["code"],
        "forbidden"
    );
    for bad in [
        json!(1),
        json!(0),
        json!("2"),
        json!(null),
        json!(4294967296u64),
    ] {
        assert_eq!(
            host.request(json!({ "t": "rekey", "epoch": bad })).await["code"],
            "bad-message"
        );
    }
    let ok = host.request(json!({ "t": "rekey", "epoch": 2 })).await;
    assert_eq!(ok["t"], "ok");
    assert_eq!(ok["re"], "rekey");
    // Everyone is told, the host included.
    for client in [&mut host, &mut a, &mut b] {
        assert_eq!(client.text("epoch").await["epoch"], 2);
    }

    // A frame under the old epoch is refused; one under the new epoch is ordered.
    a.send_frame(PATCH, 0, 5, b"old").await;
    assert_eq!(
        a.text("error").await,
        json!({ "t": "error", "code": "bad-epoch", "kind": 1, "cid": 5 })
    );
    a.send_raw(at_epoch(encode_frame(PATCH, 0, 6, b"new"), 2))
        .await;
    assert_eq!(a.text("ack").await["cid"], 6);
    let (header, payload) = b.frame().await;
    assert_eq!((header.epoch, payload.as_slice()), (2, &b"new"[..]));

    // Someone signing in afterwards learns the epoch from `welcome`.
    drop(b);
    let again = relay.auth("REKEY00001", &a.me).await;
    assert_eq!(again.welcome["room"]["epoch"], 2);
}

#[tokio::test]
async fn any_member_of_a_shared_copy_may_send_a_key_frame_to_one_member() {
    let relay = TestRelay::start().await;
    let (mut host, mut guests) = relay.room("KEYFRAME01", "shared", 2).await;
    let mut b = guests.pop().unwrap();
    let mut a = guests.pop().unwrap();

    a.send_frame(KEY, b.id, 1, b"for b").await;
    let (header, payload) = b.frame().await;
    assert_eq!((header.kind, header.from, header.to), (KEY, a.id, b.id));
    assert_eq!(payload, b"for b");
    a.send_frame(KEY, host.id, 2, b"for the host").await;
    assert_eq!(host.frame().await.0.from, a.id);
    // Never to everyone.
    a.send_frame(KEY, 0, 3, b"all").await;
    assert_eq!(a.text("error").await["code"], "needs-recipient");
}
