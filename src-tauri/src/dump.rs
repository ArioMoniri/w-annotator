//! A test hook: writes what the window has open to a file, so a test can look
//! at the running app from outside. Off unless `W_FILES_DUMP` held an absolute
//! path when the app was launched. See "Test hook" in `README.md`.

use std::ffi::OsString;
use std::path::PathBuf;

/// The file the list of open files is written to.
pub const DUMP_VAR: &str = "W_FILES_DUMP";

/// Where to write, if the hook was asked for.
pub fn target(value: Option<OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(value.filter(|v| !v.is_empty())?);
    path.is_absolute().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hook_needs_an_absolute_path() {
        assert_eq!(target(None), None);
        assert_eq!(target(Some(OsString::new())), None);
        assert_eq!(target(Some("files.json".into())), None);
        let file = std::env::temp_dir().join("files.json");
        assert_eq!(target(Some(file.clone().into())), Some(file));
    }
}
