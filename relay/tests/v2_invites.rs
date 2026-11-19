//! Invites: register, redeem with a proof, expiry, use counts, revocation.

mod common;

use std::time::Duration;

use common::*;
use serde_json::{json, Value};

const HOUR: Duration = Duration::from_secs(60 * 60);

#[test]
fn the_documented_test_vectors_hold() {
    // docs/design/ROOMS-PROTOCOL.md, "Test vectors".
    let secret: [u8; 16] = std::array::from_fn(|i| i as u8);
    assert_eq!(b64(&secret), "AAECAwQFBgcICQoLDA0ODw");
    let link = InviteLink::from_secret(secret);
    assert_eq!(link.id, "o7XlWLz18---2w9iH1Eibg");
    assert_eq!(
        b64(&link.auth_key),
        "Ev6xTmVvi_PF1s4sBZ0574I-WYcQptT7s2zTWr1B0wk"
    );
    assert_eq!(
        b64(&hkdf(&secret, "w-rooms/2 invite wrap", 32)),
        "KzS7nbWnBhOGTNPJJh0PNDD9km4D4s4nyLiwjLD5nLk"
    );
    let key = b64(&[1u8; 32]);
    let nonce = b64(&[2u8; 32]);
    assert_eq!(
        link.proof("K7Q2M9XA4TDP", &nonce, &key),
        "Ee54exLwUMB302Rnxij9CVCOLifBmAQwuL4ObJ1v_RE"
    );

    let member = Identity::from_seed([9u8; 32]);
    assert_eq!(member.key(), "_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg");
    assert_eq!(member.id(), 630_768_347);
    assert_eq!(
        member.sign("auth", "K7Q2M9XA4TDP", &nonce),
        "RA6G6hqKeo4SjyGYi2a-HgiEhanc_D8SKC80umU9m0jJD2E46pzO7s8g-dLWlRrVU65LYnMXsHFcHOIqR-TbDQ"
    );
    // The relay derives the same member id and accepts that signature.
    let key_bytes = member.key_bytes();
    assert_eq!(w_relay::auth::member_id(&key_bytes), 630_768_347);
    let sig: [u8; 64] = w_relay::auth::unb64(&member.sign("auth", "K7Q2M9XA4TDP", &nonce)).unwrap();
    let input = w_relay::auth::signing_input("auth", "K7Q2M9XA4TDP", &nonce);
    assert!(w_relay::auth::verify_signature(&key_bytes, &input, &sig));
}

#[tokio::test]
async fn a_redeemed_invite_becomes_a_membership() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE01", "shared").await;
    let link = InviteLink::new();
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let added = host.request(link.registration(json!({}))).await;
    assert_eq!(added["t"], "invite-added");
    let invite = &added["invite"];
    assert_eq!(invite["id"], link.id.as_str());
    assert_eq!(invite["role"], "editor");
    assert_eq!(invite["maxUses"], 1);
    assert_eq!(invite["uses"], 0);
    assert_eq!(invite["revoked"], false);
    let expires = invite["expiresAt"].as_u64().unwrap();
    let day = 24 * 60 * 60 * 1000;
    assert!((before + day..before + day + 5_000).contains(&expires));
    // The reply never repeats the secrets the host sent.
    assert!(added.to_string().find(&b64(&link.auth_key)).is_none());

    let ben = Identity::new();
    let joined = relay.try_redeem("INVITE01", &link, &ben).await.unwrap();
    assert_eq!(
        joined.welcome["self"],
        json!({ "id": ben.id(), "role": "editor" })
    );
    // The wrapped room key comes back to the redeemer, untouched.
    assert_eq!(
        joined.welcome["invite"],
        json!({ "wrappedKey": "d3JhcHBlZC1yb29tLWtleQ" })
    );
    let roster = host.text("roster").await;
    let ids: Vec<&Value> = roster["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| &m["id"])
        .collect();
    assert!(ids.contains(&&json!(ben.id())));

    // From now on Ben signs in with his key; the link is spent.
    drop(joined);
    let again = relay.auth("INVITE01", &ben).await;
    assert!(again.welcome.get("invite").is_none());
    let list = host.request(json!({ "t": "invite-list" })).await;
    assert_eq!(list["t"], "invites");
    assert_eq!(list["list"][0]["uses"], 1);
}

