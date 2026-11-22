//! Rust side of W Annotator: file access for paths the user chose, hosting a
//! room on the local network, and files opened with the app from the system.
//!
//! The JavaScript signature of every command is documented in `README.md`.

#[cfg(test)]
mod associations;
mod batch;
mod dump;
mod files;
mod hosted_rooms;
mod hosting;
mod recovery;
mod testing;

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WebviewEvent, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use tokio::sync::oneshot;

use batch::Batcher;
use files::Allowed;
use hosting::{Host, HostInfo};

/// Event sent to the web side with files to open: dropped on the window, or
/// opened with the app from the system.
const GIVEN_EVENT: &str = "files-given";

/// Payload of [`GIVEN_EVENT`].
#[derive(Clone, Serialize)]
struct GivenFiles {
    /// Absolute paths, already readable with `read_file`. Opened together.
    paths: Vec<String>,
    /// Why something was left out, worded for the user.
    error: Option<String>,
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn send_given(app: &AppHandle, files: &[PathBuf], error: Option<String>) {
    if files.is_empty() && error.is_none() {
        return;
    }
    let paths = files.iter().map(|p| display(p)).collect();
    let _ = app.emit(GIVEN_EVENT, GivenFiles { paths, error });
}

/// Sends the files that have gathered once nothing more has arrived for a moment.
fn open_when_quiet(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(batch::WINDOW + Duration::from_millis(20)).await;
        if let Some(files) = app.state::<Batcher>().take_due(Instant::now()) {
            send_given(&app, &files, None);
        }
    });
}

/// Takes paths the system handed to the app. They become readable here, at the
/// moment they arrive, and never because the web side named them.
///
/// Dropped files open at once. Files from "Open with" are gathered for a moment
/// first (`gather`), since one selection can arrive in several pieces.
fn take_paths(app: &AppHandle, paths: &[PathBuf], gather: bool) {
    if paths.is_empty() {
        return;
    }
    let given = app
        .state::<Allowed>()
        .allow_given(paths, files::MAX_GIVEN_BYTES);
    if !gather {
        return send_given(app, &given.files, given.error);
    }
    if given.error.is_some() {
        send_given(app, &[], given.error);
    }
    if !given.files.is_empty() {
        app.state::<Batcher>().push(given.files, Instant::now());
        open_when_quiet(app);
    }
}

#[tauri::command]
async fn host_room(
    app: AppHandle,
    host: State<'_, Host>,
    port: Option<u16>,
) -> Result<HostInfo, String> {
    // Rooms hosted here are kept in the app's own data folder, so they are
    // there again after the app was closed. Without that folder they are not kept.
    let store = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(hosted_rooms::FOLDER));
    host.start(port, store.as_deref())
        .await
        .map_err(|e| format!("Could not start hosting: {e}"))
}

#[tauri::command]
async fn stop_hosting(host: State<'_, Host>) -> Result<(), String> {
    host.stop().await;
    Ok(())
}

/// Removes what is kept of one hosted room, when its host forgets it.
#[tauri::command]
async fn forget_hosted_room(
    app: AppHandle,
    host: State<'_, Host>,
    room: String,
) -> Result<(), String> {
    let store = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(hosted_rooms::FOLDER));
    host.forget(&room, store.as_deref())
        .await
        .map_err(|e| format!("Could not forget the room: {e}"))
}

/// The bytes of a raw request body. When the webview cannot use the IPC custom
/// protocol, Tauri falls back to sending the same bytes as a JSON array.
fn body_bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        InvokeBody::Json(value) => Vec::<u8>::deserialize(value)
            .map(Cow::Owned)
            .map_err(|_| "The bytes must be sent as the raw request body".to_string()),
    }
}

/// Writes the raw request body to the path named in the `x-file-path` header.
#[tauri::command(async)]
fn write_file(request: Request<'_>, allowed: State<'_, Allowed>) -> Result<(), String> {
    let header = request
        .headers()
        .get(files::PATH_HEADER)
        .ok_or_else(|| format!("Missing {} header", files::PATH_HEADER))?;
    let path = files::decode_path_header(header.as_bytes())?;
    let path = allowed
        .check_write(&path)
        .map_err(|e| format!("Could not save {}: {e}", display(&path)))?;
    let bytes = body_bytes(request.body())?;
    files::write_atomic(&path, &bytes)
        .map_err(|e| format!("Could not save {}: {e}", display(&path)))
}

/// Returns the bytes of a file the user chose, as a raw response body.
#[tauri::command(async)]
fn read_file(allowed: State<'_, Allowed>, path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    let full = allowed
        .check_read(&path)
        .map_err(|e| format!("Could not open {}: {e}", display(&path)))?;
    std::fs::read(&full)
        .map(Response::new)
        .map_err(|e| format!("Could not open {}: {e}", display(&path)))
}

/// The folder that holds recovery copies, inside the app's local data directory.
fn recovery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(recovery::FOLDER))
        .map_err(|e| format!("Could not find the app data folder: {e}"))
}

