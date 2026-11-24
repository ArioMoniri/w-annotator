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

/// Most bytes taken in one go from a drop, "Open with" or the command line.
/// The web side holds every file in memory, so more than this cannot open anyway.
pub const MAX_GIVEN_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// What became of paths the system handed to the app.
#[derive(Debug, Default, PartialEq)]
pub struct Given {
    /// Readable files, in the order given, folders replaced by their files.
    pub files: Vec<PathBuf>,
    /// Why some of the paths were left out, worded for the user.
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    /// Files the user picked: readable and writable.
    files: HashSet<PathBuf>,
    /// Folders the user picked: everything inside is readable.
    dirs: HashSet<PathBuf>,
    /// Folders the user picked to save into: files directly inside are readable and writable.
    out_dirs: HashSet<PathBuf>,
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

    /// Records a folder the user picked to save into: files directly inside it
    /// (not in folders below, not hidden) become readable and writable. Returns
    /// the names of the files already there, sorted.
    pub fn allow_out_dir(&self, path: &Path) -> io::Result<Vec<String>> {
        let full = dunce::canonicalize(path)?;
        let names = visible_files(&full)?;
        self.0.lock().unwrap().out_dirs.insert(full);
        Ok(names)
    }

    /// Lists again, without a dialog, a folder picked during this run, or one
    /// inside it: for the web side coming back after a reload. Nothing new
    /// becomes readable.
    pub fn reopen_dir(&self, path: &Path) -> io::Result<Vec<PathBuf>> {
        let full = dunce::canonicalize(path)?;
        if !self
            .0
            .lock()
            .unwrap()
            .dirs
            .iter()
            .any(|dir| full.starts_with(dir))
        {
            return Err(denied());
        }
        let mut files = Vec::new();
        walk(&full, &mut files)?;
        files.sort();
        Ok(files)
    }

    /// Lists again, without a dialog, a folder picked to save into during this
    /// run. Nothing new becomes writable.
    pub fn reopen_out_dir(&self, path: &Path) -> io::Result<Vec<String>> {
        let full = dunce::canonicalize(path)?;
        if !self.0.lock().unwrap().out_dirs.contains(&full) {
            return Err(denied());
        }
        visible_files(&full)
    }

    /// Records paths the system handed over: files dropped on the window, opened
    /// with the app, or named on the command line. Files become readable and
    /// writable; a folder becomes readable and is replaced by the files inside
    /// it. Paths that do not exist are skipped. Nothing past `max_bytes` in
    /// total is taken.
    pub fn allow_given(&self, paths: &[PathBuf], max_bytes: u64) -> Given {
        let mut given = Given::default();
        let mut seen = HashSet::new();
        let mut bytes = 0u64;
        for path in paths {
            let found = match fs::metadata(path) {
                Ok(meta) if meta.is_dir() => match self.allow_dir(path) {
                    Ok(files) => files,
                    Err(e) => {
                        given.error = Some(format!("Could not open {}: {e}.", name_of(path)));
                        continue;
                    }
                },
                Ok(meta) if meta.is_file() => match self.allow_file(path) {
                    Ok(file) => vec![file],
                    Err(_) => continue,
                },
                _ => continue,
            };
            for file in found {
                if !seen.insert(file.clone()) {
                    continue;
                }
                bytes += fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
                if bytes > max_bytes || given.files.len() >= MAX_FOLDER_FILES {
                    given.error = Some(
                        "That is more than the app can open at once. Open fewer files.".into(),
                    );
                    return given;
                }
                given.files.push(file);
            }
        }
        given
    }

    /// A file may be read if the user picked it, if it sits next to a picked
    /// file (a `.mhd` header points at a `.raw` beside it), or if it is inside
    /// a picked folder.
    pub fn check_read(&self, path: &Path) -> io::Result<PathBuf> {
        let full = resolve(path)?;
        let inner = self.0.lock().unwrap();
        let ok = inner.files.contains(&full)
            || inner.dirs.iter().any(|dir| full.starts_with(dir))
            || in_out_dir(&inner, &full)
            || full
                .parent()
                .is_some_and(|dir| inner.files.iter().any(|f| f.parent() == Some(dir)));
        if ok {
            Ok(full)
        } else {
            Err(denied())
        }
    }

    /// A file may be written only if the user picked exactly that file, or it
    /// sits directly inside a folder the user picked to save into.
    pub fn check_write(&self, path: &Path) -> io::Result<PathBuf> {
        let full = resolve(path)?;
        let inner = self.0.lock().unwrap();
        if inner.files.contains(&full) || in_out_dir(&inner, &full) {
            Ok(full)
        } else {
            Err(denied())
        }
    }
}

