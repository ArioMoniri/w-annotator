//! Hooks for automated tests of the built app.
//!
//! Everything here does nothing unless its environment variable was set when
//! the app was launched. See "Test hooks" in `README.md`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Folder that `pick_save_path` saves into without showing a dialog.
pub const SAVE_DIR_VAR: &str = "W_E2E_SAVE_DIR";

/// File the self-test writes its result to before the app quits.
pub const SELFTEST_VAR: &str = "W_SELFTEST";

/// File name used when the web side suggests none.
const FALLBACK_NAME: &str = "mask.nii.gz";

fn absolute(value: Option<OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(value.filter(|v| !v.is_empty())?);
    path.is_absolute().then_some(path)
}

/// Where a save goes when the save folder variable is set: the suggested file
/// name inside that folder. Only the name is used, so a suggestion can never
/// leave the folder. `None` (show the dialog) when the variable is unset,
/// empty or not an absolute path.
pub fn save_target(dir: Option<OsString>, suggested: Option<&str>) -> Option<PathBuf> {
    let dir = absolute(dir)?;
    let name = suggested
        .and_then(|s| Path::new(s).file_name())
        .filter(|n| !n.is_empty())
        .map_or_else(|| OsString::from(FALLBACK_NAME), OsString::from);
    Some(dir.join(name))
}

/// The self-test result file, if a self-test was asked for.
pub fn selftest_target(value: Option<OsString>) -> Option<PathBuf> {
    absolute(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn save_target_is_off_without_the_variable() {
        assert_eq!(save_target(None, Some("mask.nii.gz")), None);
        assert_eq!(
            save_target(Some(OsString::new()), Some("mask.nii.gz")),
            None
        );
        assert_eq!(
            save_target(Some("relative/dir".into()), Some("m.nii")),
            None
        );
    }

    #[test]
    fn save_target_puts_the_suggested_name_in_the_folder() {
        let dir = root();
        assert_eq!(
            save_target(Some(dir.clone().into()), Some("seg.nii.gz")),
            Some(dir.join("seg.nii.gz"))
        );
        assert_eq!(
            save_target(Some(dir.clone().into()), None),
            Some(dir.join("mask.nii.gz"))
        );
    }

    #[test]
    fn save_target_never_leaves_the_folder() {
        let dir = root();
        let up = Path::new("..").join("..").join("evil.nii");
        assert_eq!(
            save_target(Some(dir.clone().into()), up.to_str()),
            Some(dir.join("evil.nii"))
        );
        assert_eq!(
            save_target(Some(dir.clone().into()), Some("..")),
            Some(dir.join("mask.nii.gz"))
        );
    }

    #[test]
    fn selftest_target_needs_an_absolute_path() {
        assert_eq!(selftest_target(None), None);
        assert_eq!(selftest_target(Some("result.json".into())), None);
        let file = root().join("result.json");
        assert_eq!(selftest_target(Some(file.clone().into())), Some(file));
    }
}
