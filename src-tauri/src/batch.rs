//! Gathers files that arrive close together into one open.
//!
//! Selecting an image and its mask and choosing "Open with" does not hand both
//! over at once: macOS may send several events, and on Windows and Linux each
//! file can start its own launch that forwards to the running app. Everything
//! that arrives within [`WINDOW`] of the previous arrival is opened together,
//! so the pair lands in one window as image and mask.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long to wait after the last arrival before opening what has gathered.
pub const WINDOW: Duration = Duration::from_millis(300);

#[derive(Default)]
struct Inner {
    pending: Vec<PathBuf>,
    last: Option<Instant>,
    /// The window is listening. Until then files wait, however long it takes to load.
    ready: bool,
}

/// Files waiting to be opened by the window.
#[derive(Default)]
pub struct Batcher(Mutex<Inner>);

impl Batcher {
    /// Adds files that arrived at `now`. A file already waiting is not added twice.
    pub fn push(&self, paths: Vec<PathBuf>, now: Instant) {
        let mut inner = self.0.lock().unwrap();
        for path in paths {
            if !inner.pending.contains(&path) {
                inner.pending.push(path);
            }
        }
        inner.last = Some(now);
    }

    /// The window can take files from now on.
    pub fn set_ready(&self) {
        self.0.lock().unwrap().ready = true;
    }

    /// Everything waiting, once the window is ready and nothing has arrived for
    /// [`WINDOW`]. `None` while more may still be coming, or when nothing waits.
    pub fn take_due(&self, now: Instant) -> Option<Vec<PathBuf>> {
        let mut inner = self.0.lock().unwrap();
        let quiet = match inner.last {
            Some(last) => now.saturating_duration_since(last) >= WINDOW,
            None => true,
        };
        if !inner.ready || !quiet || inner.pending.is_empty() {
            return None;
        }
        inner.last = None;
        Some(std::mem::take(&mut inner.pending))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn files_that_arrive_close_together_open_as_one_batch() {
        let batcher = Batcher::default();
        batcher.set_ready();
        let start = Instant::now();
        batcher.push(paths(&["/a/ct.mha"]), start);
        // The mask arrives from a second launch a moment later.
        let second = start + Duration::from_millis(120);
        batcher.push(paths(&["/a/ct_seg.nii.gz"]), second);
        // The first timer fires, but the wait has started again.
        assert_eq!(batcher.take_due(start + WINDOW), None);
        assert_eq!(
            batcher.take_due(second + WINDOW),
            Some(paths(&["/a/ct.mha", "/a/ct_seg.nii.gz"]))
        );
        assert_eq!(batcher.take_due(second + WINDOW * 2), None);
    }

    #[test]
    fn files_that_arrive_later_are_a_batch_of_their_own() {
        let batcher = Batcher::default();
        batcher.set_ready();
        let start = Instant::now();
        batcher.push(paths(&["/a/ct.mha"]), start);
        assert_eq!(
            batcher.take_due(start + WINDOW),
            Some(paths(&["/a/ct.mha"]))
        );
        let later = start + Duration::from_secs(5);
        batcher.push(paths(&["/a/other mask.nii.gz"]), later);
        assert_eq!(
            batcher.take_due(later + WINDOW),
            Some(paths(&["/a/other mask.nii.gz"]))
        );
    }

    #[test]
    fn files_wait_until_the_window_is_ready() {
        let batcher = Batcher::default();
        let start = Instant::now();
        batcher.push(paths(&["/a/ct.mha", "/a/ct_seg.nii.gz"]), start);
        // The page is still loading, long after the wait ran out.
        assert_eq!(batcher.take_due(start + Duration::from_secs(3)), None);
        batcher.set_ready();
        assert_eq!(
            batcher.take_due(start + Duration::from_secs(3)),
            Some(paths(&["/a/ct.mha", "/a/ct_seg.nii.gz"]))
        );
    }

    #[test]
    fn the_same_file_is_not_opened_twice_in_a_batch() {
        let batcher = Batcher::default();
        batcher.set_ready();
        let start = Instant::now();
        batcher.push(paths(&["/a/ct.mha"]), start);
        batcher.push(paths(&["/a/ct.mha", "/a/m.nii"]), start);
        assert_eq!(
            batcher.take_due(start + WINDOW),
            Some(paths(&["/a/ct.mha", "/a/m.nii"]))
        );
    }
}