#[tokio::test]
async fn a_single_use_invite_cannot_be_used_twice() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE02", "shared").await;
    let link = host.add_invite(json!({})).await;
    relay
        .try_redeem("INVITE02", &link, &Identity::new())
        .await
        .unwrap();
    let closed = relay
        .try_redeem("INVITE02", &link, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4408,
            reason: "invite already used".into()
        }
    );
    assert_eq!(
        host.text("roster").await["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn an_invite_expires_after_a_day_by_default_or_when_the_host_says() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE03", "shared").await;
    let day_link = host.add_invite(json!({})).await;
    let hour_link = host.add_invite(json!({ "ttl": 3600 })).await;
    let week_link = host.add_invite(json!({ "ttl": 7 * 24 * 3600 })).await;
    let expired = Closed {
        code: 4408,
        reason: "invite expired".into(),
    };

    let other_hour_link = host.add_invite(json!({ "ttl": 3600 })).await;

    // Five seconds before the hour is up it still works; on the hour it does not.
    relay.faults.advance_clock(HOUR - Duration::from_secs(5));
    relay
        .try_redeem("INVITE03", &other_hour_link, &Identity::new())
        .await
        .unwrap();
    relay.faults.advance_clock(Duration::from_secs(5));
    let closed = relay
        .try_redeem("INVITE03", &hour_link, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed, expired);

    relay
        .faults
        .advance_clock(22 * HOUR + Duration::from_secs(59 * 60));
    let still_good = host.add_invite(json!({})).await; // made now, good for a day from now
    relay.faults.advance_clock(Duration::from_secs(60));
    let closed = relay
        .try_redeem("INVITE03", &day_link, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed, expired);

    relay
        .try_redeem("INVITE03", &week_link, &Identity::new())
        .await
        .unwrap();
    relay
        .try_redeem("INVITE03", &still_good, &Identity::new())
        .await
        .unwrap();
}

#[tokio::test]
async fn a_revoked_invite_is_refused() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE04", "shared").await;
    let link = host.add_invite(json!({ "maxUses": 0 })).await;
    relay
        .try_redeem("INVITE04", &link, &Identity::new())
        .await
        .unwrap();

    let reply = host
        .request(json!({ "t": "invite-revoke", "id": link.id }))
        .await;
    assert_eq!(reply["t"], "ok");
    assert_eq!(reply["re"], "invite-revoke");
    let closed = relay
        .try_redeem("INVITE04", &link, &Identity::new())
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
    // Whoever got in before the revocation stays; removing them is a separate act.
    let list = host.request(json!({ "t": "invite-list" })).await;
    assert_eq!(list["list"][0]["revoked"], true);
    assert_eq!(list["list"][0]["uses"], 1);

    let reply = host
        .request(json!({ "t": "invite-revoke", "id": "AAAAAAAAAAAAAAAAAAAAAA" }))
        .await;
    assert_eq!(reply["code"], "not-found");
}

#[tokio::test]
async fn a_wrong_proof_is_refused_and_five_of_them_lock_the_invite() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE05", "shared").await;
    let link = host.add_invite(json!({})).await;
    // Someone who knows the invite id but not the secret behind it.
    let mut guesser = link.clone();
    guesser.auth_key = [0u8; 32];
    let not_valid = Closed {
        code: 4408,
        reason: "invite not valid".into(),
    };

    for _ in 0..5 {
        let closed = relay
            .try_redeem("INVITE05", &guesser, &Identity::new())
            .await
            .err()
            .unwrap();
        assert_eq!(closed, not_valid);
    }
    // Locked: even the real link waits ten minutes.
    let ben = Identity::new();
    let closed = relay
        .try_redeem("INVITE05", &link, &ben)
        .await
        .err()
        .unwrap();
    assert_eq!(
        closed,
        Closed {
            code: 4429,
            reason: "too many attempts".into()
        }
    );
    relay.faults.advance_clock(Duration::from_secs(10 * 60));
    relay.try_redeem("INVITE05", &link, &ben).await.unwrap();

    // A proof made for another key or another nonce is a wrong proof.
    let link = host.add_invite(json!({})).await;
    let eve = Identity::new();
    let closed = relay
        .handshake("INVITE05", &eve, |nonce| {
            json!({ "t": "redeem", "proto": 2, "invite": link.id, "key": eve.key(),
                    "proof": link.proof("INVITE05", nonce, &ben.key()),
                    "sig": eve.sign("redeem", "INVITE05", nonce) })
        })
        .await
        .err()
        .unwrap();
    assert_eq!(closed, not_valid);
    // An invite id the room does not know looks the same.
    let closed = relay
        .try_redeem("INVITE05", &InviteLink::new(), &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed, not_valid);
}

#[tokio::test]
async fn two_people_racing_for_a_single_use_invite_one_wins() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE06", "shared").await;
    for _ in 0..10 {
        let link = host.add_invite(json!({})).await;
        let (a, b) = (Identity::new(), Identity::new());
        let (first, second) = tokio::join!(
            relay.try_redeem("INVITE06", &link, &a),
            relay.try_redeem("INVITE06", &link, &b)
        );
        let (winner, loser) = match (first, second) {
            (Ok(w), Err(l)) | (Err(l), Ok(w)) => (w, l),
            (Ok(_), Ok(_)) => panic!("both redeemed a single-use invite"),
            (Err(a), Err(b)) => panic!("nobody got in: {a:?} {b:?}"),
        };
        assert_eq!(
            loser,
            Closed {
                code: 4408,
                reason: "invite already used".into()
            }
        );
        host.request(json!({ "t": "member-remove", "member": winner.id }))
            .await;
    }
}

