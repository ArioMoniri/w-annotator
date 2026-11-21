//! Room records, identity, roles, removal, deletion, limits and expiry.

mod common;

use std::time::Duration;

use common::*;
use futures_util::SinkExt;
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use w_relay::{RoomInfo, RoomType};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

fn roster_ids(msg: &Value) -> Vec<u64> {
    let list = msg.get("members").or_else(|| msg.get("roster")).unwrap();
    list.as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_u64().unwrap())
        .collect()
}

#[tokio::test]
async fn only_a_member_key_with_a_valid_signature_signs_in() {
    let relay = TestRelay::start().await;
    let (host, members) = relay.room("AUTH0001", "shared", 1).await;
    let member = members[0].me.clone();
    drop(members);

    // A key the room has never seen.
    let stranger = Identity::new();
    let closed = relay.try_auth("AUTH0001", &stranger).await.err().unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4401,
            reason: "not a member".into()
        }
    );

    // A member's key with someone else's signature.
    let closed = relay
        .handshake("AUTH0001", &member, |nonce| {
            json!({ "t": "auth", "proto": 2, "key": member.key(), "sig": stranger.sign("auth", "AUTH0001", nonce) })
        })
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4401,
            reason: "bad signature".into()
        }
    );

    // A signature made for another connection's nonce cannot be replayed.
    let (_other, other_hello) = relay.open("AUTH0001").await;
    let stale = member.sign("auth", "AUTH0001", other_hello["nonce"].as_str().unwrap());
    let closed = relay
        .handshake(
            "AUTH0001",
            &member,
            |_| json!({ "t": "auth", "proto": 2, "key": member.key(), "sig": stale }),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(closed.code, 4401);

    // Nor one made for another room or another operation.
    relay.create("AUTH0002", "shared").await;
    for (op, room) in [
        ("auth", "AUTH0002"),
        ("create", "AUTH0001"),
        ("redeem", "AUTH0001"),
    ] {
        let closed = relay
            .handshake("AUTH0001", &member, |nonce| {
                json!({ "t": "auth", "proto": 2, "key": member.key(), "sig": member.sign(op, room, nonce) })
            })
            .await
            .err()
            .unwrap();
        assert_eq!(closed.code, 4401, "{op} {room}");
    }

    // The real thing works, and the room id is case-insensitive.
    let back = relay.auth("auth0001", &member).await;
    assert_eq!(
        back.welcome["self"],
        json!({ "id": member.id(), "role": "editor" })
    );
    drop(host);
}

#[tokio::test]
async fn a_member_keeps_its_id_across_reconnects_and_presence_follows() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("STABLE01", "shared", 2).await;
    let second = members.pop().unwrap();
    let mut first = members.pop().unwrap();
    let who = second.me.clone();
    let id = second.id;

    drop(second);
    let gone = json!({ "t": "presence", "member": id, "online": false });
    assert_eq!(host.text("presence").await, gone);
    assert_eq!(first.text("presence").await, gone);

    let back = relay.auth("STABLE01", &who).await;
    assert_eq!(back.id, id);
    let here = json!({ "t": "presence", "member": id, "online": true });
    assert_eq!(host.text("presence").await, here);
    assert_eq!(first.text("presence").await, here);
    let online: Vec<bool> = back.welcome["roster"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["online"].as_bool().unwrap())
        .collect();
    assert_eq!(online, [true, true, true]);
}

#[tokio::test]
async fn a_second_connection_of_the_same_member_replaces_the_first() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("TWICE001", "shared", 1).await;
    let mut old = members.pop().unwrap();
    let mut new = relay.auth("TWICE001", &old.me).await;
    assert_eq!(
        old.closed().await,
        Closed {
            code: 4003,
            reason: "signed in elsewhere".into()
        }
    );
    // The member never went offline as far as the room is concerned.
    host.send_frame(PATCH, 0, 1, b"x").await;
    assert_eq!(new.frame().await.1, b"x");
    host.sync().await;
    assert!(tokio::time::timeout(QUIET, host.text("presence"))
        .await
        .is_err());
}

