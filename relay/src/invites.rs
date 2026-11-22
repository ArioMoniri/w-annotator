//! Invites: capability links the host registers with the relay.
//!
//! The relay never sees the secret in the link. It holds the invite id, a key
//! to check a redeemer's proof with, and an opaque blob (the room key wrapped
//! for the invitee) that it hands over once the proof is right.

use serde_json::{json, Value};

use crate::auth::b64;
use crate::auth::{unb64, verify_proof};
use crate::limits::{Limits, Timing};
use crate::persist::SavedInvite;
use crate::rooms::Role;

/// Longest wrapped room key the relay stores, in base64 characters.
pub const MAX_WRAPPED_KEY_CHARS: usize = 512;

/// Why a redeem attempt was turned away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No such invite, or the proof is wrong.
    NotValid,
    Expired,
    Used,
    Revoked,
    /// Too many wrong proofs; try again later.
    Locked,
}

impl Refusal {
    /// Close reason sent with the close code.
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::NotValid => "invite not valid",
            Refusal::Expired => "invite expired",
            Refusal::Used => "invite already used",
            Refusal::Revoked => "invite revoked",
            Refusal::Locked => "too many attempts",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Invite {
    auth_key: [u8; 32],
    wrapped_key: String,
    pub role: Role,
    pub expires_ms: u64,
    /// 0 means any number of uses until expiry.
    pub max_uses: u32,
    pub uses: u32,
    pub revoked: bool,
    failures: u32,
    locked_until_ms: u64,
}

/// A valid id is 16 to 64 characters of the URL-safe base64 alphabet.
pub fn valid_id(id: &str) -> bool {
    (16..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Invite {
    /// Builds an invite from an `invite-add` message. `Err` names the bad field.
    pub fn from_request(
        msg: &Value,
        single_use_only: bool,
        now_ms: u64,
        timing: &Timing,
    ) -> Result<(String, Invite), &'static str> {
        let id = msg.get("id").and_then(Value::as_str).ok_or("id")?;
        if !valid_id(id) {
            return Err("id");
        }
        let auth_key = msg
            .get("authKey")
            .and_then(Value::as_str)
            .and_then(unb64::<32>)
            .ok_or("authKey")?;
        let wrapped_key = match msg.get("wrappedKey") {
            None | Some(Value::Null) => "",
            Some(Value::String(s)) if s.len() <= MAX_WRAPPED_KEY_CHARS => s.as_str(),
            Some(_) => return Err("wrappedKey"),
        };
        let role = match msg.get("role") {
            None | Some(Value::Null) => Role::Editor,
            Some(Value::String(s)) => match Role::parse(s) {
                Some(Role::Host) | None => return Err("role"),
                Some(role) => role,
            },
            Some(_) => return Err("role"),
        };
        let ttl_ms = match msg.get("ttl") {
            None | Some(Value::Null) => timing.invite_default_ttl.as_millis() as u64,
            Some(v) => {
                let secs = v.as_u64().ok_or("ttl")?;
                if secs == 0 || secs > timing.invite_max_ttl.as_secs() {
                    return Err("ttl");
                }
                secs * 1000
            }
        };
        let max_uses = match msg.get("maxUses") {
            None | Some(Value::Null) => 1,
            Some(v) => u32::try_from(v.as_u64().ok_or("maxUses")?).map_err(|_| "maxUses")?,
        };
        if single_use_only && max_uses != 1 {
            return Err("maxUses");
        }
        Ok((
            id.to_owned(),
            Invite {
                auth_key,
                wrapped_key: wrapped_key.to_owned(),
                role,
                expires_ms: now_ms.saturating_add(ttl_ms),
                max_uses,
                uses: 0,
                revoked: false,
                failures: 0,
                locked_until_ms: 0,
            },
        ))
    }

    /// Whether the invite can still admit someone.
    pub fn live(&self, now_ms: u64) -> bool {
        !self.revoked
            && now_ms < self.expires_ms
            && (self.max_uses == 0 || self.uses < self.max_uses)
    }

    /// Checks a redeem attempt without spending a use. A wrong proof counts
    /// towards the lock.
    pub fn check(
        &mut self,
        proof_input: &[u8],
        proof: &[u8; 32],
        now_ms: u64,
        limits: &Limits,
        timing: &Timing,
    ) -> Result<(), Refusal> {
        if self.revoked {
            return Err(Refusal::Revoked);
        }
        if now_ms >= self.expires_ms {
            return Err(Refusal::Expired);
        }
        if self.max_uses != 0 && self.uses >= self.max_uses {
            return Err(Refusal::Used);
        }
        if now_ms < self.locked_until_ms {
            return Err(Refusal::Locked);
        }
        if !verify_proof(&self.auth_key, proof_input, proof) {
            self.failures += 1;
            if self.failures >= limits.invite_failures {
                self.failures = 0;
                self.locked_until_ms = now_ms.saturating_add(timing.invite_lock.as_millis() as u64);
            }
            return Err(Refusal::NotValid);
        }
        self.failures = 0;
        Ok(())
    }

    /// Spends one use and returns the wrapped room key for the new member.
    pub fn spend(&mut self) -> &str {
        self.uses = self.uses.saturating_add(1);
        &self.wrapped_key
    }

    /// Whether the sweeper may drop the record.
    pub fn forgettable(&self, now_ms: u64, timing: &Timing) -> bool {
        now_ms
            >= self
                .expires_ms
                .saturating_add(timing.invite_forget.as_millis() as u64)
    }

    /// The invite as an embedding app stores it (`persist`).
    pub(crate) fn to_saved(&self, id: &str) -> SavedInvite {
        SavedInvite {
            id: id.to_owned(),
            auth_key: b64(&self.auth_key),
            wrapped_key: self.wrapped_key.clone(),
            role: self.role.as_str().to_owned(),
            expires_at: self.expires_ms,
            max_uses: self.max_uses,
            uses: self.uses,
            revoked: self.revoked,
        }
    }

    /// An invite read back from storage, or `None` when it is not one. Wrong
    /// proofs counted before the restart are forgotten.
    pub(crate) fn from_saved(saved: &SavedInvite) -> Option<(String, Invite)> {
        let role = match Role::parse(&saved.role) {
            Some(Role::Host) | None => return None,
            Some(role) => role,
        };
        if !valid_id(&saved.id) || saved.wrapped_key.len() > MAX_WRAPPED_KEY_CHARS {
            return None;
        }
        Some((
            saved.id.clone(),
            Invite {
                auth_key: unb64::<32>(&saved.auth_key)?,
                wrapped_key: saved.wrapped_key.clone(),
                role,
                expires_ms: saved.expires_at,
                max_uses: saved.max_uses,
                uses: saved.uses,
                revoked: saved.revoked,
                failures: 0,
                locked_until_ms: 0,
            },
        ))
    }

    /// What the host sees in `invite-added` and `invites`. Never the auth key.
    pub fn public(&self, id: &str) -> Value {
        json!({
            "id": id,
            "role": self.role.as_str(),
            "expiresAt": self.expires_ms,
            "maxUses": self.max_uses,
            "uses": self.uses,
            "revoked": self.revoked,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::b64;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    const KEY: [u8; 32] = [7u8; 32];
    const ID: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    fn request(extra: Value) -> Value {
        let mut msg = json!({ "t": "invite-add", "id": ID, "authKey": b64(&KEY) });
        msg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        msg
    }

    fn make(extra: Value) -> Result<Invite, &'static str> {
        Invite::from_request(&request(extra), false, 1_000, &Timing::default()).map(|(_, i)| i)
    }

    fn proof(input: &[u8]) -> [u8; 32] {
        let mut mac = Hmac::<Sha256>::new_from_slice(&KEY).unwrap();
        mac.update(input);
        mac.finalize().into_bytes().into()
    }

    #[test]
    fn defaults_are_single_use_editor_for_a_day() {
        let invite = make(json!({})).unwrap();
        assert_eq!(invite.max_uses, 1);
        assert_eq!(invite.role, Role::Editor);
        assert_eq!(invite.expires_ms, 1_000 + 86_400_000);
        assert!(invite.live(1_000));
        assert_eq!(
            invite.public(ID),
            json!({ "id": ID, "role": "editor", "expiresAt": 86_401_000u64, "maxUses": 1, "uses": 0, "revoked": false })
        );
    }

    #[test]
    fn bad_fields_are_named() {
        assert_eq!(make(json!({ "id": "short" })).unwrap_err(), "id");
        assert_eq!(
            make(json!({ "id": "has space in it!!!!" })).unwrap_err(),
            "id"
        );
        assert_eq!(make(json!({ "id": "A".repeat(65) })).unwrap_err(), "id");
        assert_eq!(make(json!({ "authKey": "AAAA" })).unwrap_err(), "authKey");
        assert_eq!(make(json!({ "authKey": 5 })).unwrap_err(), "authKey");
        assert_eq!(make(json!({ "role": "host" })).unwrap_err(), "role");
        assert_eq!(make(json!({ "role": "admin" })).unwrap_err(), "role");
        assert_eq!(make(json!({ "ttl": 0 })).unwrap_err(), "ttl");
        assert_eq!(make(json!({ "ttl": 7 * 86_400 + 1 })).unwrap_err(), "ttl");
        assert_eq!(make(json!({ "ttl": -5 })).unwrap_err(), "ttl");
        assert_eq!(make(json!({ "ttl": "soon" })).unwrap_err(), "ttl");
        assert_eq!(
            make(json!({ "maxUses": 4_294_967_296u64 })).unwrap_err(),
            "maxUses"
        );
        assert_eq!(
            make(json!({ "wrappedKey": "A".repeat(MAX_WRAPPED_KEY_CHARS + 1) })).unwrap_err(),
            "wrappedKey"
        );
        assert!(
            make(json!({ "ttl": 3600, "maxUses": 0, "role": "viewer", "wrappedKey": "abc" }))
                .is_ok()
        );
        // View-through-host rooms only hand out single-use links.
        let multi = request(json!({ "maxUses": 5 }));
        assert_eq!(
            Invite::from_request(&multi, true, 0, &Timing::default()).unwrap_err(),
            "maxUses"
        );
    }

    #[test]
    fn expiry_use_count_and_revocation_refuse_in_that_order_of_meaning() {
        let (limits, timing) = (Limits::default(), Timing::default());
        let input = b"proof input";
        let good = proof(input);

        let mut invite = make(json!({ "ttl": 60 })).unwrap();
        assert_eq!(invite.check(input, &good, 2_000, &limits, &timing), Ok(()));
        assert_eq!(
            invite.check(input, &good, 61_000, &limits, &timing),
            Err(Refusal::Expired)
        );

        let mut invite = make(json!({})).unwrap();
        assert_eq!(invite.check(input, &good, 2_000, &limits, &timing), Ok(()));
        invite.spend();
        assert_eq!(
            invite.check(input, &good, 2_000, &limits, &timing),
            Err(Refusal::Used)
        );
        assert!(!invite.live(2_000));

        let mut invite = make(json!({ "maxUses": 0 })).unwrap();
        for _ in 0..100 {
            assert_eq!(invite.check(input, &good, 2_000, &limits, &timing), Ok(()));
            invite.spend();
        }
        invite.revoked = true;
        assert_eq!(
            invite.check(input, &good, 2_000, &limits, &timing),
            Err(Refusal::Revoked)
        );
    }

    #[test]
    fn five_wrong_proofs_lock_the_invite_for_ten_minutes() {
        let (limits, timing) = (Limits::default(), Timing::default());
        let input = b"proof input";
        let good = proof(input);
        let bad = [0u8; 32];
        let mut invite = make(json!({})).unwrap();
        for _ in 0..5 {
            assert_eq!(
                invite.check(input, &bad, 2_000, &limits, &timing),
                Err(Refusal::NotValid)
            );
        }
        // Even the right proof waits out the lock.
        assert_eq!(
            invite.check(input, &good, 2_000, &limits, &timing),
            Err(Refusal::Locked)
        );
        assert_eq!(
            invite.check(input, &good, 2_000 + 599_999, &limits, &timing),
            Err(Refusal::Locked)
        );
        assert_eq!(
            invite.check(input, &good, 2_000 + 600_000, &limits, &timing),
            Ok(())
        );
    }

    #[test]
    fn a_right_proof_clears_the_failure_count() {
        let (limits, timing) = (Limits::default(), Timing::default());
        let input = b"proof input";
        let good = proof(input);
        let mut invite = make(json!({ "maxUses": 0 })).unwrap();
        for _ in 0..3 {
            for _ in 0..4 {
                let _ = invite.check(input, &[1u8; 32], 2_000, &limits, &timing);
            }
            assert_eq!(invite.check(input, &good, 2_000, &limits, &timing), Ok(()));
        }
    }

    #[test]
    fn records_are_forgotten_a_day_after_expiry() {
        let timing = Timing::default();
        let invite = make(json!({ "ttl": 60 })).unwrap();
        assert!(!invite.forgettable(61_000 + 86_399_999, &timing));
        assert!(invite.forgettable(61_000 + 86_400_000, &timing));
    }
}
