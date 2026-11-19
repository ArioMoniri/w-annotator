//! Recovery copies of unsaved mask edits, kept in the app's local data folder.
//!
//! The web side never names a file here. It gives a key (lowercase hex, the
//! fingerprint of an image) and this module maps it to `<key>.wrec` inside one
//! folder. A second file, `<key>.path`, may hold the path of the image the
//! copy belongs to, so the app can offer to reopen it. That path is recorded
//! only when the user chose the file in this app, and it is never returned to
//! the web side: only its file name is.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::files::write_atomic;

/// Header that carries the key of `recovery_write`.
pub const KEY_HEADER: &str = "x-recovery-key";

/// Optional header of `recovery_write`: the percent-encoded path of the image.
pub const IMAGE_PATH_HEADER: &str = "x-image-path";

/// Folder inside the app's local data directory.
pub const FOLDER: &str = "recovery";

const COPY_EXT: &str = "wrec";
const PATH_EXT: &str = "path";

/// One recovery copy, as listed for the web side.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Copy {
    pub key: String,
    /// When the copy was written, in milliseconds since 1970.
    pub saved_at: u64,
    pub bytes: u64,
    /// File name of the image, when its path is known and the file still exists.
    pub image_name: Option<String>,
}

/// A key is 16 to 64 lowercase hex characters: never a path, a dot or a separator.
pub fn valid_key(key: &str) -> bool {
    (16..=64).contains(&key.len()) && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn checked(key: &str) -> io::Result<&str> {
    if valid_key(key) {
        Ok(key)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the recovery key is not valid",
        ))
    }
}

fn file(dir: &Path, key: &str, ext: &str) -> io::Result<PathBuf> {
    Ok(dir.join(format!("{}.{ext}", checked(key)?)))
}

/// Writes the copy for `key`, replacing an earlier one. With `image`, also
/// remembers where the image is; without it, an earlier note is kept.
pub fn write(dir: &Path, key: &str, bytes: &[u8], image: Option<&Path>) -> io::Result<()> {
    let target = file(dir, key, COPY_EXT)?;
    fs::create_dir_all(dir)?;
    write_atomic(&target, bytes)?;
    if let Some(image) = image {
        write_atomic(
            &file(dir, key, PATH_EXT)?,
            image.to_string_lossy().as_bytes(),
        )?;
    }
    Ok(())
}

