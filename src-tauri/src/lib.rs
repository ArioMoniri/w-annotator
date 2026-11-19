//! Rust side of W Annotator: file access for paths the user chose, hosting a
//! room on the local network, and files opened with the app from the system.
//!
//! The JavaScript signature of every command is documented in `README.md`.

mod files;
mod hosting;
mod testing;

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use tokio::sync::oneshot;

use files::Allowed;
use hosting::{Host, HostInfo};

/// Event sent to the web side when the system asks the running app to open files.
const OPENED_EVENT: &str = "opened-files";

/// Files the system asked the app to open, in order.
#[derive(Default)]
struct Opened(Mutex<Vec<String>>);

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Records files the system handed to the app and allows access to them.
fn remember_opened(app: &AppHandle, paths: Vec<PathBuf>, notify: bool) {
    let allowed = app.state::<Allowed>();
    let new: Vec<String> = paths
        .iter()
        .filter_map(|p| allowed.allow_file(p).ok())
        .map(|p| display(&p))
        .collect();
    if new.is_empty() {
        return;
    }
    app.state::<Opened>().0.lock().unwrap().extend(new.clone());
    if notify {
        let _ = app.emit(OPENED_EVENT, new);
    }
}

#[tauri::command]
async fn host_room(host: State<'_, Host>, port: Option<u16>) -> Result<HostInfo, String> {
    host.start(port)
        .await
        .map_err(|e| format!("Could not start hosting: {e}"))
}

#[tauri::command]
async fn stop_hosting(host: State<'_, Host>) -> Result<(), String> {
    host.stop().await;
    Ok(())
}

/// The bytes of a raw request body. When the webview cannot use the IPC custom
/// protocol, Tauri falls back to sending the same bytes as a JSON array.
fn body_bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        InvokeBody::Json(value) => Vec::<u8>::deserialize(value)
            .map(Cow::Owned)
            .map_err(|_| "write_file expects the file bytes as the raw request body".to_string()),
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

#[tauri::command]
fn opened_files(opened: State<'_, Opened>) -> Vec<String> {
    opened.0.lock().unwrap().clone()
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .manage(Allowed::default())
        .manage(Host::default())
        .manage(Opened::default())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            // "Open with" on Windows and Linux passes the files as arguments.
            remember_opened(
                app.handle(),
                files::files_from_args(std::env::args()),
                false,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_room,
            stop_hosting,
            write_file,
            read_file,
            opened_files,
            pick_open_paths,
            pick_save_path,
            selftest_enabled,
            selftest_finish,
        ])
        .build(tauri::generate_context!())
        .expect("error while building W Annotator");

    app.run(|_app, _event| {
        // macOS delivers "Open with" and double-clicked files as an event.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let paths = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
            remember_opened(_app, paths, true);
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