/// Writes the raw request body as the recovery copy for the key in the
/// `x-recovery-key` header. An `x-image-path` header is remembered only if the
/// user chose that file in this run of the app.
#[tauri::command(async)]
fn recovery_write(
    app: AppHandle,
    request: Request<'_>,
    allowed: State<'_, Allowed>,
) -> Result<(), String> {
    let key = request
        .headers()
        .get(recovery::KEY_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("Missing {} header", recovery::KEY_HEADER))?;
    let image = request
        .headers()
        .get(recovery::IMAGE_PATH_HEADER)
        .and_then(|v| files::decode_path_header(v.as_bytes()).ok())
        .and_then(|path| allowed.check_write(&path).ok());
    let bytes = body_bytes(request.body())?;
    recovery::write(&recovery_dir(&app)?, key, &bytes, image.as_deref())
        .map_err(|e| format!("Could not write the recovery copy: {e}"))
}

/// Returns the recovery copy for `key` as a raw response body; empty if there is none.
#[tauri::command(async)]
fn recovery_read(app: AppHandle, key: String) -> Result<Response, String> {
    recovery::read(&recovery_dir(&app)?, &key)
        .map(|bytes| Response::new(bytes.unwrap_or_default()))
        .map_err(|e| format!("Could not read the recovery copy: {e}"))
}

#[tauri::command(async)]
fn recovery_list(app: AppHandle) -> Result<Vec<recovery::Copy>, String> {
    recovery::list(&recovery_dir(&app)?)
        .map_err(|e| format!("Could not list the recovery copies: {e}"))
}

#[tauri::command(async)]
fn recovery_delete(app: AppHandle, key: String) -> Result<(), String> {
    recovery::delete(&recovery_dir(&app)?, &key)
        .map_err(|e| format!("Could not remove the recovery copy: {e}"))
}

/// Returns the bytes of the image a recovery copy belongs to, when its path was
/// recorded by `recovery_write` and the file still exists.
#[tauri::command(async)]
fn recovery_image(app: AppHandle, key: String) -> Result<Response, String> {
    let path = recovery::image_path(&recovery_dir(&app)?, &key)
        .map_err(|e| format!("Could not open the image: {e}"))?
        .ok_or("The image is no longer where it was. Open it from its new place.")?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Could not open the image: {e}"))
}

/// The window is listening for [`GIVEN_EVENT`]. Files the app was launched
/// with have waited for this; they are sent now.
#[tauri::command]
fn files_ready(app: AppHandle, batcher: State<'_, Batcher>) {
    batcher.set_ready();
    open_when_quiet(&app);
}

/// Shows a file the user opened in the system's file manager.
#[tauri::command(async)]
fn reveal_file(allowed: State<'_, Allowed>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let full = allowed
        .check_read(&path)
        .map_err(|e| format!("Could not show {}: {e}", display(&path)))?;
    tauri_plugin_opener::reveal_item_in_dir(&full)
        .map_err(|e| format!("Could not show {}: {e}", display(&path)))
}

/// Test hook: writes `text` to the file named by `W_FILES_DUMP`. Returns false,
/// and writes nothing, when the app was launched without it.
#[tauri::command(async)]
fn dump_files(text: String) -> Result<bool, String> {
    let Some(path) = dump::target(std::env::var_os(dump::DUMP_VAR)) else {
        return Ok(false);
    };
    files::write_atomic(&path, text.as_bytes())
        .map(|()| true)
        .map_err(|e| format!("Could not write {}: {e}", display(&path)))
}

/// A file type filter for the dialogs, e.g. `{ name: "NIfTI", extensions: ["nii", "gz"] }`.
#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

fn file_dialog(
    window: &WebviewWindow,
    title: Option<String>,
    filters: Option<Vec<Filter>>,
) -> FileDialogBuilder<tauri::Wry> {
    let mut dialog = window.dialog().file().set_parent(window);
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    for filter in filters.unwrap_or_default() {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(filter.name, &extensions);
    }
    dialog
}

fn picked(path: FilePath) -> Result<PathBuf, String> {
    path.into_path()
        .map_err(|e| format!("Could not use that location: {e}"))
}