#[tokio::test]
async fn viewers_cannot_edit_and_only_the_host_changes_roles() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("ROLES001", "shared").await;
    let mut editor = host.invite(&relay, json!({})).await;
    let mut viewer = host.invite(&relay, json!({ "role": "viewer" })).await;
    assert_eq!(viewer.welcome["self"]["role"], "viewer");
    host.drain().await;
    editor.drain().await;

    // A viewer's edit frames are refused and reach nobody.
    for kind in [PATCH, SEG_OP] {
        viewer.send_frame(kind, 0, 4, b"scribble").await;
        assert_eq!(
            viewer.text("error").await,
            json!({ "t": "error", "code": "forbidden", "kind": kind, "cid": 4 })
        );
    }
    host.no_frames().await;
    editor.no_frames().await;
    // A viewer still has a cursor.
    viewer.send_frame(PRESENCE, 0, 0, b"cursor").await;
    assert_eq!(host.frame().await.0.kind, PRESENCE);
    assert_eq!(editor.frame().await.0.kind, PRESENCE);

    // An editor cannot promote, demote, remove, invite or delete.
    for request in [
        json!({ "t": "member-role", "member": viewer.id, "role": "editor" }),
        json!({ "t": "member-remove", "member": viewer.id }),
        json!({ "t": "invite-list" }),
        json!({ "t": "invite-revoke", "id": "AAAAAAAAAAAAAAAAAAAAAA" }),
        InviteLink::new().registration(json!({})),
        json!({ "t": "room-delete" }),
        json!({ "t": "room-close" }),
    ] {
        let reply = editor.request(request.clone()).await;
        assert_eq!(reply["code"], "forbidden", "{request}");
    }

    // The host can. Everyone hears the new roster.
    let reply = host
        .request(json!({ "t": "member-role", "member": viewer.id, "role": "editor" }))
        .await;
    assert_eq!(reply["t"], "ok");
    assert_eq!(reply["re"], "member-role");
    let roster = viewer.text("roster").await;
    let role_of = |id: u32| {
        roster["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == id)
            .unwrap()["role"]
            .clone()
    };
    assert_eq!(role_of(viewer.id), "editor");
    viewer.send_frame(PATCH, 0, 5, b"now allowed").await;
    assert_eq!(viewer.text("ack").await["cid"], 5);
    assert_eq!(host.frame().await.1, b"now allowed");

    // Nobody becomes host, and the host's own role is fixed.
    for request in [
        json!({ "t": "member-role", "member": viewer.id, "role": "host" }),
        json!({ "t": "member-role", "member": viewer.id, "role": "owner" }),
        json!({ "t": "member-role", "member": "x", "role": "viewer" }),
    ] {
        assert_eq!(host.request(request).await["code"], "bad-message");
    }
    let reply = host
        .request(json!({ "t": "member-role", "member": host.id, "role": "viewer" }))
        .await;
    assert_eq!(reply["code"], "forbidden");
    let reply = host
        .request(json!({ "t": "member-role", "member": 12345, "role": "viewer" }))
        .await;
    assert_eq!(reply["code"], "not-found");
}