/// The names of the files directly inside a folder, not hidden, sorted.
fn visible_files(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with('.') && entry.file_type()?.is_file() {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// Directly inside a folder picked to save into, and not hidden.
fn in_out_dir(inner: &Inner, full: &Path) -> bool {
    let visible = full
        .file_name()
        .is_some_and(|n| !n.to_string_lossy().starts_with('.'));
    visible
        && full
            .parent()
            .is_some_and(|dir| inner.out_dirs.contains(dir))
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| path.to_string_lossy(), |n| n.to_string_lossy())
        .into_owned()
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

/// Files and folders named on a command line, as absolute paths. This is how
/// "Open with" arrives on Windows and Linux, at launch and from a second
/// launch that hands its arguments to the running app.
///
/// The first argument (the program) and flags are skipped. A relative path is
/// read from `cwd`, the folder the command was run in. A `file://` address, as
/// Linux desktops may pass, is turned into its path. Paths that do not exist
/// are left out.
pub fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
        .filter_map(|arg| {
            if arg.starts_with("file://") {
                return tauri::Url::parse(&arg).ok()?.to_file_path().ok();
            }
            let path = PathBuf::from(arg);
            Some(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            })
        })
        .filter_map(|p| dunce::canonicalize(p).ok())
        // Never a whole drive: a bare `file://` or `/` names no file.
        .filter(|p| p.file_name().is_some() && (p.is_file() || p.is_dir()))
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
    fn a_picked_output_folder_takes_new_files_directly_inside_it() {
        let tmp = TempDir::new("out");
        let out = tmp.0.join("labels_corrected");
        fs::create_dir(&out).unwrap();
        fs::write(out.join("p1_0001.mha"), b"old").unwrap();
        fs::write(out.join(".hidden"), b"h").unwrap();
        fs::create_dir(out.join("sub")).unwrap();
        fs::write(out.join("sub").join("deep.mha"), b"d").unwrap();

        let allowed = Allowed::default();
        // It lists the files already there, for picking up where work stopped.
        assert_eq!(
            allowed.allow_out_dir(&out).unwrap(),
            vec!["p1_0001.mha".to_string()]
        );
        let new = out.join("p1_0002.mha");
        assert!(allowed.check_write(&new).is_ok());
        assert!(allowed.check_write(&out.join("p1_0001.mha")).is_ok());
        assert!(allowed.check_read(&out.join("p1_0001.mha")).is_ok());
        assert!(allowed.check_read(&new).is_ok());
        write_atomic(&allowed.check_write(&new).unwrap(), b"new").unwrap();
        assert_eq!(fs::read(&new).unwrap(), b"new");
    }

    #[test]
    fn a_folder_picked_in_this_run_can_be_listed_again_without_a_dialog() {
        let tmp = TempDir::new("reopen");
        let ds = tmp.0.join("t1");
        fs::create_dir_all(ds.join("ImagesTr")).unwrap();
        fs::write(ds.join("ImagesTr").join("a_0000.mha"), b"a").unwrap();
        fs::write(ds.join("dataset.json"), b"{}").unwrap();
        fs::create_dir(tmp.0.join("other")).unwrap();

        let allowed = Allowed::default();
        // Nothing is reopened that was not picked.
        assert!(allowed.reopen_dir(&ds).is_err());
        let picked = allowed.allow_dir(&ds).unwrap();
        // A file added since is listed too.
        fs::write(ds.join("ImagesTr").join("b_0000.mha"), b"b").unwrap();
        let again = allowed.reopen_dir(&ds).unwrap();
        assert_eq!(again.len(), picked.len() + 1);
        assert!(allowed
            .check_read(&ds.join("ImagesTr").join("b_0000.mha"))
            .is_ok());
        // A folder inside the picked one is fine; one above or beside it is not.
        assert_eq!(allowed.reopen_dir(&ds.join("ImagesTr")).unwrap().len(), 2);
        assert!(allowed.reopen_dir(&tmp.0).is_err());
        assert!(allowed.reopen_dir(&tmp.0.join("other")).is_err());
        assert!(allowed
            .reopen_dir(&ds.join("ImagesTr").join("..").join(".."))
            .is_err());
    }

    #[test]
    fn an_output_folder_picked_in_this_run_can_be_reopened_without_a_dialog() {
        let tmp = TempDir::new("reopenout");
        let out = tmp.0.join("q");
        fs::create_dir(&out).unwrap();
        fs::create_dir(out.join("sub")).unwrap();
        let allowed = Allowed::default();
        assert!(allowed.reopen_out_dir(&out).is_err());
        allowed.allow_out_dir(&out).unwrap();
        fs::write(out.join("p1_0001.mha"), b"m").unwrap();
        assert_eq!(
            allowed.reopen_out_dir(&out).unwrap(),
            vec!["p1_0001.mha".to_string()]
        );
        // Only that folder: not one inside it, and a read-only dataset folder is not one.
        assert!(allowed.reopen_out_dir(&out.join("sub")).is_err());
        let ds = tmp.0.join("t1");
        fs::create_dir(&ds).unwrap();
        allowed.allow_dir(&ds).unwrap();
        assert!(allowed.reopen_out_dir(&ds).is_err());
    }

    #[test]
    fn an_output_folder_allows_nothing_below_beside_or_hidden() {
        let tmp = TempDir::new("outdeny");
        let out = tmp.0.join("out");
        fs::create_dir(&out).unwrap();
        fs::create_dir(out.join("sub")).unwrap();
        let allowed = Allowed::default();
        allowed.allow_out_dir(&out).unwrap();
        assert!(allowed.check_write(&out.join("sub").join("x.mha")).is_err());
        assert!(allowed.check_write(&tmp.0.join("beside.mha")).is_err());
        assert!(allowed.check_write(&out.join(".hidden")).is_err());
        // Dot segments do not get out of it.
        assert!(allowed
            .check_write(&out.join("sub").join("..").join("..").join("x.mha"))
            .is_err());
        assert!(allowed.check_read(&out.join("sub").join("x.mha")).is_err());
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
    fn command_line_arguments_keep_existing_files_and_folders() {
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
        // A folder stays: it may hold a DICOM series.
        assert_eq!(
            paths_from_args(args, &std::env::temp_dir()),
            vec![file, tmp.0.clone()]
        );
    }

    #[test]
    fn arguments_with_spaces_and_other_alphabets_arrive_whole() {
        let tmp = TempDir::new("args-names");
        let spaced = tmp.0.join("CT chest 1.mha");
        let accented = tmp.0.join("Gö\u{11f}üs BT \u{2013} maske.nii.gz");
        let cjk = tmp.0.join("\u{80f8}\u{90e8}.nrrd");
        for f in [&spaced, &accented, &cjk] {
            fs::write(f, b"x").unwrap();
        }
        let args = ["app", "CT chest 1.mha"]
            .into_iter()
            .map(String::from)
            .chain([&accented, &cjk].map(|p| p.to_string_lossy().into_owned()));
        // The first is relative to the folder the command ran in.
        assert_eq!(paths_from_args(args, &tmp.0), vec![spaced, accented, cjk]);
    }

    #[test]
    fn a_file_address_becomes_its_path() {
        let tmp = TempDir::new("args-url");
        let file = tmp.0.join("my scan é.nii");
        fs::write(&file, b"x").unwrap();
        let url = tauri::Url::from_file_path(&file).unwrap().to_string();
        assert!(url.contains("%20"));
        let args = vec!["app".to_string(), url, "file://".to_string()];
        assert_eq!(paths_from_args(args, &tmp.0), vec![file]);
    }

    #[test]
    fn given_files_can_be_read_and_given_folders_are_listed() {
        let tmp = TempDir::new("given");
        let image = tmp.0.join("ct.mha");
        fs::write(&image, b"image").unwrap();
        fs::create_dir(tmp.0.join("series")).unwrap();
        let slice = tmp.0.join("series").join("1.dcm");
        fs::write(&slice, b"slice").unwrap();
        fs::create_dir(tmp.0.join("other")).unwrap();
        let untouched = tmp.0.join("other").join("x.nii");
        fs::write(&untouched, b"x").unwrap();

        let allowed = Allowed::default();
        let given = allowed.allow_given(
            &[
                image.clone(),
                tmp.0.join("series"),
                tmp.0.join("gone.nii"),
                image.clone(),
            ],
            MAX_GIVEN_BYTES,
        );
        assert_eq!(given.files, vec![image.clone(), slice.clone()]);
        assert_eq!(given.error, None);
        assert!(allowed.check_read(&image).is_ok());
        assert!(allowed.check_read(&slice).is_ok());
        // Nothing else became readable.
        assert!(allowed.check_read(&untouched).is_err());
    }

    #[test]
    fn given_paths_stop_at_the_size_limit_with_a_message() {
        let tmp = TempDir::new("given-cap");
        let a = tmp.0.join("a.nii");
        let b = tmp.0.join("b.nii");
        fs::write(&a, [0u8; 60]).unwrap();
        fs::write(&b, [0u8; 60]).unwrap();
        let given = Allowed::default().allow_given(&[a.clone(), b], 100);
        assert_eq!(given.files, vec![a]);
        assert!(given.error.unwrap().contains("more than the app can open"));
    }
}
