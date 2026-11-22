//! Room records that outlive the relay (`ROOMS.md` task 2.4).
//!
//! The relay itself writes nothing to disk. An embedding app asks for
//! [`Relay::export`](crate::Relay::export), stores the answer where it sees
//! fit, and hands it back to [`Relay::import`](crate::Relay::import) the next
//! time it starts. What is kept is what a room needs for its members to sign
//! in again: who they are, their roles, the links that are still open with
//! their remaining uses and expiry, who was removed, and which ids were
//! deleted. **No payload is kept**: not the edit log, not a name, not a voxel.
//! The order of edits therefore starts over (`room.session` changes and
//! `head` is 0), exactly as when the host makes the room again after a relay
//! restart, and members merge against the host.
//!
//! Only shared-copy rooms are kept. A view-through-host room is one session.
//!
//! The format is versioned by [`FORMAT`]. A reader ignores fields it does not
//! know and refuses a record with a higher version whole. `epoch` is the
//! room's key epoch: when key rotation is built, whatever the relay must
//! remember per epoch belongs next to it in [`SavedRoom`], with a new
//! `FORMAT` only if an older reader would get it wrong.

use serde::{Deserialize, Serialize};

/// Version of the saved form. Raise it when an older reader would misread a record.
pub const FORMAT: u32 = 1;

/// Everything a relay keeps across a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedRelay {
    pub version: u32,
    #[serde(default)]
    pub rooms: Vec<SavedRoom>,
    /// Ids of deleted rooms, which answer 4410 for 30 days.
    #[serde(default)]
    pub tombstones: Vec<SavedTombstone>,
}

impl Default for SavedRelay {
    fn default() -> Self {
        SavedRelay {
            version: FORMAT,
            rooms: Vec::new(),
            tombstones: Vec::new(),
        }
    }
}

impl SavedRelay {
    /// True when there is nothing worth storing.
    pub fn is_empty(&self) -> bool {
        self.rooms.is_empty() && self.tombstones.is_empty()
    }
}

/// One shared-copy room. Keys are unpadded URL-safe base64, times are
/// milliseconds since the Unix epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRoom {
    pub id: String,
    /// Always `shared` in format 1.
    #[serde(rename = "type")]
    pub kind: String,
    /// The key epoch every frame must carry. 1 until keys are rotated.
    pub epoch: u32,
    /// The host's public key.
    pub host: String,
    /// Everyone but the host.
    #[serde(default)]
    pub members: Vec<SavedMember>,
    /// Keys of people the host removed; they never work again.
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default)]
    pub invites: Vec<SavedInvite>,
    /// When anyone was last connected.
    pub last_active: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMember {
    pub key: String,
    #[serde(default)]
    pub xkey: Option<String>,
    /// `editor` or `viewer`.
    pub role: String,
    /// The invite this member came in through.
    #[serde(default)]
    pub invite: Option<String>,
    /// Membership lapses 30 days after this.
    pub last_seen: u64,
}

/// An invite as the host registered it, with what has been used of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedInvite {
    pub id: String,
    pub auth_key: String,
    #[serde(default)]
    pub wrapped_key: String,
    pub role: String,
    pub expires_at: u64,
    /// 0 means any number of uses until expiry.
    pub max_uses: u32,
    pub uses: u32,
    #[serde(default)]
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTombstone {
    pub id: String,
    pub at: u64,
    /// `room deleted`, `room closed` or `host lost`.
    pub reason: String,
}

/// Why a saved record was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportError {
    /// Written by a newer relay. Nothing was read, and the record should be left as it is.
    Newer(u32),
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::Newer(version) => write!(
                f,
                "the saved rooms are in format {version}, this relay reads up to {FORMAT}"
            ),
        }
    }
}

impl std::error::Error for ImportError {}