#[tokio::test]
async fn a_removed_member_is_closed_at_once_and_can_never_come_back() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("REMOVE01", "shared").await;
    // Ben came in through a link that still has uses left.
    let link = host.add_invite(json!({ "maxUses": 5 })).await;
    let ben = Identity::new();
    let mut ben_client = relay.try_redeem("REMOVE01", &link, &ben).await.unwrap();
    let mut other = host.invite(&relay, json!({})).await;
    host.drain().await;
    other.drain().await;

    let started = std::time::Instant::now();
    let reply = host
        .request(json!({ "t": "member-remove", "member": ben.id() }))
        .await;
    assert_eq!(reply["t"], "ok");
    assert_eq!(
        ben_client.closed().await,
        Closed {
            code: 4403,
            reason: "removed by host".into()
        }
    );
    assert!(started.elapsed() < Duration::from_secs(1));

    // The others carry on with a roster without him.
    let expect = vec![u64::from(host.id), u64::from(other.id)];
    let mut sorted = expect.clone();
    sorted.sort_unstable();
    assert_eq!(roster_ids(&other.text("roster").await), sorted);
    assert_eq!(roster_ids(&host.text("roster").await), sorted);
    host.send_frame(PATCH, 0, 1, b"without ben").await;
    assert_eq!(other.frame().await.1, b"without ben");

    // His old membership is refused as removed, not merely unknown.
    let closed = relay.try_auth("REMOVE01", &ben).await.err().unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4403,
            reason: "removed by host".into()
        }
    );
    // The link he came in through is dead for his key...
    let closed = relay
        .try_redeem("REMOVE01", &link, &ben)
        .await
        .err()
        .unwrap();
    assert_eq!(closed.code, 4403);
    // ...and for a fresh key too, though it had four uses left.
    let closed = relay
        .try_redeem("REMOVE01", &link, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4408,
            reason: "invite revoked".into()
        }
    );

    // The host cannot remove itself or someone who is not there.
    assert_eq!(
        host.request(json!({ "t": "member-remove", "member": host.id }))
            .await["code"],
        "forbidden"
    );
    assert_eq!(
        host.request(json!({ "t": "member-remove", "member": ben.id() }))
            .await["code"],
        "not-found"
    );
}

#[tokio::test]
async fn removing_someone_can_revoke_every_open_link_in_the_same_step() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("REMOVE02", "shared").await;
    let unused = host.add_invite(json!({})).await;
    let guest = host.invite(&relay, json!({})).await;
    host.request(json!({ "t": "member-remove", "member": guest.id, "revokeInvites": true }))
        .await;
    let closed = relay
        .try_redeem("REMOVE02", &unused, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4408,
            reason: "invite revoked".into()
        }
    );
}

#[tokio::test]
async fn deleting_a_room_closes_everyone_with_4410_and_frees_its_state() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("DELETE01", "shared", 2).await;
    let offline = members.pop().unwrap();
    let offline_id = offline.me.clone();
    drop(offline);
    let unused = host.add_invite(json!({})).await;
    host.send_frame(PATCH, 0, 1, b"some history").await;
    host.text("ack").await;
    assert_eq!(relay.relay.stats().rooms, 1);

    host.send_json(json!({ "t": "room-delete" })).await;
    let gone = Closed {
        code: 4410,
        reason: "room deleted".into(),
    };
    assert_eq!(host.closed().await, gone);
    assert_eq!(members[0].closed().await, gone);
    assert_eq!(relay.relay.stats().rooms, 0);
    assert_eq!(relay.relay.rooms(), Vec::<RoomInfo>::new());

    // Everyone who returns is told it was deleted, whatever they try.
    assert_eq!(
        relay.try_auth("DELETE01", &offline_id).await.err().unwrap(),
        gone
    );
    assert_eq!(
        relay.try_auth("DELETE01", &host.me).await.err().unwrap(),
        gone
    );
    assert_eq!(
        relay
            .try_redeem("DELETE01", &unused, &Identity::new())
            .await
            .err()
            .unwrap(),
        gone
    );
    // The id cannot be taken over while it is remembered.
    let closed = relay
        .try_create("DELETE01", "shared", &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed.code, 4409);

    // After 30 days the tombstone is forgotten too.
    relay.faults.advance_clock(30 * DAY);
    relay.faults.sweep();
    let closed = relay.try_auth("DELETE01", &offline_id).await.err().unwrap();
    assert_eq!(closed.code, 4404);
}

#[tokio::test]
async fn the_seventeenth_member_is_told_the_room_is_full_and_keeps_the_invite() {
    let relay = TestRelay::start().await;
    let (mut host, members) = relay.room("FULL0001", "shared", 15).await;
    let link = host.add_invite(json!({})).await;
    let late = Identity::new();
    let closed = relay
        .try_redeem("FULL0001", &link, &late)
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4001,
            reason: "room full".into()
        }
    );

    // A seat frees up when the host removes someone; the same link then works.
    host.request(json!({ "t": "member-remove", "member": members[0].id }))
        .await;
    let joined = relay.try_redeem("FULL0001", &link, &late).await.unwrap();
    assert_eq!(joined.welcome["roster"].as_array().unwrap().len(), 16);
}