/// Shows an open dialog. The chosen files (or, with `directory`, every file in
/// the chosen folder) become readable; chosen files also become writable.
#[tauri::command]
async fn pick_open_paths(
    window: WebviewWindow,
    allowed: State<'_, Allowed>,
    multiple: Option<bool>,
    directory: Option<bool>,
    title: Option<String>,
    filters: Option<Vec<Filter>>,
) -> Result<Vec<String>, String> {
    let dialog = file_dialog(&window, title, filters);
    if directory.unwrap_or(false) {
        let (tx, rx) = oneshot::channel();
        dialog.pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
        let Some(folder) = rx.await.map_err(|e| e.to_string())? else {
            return Ok(Vec::new());
        };
        let folder = picked(folder)?;
        let files = allowed
            .allow_dir(&folder)
            .map_err(|e| format!("Could not open {}: {e}", display(&folder)))?;
        return Ok(files.iter().map(|p| display(p)).collect());
    }

    let (tx, rx) = oneshot::channel();
    if multiple.unwrap_or(false) {
        dialog.pick_files(move |files| {
            let _ = tx.send(files.unwrap_or_default());
        });
    } else {
        dialog.pick_file(move |file| {
            let _ = tx.send(file.into_iter().collect());
        });
    }
    let mut out = Vec::new();
    for file in rx.await.map_err(|e| e.to_string())? {
        let path = picked(file)?;
        let full = allowed
            .allow_file(&path)
            .map_err(|e| format!("Could not open {}: {e}", display(&path)))?;
        out.push(display(&full));
    }
    Ok(out)
}

/// Shows a save dialog. The chosen path becomes writable with `write_file`.
#[tauri::command]
async fn pick_save_path(
    window: WebviewWindow,
    allowed: State<'_, Allowed>,
    default_name: Option<String>,
    title: Option<String>,
    filters: Option<Vec<Filter>>,
) -> Result<Option<String>, String> {
    // Test hook: with W_E2E_SAVE_DIR set at launch, save there without a dialog.
    if let Some(path) = testing::save_target(
        std::env::var_os(testing::SAVE_DIR_VAR),
        default_name.as_deref(),
    ) {
        let full = allowed
            .allow_file(&path)
            .map_err(|e| format!("Could not save to {}: {e}", display(&path)))?;
        return Ok(Some(display(&full)));
    }
    let mut dialog = file_dialog(&window, title, filters);
    if let Some(name) = default_name {
        dialog = dialog.set_file_name(name);
    }
    let (tx, rx) = oneshot::channel();
    dialog.save_file(move |file| {
        let _ = tx.send(file);
    });
    let Some(file) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = picked(file)?;
    let full = allowed
        .allow_file(&path)
        .map_err(|e| format!("Could not save to {}: {e}", display(&path)))?;
    Ok(Some(display(&full)))
}

/// Test hook: true when the app was launched with W_SELFTEST set.
#[tauri::command]
fn selftest_enabled() -> bool {
    testing::selftest_target(std::env::var_os(testing::SELFTEST_VAR)).is_some()
}

/// Test hook: writes the self-test result to the W_SELFTEST file and quits.
/// Rejects, and writes nothing, when the app was launched without W_SELFTEST.
#[tauri::command(async)]
fn selftest_finish(app: AppHandle, report: String) -> Result<(), String> {
    let path = testing::selftest_target(std::env::var_os(testing::SELFTEST_VAR))
        .ok_or("The self-test is not enabled")?;
    files::write_atomic(&path, report.as_bytes())
        .map_err(|e| format!("Could not write {}: {e}", display(&path)))?;
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // First, so a second launch stops before it builds anything: it hands its
    // files to the window that is already open, and quits.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            take_paths(app, &files::paths_from_args(args, Path::new(&cwd)), true);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(Allowed::default())
        .manage(Host::default())
        .manage(Batcher::default())
        .on_webview_event(|webview, event| {
            // Files and folders dropped on the window, with their real paths.
            if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                take_paths(webview.app_handle(), paths, false);
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            // "Open with" on Windows and Linux passes the files as arguments.
            let cwd = std::env::current_dir().unwrap_or_default();
            take_paths(
                app.handle(),
                &files::paths_from_args(std::env::args(), &cwd),
                true,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_room,
            stop_hosting,
            forget_hosted_room,
            write_file,
            read_file,
            files_ready,
            reveal_file,
            dump_files,
            pick_open_paths,
            pick_save_path,
            selftest_enabled,
            selftest_finish,
            recovery_write,
            recovery_read,
            recovery_list,
            recovery_delete,
            recovery_image,
        ])
        .build(tauri::generate_context!())
        .expect("error while building W Annotator");

    app.run(|_app, _event| {
        // Rooms hosted here are written one last time, so someone who joined a
        // moment ago is still a member when the room is opened again.
        if let tauri::RunEvent::Exit = &_event {
            tauri::async_runtime::block_on(_app.state::<Host>().keep_now());
        }
        // macOS delivers "Open with" and double-clicked files as an event, at
        // launch and while running, and sometimes one selection in several events.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let paths: Vec<PathBuf> = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
            take_paths(_app, &paths, true);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_bytes_reads_raw_and_the_json_fallback() {
        let raw = InvokeBody::Raw(vec![1, 2, 255]);
        assert_eq!(&*body_bytes(&raw).unwrap(), &[1, 2, 255]);
        let json = InvokeBody::Json(serde_json::json!([1, 2, 255]));
        assert_eq!(&*body_bytes(&json).unwrap(), &[1, 2, 255]);
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({ "path": "x" }))).is_err());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!([1, 256]))).is_err());
    }
}
