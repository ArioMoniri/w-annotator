//! The fault-injection hooks themselves: each one does what it says, on one
//! member, deterministically.

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::json;

#[tokio::test]
async fn frames_from_one_member_can_be_dropped_on_the_way_in() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("FAULT001", "shared", 2).await;
    let (a, rest) = members.split_first_mut().unwrap();
    let b = &mut rest[0];

    relay.faults.drop_inbound("FAULT001", a.id, 2);
    for cid in 1..=3u64 {
        a.send_frame(PATCH, 0, cid, format!("a{cid}").as_bytes())
            .await;
    }
    a.sync().await;
    b.send_frame(PATCH, 0, 1, b"b1").await;
    // Only a's third frame was seen; b is untouched.
    assert_eq!(
        a.text("ack").await,
        json!({ "t": "ack", "cid": 3, "seq": 1 })
    );
    assert_eq!(host.frame().await.1, b"a3");
    assert_eq!(host.frame().await.1, b"b1");
    host.no_frames().await;
}

#[tokio::test]
async fn frames_for_one_member_can_be_dropped_delayed_or_reordered() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("FAULT002", "shared", 2).await;
    let (a, rest) = members.split_first_mut().unwrap();
    let b = &mut rest[0];

    // Drop: a misses one frame, b does not.
    relay.faults.drop_outbound("FAULT002", a.id, 1);
    host.send_frame(PATCH, 0, 1, b"one").await;
    host.send_frame(PATCH, 0, 2, b"two").await;
    assert_eq!(a.frame().await.0.seq, 2);
    assert_eq!(b.frame().await.0.seq, 1);
    assert_eq!(b.frame().await.0.seq, 2);

    // Reorder: the next two frames for a arrive swapped.
    relay.faults.reorder_outbound("FAULT002", a.id);
    host.send_frame(PATCH, 0, 3, b"three").await;
    host.send_frame(PATCH, 0, 4, b"four").await;
    host.send_frame(PATCH, 0, 5, b"five").await;
    let seqs = [
        a.frame().await.0.seq,
        a.frame().await.0.seq,
        a.frame().await.0.seq,
    ];
    assert_eq!(seqs, [4, 3, 5]);
    let seqs = [
        b.frame().await.0.seq,
        b.frame().await.0.seq,
        b.frame().await.0.seq,
    ];
    assert_eq!(seqs, [3, 4, 5]);

    // Delay: a hears late, b at once; healing ends it.
    relay
        .faults
        .delay_outbound("FAULT002", a.id, Duration::from_millis(300));
    let sent = Instant::now();
    host.send_frame(PATCH, 0, 6, b"six").await;
    assert_eq!(b.frame().await.0.seq, 6);
    assert!(sent.elapsed() < Duration::from_millis(200));
    assert_eq!(a.frame().await.0.seq, 6);
    assert!(sent.elapsed() >= Duration::from_millis(300));
    relay.faults.heal("FAULT002", a.id);
    let sent = Instant::now();
    host.send_frame(PATCH, 0, 7, b"seven").await;
    assert_eq!(a.frame().await.0.seq, 7);
    assert!(sent.elapsed() < Duration::from_millis(200));
}

#[tokio::test]
async fn a_paused_room_delivers_nothing_until_it_is_resumed_then_everything_in_order() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("FAULT003", "shared", 1).await;
    let guest = &mut members[0];
    let mut other_host = relay.create("FAULT004", "shared").await;

    relay.faults.pause_room("FAULT003");
    for cid in 1..=5u64 {
        host.send_frame(PATCH, 0, cid, b"held").await;
    }
    guest.no_frames().await;
    // Another room is not paused.
    other_host.sync().await;

    relay.faults.resume_room("FAULT003");
    for seq in 1..=5u64 {
        assert_eq!(guest.frame().await.0.seq, seq);
    }
    for cid in 1..=5u64 {
        assert_eq!(host.text("ack").await["cid"], cid);
    }
}

#[tokio::test]
async fn one_client_can_be_cut_off_and_brought_back_deterministically() {
    let relay = TestRelay::start().await;
    let (mut host, mut members) = relay.room("FAULT005", "shared", 2).await;
    let mut stays = members.pop().unwrap();
    let mut cut = members.pop().unwrap();
    let who = cut.me.clone();

    host.send_frame(PATCH, 0, 1, b"before").await;
    assert_eq!(cut.frame().await.0.seq, 1);

    assert!(relay.faults.kill("FAULT005", cut.id));
    // No close frame: to the client this is a dead link, not a goodbye.
    assert_eq!(cut.closed().await.code, 0);
    assert_eq!(
        host.text("presence").await,
        json!({ "t": "presence", "member": who.id(), "online": false })
    );
    // Killing someone who is not connected reports that.
    assert!(!relay.faults.kill("FAULT005", who.id()));
    assert!(!relay.faults.kill("NOSUCH99", who.id()));

    host.send_frame(PATCH, 0, 2, b"during").await;
    assert_eq!(stays.frame().await.0.seq, 1);
    assert_eq!(stays.frame().await.0.seq, 2);

    let mut back = relay.resume("FAULT005", &who, 1).await;
    let (header, payload) = back.frame().await;
    assert_eq!((header.seq, payload.as_slice()), (2, &b"during"[..]));
    host.send_frame(PATCH, 0, 3, b"after").await;
    assert_eq!(back.frame().await.0.seq, 3);
}

#[tokio::test]
async fn a_silenced_member_in_a_shared_room_times_out_and_can_return() {
    let relay = TestRelay::with(|c| {
        c.timing.ping_interval = Duration::from_millis(100);
        c.timing.idle_timeout = Duration::from_millis(400);
    })
    .await;
    let (mut host, mut members) = relay.room("FAULT006", "shared", 1).await;
    let quiet = members.pop().unwrap();

    relay.faults.silence("FAULT006", quiet.id);
    let started = Instant::now();
    assert_eq!(host.text("presence").await["online"], false);
    assert!(started.elapsed() >= Duration::from_millis(250));
    // The room is a shared copy: it does not end, and the host stayed alive on pings.
    relay.faults.heal("FAULT006", quiet.id);
    let back = relay.auth("FAULT006", &quiet.me).await;
    assert_eq!(back.welcome["room"]["state"], "active");
}

#[tokio::test]
async fn the_clock_can_be_moved_without_waiting() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("FAULT007", "shared").await;
    let first = host
        .request(InviteLink::new().registration(json!({})))
        .await;
    relay.faults.advance_clock(Duration::from_secs(1000));
    let second = host
        .request(InviteLink::new().registration(json!({})))
        .await;
    let delta = second["invite"]["expiresAt"].as_u64().unwrap()
        - first["invite"]["expiresAt"].as_u64().unwrap();
    assert!((1_000_000..1_005_000).contains(&delta), "{delta}");
}

#[tokio::test]
async fn a_relay_without_the_hooks_has_no_faults() {
    // The default configuration, as the binary and the desktop app use it.
    let config = w_relay::RelayConfig::default();
    assert!(config.faults.is_none());
    assert!(w_relay::RelayConfig::embedded().faults.is_none());
    // A handle that is not attached to a relay does nothing.
    let loose = w_relay::Faults::new();
    assert!(!loose.kill("FAULT008", 1));
    loose.sweep();
    loose.wipe();
}