#[tokio::test]
async fn a_member_that_floods_is_closed_with_4429_and_the_room_carries_on() {
    let relay = TestRelay::with(|c| c.limits.messages_per_sec = 50).await;
    let (mut host, mut members) = relay.room("FLOOD001", "shared", 2).await;
    let mut calm = members.pop().unwrap();
    let mut flooder = members.pop().unwrap();

    for i in 0..400u64 {
        if flooder
            .ws
            .send(Message::binary(encode_frame(PATCH, 0, i, b"spam")))
            .await
            .is_err()
        {
            break;
        }
    }
    assert_eq!(
        flooder.closed().await,
        Closed {
            code: 4429,
            reason: "rate limited".into()
        }
    );

    // At most the allowance got through, and the others are fine.
    host.sync().await;
    host.drain().await;
    calm.drain().await;
    calm.send_frame(PATCH, 0, 1, b"calm").await;
    let ack = calm.text("ack").await;
    assert!(ack["seq"].as_u64().unwrap() <= 51, "{ack}");
    assert_eq!(host.frame().await.1, b"calm");
    // The flooder is still a member and can come back.
    relay.auth("FLOOD001", &flooder.me).await;
}

#[tokio::test]
async fn a_byte_flood_is_limited_too() {
    let relay = TestRelay::with(|c| {
        c.limits.bytes_per_sec = 256 * 1024;
        c.limits.max_message_bytes = 64 * 1024;
    })
    .await;
    let (_host, mut members) = relay.room("FLOOD002", "shared", 1).await;
    let flooder = &mut members[0];
    let big = vec![0u8; 60 * 1024];
    for i in 0..10u64 {
        if flooder
            .ws
            .send(Message::binary(encode_frame(PATCH, 0, i, &big)))
            .await
            .is_err()
        {
            break;
        }
    }
    assert_eq!(flooder.closed().await.code, 4429);
}

