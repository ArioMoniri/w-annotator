//! View-through-host rooms: star routing, no file-class frames, host liveness.

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use w_relay::proto::Header;

async fn relay() -> TestRelay {
    TestRelay::start().await
}

/// Short host liveness timings, so losing a host takes well under a second.
/// A test client only answers pings while it is being read, so these tests
/// keep reading the host whenever it is meant to be alive.
async fn fast() -> TestRelay {
    TestRelay::with(|c| {
        c.timing.host_ping_interval = Duration::from_millis(100);
        c.timing.host_timeout = Duration::from_millis(400);
        c.timing.host_grace = Duration::from_millis(400);
    })
    .await
}

#[tokio::test]
async fn a_guest_reaches_only_the_host_whatever_target_it_names() {
    let relay = relay().await;
    let (mut host, mut guests) = relay.room("STAR0001", "host-view", 2).await;
    let (a, rest) = guests.split_first_mut().unwrap();
    let b = &mut rest[0];

    for to in [0, host.id, b.id] {
        // A guest's edit goes to the host alone, unordered: the host decides.
        a.send_frame(PATCH, to, 11, b"stroke").await;
        let (header, payload) = host.frame().await;
        assert_eq!(
            header,
            Header {
                version: 3,
                kind: PATCH,
                flags: 0,
                from: a.id,
                to: host.id,
                seq: 11,
                epoch: 1
            }
        );
        assert_eq!(payload, b"stroke");
        a.send_frame(SEG_OP, to, 12, b"rename").await;
        assert_eq!(host.frame().await.0.kind, SEG_OP);
        a.send_frame(PRESENCE, to, 0, b"cursor").await;
        assert_eq!(host.frame().await.0.kind, PRESENCE);
        a.send_frame(SLICE_REQUEST, to, 13, b"axial 40").await;
        let (header, _) = host.frame().await;
        assert_eq!(
            (header.kind, header.from, header.seq),
            (SLICE_REQUEST, a.id, 13)
        );
        a.send_frame(KEY, to, 14, b"x25519").await;
        assert_eq!(host.frame().await.0.kind, KEY);
    }
    a.sync().await;
    // The other guest heard none of it, and the guest got no ack from the relay.
    b.no_frames().await;
    assert!(tokio::time::timeout(QUIET, a.text("ack")).await.is_err());
}

#[tokio::test]
async fn the_host_orders_edits_and_answers_each_guest_alone() {
    let relay = relay().await;
    let (mut host, mut guests) = relay.room("STAR0002", "host-view", 2).await;
    let (a, rest) = guests.split_first_mut().unwrap();
    let b = &mut rest[0];

    // The host's edits are the room's order.
    host.send_frame(PATCH, 0, 1, b"applied stroke").await;
    assert_eq!(
        host.text("ack").await,
        json!({ "t": "ack", "cid": 1, "seq": 1 })
    );
    for guest in [&mut *a, &mut *b] {
        let (header, payload) = guest.frame().await;
        assert_eq!((header.seq, header.from, header.to), (1, host.id, 0));
        assert_eq!(payload, b"applied stroke");
    }

    // A slice goes to the guest who asked and nobody else.
    host.send_frame(SLICE, a.id, 13, b"8-bit slice").await;
    let (header, payload) = a.frame().await;
    assert_eq!((header.kind, header.to, header.seq), (SLICE, a.id, 13));
    assert_eq!(payload, b"8-bit slice");
    host.send_frame(KEY, b.id, 2, b"pairwise").await;
    assert_eq!(b.frame().await.0.kind, KEY);
    a.no_frames().await;
    b.no_frames().await;

    // A slice or a key for "everyone" is refused.
    for kind in [SLICE, KEY] {
        host.send_frame(kind, 0, 3, b"broadcast?").await;
        assert_eq!(host.text("error").await["code"], "needs-recipient");
    }
    a.no_frames().await;
}

#[tokio::test]
async fn file_class_frames_never_reach_a_guest() {
    let relay = relay().await;
    let (mut host, mut guests) = relay.room("STAR0003", "host-view", 2).await;
    let (a, rest) = guests.split_first_mut().unwrap();
    let b = &mut rest[0];

    for kind in [SYNC_SLAB, IMAGE_SLAB, SYNC_REQUEST] {
        // Not from the host, to one guest or to all...
        for to in [a.id, 0] {
            host.send_frame(kind, to, 1, b"the file").await;
            let error = host.text("error").await;
            assert_eq!(
                (&error["code"], &error["kind"]),
                (&json!("forbidden"), &json!(kind))
            );
        }
        // ...not from a guest to the host or to another guest.
        for to in [host.id, b.id] {
            a.send_frame(kind, to, 1, b"give me the file").await;
            assert_eq!(a.text("error").await["code"], "forbidden");
        }
    }
    // A guest cannot pose as the slice source either.
    a.send_frame(SLICE, b.id, 1, b"fake slice").await;
    assert_eq!(a.text("error").await["code"], "forbidden");

    host.sync().await;
    a.sync().await;
    host.no_frames().await;
    a.no_frames().await;
    b.no_frames().await;
}