/// The bytes of the copy for `key`, or `None` when there is none.
pub fn read(dir: &Path, key: &str) -> io::Result<Option<Vec<u8>>> {
    match fs::read(file(dir, key, COPY_EXT)?) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Removes the copy for `key` and its note. Removing a missing copy is not an error.
pub fn delete(dir: &Path, key: &str) -> io::Result<()> {
    for ext in [COPY_EXT, PATH_EXT] {
        match fs::remove_file(file(dir, key, ext)?) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// Where the image for `key` is, if that was recorded and the file still exists.
pub fn image_path(dir: &Path, key: &str) -> io::Result<Option<PathBuf>> {
    let note = match fs::read_to_string(file(dir, key, PATH_EXT)?) {
        Ok(note) => note,
        Err(_) => return Ok(None),
    };
    let path = PathBuf::from(note);
    Ok((path.is_absolute() && path.is_file()).then_some(path))
}

/// Every copy in the folder, newest first. Files that are not copies are ignored.
pub fn list(dir: &Path) -> io::Result<Vec<Copy>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries {
        let path = entry?.path();
        let key = match (
            path.file_stem().and_then(|s| s.to_str()),
            path.extension().and_then(|e| e.to_str()),
        ) {
            (Some(stem), Some(COPY_EXT)) if valid_key(stem) => stem.to_string(),
            _ => continue,
        };
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let saved_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        let image_name = image_path(dir, &key)?
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
        out.push(Copy {
            key,
            saved_at,
            bytes: meta.len(),
            image_name,
        });
    }
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then(a.key.cmp(&b.key)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "w-annotator-recovery-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dunce::canonicalize(dir).unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn keys_are_16_to_64_lowercase_hex_characters() {
        assert!(valid_key("0123456789abcdef"));
        assert!(valid_key(&"a".repeat(64)));
        assert!(valid_key(KEY));
        assert!(!valid_key(""));
        assert!(!valid_key(&"a".repeat(15)));
        assert!(!valid_key(&"a".repeat(65)));
        assert!(!valid_key("0123456789ABCDEF"));
        assert!(!valid_key("0123456789abcdeg"));
        assert!(!valid_key("0123456789abcdef.wrec"));
        assert!(!valid_key("../0123456789abcdef"));
        assert!(!valid_key("0123456789abcdef/x"));
        assert!(!valid_key("0123456789abcdef\\x"));
        assert!(!valid_key("C:0123456789abcdef"));
        assert!(!valid_key("0123456789abcde\u{0}"));
        assert!(!valid_key("０１２３４５６７８９abcdef"));
    }

    #[test]
    fn a_bad_key_is_refused_by_every_operation_and_touches_nothing() {
        let tmp = TempDir::new("badkey");
        let dir = tmp.0.join("recovery");
        for key in ["../escape0123456789", "..", "", "ABCDEF0123456789"] {
            assert!(write(&dir, key, b"x", None).is_err());
            assert!(read(&dir, key).is_err());
            assert!(delete(&dir, key).is_err());
            assert!(image_path(&dir, key).is_err());
        }
        assert!(!dir.exists());
        assert_eq!(fs::read_dir(&tmp.0).unwrap().count(), 0);
    }

    #[test]
    fn a_copy_round_trips_and_the_newest_write_wins() {
        let tmp = TempDir::new("roundtrip");
        // The folder does not exist before the first write.
        let dir = tmp.0.join("data").join("recovery");
        assert_eq!(read(&dir, KEY).unwrap(), None);
        assert_eq!(list(&dir).unwrap(), Vec::new());

        let first: Vec<u8> = (0..=255).collect();
        write(&dir, KEY, &first, None).unwrap();
        assert_eq!(read(&dir, KEY).unwrap().unwrap(), first);
        write(&dir, KEY, b"second", None).unwrap();
        assert_eq!(read(&dir, KEY).unwrap().unwrap(), b"second");

        let copies = list(&dir).unwrap();
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].key, KEY);
        assert_eq!(copies[0].bytes, 6);
        assert!(copies[0].saved_at > 1_600_000_000_000);
        assert_eq!(copies[0].image_name, None);
        // Only the copy is in the folder: no temporary file is left behind.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn delete_removes_the_copy_and_its_note_and_may_be_repeated() {
        let tmp = TempDir::new("delete");
        let image = tmp.0.join("scan.nii.gz");
        fs::write(&image, b"i").unwrap();
        write(&tmp.0, KEY, b"copy", Some(&image)).unwrap();
        delete(&tmp.0, KEY).unwrap();
        assert_eq!(read(&tmp.0, KEY).unwrap(), None);
        assert_eq!(image_path(&tmp.0, KEY).unwrap(), None);
        assert_eq!(fs::read_dir(&tmp.0).unwrap().count(), 1);
        delete(&tmp.0, KEY).unwrap();
    }

    #[test]
    fn the_image_is_offered_only_while_it_exists_and_only_by_name() {
        let tmp = TempDir::new("image");
        let dir = tmp.0.join("recovery");
        let image = tmp.0.join("scan é.nii.gz");
        fs::write(&image, b"i").unwrap();

        write(&dir, KEY, b"copy", Some(&image)).unwrap();
        assert_eq!(image_path(&dir, KEY).unwrap(), Some(image.clone()));
        assert_eq!(
            list(&dir).unwrap()[0].image_name.as_deref(),
            Some("scan é.nii.gz")
        );
        // A later write without a path keeps the note.
        write(&dir, KEY, b"copy 2", None).unwrap();
        assert_eq!(image_path(&dir, KEY).unwrap(), Some(image.clone()));

        fs::remove_file(&image).unwrap();
        assert_eq!(image_path(&dir, KEY).unwrap(), None);
        assert_eq!(list(&dir).unwrap()[0].image_name, None);
    }

    #[test]
    fn list_ignores_other_files_and_puts_the_newest_first() {
        let tmp = TempDir::new("list");
        let older = "aaaaaaaaaaaaaaaa";
        let newer = "bbbbbbbbbbbbbbbb";
        write(&tmp.0, older, b"1", None).unwrap();
        write(&tmp.0, newer, b"22", None).unwrap();
        let earlier = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(tmp.0.join(format!("{older}.wrec")))
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        fs::write(tmp.0.join("notes.txt"), b"x").unwrap();
        fs::write(tmp.0.join("NOT-A-KEY.wrec"), b"x").unwrap();
        fs::write(tmp.0.join(".aaaaaaaaaaaaaaaa.wrec.1.part"), b"x").unwrap();

        let keys: Vec<String> = list(&tmp.0).unwrap().into_iter().map(|c| c.key).collect();
        assert_eq!(keys, vec![newer.to_string(), older.to_string()]);
    }
}