#[tokio::test]
async fn the_room_allowance_drops_frames_without_closing_anyone() {
    let relay = TestRelay::with(|c| c.limits.room_messages_per_sec = 20).await;
    let (mut host, mut members) = relay.room("FLOOD003", "shared", 1).await;
    let guest = &mut members[0];
    for i in 0..60u64 {
        guest.send_frame(PATCH, 0, i, b"p").await;
    }
    guest.sync().await;
    let mut acked = 0;
    let mut refused = 0;
    while let Ok(event) = tokio::time::timeout(QUIET, guest.event()).await {
        match event {
            Event::Text(v) if v["t"] == "ack" => acked += 1,
            Event::Text(v) if v["code"] == "rate-limited" => refused += 1,
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(acked + refused, 60);
    assert!((20..=30).contains(&acked), "{acked} frames got through");
    host.sync().await;
}

#[tokio::test]
async fn connection_attempts_are_limited_per_address() {
    let relay = TestRelay::with(|c| {
        c.limits.joins_per_minute = 5;
        c.v1 = true;
    })
    .await;
    for _ in 0..5 {
        relay.open("JOINS001").await;
    }
    assert_eq!(http_status(connect_async(relay.url("JOINS001")).await), 429);
    // v1 and the health check are not part of that limit.
    assert!(relay.http_get("/health").await.ends_with("ok"));
    connect_async(format!("ws://{}/r/ABCD?name=x", relay.addr))
        .await
        .unwrap();
}

#[tokio::test]
async fn the_relay_holds_a_bounded_number_of_rooms_and_connections() {
    let relay = TestRelay::with(|c| {
        c.limits.max_rooms = 2;
        c.limits.max_connections = 4;
    })
    .await;
    let _a = relay.create("ROOMCAP1", "shared").await;
    let _b = relay.create("ROOMCAP2", "shared").await;
    let closed = relay
        .try_create("ROOMCAP3", "shared", &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4001,
            reason: "relay full".into()
        }
    );

    // Two hosts are connected; two more sockets fit, a fifth does not.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _c = relay.open("ROOMCAP1").await;
    let _d = relay.open("ROOMCAP1").await;
    assert_eq!(http_status(connect_async(relay.url("ROOMCAP1")).await), 503);
    drop(_c);
    tokio::time::sleep(Duration::from_millis(200)).await;
    relay.open("ROOMCAP1").await;
}

#[tokio::test]
async fn a_member_that_stops_reading_is_dropped_with_4002_without_stalling_the_room() {
    let relay = TestRelay::with(|c| {
        c.limits.queue_bytes = 256 * 1024;
        c.limits.log_bytes = 64 * 1024;
    })
    .await;
    let (mut host, mut members) = relay.room("SLOW0001", "shared", 2).await;
    let mut healthy = members.pop().unwrap();
    let stalled = members.pop().unwrap(); // never reads again
    let stalled_id = stalled.id;

    let payload = vec![0u8; 100 * 1024];
    let mut delivered = 0;
    let mut dropped = false;
    for cid in 0..400u64 {
        host.send_frame(PATCH, 0, cid, &payload).await;
        healthy.frame().await;
        delivered += 1;
        // Stay inside the sender's own byte allowance.
        tokio::time::sleep(Duration::from_millis(6)).await;
        host.sync().await;
        if let Ok(Event::Text(v)) =
            tokio::time::timeout(Duration::from_millis(1), host.event()).await
        {
            if v["t"] == "presence" && v["member"] == stalled_id {
                dropped = true;
                break;
            }
        }
    }
    assert!(dropped, "the stalled member was never dropped");
    assert!(delivered > 0);
    drop(stalled);
}

#[tokio::test]
async fn a_shared_room_outlives_its_host_going_offline() {
    let relay = TestRelay::start().await;
    let (host, mut members) = relay.room("AWAY0001", "shared", 2).await;
    let host_identity = host.me.clone();
    let host_id = host.id;
    drop(host);
    let (a, rest) = members.split_first_mut().unwrap();
    let b = &mut rest[0];

    assert_eq!(
        a.text("room-state").await,
        json!({ "t": "room-state", "state": "host-away" })
    );
    assert_eq!(b.text("room-state").await["state"], "host-away");
    // The others keep editing through the relay.
    a.send_frame(PATCH, 0, 1, b"while the host is away").await;
    assert_eq!(a.text("ack").await["seq"], 1);
    assert_eq!(b.frame().await.1, b"while the host is away");

    // Everyone leaves: the record stays (dormant), nothing is lost.
    let b_identity = b.me.clone();
    drop(members);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        relay.relay.rooms(),
        vec![RoomInfo {
            id: "AWAY0001".into(),
            room_type: RoomType::Shared,
            members: 3,
            online: 0,
            head: 1
        }]
    );
    let mut b = relay.auth("AWAY0001", &b_identity).await;
    assert_eq!(b.welcome["room"]["state"], "host-away");
    assert_eq!(b.welcome["room"]["head"], 1);

    let host = relay.auth("AWAY0001", &host_identity).await;
    assert_eq!(host.welcome["room"]["state"], "active");
    assert_eq!(b.text("presence").await["member"], host_id);
    assert_eq!(b.text("room-state").await["state"], "active");
}

#[tokio::test]
async fn members_and_rooms_lapse_after_thirty_idle_days() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("LAPSE001", "shared", 2).await;
    let idle = members.pop().unwrap();
    let idle_identity = idle.me.clone();
    let idle_id = idle.id;
    drop(idle);
    host.text("presence").await;

    relay
        .faults
        .advance_clock(30 * DAY - Duration::from_secs(60));
    relay.faults.sweep();
    host.sync().await;
    assert!(tokio::time::timeout(QUIET, host.text("roster"))
        .await
        .is_err());

    relay.faults.advance_clock(Duration::from_secs(60));
    relay.faults.sweep();
    // The connected member and the host stay, whatever the clock says.
    let roster = host.text("roster").await;
    assert_eq!(roster_ids(&roster).len(), 2);
    assert!(!roster_ids(&roster).contains(&u64::from(idle_id)));
    let closed = relay
        .try_auth("LAPSE001", &idle_identity)
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4401,
            reason: "not a member".into()
        }
    );

    // A room nobody connects to for thirty days is forgotten entirely.
    let host_identity = host.me.clone();
    drop(host);
    drop(members);
    tokio::time::sleep(Duration::from_millis(100)).await;
    relay
        .faults
        .advance_clock(30 * DAY - Duration::from_secs(60));
    relay.faults.sweep();
    assert_eq!(relay.relay.stats().rooms, 1);
    relay.faults.advance_clock(Duration::from_secs(60));
    relay.faults.sweep();
    assert_eq!(relay.relay.stats().rooms, 0);
    let closed = relay
        .try_auth("LAPSE001", &host_identity)
        .await
        .err()
        .unwrap();
    assert_eq!(closed.code, 4404);
}