#[tokio::test]
async fn viewers_in_a_host_view_room_can_look_but_not_edit() {
    let relay = relay().await;
    let mut host = relay.create("STAR0004", "host-view").await;
    let mut viewer = host.invite(&relay, json!({ "role": "viewer" })).await;
    host.drain().await;
    viewer.send_frame(PATCH, 0, 1, b"scribble").await;
    assert_eq!(viewer.text("error").await["code"], "forbidden");
    viewer.send_frame(SLICE_REQUEST, 0, 2, b"axial 1").await;
    assert_eq!(host.frame().await.0.kind, SLICE_REQUEST);
    host.no_frames().await;
}

#[tokio::test]
async fn slice_requests_are_rate_limited_per_guest() {
    let relay = TestRelay::with(|c| {
        c.limits.slice_requests_burst = 5;
        c.limits.slice_requests_per_minute = 60;
    })
    .await;
    let (mut host, mut guests) = relay.room("STAR0005", "host-view", 2).await;
    let (a, rest) = guests.split_first_mut().unwrap();
    let b = &mut rest[0];

    for cid in 0..12u64 {
        a.send_frame(SLICE_REQUEST, 0, cid, b"next slice").await;
    }
    a.sync().await;
    let mut refused = 0;
    while let Ok(error) = tokio::time::timeout(QUIET, a.text("error")).await {
        assert_eq!(error["code"], "rate-limited");
        assert_eq!(error["kind"], SLICE_REQUEST);
        refused += 1;
    }
    assert!((6..=7).contains(&refused), "{refused} refused");
    for _ in 0..(12 - refused) {
        assert_eq!(host.frame().await.0.from, a.id);
    }
    // The other guest has its own allowance.
    b.send_frame(SLICE_REQUEST, 0, 1, b"mine").await;
    assert_eq!(host.frame().await.0.from, b.id);
}

