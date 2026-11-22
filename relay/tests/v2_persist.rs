//! Room records that outlive the relay (`ROOMS.md` task 2.4): what is kept,
//! what comes back, and what lapses while the relay is not running.

mod common;

use std::time::Duration;

use common::*;
use serde_json::json;
use w_relay::persist::{SavedRelay, FORMAT};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

#[tokio::test]
async fn a_shared_room_comes_back_with_its_members_roles_and_links() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("PERSIST1", "shared").await;
    let me = host.me.clone();

    // Two members: one stays an editor, one is changed to a viewer.
    let editor = Identity::new();
    let viewer = Identity::new();
    let five = host
        .add_invite(json!({ "maxUses": 5, "ttl": 7 * 86_400 }))
        .await;
    relay.try_redeem("PERSIST1", &five, &editor).await.unwrap();
    relay.try_redeem("PERSIST1", &five, &viewer).await.unwrap();
    let reply = host
        .request(json!({ "t": "member-role", "member": viewer.id(), "role": "viewer" }))
        .await;
    assert_eq!(reply["t"], "ok");

    // Someone removed, a link switched off, and an edit so that the head is not 0.
    let gone = Identity::new();
    let single = host.add_invite(json!({})).await;
    relay.try_redeem("PERSIST1", &single, &gone).await.unwrap();
    host.request(json!({ "t": "member-remove", "member": gone.id() }))
        .await;
    let off = host.add_invite(json!({})).await;
    let listed = host.request(json!({ "t": "invite-list" })).await;
    let off_id = listed["list"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["uses"] == 0 && i["maxUses"] == 1 && i["revoked"] == false)
        .unwrap()["id"]
        .clone();
    host.request(json!({ "t": "invite-revoke", "id": off_id }))
        .await;
    host.send_frame(PATCH, 0, 1, b"an edit").await;
    assert_eq!(host.text("ack").await["seq"], 1);
    let session = host.welcome["room"]["session"].clone();

    // A view-through-host room is one session: it is never kept.
    relay.create("PERSIST2", "host-view").await;

    let saved = relay.relay.export();
    assert_eq!(saved.version, FORMAT);
    assert_eq!(saved.rooms.len(), 1, "only the shared-copy room is kept");
    assert_eq!(saved.rooms[0].id, "PERSIST1");
    assert_eq!(saved.rooms[0].members.len(), 2, "everyone but the host");

    // Through text and back, as the app stores it.
    let text = serde_json::to_string(&saved).unwrap();
    let saved: SavedRelay = serde_json::from_str(&text).unwrap();

    let again = TestRelay::start().await;
    assert_eq!(again.relay.import(saved).unwrap(), 1);

    // The host signs in, it does not have to make the room again. The order of edits starts over.
    let host2 = again.auth("PERSIST1", &me).await;
    assert_eq!(host2.welcome["self"]["role"], "host");
    assert_eq!(host2.welcome["room"]["head"], 0);
    assert_ne!(host2.welcome["room"]["session"], session);
    assert_eq!(host2.welcome["roster"].as_array().unwrap().len(), 3);

    let back = again.auth("PERSIST1", &editor).await;
    assert_eq!(back.welcome["self"]["role"], "editor");
    let back = again.auth("PERSIST1", &viewer).await;
    assert_eq!(back.welcome["self"]["role"], "viewer");

    // Removal is remembered, and so is the link that was switched off.
    let closed = again.try_auth("PERSIST1", &gone).await.err().unwrap();
    assert_eq!(closed.code, 4403);
    let closed = again
        .try_redeem("PERSIST1", &off, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed.reason, "invite revoked");
    let closed = again
        .try_redeem("PERSIST1", &single, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed.reason, "invite revoked");

    // The link for five has three uses left, not five again.
    for _ in 0..3 {
        let joined = again
            .try_redeem("PERSIST1", &five, &Identity::new())
            .await
            .unwrap();
        assert!(joined.welcome["invite"]["wrappedKey"].is_string());
    }
    let closed = again
        .try_redeem("PERSIST1", &five, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed.reason, "invite already used");
}