#[tokio::test]
async fn after_a_relay_restart_the_host_makes_the_room_again_with_its_members() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("RESTART1", "shared", 2).await;
    let session = host.welcome["room"]["session"].clone();
    let people: Vec<Identity> = members.iter().map(|m| m.me.clone()).collect();

    relay.faults.wipe();
    assert_eq!(
        host.closed().await.code,
        0,
        "a restart sends no close frame"
    );
    assert_eq!(members[0].closed().await.code, 0);
    // Members wait: the room is unknown until the host is back.
    let closed = relay.try_auth("RESTART1", &people[0]).await.err().unwrap();
    assert_eq!(closed.code, 4404);

    let me = host.me.clone();
    let seeded = relay
        .handshake("RESTART1", &me, |nonce| {
            json!({
                "t": "create", "proto": 2, "type": "shared", "key": me.key(),
                "sig": me.sign("create", "RESTART1", nonce),
                "members": [
                    { "key": people[0].key(), "role": "editor" },
                    { "key": people[1].key(), "role": "viewer" },
                ],
            })
        })
        .await
        .unwrap();
    assert_ne!(seeded.welcome["room"]["session"], session);
    assert_eq!(seeded.welcome["room"]["head"], 0);
    assert_eq!(seeded.welcome["roster"].as_array().unwrap().len(), 3);

    let first = relay.auth("RESTART1", &people[0]).await;
    assert_eq!(first.welcome["self"]["role"], "editor");
    let second = relay.auth("RESTART1", &people[1]).await;
    assert_eq!(second.welcome["self"]["role"], "viewer");

    // A seed list cannot make a second host or repeat a key.
    for bad in [
        json!([{ "key": people[0].key(), "role": "host" }]),
        json!([{ "key": people[0].key(), "role": "editor" }, { "key": people[0].key(), "role": "editor" }]),
        json!([{ "key": "nope", "role": "editor" }]),
        json!("everyone"),
    ] {
        let closed = relay
            .handshake("RESTART2", &me, |nonce| {
                json!({ "t": "create", "proto": 2, "type": "shared", "key": me.key(),
                        "sig": me.sign("create", "RESTART2", nonce), "members": bad })
            })
            .await
            .err()
            .unwrap();
        assert_eq!(closed.code, 4400);
    }
}

#[tokio::test]
async fn the_embedding_app_can_list_and_delete_rooms() {
    let relay = TestRelay::start().await;
    let (_host, mut members) = relay.room("EMBED001", "host-view", 1).await;
    relay.create("EMBED002", "shared").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        relay.relay.rooms(),
        vec![
            RoomInfo {
                id: "EMBED001".into(),
                room_type: RoomType::HostView,
                members: 2,
                online: 2,
                head: 0
            },
            RoomInfo {
                id: "EMBED002".into(),
                room_type: RoomType::Shared,
                members: 1,
                online: 0,
                head: 0
            },
        ]
    );
    assert!(relay.relay.delete_room("embed001"));
    assert!(!relay.relay.delete_room("embed001"));
    assert!(!relay.relay.delete_room("not a room id"));
    assert_eq!(
        members[0].closed().await,
        Closed {
            code: 4410,
            reason: "room deleted".into()
        }
    );
    assert_eq!(relay.relay.stats().rooms, 1);
}