#[tokio::test]
async fn use_counts_can_be_several_or_unlimited_until_expiry() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE07", "shared").await;
    let three = host.add_invite(json!({ "maxUses": 3 })).await;
    for _ in 0..3 {
        relay
            .try_redeem("INVITE07", &three, &Identity::new())
            .await
            .unwrap();
    }
    let closed = relay
        .try_redeem("INVITE07", &three, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed.reason, "invite already used");

    let open = host.add_invite(json!({ "maxUses": 0, "ttl": 3600 })).await;
    for _ in 0..6 {
        relay
            .try_redeem("INVITE07", &open, &Identity::new())
            .await
            .unwrap();
    }
    relay.faults.advance_clock(HOUR);
    let closed = relay
        .try_redeem("INVITE07", &open, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed.reason, "invite expired");
}

#[tokio::test]
async fn redeeming_again_with_the_same_key_signs_in_without_spending_a_use() {
    // A client whose connection died before `welcome` arrived retries `redeem`.
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE08", "shared").await;
    let link = host.add_invite(json!({})).await;
    let ben = Identity::new();
    drop(relay.try_redeem("INVITE08", &link, &ben).await.unwrap());
    let again = relay.try_redeem("INVITE08", &link, &ben).await.unwrap();
    assert_eq!(again.welcome["self"]["id"], ben.id());
    assert!(again.welcome.get("invite").is_none());
    let list = host.request(json!({ "t": "invite-list" })).await;
    assert_eq!(list["list"][0]["uses"], 1);
}

#[tokio::test]
async fn invite_requests_are_validated_and_bounded() {
    let relay = TestRelay::with(|c| c.limits.max_invites = 3).await;
    let mut host = relay.create("INVITE09", "shared").await;
    for bad in [
        json!({ "id": "short" }),
        json!({ "authKey": "AAAA" }),
        json!({ "role": "host" }),
        json!({ "ttl": 7 * 24 * 3600 + 1 }),
        json!({ "ttl": 0 }),
        json!({ "maxUses": -1 }),
        json!({ "wrappedKey": "x".repeat(513) }),
    ] {
        let reply = host
            .request(InviteLink::new().registration(bad.clone()))
            .await;
        assert_eq!(reply["code"], "bad-message", "{bad}");
    }
    let first = host.add_invite(json!({})).await;
    assert_eq!(
        host.request(first.registration(json!({}))).await["code"],
        "exists"
    );
    host.add_invite(json!({})).await;
    host.add_invite(json!({})).await;
    // Three live links is this relay's limit.
    let reply = host
        .request(InviteLink::new().registration(json!({})))
        .await;
    assert_eq!(reply["code"], "limit");
    // A spent link makes room for a new one.
    relay
        .try_redeem("INVITE09", &first, &Identity::new())
        .await
        .unwrap();
    host.add_invite(json!({})).await;
    let list = host.request(json!({ "t": "invite-list" })).await;
    assert_eq!(list["list"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn spent_and_expired_invites_are_forgotten_a_day_after_expiry() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE10", "shared").await;
    let link = host.add_invite(json!({ "ttl": 3600 })).await;
    host.request(json!({ "t": "invite-revoke", "id": link.id }))
        .await;
    relay.faults.advance_clock(24 * HOUR);
    relay.faults.sweep();
    let list = host.request(json!({ "t": "invite-list" })).await;
    assert_eq!(list["list"].as_array().unwrap().len(), 1);
    relay.faults.advance_clock(HOUR);
    relay.faults.sweep();
    let list = host.request(json!({ "t": "invite-list" })).await;
    assert_eq!(list["list"], json!([]));
    // Forgotten means unknown, which reads the same as never valid.
    let closed = relay
        .try_redeem("INVITE10", &link, &Identity::new())
        .await
        .err()
        .unwrap();
    assert_eq!(closed.reason, "invite not valid");
}

#[tokio::test]
async fn view_through_host_links_are_always_single_use() {
    let relay = TestRelay::start().await;
    let mut host = relay.create("INVITE11", "host-view").await;
    for uses in [0, 2, 5] {
        let reply = host
            .request(InviteLink::new().registration(json!({ "maxUses": uses })))
            .await;
        assert_eq!(reply["code"], "bad-message");
    }
    let link = host.add_invite(json!({ "maxUses": 1 })).await;
    relay
        .try_redeem("INVITE11", &link, &Identity::new())
        .await
        .unwrap();
}
