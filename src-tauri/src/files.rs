//! Which files the web side may read and write.
//!
//! The web side never gets free access to the disk. A path becomes usable only
//! after the user chose it: in an open or save dialog shown by this app, or by
//! opening a file with the app from the system ("Open with", command line).

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;

/// Header that carries the percent-encoded target path of `write_file`.
pub const PATH_HEADER: &str = "x-file-path";

/// Most files returned when the user picks a folder.
pub const MAX_FOLDER_FILES: usize = 20_000;

#[derive(Default)]
struct Inner {
    /// Files the user picked: readable and writable.
    files: HashSet<PathBuf>,
    /// Folders the user picked: everything inside is readable.
    dirs: HashSet<PathBuf>,
}

/// The paths the user has chosen during this run of the app.
#[derive(Default)]
pub struct Allowed(Mutex<Inner>);

/// Resolves a path to a stable absolute form, even if the file does not exist yet.
fn resolve(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the path must be absolute",
        ));
    }
    if let Ok(full) = dunce::canonicalize(path) {
        return Ok(full);
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the path has no file name",
        ));
    };
    Ok(dunce::canonicalize(parent)?.join(name))
}

impl Allowed {
    /// Records a file the user picked. Returns the path to hand to the web side.
    pub fn allow_file(&self, path: &Path) -> io::Result<PathBuf> {
        let full = resolve(path)?;
        self.0.lock().unwrap().files.insert(full.clone());
        Ok(full)
    }

    /// Records a folder the user picked and returns the files inside it, sorted.
    pub fn allow_dir(&self, path: &Path) -> io::Result<Vec<PathBuf>> {
        let full = dunce::canonicalize(path)?;
        let mut files = Vec::new();
        walk(&full, &mut files)?;
        files.sort();
        self.0.lock().unwrap().dirs.insert(full);
        Ok(files)
    }

    /// A file may be read if the user picked it, if it sits next to a picked
    /// file (a `.mhd` header points at a `.raw` beside it), or if it is inside
    /// a picked folder.
    pub fn check_read(&self, path: &Path) -> io::Result<PathBuf> {
        let full = resolve(path)?;
        let inner = self.0.lock().unwrap();
        let ok = inner.files.contains(&full)
            || inner.dirs.iter().any(|dir| full.starts_with(dir))
            || full
                .parent()
                .is_some_and(|dir| inner.files.iter().any(|f| f.parent() == Some(dir)));
        if ok {
            Ok(full)
        } else {
            Err(denied())
        }
    }

    /// A file may be written only if the user picked exactly that file.
    pub fn check_write(&self, path: &Path) -> io::Result<PathBuf> {
        let full = resolve(path)?;
        if self.0.lock().unwrap().files.contains(&full) {
            Ok(full)
        } else {
            Err(denied())
        }
    }
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "this file was not chosen in a dialog",
    )
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            walk(&entry.path(), out)?;
        } else if kind.is_file() {
            if out.len() >= MAX_FOLDER_FILES {
                return Err(io::Error::other(format!(
                    "the folder holds more than {MAX_FOLDER_FILES} files"
                )));
            }
            out.push(entry.path());
        }
    }
    Ok(())
}

/// Decodes the percent-encoded UTF-8 path sent in the [`PATH_HEADER`] header.
pub fn decode_path_header(value: &[u8]) -> Result<PathBuf, String> {
    let raw = std::str::from_utf8(value).map_err(|_| "the path header is not valid text")?;
    let decoded = percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| "the path header is not valid UTF-8")?;
    if decoded.is_empty() {
        return Err("the path header is empty".into());
    }
    Ok(PathBuf::from(decoded.into_owned()))
}

/// Writes `bytes` to `path` so that a crash never leaves a half-written file:
/// the data goes to a temporary file beside it, which then replaces the target.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the path has no file name",
        ));
    };
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.part", std::process::id()));
    let tmp = dir.join(tmp_name);

    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Paths given on the command line that point at existing files.
