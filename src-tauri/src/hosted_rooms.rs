//! The file that lets a room hosted by this app outlive the app (`ROOMS.md` task 2.4).
//!
//! It holds what the embedded relay needs for members to sign in again after
//! the host reopens the room: member keys and roles, open invite links with
//! their remaining uses and expiry, removed keys, deleted room ids, and the
//! port the relay listened on, so the address in people's links still works.
//! No image, mask, name or edit is in it; see `w_relay::persist`.
//!
//! The file is `rooms/hosted.json` in the app's local data folder. On macOS
//! and Linux the folder is made for this user only (0700) and the file is
//! written 0600. On Windows the app data folder already belongs to the user.
//!
//! Layout, versioned by `format`:
//!
//! ```json
//! { "format": 1, "port": 8787, "relay": { "version": 1, "rooms": [...], "tombstones": [...] } }
//! ```
//!
//! `relay` is the relay's own record and carries its own version. A file with
//! a higher `format`, or a relay record this build cannot read, is left
//! exactly as it is: the app then hosts without keeping rooms, rather than
//! overwrite what a newer version wrote.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use w_relay::persist::{SavedRelay, FORMAT as RELAY_FORMAT};

/// Folder inside the app's local data folder.
pub const FOLDER: &str = "rooms";
const FILE: &str = "hosted.json";
/// Version of this file's own layout.
pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedFile {
    pub format: u32,
    /// The port the relay last listened on.
    pub port: u16,
    pub relay: SavedRelay,
}

/// What was found on disk.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    /// No file: nothing was hosted, or every room was deleted.
    Nothing,
    Rooms(HostedFile),
    /// A file from a newer version of the app. It must not be written over.
    Newer,
    /// A file that cannot be read. It is replaced at the next write.
    Damaged,
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

pub fn read(dir: &Path) -> Found {
    let bytes = match fs::read(path(dir)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Found::Nothing,
        Err(_) => return Found::Damaged,
    };
    // The versions are looked at first, so a newer file whose shape changed is still recognised.
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Found::Damaged;
    };
    let version = |v: &serde_json::Value| v.as_u64().and_then(|n| u32::try_from(n).ok());
    let (Some(format), Some(relay)) = (
        version(&value["format"]),
        version(&value["relay"]["version"]),
    ) else {
        return Found::Damaged;
    };
    if format > FORMAT || relay > RELAY_FORMAT {
        return Found::Newer;
    }
    match serde_json::from_value::<HostedFile>(value) {
        Ok(file) => Found::Rooms(file),
        Err(_) => Found::Damaged,
    }
}