#[tokio::test]
async fn room_close_ends_the_session_for_everyone_at_once_and_erases_it() {
    let relay = relay().await;
    let (mut host, mut guests) = relay.room("CLOSE001", "host-view", 2).await;
    let unused = host.add_invite(json!({})).await;
    let guest = guests[0].me.clone();

    let started = Instant::now();
    host.send_json(json!({ "t": "room-close" })).await;
    let closed = Closed {
        code: 4410,
        reason: "room closed".into(),
    };
    assert_eq!(guests[0].closed().await, closed);
    assert_eq!(guests[1].closed().await, closed);
    assert_eq!(host.closed().await, closed);
    assert!(started.elapsed() < Duration::from_millis(300));

    // The record, its members and its invites are gone; a new session is a new room.
    assert_eq!(relay.relay.stats().rooms, 0);
    assert_eq!(
        relay.try_auth("CLOSE001", &guest).await.err().unwrap(),
        closed
    );
    assert_eq!(
        relay.try_auth("CLOSE001", &host.me).await.err().unwrap(),
        closed
    );
    assert_eq!(
        relay
            .try_redeem("CLOSE001", &unused, &Identity::new())
            .await
            .err()
            .unwrap(),
        closed
    );
    assert_eq!(
        relay
            .try_create("CLOSE001", "host-view", &host.me)
            .await
            .err()
            .unwrap()
            .code,
        4409
    );
    relay
        .try_create("CLOSE002", "host-view", &host.me)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_host_closing_its_socket_cleanly_ends_the_room_at_once() {
    let relay = relay().await;
    let (mut host, mut guests) = relay.room("CLOSE003", "host-view", 1).await;
    let started = Instant::now();
    host.ws.close(None).await.unwrap();
    assert_eq!(
        guests[0].closed().await,
        Closed {
            code: 4410,
            reason: "room closed".into()
        }
    );
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn room_close_is_only_for_view_through_host_rooms() {
    let relay = relay().await;
    let mut host = relay.create("CLOSE004", "shared").await;
    let reply = host.request(json!({ "t": "room-close" })).await;
    assert_eq!(reply["code"], "wrong-room-type");
    host.sync().await;
}

#[tokio::test]
async fn a_hard_disconnect_of_the_host_blanks_guests_then_closes_within_the_grace_time() {
    let relay = fast().await;
    let (host, mut guests) = relay.room("LOST0001", "host-view", 2).await;

    let started = Instant::now();
    assert!(relay.faults.kill("LOST0001", host.id));
    // Guests are told at once, so the client can blank the view.
    for guest in &mut guests {
        assert_eq!(
            guest.text("room-state").await,
            json!({ "t": "room-state", "state": "host-away" })
        );
    }
    assert!(started.elapsed() < Duration::from_millis(200));
    // The host does not come back: the room closes when the grace time is up.
    let lost = Closed {
        code: 4410,
        reason: "host lost".into(),
    };
    assert_eq!(guests[0].closed().await, lost);
    assert_eq!(guests[1].closed().await, lost);
    let took = started.elapsed();
    assert!(
        (Duration::from_millis(350)..Duration::from_millis(900)).contains(&took),
        "{took:?}"
    );
    assert_eq!(relay.relay.stats().rooms, 0);
    assert_eq!(
        relay.try_auth("LOST0001", &host.me).await.err().unwrap(),
        lost
    );
}

#[tokio::test]
async fn a_host_that_returns_within_the_grace_time_keeps_the_room() {
    let relay = fast().await;
    let (host, mut guests) = relay.room("LOST0002", "host-view", 1).await;
    let guest = &mut guests[0];

    relay.faults.kill("LOST0002", host.id);
    assert_eq!(guest.text("room-state").await["state"], "host-away");
    // While the host is away a guest's frames have nowhere to go.
    guest.send_frame(SLICE_REQUEST, 0, 1, b"axial 2").await;
    assert_eq!(guest.text("error").await["code"], "offline");

    let mut host = relay.auth("LOST0002", &host.me).await;
    assert_eq!(guest.text("room-state").await["state"], "active");
    // Well past the first grace period the room is still there and works.
    assert!(
        tokio::time::timeout(Duration::from_millis(600), host.event())
            .await
            .is_err()
    );
    guest.send_frame(SLICE_REQUEST, 0, 2, b"axial 3").await;
    assert_eq!(host.frame().await.0.seq, 2);

    // A second loss gets its own full grace period, then closes.
    relay.faults.kill("LOST0002", host.id);
    assert_eq!(guest.closed().await.reason, "host lost");
}

#[tokio::test]
async fn a_host_that_goes_silent_is_noticed_by_the_liveness_timeout() {
    let relay = fast().await;
    let (host, mut guests) = relay.room("LOST0003", "host-view", 1).await;

    // The lid is shut: the socket stays open but nothing moves either way.
    let started = Instant::now();
    relay.faults.silence("LOST0003", host.id);
    assert_eq!(
        guests[0].closed().await,
        Closed {
            code: 4410,
            reason: "host lost".into()
        }
    );
    let took = started.elapsed();
    assert!(
        (Duration::from_millis(250)..Duration::from_millis(900)).contains(&took),
        "{took:?}"
    );
    drop(host);
}

#[tokio::test]
async fn a_live_host_is_kept_by_pings_alone_and_a_guest_leaving_changes_nothing() {
    let relay = fast().await;
    let (mut host, mut guests) = relay.room("LIVE0001", "host-view", 2).await;
    let leaver = guests.pop().unwrap();
    let leaver_id = leaver.id;
    drop(leaver);
    assert_eq!(
        host.text("presence").await,
        json!({ "t": "presence", "member": leaver_id, "online": false })
    );
    assert_eq!(guests[0].text("presence").await["member"], leaver_id);
    // Three timeouts' worth of idleness: both ends only answer pings.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1200);
    let guest = &mut guests[0];
    tokio::select! {
        _ = tokio::time::sleep_until(deadline) => {}
        event = host.event() => panic!("host got {event:?}"),
        event = guest.event() => panic!("guest got {event:?}"),
    }
    host.send_frame(PATCH, 0, 1, b"still here").await;
    assert_eq!(guest.frame().await.1, b"still here");
}

#[tokio::test]
async fn the_default_host_timings_are_five_and_fifteen_seconds() {
    let timing = w_relay::Timing::default();
    assert_eq!(timing.host_ping_interval, Duration::from_secs(5));
    assert_eq!(timing.host_timeout, Duration::from_secs(15));
    assert_eq!(timing.host_grace, Duration::from_secs(15));
}