#[tokio::test]
async fn what_lapsed_while_the_relay_was_off_does_not_come_back() {
    let relay = TestRelay::start().await;
    let (mut host, members) = relay.room("LAPSE001", "shared", 1).await;
    let me = host.me.clone();
    let member = members[0].me.clone();
    drop(members);
    let hour = host.add_invite(json!({ "ttl": 3600 })).await;
    let week = host
        .add_invite(json!({ "ttl": 7 * 86_400, "maxUses": 0 }))
        .await;
    relay.create("LAPSE002", "shared").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let saved = relay.relay.export();
    assert_eq!(saved.rooms.len(), 2);

    // Two hours later: the hour link is over, the week link is not.
    let later = TestRelay::start().await;
    later.faults.advance_clock(DAY / 12);
    assert_eq!(later.relay.import(saved.clone()).unwrap(), 2);
    later.auth("LAPSE001", &me).await;
    later.auth("LAPSE001", &member).await;
    let closed = later
        .try_redeem("LAPSE001", &hour, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed.reason, "invite expired");
    later
        .try_redeem("LAPSE001", &week, &Identity::new())
        .await
        .unwrap();

    // Thirty-one days later: the member has lapsed, and so has the room nobody came back to.
    let much_later = TestRelay::start().await;
    much_later.faults.advance_clock(31 * DAY);
    assert_eq!(much_later.relay.import(saved).unwrap(), 0);
    let closed = much_later.try_auth("LAPSE001", &me).await.err().unwrap();
    assert_eq!(closed.code, 4404);
}

#[tokio::test]
async fn a_deleted_room_is_not_kept_but_its_id_still_says_so() {
    let relay = TestRelay::start().await;
    let (mut host, members) = relay.room("DELETED1", "shared", 1).await;
    let member = members[0].me.clone();
    host.send_json(json!({ "t": "room-delete" })).await;
    assert_eq!(host.closed().await.code, 4410);

    let saved = relay.relay.export();
    assert!(saved.rooms.is_empty());
    assert_eq!(saved.tombstones.len(), 1);
    let text = serde_json::to_string(&saved).unwrap();
    assert!(
        !text.contains(&member.key()),
        "nothing of the room's members is left"
    );

    let again = TestRelay::start().await;
    again.relay.import(saved).unwrap();
    let closed = again.try_auth("DELETED1", &member).await.err().unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4410,
            reason: "room deleted".into()
        }
    );
}

#[tokio::test]
async fn a_record_this_relay_cannot_read_is_refused_whole() {
    let relay = TestRelay::start().await;
    relay.create("FORMAT01", "shared").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut newer = relay.relay.export();
    newer.version = FORMAT + 1;
    let again = TestRelay::start().await;
    assert!(again.relay.import(newer).is_err());
    assert_eq!(again.relay.stats().rooms, 0);

    // Damaged entries are left out one by one; the rest comes back.
    let mut damaged = relay.relay.export();
    let mut copy = damaged.rooms[0].clone();
    copy.id = "not a room id".into();
    damaged.rooms.push(copy);
    let mut copy = damaged.rooms[0].clone();
    copy.id = "FORMAT02".into();
    copy.host = "not a key".into();
    damaged.rooms.push(copy);
    assert_eq!(again.relay.import(damaged).unwrap(), 1);
    assert_eq!(again.relay.stats().rooms, 1);

    // A room that is already there is not replaced.
    assert_eq!(again.relay.import(relay.relay.export()).unwrap(), 0);
}

#[test]
fn the_format_has_a_version_and_a_place_for_key_epochs() {
    let text = r#"{"version":1,"rooms":[{"id":"K7Q2M9XA4TDP","type":"shared","epoch":3,
        "host":"_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg","members":[],"removed":[],"invites":[],
        "lastActive":5,"somethingNewer":true}],"tombstones":[]}"#;
    let saved: SavedRelay = serde_json::from_str(text).unwrap();
    assert_eq!(saved.rooms[0].epoch, 3);
    // Fields this version does not know are ignored, not an error.
    let out = serde_json::to_value(&saved).unwrap();
    assert_eq!(out["version"], 1);
    assert_eq!(out["rooms"][0]["epoch"], 3);
    assert_eq!(out["rooms"][0]["type"], "shared");
}

#[tokio::test]
async fn kept_rooms_never_fill_the_relay() {
    let relay = TestRelay::start().await;
    relay.create("KEPT0001", "shared").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let one = relay.relay.export().rooms[0].clone();
    // Six rooms, each used an hour after the one before.
    let mut saved = relay.relay.export();
    saved.rooms = (0..6u64)
        .map(|n| {
            let mut room = one.clone();
            room.id = format!("KEPT000{}", n + 2);
            room.last_active = one.last_active - (5 - n) * 3_600_000;
            room
        })
        .collect();

    // A relay with space for four rooms takes two back: the two used last.
    let small = TestRelay::with(|c| c.limits.max_rooms = 4).await;
    assert_eq!(small.relay.import(saved).unwrap(), 2);
    let ids: Vec<String> = small.relay.rooms().into_iter().map(|r| r.id).collect();
    assert_eq!(ids, ["KEPT0006", "KEPT0007"]);
    // So a new room can still be made.
    small.create("NEWROOM1", "shared").await;
    assert_eq!(small.relay.stats().rooms, 3);

    // The relay inside the desktop app has space for more than one person keeps open.
    assert_eq!(w_relay::RelayConfig::embedded().limits.max_rooms, 32);
}
