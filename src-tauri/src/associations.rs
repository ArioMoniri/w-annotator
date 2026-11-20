//! Checks of the "Open with" configuration: `tauri.conf.json` and the
//! per-platform files merged over it. Tests only; the app has no code here.
//!
//! The macOS check builds the `Info.plist` entries with the same function the
//! Tauri bundler uses, so it can run on any machine.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;
use tauri::utils::config::{file_associations_plist, FileAssociation};

/// Every extension the app opens that a system can key on.
const EXTENSIONS: [&str; 6] = ["nii", "mha", "mhd", "nrrd", "nhdr", "dcm"];

fn read(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The associations a platform ends up with: its own file replaces the base list.
fn associations(platform: Option<&str>) -> Vec<FileAssociation> {
    let base = read("tauri.conf.json");
    let own = platform.map(|p| read(&format!("tauri.{p}.conf.json")));
    let list = own
        .as_ref()
        .and_then(|c| c["bundle"].get("fileAssociations"))
        .unwrap_or(&base["bundle"]["fileAssociations"]);
    serde_json::from_value(list.clone()).unwrap()
}

fn extensions(list: &[FileAssociation]) -> BTreeSet<String> {
    list.iter()
        .flat_map(|a| a.ext.iter().map(|e| e.0.clone()))
        .collect()
}

#[test]
fn every_platform_lists_every_format() {
    for platform in [None, Some("macos"), Some("windows"), Some("linux")] {
        let found = extensions(&associations(platform));
        for ext in EXTENSIONS {
            assert!(found.contains(ext), "{platform:?} is missing .{ext}");
        }
    }
}

#[test]
fn the_window_takes_native_drops() {
    let base = read("tauri.conf.json");
    assert_eq!(base["app"]["windows"][0]["dragDropEnabled"], true);
}

#[test]
fn macos_offers_the_app_without_taking_any_default() {
    let plist = file_associations_plist(&associations(Some("macos"))).unwrap();
    let plist = plist.as_dictionary().unwrap();
    let documents = plist["CFBundleDocumentTypes"].as_array().unwrap();
    assert_eq!(documents.len(), 6);
    for doc in documents {
        let doc = doc.as_dictionary().unwrap();
        assert_eq!(doc["LSHandlerRank"].as_string(), Some("Alternate"));
        assert!(!doc["CFBundleTypeName"].as_string().unwrap().is_empty());
    }
    let content_types = |name: &str| -> Vec<String> {
        documents
            .iter()
            .map(|d| d.as_dictionary().unwrap())
            .find(|d| d["CFBundleTypeName"].as_string() == Some(name))
            .and_then(|d| d.get("LSItemContentTypes"))
            .map(|v| {
                v.as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_string().unwrap().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    // A .nii.gz is a gzip archive to Finder; the app is listed for those, as a viewer.
    assert_eq!(
        content_types("Compressed NIfTI image"),
        ["org.gnu.gnu-zip-archive"]
    );
    assert_eq!(content_types("DICOM image"), ["org.nema.dicom"]);
    assert_eq!(
        content_types("NIfTI image (compressed)"),
        ["com.wannotator.nifti-gz"]
    );

    // The one type the app declares itself: the double extension, as a kind of gzip archive.
    let exported = plist["UTExportedTypeDeclarations"].as_array().unwrap();
    assert_eq!(exported.len(), 1);
    let exported = exported[0].as_dictionary().unwrap();
    assert_eq!(
        exported["UTTypeIdentifier"].as_string(),
        Some("com.wannotator.nifti-gz")
    );
    assert_eq!(
        exported["UTTypeConformsTo"].as_array().unwrap()[0].as_string(),
        Some("org.gnu.gnu-zip-archive")
    );
    let tags = exported["UTTypeTagSpecification"].as_dictionary().unwrap();
    assert_eq!(
        tags["public.filename-extension"].as_array().unwrap()[0].as_string(),
        Some("nii.gz")
    );
}

#[test]
fn windows_never_claims_gz_and_names_its_file_classes_uniquely() {
    let list = associations(Some("windows"));
    assert!(!extensions(&list).iter().any(|e| e.ends_with("gz")));
    for a in &list {
        // The installer uses the name as the registry key of the file class.
        let name = a.name.as_deref().unwrap();
        assert!(name.starts_with("WAnnotator.") && !name.contains(' '));
        assert!(a.description.is_some());
    }
    // .gz only gets the app in its "Open with" list, through the installer hook.
    let hook =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("windows/hooks.nsh"))
            .unwrap();
    assert!(hook.contains(r#""Software\Classes\.gz\OpenWithProgids" "WAnnotator.NIfTI""#));
    assert!(list
        .iter()
        .any(|a| a.name.as_deref() == Some("WAnnotator.NIfTI")));
    let conf = read("tauri.windows.conf.json");
    assert_eq!(
        conf["bundle"]["windows"]["nsis"]["installerHooks"],
        "windows/hooks.nsh"
    );
}

#[test]
fn linux_types_are_defined_in_the_file_the_packages_install() {
    let xml = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("linux/w-annotator-mime.xml"),
    )
    .unwrap();
    let list = associations(Some("linux"));
    assert!(extensions(&list).contains("nii.gz"));
    for a in &list {
        let mime = a
            .mime_type
            .as_deref()
            .expect("a MIME type for the .desktop entry");
        // DICOM is already known to the desktop.
        if mime != "application/dicom" {
            assert!(
                xml.contains(&format!(r#"<mime-type type="{mime}">"#)),
                "{mime}"
            );
        }
        for ext in &a.ext {
            if mime != "application/dicom" {
                assert!(xml.contains(&format!(r#"<glob pattern="*.{}"/>"#, ext.0)));
            }
        }
    }
    let conf = read("tauri.linux.conf.json");
    for package in ["deb", "rpm"] {
        assert_eq!(
            conf["bundle"]["linux"][package]["files"]["/usr/share/mime/packages/w-annotator.xml"],
            "linux/w-annotator-mime.xml"
        );
    }
}