pub fn files_from_args(args: impl IntoIterator<Item = String>) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .filter_map(|p| dunce::canonicalize(p).ok())
        .filter(|p| p.is_file())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "w-annotator-test-{tag}-{}-{:?}",
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

    #[test]
    fn nothing_is_allowed_until_picked() {
        let tmp = TempDir::new("deny");
        let file = tmp.0.join("scan.nii");
        fs::write(&file, b"x").unwrap();
        let allowed = Allowed::default();
        assert!(allowed.check_read(&file).is_err());
        assert!(allowed.check_write(&file).is_err());
        assert!(allowed.check_read(Path::new("relative.nii")).is_err());
    }

    #[test]
    fn a_picked_file_can_be_read_and_written_and_its_neighbours_only_read() {
        let tmp = TempDir::new("file");
        let header = tmp.0.join("scan.mhd");
        let raw = tmp.0.join("scan.raw");
        fs::write(&header, b"h").unwrap();
        fs::write(&raw, b"r").unwrap();
        fs::create_dir(tmp.0.join("sub")).unwrap();
        let nested = tmp.0.join("sub").join("other.nii");
        fs::write(&nested, b"n").unwrap();

        let allowed = Allowed::default();
        allowed.allow_file(&header).unwrap();
        assert!(allowed.check_read(&header).is_ok());
        assert!(allowed.check_write(&header).is_ok());
        assert!(allowed.check_read(&raw).is_ok());
        assert!(allowed.check_write(&raw).is_err());
        assert!(allowed.check_read(&nested).is_err());
        // Dot segments do not get around the check.
        let sneaky = tmp.0.join("sub").join("..").join("sub").join("other.nii");
        assert!(allowed.check_read(&sneaky).is_err());
    }

    #[test]
    fn a_save_target_that_does_not_exist_yet_can_be_written() {
        let tmp = TempDir::new("save");
        let target = tmp.0.join("mask.nii.gz");
        let allowed = Allowed::default();
        let full = allowed.allow_file(&target).unwrap();
        let checked = allowed.check_write(&target).unwrap();
        assert_eq!(full, checked);
        write_atomic(&checked, b"first").unwrap();
        write_atomic(&checked, b"second").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
        // No temporary file is left behind.
        assert_eq!(fs::read_dir(&tmp.0).unwrap().count(), 1);
        assert!(allowed.check_read(&target).is_ok());
    }

    #[test]
    fn a_picked_folder_lists_and_allows_reading_its_files() {
        let tmp = TempDir::new("dir");
        fs::create_dir(tmp.0.join("series")).unwrap();
        fs::write(tmp.0.join("series").join("b.dcm"), b"b").unwrap();
        fs::write(tmp.0.join("a.dcm"), b"a").unwrap();
        fs::write(tmp.0.join(".hidden"), b"h").unwrap();

        let allowed = Allowed::default();
        let files = allowed.allow_dir(&tmp.0).unwrap();
        assert_eq!(
            files,
            vec![tmp.0.join("a.dcm"), tmp.0.join("series").join("b.dcm")]
        );
        assert!(allowed.check_read(&files[1]).is_ok());
        assert!(allowed.check_write(&files[1]).is_err());
    }

    #[test]
    fn path_header_is_percent_decoded() {
        let p = decode_path_header(b"%2Ftmp%2Fma%20sk%20%C3%A9.nii.gz").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/ma sk é.nii.gz"));
        assert_eq!(
            decode_path_header(b"C%3A%5CUsers%5Ca%5Cm.nii").unwrap(),
            PathBuf::from("C:\\Users\\a\\m.nii")
        );
        assert!(decode_path_header(b"").is_err());
        assert!(decode_path_header(b"%FF").is_err());
    }

    #[test]
    fn command_line_arguments_keep_only_existing_files() {
        let tmp = TempDir::new("args");
        let file = tmp.0.join("scan.nrrd");
        fs::write(&file, b"x").unwrap();
        let args = vec![
            "app".to_string(),
            "--flag".to_string(),
            file.to_string_lossy().into_owned(),
            tmp.0.join("missing.nii").to_string_lossy().into_owned(),
            tmp.0.to_string_lossy().into_owned(),
        ];
        assert_eq!(files_from_args(args), vec![file]);
    }
}