/// Stores the rooms, or removes the file when there is nothing left to keep.
pub fn write(dir: &Path, port: u16, relay: &SavedRelay) -> io::Result<()> {
    let target = path(dir);
    if relay.is_empty() {
        return match fs::remove_file(&target) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    make_private_dir(dir)?;
    let file = HostedFile {
        format: FORMAT,
        port,
        relay: relay.clone(),
    };
    let bytes = serde_json::to_vec(&file).map_err(io::Error::other)?;
    // A temporary file beside the target, then a rename: a crash never leaves half a file.
    let tmp = dir.join(format!(".{FILE}.{}.part", std::process::id()));
    let result = (|| {
        let mut out = private_file(&tmp)?;
        out.write_all(&bytes)?;
        out.sync_all()?;
        drop(out);
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(unix)]
fn make_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    // The folder may be older than this rule.
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn make_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

#[cfg(unix)]
fn private_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let _ = fs::remove_file(path);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn private_file(path: &Path) -> io::Result<fs::File> {
    fs::File::create(path)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use w_relay::persist::{SavedInvite, SavedMember, SavedRoom, SavedTombstone};

    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "w-annotator-hosted-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// The public key of the documented test vector (`ROOMS-PROTOCOL.md` §16).
    pub const HOST_KEY: &str = "_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg";

    pub fn sample(now_ms: u64) -> SavedRelay {
        SavedRelay {
            version: RELAY_FORMAT,
            rooms: vec![SavedRoom {
                id: "K7Q2M9XA4TDP".into(),
                kind: "shared".into(),
                epoch: 1,
                host: HOST_KEY.into(),
                members: vec![SavedMember {
                    key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE".into(),
                    xkey: None,
                    role: "viewer".into(),
                    invite: Some("o7XlWLz18---2w9iH1Eibg".into()),
                    last_seen: now_ms,
                }],
                removed: vec![],
                invites: vec![SavedInvite {
                    id: "o7XlWLz18---2w9iH1Eibg".into(),
                    auth_key: "Ev6xTmVvi_PF1s4sBZ0574I-WYcQptT7s2zTWr1B0wk".into(),
                    wrapped_key: "abc".into(),
                    role: "editor".into(),
                    expires_at: now_ms + 3_600_000,
                    max_uses: 5,
                    uses: 1,
                    revoked: false,
                }],
                last_active: now_ms,
            }],
            tombstones: vec![SavedTombstone {
                id: "DELETED00001".into(),
                at: now_ms,
                reason: "room deleted".into(),
            }],
        }
    }

    #[test]
    fn rooms_round_trip_with_the_port() {
        let dir = TempDir::new("round");
        assert_eq!(read(&dir.0), Found::Nothing);
        let relay = sample(1_000);
        write(&dir.0, 8790, &relay).unwrap();
        assert_eq!(
            read(&dir.0),
            Found::Rooms(HostedFile {
                format: FORMAT,
                port: 8790,
                relay: relay.clone()
            })
        );
        // The newest write wins, and no temporary file is left behind.
        write(&dir.0, 8791, &relay).unwrap();
        let Found::Rooms(file) = read(&dir.0) else {
            panic!("expected rooms")
        };
        assert_eq!(file.port, 8791);
        let names: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(FILE)]);
    }

    #[test]
    fn the_layout_is_the_documented_one() {
        let dir = TempDir::new("layout");
        write(&dir.0, 8787, &sample(1_000)).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(path(&dir.0)).unwrap()).unwrap();
        assert_eq!(value["format"], 1);
        assert_eq!(value["port"], 8787);
        assert_eq!(value["relay"]["version"], 1);
        let room = &value["relay"]["rooms"][0];
        assert_eq!(room["id"], "K7Q2M9XA4TDP");
        assert_eq!(room["type"], "shared");
        assert_eq!(room["epoch"], 1);
        assert_eq!(room["members"][0]["role"], "viewer");
        assert_eq!(room["invites"][0]["maxUses"], 5);
        assert_eq!(room["invites"][0]["uses"], 1);
        assert_eq!(room["invites"][0]["expiresAt"], 3_601_000);
        // Nothing about an image, a mask, a name or an edit has a place in it.
        let mut keys: Vec<&str> = room
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "epoch",
                "host",
                "id",
                "invites",
                "lastActive",
                "members",
                "removed",
                "type"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_and_its_folder_are_for_this_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("perms");
        // A folder that already exists with wider permissions is narrowed.
        fs::create_dir_all(&dir.0).unwrap();
        fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o755)).unwrap();
        write(&dir.0, 8787, &sample(1_000)).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path(&dir.0)), 0o600);
        assert_eq!(mode(&dir.0), 0o700);
        // Still so after it is written again.
        write(&dir.0, 8787, &sample(2_000)).unwrap();
        assert_eq!(mode(&path(&dir.0)), 0o600);
    }

    #[test]
    fn nothing_to_keep_removes_the_file() {
        let dir = TempDir::new("empty");
        write(&dir.0, 8787, &SavedRelay::default()).unwrap();
        assert!(!dir.0.exists(), "nothing is made for nothing");
        write(&dir.0, 8787, &sample(1_000)).unwrap();
        assert!(path(&dir.0).exists());
        write(&dir.0, 8787, &SavedRelay::default()).unwrap();
        assert!(!path(&dir.0).exists());
        write(&dir.0, 8787, &SavedRelay::default()).unwrap(); // may be repeated
        assert_eq!(read(&dir.0), Found::Nothing);
    }

    #[test]
    fn a_newer_or_damaged_file_is_told_apart() {
        let dir = TempDir::new("newer");
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(
            path(&dir.0),
            br#"{"format":2,"port":8787,"relay":{"version":1}}"#,
        )
        .unwrap();
        assert_eq!(read(&dir.0), Found::Newer);
        fs::write(
            path(&dir.0),
            br#"{"format":1,"port":8787,"relay":{"version":9,"rooms":"other"}}"#,
        )
        .unwrap();
        assert_eq!(read(&dir.0), Found::Newer);
        for bad in [
            &b"not json"[..],
            br#"{"port":8787}"#,
            br#"{"format":1,"port":"x","relay":{"version":1}}"#,
            br#"[]"#,
        ] {
            fs::write(path(&dir.0), bad).unwrap();
            assert_eq!(read(&dir.0), Found::Damaged);
        }
    }
}
