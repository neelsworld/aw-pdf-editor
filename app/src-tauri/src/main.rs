// SPDX-License-Identifier: AGPL-3.0-or-later
// AW PDF Editor. This shell shows the window, opens file pickers, hands PDF bytes to the viewer and
// passes requests to the Python worker (one JSON object per line, the same protocol as AW Signer's
// worker). All PDF reading and writing happens in the worker; the viewer only displays.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{DragDropEvent, Emitter, WindowEvent};
use tauri_plugin_dialog::DialogExt;

/// Messages after which the worker has nothing more to say for this request.
const LAST_MESSAGES: [&str; 10] = ["pong", "info", "saved", "split_done", "office_status", "converted", "exported", "page_layer", "found", "error"];

/// Files that "Create PDF" can turn into a PDF (worker/src/aw_pdf_worker/convert.py).
const CONVERTIBLE: &[&str] = &[
    "jpg", "jpeg", "png", "tif", "tiff", "bmp", "gif", "webp", "txt", "text", "csv", "html", "htm", "md", "markdown",
    "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp",
];
/// What each format is saved as: (format, extension, name in the save dialog).
const SAVE_TYPES: &[(&str, &str, &str)] = &[
    ("pdf", "pdf", "PDF"), ("docx", "docx", "Word document"), ("xlsx", "xlsx", "Excel workbook"),
    ("pptx", "pptx", "PowerPoint presentation"), ("png", "png", "PNG image"), ("jpeg", "jpg", "JPEG image"),
    ("tiff", "tiff", "TIFF image"), ("txt", "txt", "Plain text"), ("html", "html", "Web page"), ("md", "md", "Markdown"),
];

/// Files the person chose (picker or drag-and-drop). The viewer and the worker may read only these,
/// so a page in the window can never ask for an arbitrary file on disk.
static OPENED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
/// Non-PDF files the person chose for "Create PDF": the worker may read these to convert them.
static CONVERT_INPUTS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
/// The app's own folder for converted files and the background LibreOffice profile.
static WORK_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Where the person chose to save (save dialog) and folders they chose (for split parts). The worker
/// may write only there, or over a file they opened ("Save").
static SAVE_TARGETS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
static FOLDERS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
/// Unsaved changes in the window, so closing it asks first.
static DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn add_to(set: &Mutex<Option<HashSet<PathBuf>>>, path: &Path) {
    set.lock().unwrap().get_or_insert_with(HashSet::new).insert(path.to_path_buf());
}

fn is_in(set: &Mutex<Option<HashSet<PathBuf>>>, path: &Path) -> bool {
    set.lock().unwrap().as_ref().is_some_and(|items| items.contains(path))
}

fn allow(path: &Path) {
    add_to(&OPENED, path);
}

fn extension(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn is_convertible(path: &Path) -> bool {
    CONVERTIBLE.contains(&extension(path).as_str())
}

/// Sorts chosen or dropped files: PDFs may be opened, other supported files may be converted.
fn sort_files(paths: impl IntoIterator<Item = PathBuf>) -> Value {
    let (mut pdfs, mut others) = (vec![], vec![]);
    for path in paths.into_iter().filter(|p| p.is_file()) {
        if is_pdf_name(&path) {
            allow(&path);
            pdfs.push(path.display().to_string());
        } else if is_convertible(&path) {
            add_to(&CONVERT_INPUTS, &path);
            others.push(path.display().to_string());
        }
    }
    json!({ "pdfs": pdfs, "others": others })
}

/// Fills in the app's own folders for "Create PDF", so the page never chooses where the worker writes.
fn prepare_request(request: &mut Value) {
    if request.get("command").and_then(Value::as_str) == Some("to_pdf") {
        if let Some(work) = WORK_DIR.lock().unwrap().clone() {
            request["out_dir"] = json!(work.join("converted"));
            request["profile_dir"] = json!(work.join("office-profile"));
        }
    }
}

/// Checks a worker request against what the person chose, before the worker sees it.
fn check_request(request: &Value) -> Result<(), String> {
    let text = |key: &str| request.get(key).and_then(Value::as_str).map(PathBuf::from);
    let sources_ok = || {
        request.get("sources").and_then(Value::as_array).is_some_and(|sources| {
            sources.iter().all(|s| s.get("path").and_then(Value::as_str).is_some_and(|p| is_allowed(Path::new(p))))
        })
    };
    let refused = || Err("The PDF engine was asked to use a file you didn't choose.".to_string());
    // Batch: results go into a folder the person chose.
    let in_chosen_folder = |path: &Path| path.parent().is_some_and(|folder| is_in(&FOLDERS, folder));
    match request.get("command").and_then(Value::as_str) {
        Some("ping") => Ok(()),
        Some("info") => match text("path") {
            Some(path) if is_allowed(&path) => Ok(()),
            _ => refused(),
        },
        Some("apply_plan") => match text("output") {
            Some(out) if sources_ok() && (is_in(&SAVE_TARGETS, &out) || is_allowed(&out) || in_chosen_folder(&out)) && is_pdf_name(&out) => Ok(()),
            _ => refused(),
        },
        Some("split") => match text("folder") {
            Some(folder) if sources_ok() && is_in(&FOLDERS, &folder) => Ok(()),
            _ => refused(),
        },
        Some("office_status") => Ok(()),
        Some("page_layer") | Some("find_text") => {
            if sources_ok() { Ok(()) } else { refused() }
        }
        Some("to_pdf") => {
            let inputs = request.get("inputs").and_then(Value::as_array);
            let ok = inputs.is_some_and(|items| {
                items.iter().all(|p| p.as_str().is_some_and(|p| is_in(&CONVERT_INPUTS, Path::new(p))))
            });
            if ok { Ok(()) } else { refused() }
        }
        Some("export") => {
            let to_file = text("output").is_some_and(|out| is_in(&SAVE_TARGETS, &out) || in_chosen_folder(&out));
            let to_folder = text("folder").is_some_and(|folder| is_in(&FOLDERS, &folder));
            if sources_ok() && (to_file || to_folder) { Ok(()) } else { refused() }
        }
        _ => Err("Unknown request.".into()),
    }
}

/// Recently opened PDFs, kept by this shell (not the page) in the app's data folder, so reopening one
/// is allowed only for files the person really opened before.
const RECENT_LIMIT: usize = 10;

fn recent_store(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let folder = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder.join("recent.json"))
}

fn load_recent(app: &tauri::AppHandle) -> Vec<PathBuf> {
    recent_store(app)
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

fn remember(app: &tauri::AppHandle, path: &Path) {
    let mut list = load_recent(app);
    list.retain(|item| item != path);
    list.insert(0, path.to_path_buf());
    list.truncate(RECENT_LIMIT);
    if let Some(file) = recent_store(app) {
        let text: Vec<String> = list.iter().map(|p| p.display().to_string()).collect();
        let _ = std::fs::write(file, serde_json::to_string(&text).unwrap_or_default());
    }
}

/// The recent list for the start screen; files that no longer exist are left out. Listing a file also
/// lets the viewer reopen it.
#[tauri::command]
fn recent_files(app: tauri::AppHandle) -> Vec<Value> {
    load_recent(&app)
        .into_iter()
        .filter(|path| path.is_file())
        .map(|path| {
            allow(&path);
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            json!({ "path": path.display().to_string(), "name": name })
        })
        .collect()
}

fn is_allowed(path: &Path) -> bool {
    OPENED.lock().unwrap().as_ref().is_some_and(|set| set.contains(path))
}

fn is_pdf_name(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// How to start the worker. An installed build has the packed worker next to the app (Windows) or in
/// the app's Resources folder (Mac). A development run starts `python -m aw_pdf_worker` from
/// worker/src with worker/.venv's Python; AW_PDF_PYTHON picks another interpreter.
fn worker_command() -> Command {
    let name = if cfg!(windows) { "aw-pdf-worker.exe" } else { "aw-pdf-worker" };
    if let Some(folder) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from)) {
        // Windows installer: Windows' embeddable Python with the worker code next to it (as AW Signer).
        let worker = folder.join("aw-pdf-worker");
        let embedded = worker.join("python").join("python.exe");
        if embedded.is_file() {
            let mut command = Command::new(embedded);
            command.args(["-X", "utf8", "-m", "aw_pdf_worker"]).env("AW_TESSDATA", worker.join("tessdata"));
            return command;
        }
        for base in [worker, folder.join("../Resources/aw-pdf-worker")] {
            let packaged = base.join(name);
            if packaged.is_file() {
                let mut command = Command::new(packaged);
                command.env("PYTHONUTF8", "1");
                return command;
            }
        }
    }
    let worker = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../worker");
    let venv = worker.join(if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" });
    let python = std::env::var("AW_PDF_PYTHON").map(PathBuf::from).unwrap_or(venv);
    let mut command = Command::new(python);
    command.args(["-X", "utf8", "-m", "aw_pdf_worker"]).env("PYTHONPATH", worker.join("src"));
    command
}

/// Runs one request and returns the worker's final message. `timeout` ends a worker that hangs.
fn talk_to_worker(request: &Value, timeout: Duration) -> Value {
    let mut command = worker_command();
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no black console window
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return json!({ "type": "error", "error": format!("Could not start the PDF engine: {error}") }),
    };
    if let Some(mut input) = child.stdin.take() {
        let line = format!("{request}\n");
        if let Err(error) = input.write_all(line.as_bytes()) {
            let _ = child.kill();
            return json!({ "type": "error", "error": format!("Could not talk to the PDF engine: {error}") });
        }
    } // input closed here: one request per worker, like AW Signer

    let stderr = child.stderr.take();
    let diagnostics = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut last = None;
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                let kind = message.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                last = Some(message);
                if LAST_MESSAGES.contains(&kind.as_str()) {
                    break;
                }
            }
        }
        last
    });

    let started = Instant::now();
    while !reader.is_finished() && started.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(20));
    }
    let timed_out = !reader.is_finished();
    let _ = child.kill();
    let _ = child.wait();
    let answer = reader.join().ok().flatten();
    let diagnostics = diagnostics.join().unwrap_or_default();
    match answer {
        Some(message) if !timed_out => message,
        _ if timed_out => json!({ "type": "error", "error": "The PDF engine took too long and was stopped." }),
        _ => {
            let tail: Vec<&str> = diagnostics.lines().rev().take(3).collect();
            let detail = tail.into_iter().rev().collect::<Vec<_>>().join(" ");
            json!({ "type": "error", "error": format!("The PDF engine stopped unexpectedly. {detail}") })
        }
    }
}

#[tauri::command]
async fn run_worker(app: tauri::AppHandle, mut request: Value) -> Value {
    if let Err(error) = check_request(&request) {
        return json!({ "type": "error", "error": error });
    }
    prepare_request(&mut request);
    // Saving a big merged file, splitting by size or converting office files can take a while;
    // 10 minutes before giving up.
    let answer = tauri::async_runtime::spawn_blocking(move || talk_to_worker(&request, Duration::from_secs(600)))
        .await
        .unwrap_or_else(|error| json!({ "type": "error", "error": error.to_string() }));
    if answer["type"] == "saved" {
        if let Some(path) = answer["path"].as_str().map(PathBuf::from) {
            allow(&path); // the saved file is what the window shows next
            remember(&app, &path);
        }
    }
    if answer["type"] == "converted" {
        for file in answer["files"].as_array().into_iter().flatten() {
            if let Some(pdf) = file["pdf"].as_str() {
                allow(Path::new(pdf)); // converted PDFs are opened next
            }
        }
    }
    if answer["type"] == "exported" {
        for file in answer["files"].as_array().into_iter().flatten() {
            if let Some(path) = file["path"].as_str() {
                allow(Path::new(path)); // so "Show in folder" may point at it
            }
        }
    }
    answer
}

/// "Create PDF" and "Insert from file": PDFs and every file type that can be converted.
#[tauri::command]
async fn pick_any_files(app: tauri::AppHandle) -> Value {
    let mut supported = vec!["pdf"];
    supported.extend_from_slice(CONVERTIBLE);
    let picked = app
        .dialog()
        .file()
        .add_filter("PDFs, images, Office and text files", &supported)
        .blocking_pick_files()
        .unwrap_or_default();
    sort_files(picked.into_iter().filter_map(|file| file.into_path().ok()))
}

#[tauri::command]
async fn pick_pdf(app: tauri::AppHandle) -> Option<String> {
    let picked = app.dialog().file().add_filter("PDF", &["pdf", "PDF"]).blocking_pick_file()?;
    let path = picked.into_path().ok()?;
    allow(&path);
    Some(path.display().to_string())
}

/// Several PDFs at once, for Merge and "Insert pages from a file".
#[tauri::command]
async fn pick_pdfs(app: tauri::AppHandle) -> Vec<String> {
    let picked = app.dialog().file().add_filter("PDF", &["pdf", "PDF"]).blocking_pick_files().unwrap_or_default();
    picked
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .filter(|path| is_pdf_name(path))
        .map(|path| {
            allow(&path);
            path.display().to_string()
        })
        .collect()
}

/// "Save as": the system save dialog (which itself asks before replacing a file).
#[tauri::command]
async fn pick_save_path(app: tauri::AppHandle, suggested: String, folder: Option<String>, format: Option<String>) -> Option<String> {
    let format = format.unwrap_or_else(|| "pdf".into());
    let &(_, ext, label) = SAVE_TYPES.iter().find(|(f, _, _)| *f == format)?;
    let mut dialog = app.dialog().file().add_filter(label, &[ext]).set_file_name(&suggested);
    if let Some(folder) = folder.map(PathBuf::from).filter(|f| f.is_dir()) {
        dialog = dialog.set_directory(folder);
    }
    let mut path = dialog.blocking_save_file()?.into_path().ok()?;
    let has_ext = extension(&path) == ext || (ext == "jpg" && extension(&path) == "jpeg") || (ext == "tiff" && extension(&path) == "tif");
    if !has_ext {
        let name = format!("{}.{ext}", path.file_name()?.to_string_lossy());
        path.set_file_name(name);
    }
    add_to(&SAVE_TARGETS, &path);
    Some(path.display().to_string())
}

/// A picture to place on a page (logo, scanned signature): read here and handed to the page as
/// base64, so the page never needs file access. Up to 15 MB.
#[tauri::command]
async fn pick_image(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    use base64::Engine;
    let Some(file) = app.dialog().file().add_filter("Pictures", &["png", "jpg", "jpeg"]).blocking_pick_file() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    let bytes = std::fs::read(&path).map_err(|error| format!("Could not read the picture: {error}"))?;
    if bytes.len() > 15 * 1024 * 1024 {
        return Err("That picture is larger than 15 MB. Use a smaller one.".into());
    }
    let mime = if extension(&path) == "png" { "image/png" } else { "image/jpeg" };
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(Some(json!({ "name": name, "mime": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes) })))
}

/// A folder for split parts.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, folder: Option<String>) -> Option<String> {
    let mut dialog = app.dialog().file();
    if let Some(folder) = folder.map(PathBuf::from).filter(|f| f.is_dir()) {
        dialog = dialog.set_directory(folder);
    }
    let path = dialog.blocking_pick_folder()?.into_path().ok()?;
    add_to(&FOLDERS, &path);
    Some(path.display().to_string())
}

/// Shows a saved file or a split folder in Finder / File Explorer.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !(is_allowed(&path) || is_in(&FOLDERS, &path)) {
        return Err("Only files and folders you chose can be shown.".into());
    }
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(windows)]
    let result = Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(path.parent().unwrap_or(&path)).spawn();
    result.map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_dirty(dirty: bool) {
    DIRTY.store(dirty, std::sync::atomic::Ordering::SeqCst);
}

/// Close after the person chose "Discard changes".
#[tauri::command]
fn close_window(window: tauri::Window) {
    DIRTY.store(false, std::sync::atomic::Ordering::SeqCst);
    let _ = window.close();
}

/// The bytes of a PDF the person opened, for the on-screen viewer.
#[tauri::command]
fn read_pdf(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    let bytes = read_opened_pdf(&path)?;
    remember(&app, &path);
    Ok(tauri::ipc::Response::new(bytes))
}

fn read_opened_pdf(path: &Path) -> Result<Vec<u8>, String> {
    if !is_allowed(path) || !is_pdf_name(path) {
        return Err("Open the file from AW PDF Editor first.".into());
    }
    std::fs::read(path).map_err(|error| format!("Could not read the file: {error}"))
}

/// Opens an AccredWorks web page in the default browser. Only accredworks.com, so a page in the
/// window can't send the person anywhere else.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // accredworks.com, and LibreOffice's download page for people who need it to convert Office files.
    if !(url.starts_with("https://accredworks.com/") || url == "https://www.libreoffice.org/download/") {
        return Err("Only accredworks.com links can be opened.".into());
    }
    #[cfg(windows)]
    let result = Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|error| error.to_string())
}

/// A web or e-mail link inside a PDF, after the person clicked it and confirmed. Only http, https and
/// mailto: never file:, javascript: or app links, which a PDF could use to start something on this computer.
fn is_safe_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"' || c == '\\')
}

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !is_safe_link(&url) {
        return Err("Only web (http, https) and e-mail links can be opened.".into());
    }
    #[cfg(windows)]
    let result = Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|error| error.to_string())
}

/// Full screen for reading and presentations. Returns the new state.
#[tauri::command]
fn set_fullscreen(window: tauri::WebviewWindow, on: Option<bool>) -> Result<bool, String> {
    let now = window.is_fullscreen().map_err(|e| e.to_string())?;
    let want = on.unwrap_or(!now);
    window.set_fullscreen(want).map_err(|e| e.to_string())?;
    Ok(want)
}

/// PDFs to open that arrived before the page was ready (Finder "Open with" while starting).
static PENDING_OPEN: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
static PAGE_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// PDFs given when the app started ("Open with AW PDF Editor" on Windows, or from a terminal) and any
/// that Finder handed over while it was starting. The page calls this once, when it is ready.
#[tauri::command]
fn launch_files() -> Vec<String> {
    PAGE_READY.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut paths: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    paths.append(&mut PENDING_OPEN.lock().unwrap());
    paths
        .into_iter()
        .filter(|p| is_pdf_name(p) && p.is_file())
        .map(|p| {
            allow(&p);
            p.display().to_string()
        })
        .collect()
}

/// Finder's "Open with AW PDF Editor" (or a PDF dropped on the Dock icon) while the app runs.
fn open_from_system(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    let pdfs: Vec<PathBuf> = paths.into_iter().filter(|p| is_pdf_name(p) && p.is_file()).collect();
    if pdfs.is_empty() {
        return;
    }
    if !PAGE_READY.load(std::sync::atomic::Ordering::SeqCst) {
        PENDING_OPEN.lock().unwrap().extend(pdfs);
        return;
    }
    let list: Vec<String> = pdfs.iter().map(|p| { allow(p); p.display().to_string() }).collect();
    let _ = app.emit("open-files", list);
}

/// "Sign with DSC": hands the saved PDF to AW Signer, a separate app. Only the file's path passes
/// between the two (AW Signer is closed source, this editor is AGPL: no shared code or worker).
/// Returns what happened, for the editor's message:
/// - "handed": AW Signer was started with the path. Builds from 2026-11-05 on open it in their Sign
///   screen; older ones just start, so the message also offers "Show in folder".
/// - "started": AW Signer was started without the path (a Mac AW Signer 2.6.2 or older, or the
///   Microsoft Store install without the awsigner.exe alias), and the PDF is selected in Finder /
///   File Explorer to choose there.
/// - "missing": AW Signer isn't installed.
#[tauri::command]
fn open_in_signer(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !is_allowed(&path) {
        return Err("Save the PDF first.".into());
    }
    #[cfg(target_os = "macos")]
    {
        const SIGNER: &str = "com.accredworks.aw-signer-v2";
        // AW Signer 2.6.2 and older declare no PDF document type, so handing them a file could end in
        // a "can't open files in this format" message. Where AW Signer is in its usual place, read its
        // Info.plist (XML or binary, the key name is plain text in both) and start an old one without
        // the file, with the PDF selected in Finder, as before.
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let plist = [PathBuf::from("/Applications"), home.join("Applications")]
            .into_iter()
            .map(|d| d.join("AccredWorks AW Signer.app").join("Contents").join("Info.plist"))
            .find(|p| p.is_file());
        let takes_files = plist
            .and_then(|p| std::fs::read(p).ok())
            .map_or(true, |bytes| bytes.windows(21).any(|w| w == b"CFBundleDocumentTypes"));
        if !takes_files {
            Command::new("open").args(["-b", SIGNER]).spawn().map_err(|error| error.to_string())?;
            let _ = Command::new("open").arg("-R").arg(&path).spawn();
            return Ok("started".into());
        }
        // `open -b` fails (non-zero) when no app has this bundle id.
        let handed = Command::new("open")
            .args(["-b", SIGNER])
            .arg(&path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        return Ok(if handed { "handed" } else { "missing" }.into());
    }
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        // The NSIS installer puts AW Signer here (01_AW_Signer/windows/packaging/installer.nsi).
        let exe = local.as_ref().map(|d| d.join("Programs").join("AW Signer").join("AW Signer.exe"));
        if let Some(exe) = exe.filter(|e| e.is_file()) {
            Command::new(exe).arg(&path).spawn().map_err(|error| error.to_string())?;
            return Ok("handed".into());
        }
        // Microsoft Store install with the app execution alias (AW Signer Store builds after 2026-11-06,
        // 01_AW_Signer/windows/packaging/AppxManifest.xml). The alias is a reparse point that
        // `is_file()` can't follow, so only check that it exists.
        let alias = local.as_ref().map(|d| d.join("Microsoft").join("WindowsApps").join("awsigner.exe"));
        if let Some(alias) = alias.filter(|a| std::fs::symlink_metadata(a).is_ok()) {
            if Command::new(&alias).arg(&path).spawn().is_ok() {
                return Ok("handed".into());
            }
        }
        // Older Store install, without the alias: its per-user data folder is %LOCALAPPDATA%\Packages\
        // <package family name>, which starts with the package identity (01_AW_Signer/windows/STORE-PLAN.md).
        // It can't be given a file argument, so start it and select the file in Explorer.
        let family = local.and_then(|d| std::fs::read_dir(d.join("Packages")).ok()).and_then(|entries| {
            entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).find(|n| n.starts_with("NeelK.AWSigner_"))
        });
        if let Some(family) = family {
            Command::new("explorer").arg(format!("shell:AppsFolder\\{family}!AWSigner")).spawn().map_err(|error| error.to_string())?;
            let _ = Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
            return Ok("started".into());
        }
        return Ok("missing".into());
    }
    #[allow(unreachable_code)]
    Ok("missing".into())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_links_open_only_web_and_mail() {
        assert!(is_safe_link("https://accredworks.com/pdf-editor"));
        assert!(is_safe_link("http://example.org/a?b=c#d"));
        assert!(is_safe_link("mailto:support@accredworks.com"));
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "smb://server/share", "ms-settings:", "https://a.b/ c", "https://a.b/\nx", "/Applications/Calculator.app"] {
            assert!(!is_safe_link(bad), "{bad}");
        }
    }

    #[test]
    fn ping_reaches_the_worker() {
        let answer = talk_to_worker(&json!({ "command": "ping" }), Duration::from_secs(30));
        assert_eq!(answer["type"], "pong", "{answer}");
        assert!(answer["engine"].as_str().unwrap().contains("MuPDF"));
    }

    #[test]
    fn viewer_reads_only_opened_pdfs() {
        assert!(read_opened_pdf(Path::new("/etc/hosts")).is_err());
        let not_opened = std::env::temp_dir().join("never-opened.pdf");
        std::fs::write(&not_opened, b"%PDF-1.4").unwrap();
        assert!(read_opened_pdf(&not_opened).is_err());
        allow(&not_opened);
        assert!(read_opened_pdf(&not_opened).is_ok());
        std::fs::remove_file(&not_opened).unwrap();
    }

    #[test]
    fn worker_requests_only_touch_chosen_files() {
        let opened = std::env::temp_dir().join("aw-check-opened.pdf");
        let chosen_out = std::env::temp_dir().join("aw-check-out.pdf");
        let folder = std::env::temp_dir().join("aw-check-folder");
        allow(&opened);
        add_to(&SAVE_TARGETS, &chosen_out);
        add_to(&FOLDERS, &folder);
        let src = json!([{ "path": opened }]);
        let plan = json!([{ "src": 0, "page": 1 }]);

        assert!(check_request(&json!({ "command": "ping" })).is_ok());
        assert!(check_request(&json!({ "command": "info", "path": opened })).is_ok());
        assert!(check_request(&json!({ "command": "info", "path": "/etc/passwd" })).is_err());
        // Save over the opened file, or to a path from the save dialog: yes. Anywhere else: no.
        assert!(check_request(&json!({ "command": "apply_plan", "sources": src, "pages": plan, "output": opened })).is_ok());
        assert!(check_request(&json!({ "command": "apply_plan", "sources": src, "pages": plan, "output": chosen_out })).is_ok());
        assert!(check_request(&json!({ "command": "apply_plan", "sources": src, "pages": plan, "output": "/tmp/other.pdf" })).is_err());
        let foreign = json!([{ "path": "/etc/hosts" }]);
        assert!(check_request(&json!({ "command": "apply_plan", "sources": foreign, "pages": plan, "output": chosen_out })).is_err());
        assert!(check_request(&json!({ "command": "split", "sources": src, "pages": plan, "folder": folder })).is_ok());
        assert!(check_request(&json!({ "command": "split", "sources": src, "pages": plan, "folder": "/tmp" })).is_err());
        // Batch: into the chosen folder yes, next to it no.
        assert!(check_request(&json!({ "command": "apply_plan", "sources": src, "pages": plan, "output": folder.join("a.pdf") })).is_ok());
        assert!(check_request(&json!({ "command": "apply_plan", "sources": src, "pages": plan, "output": std::env::temp_dir().join("a.pdf") })).is_err());
        assert!(check_request(&json!({ "command": "find_text", "sources": src, "pages": plan, "terms": ["x"] })).is_ok());
        assert!(check_request(&json!({ "command": "delete_everything" })).is_err());
    }

    #[test]
    fn convert_and_export_requests_only_touch_chosen_files() {
        let opened = std::env::temp_dir().join("aw-check2-opened.pdf");
        let photo = std::env::temp_dir().join("aw-check2-photo.jpg");
        let word_out = std::env::temp_dir().join("aw-check2-out.docx");
        let images = std::env::temp_dir().join("aw-check2-images");
        allow(&opened);
        add_to(&CONVERT_INPUTS, &photo);
        add_to(&SAVE_TARGETS, &word_out);
        add_to(&FOLDERS, &images);
        let src = json!([{ "path": opened }]);
        let plan = json!([{ "src": 0, "page": 1 }]);

        assert!(check_request(&json!({ "command": "to_pdf", "inputs": [photo] })).is_ok());
        assert!(check_request(&json!({ "command": "page_layer", "sources": src, "page": { "src": 0, "page": 1 } })).is_ok());
        assert!(check_request(&json!({ "command": "page_layer", "sources": [{ "path": "/etc/hosts" }], "page": {} })).is_err());
        assert!(check_request(&json!({ "command": "to_pdf", "inputs": [photo, "/etc/hosts"] })).is_err());
        assert!(check_request(&json!({ "command": "export", "format": "docx", "sources": src, "pages": plan, "output": word_out })).is_ok());
        assert!(check_request(&json!({ "command": "export", "format": "png", "sources": src, "pages": plan, "folder": images })).is_ok());
        assert!(check_request(&json!({ "command": "export", "format": "txt", "sources": src, "pages": plan, "output": "/tmp/x.txt" })).is_err());
        // The page can't choose where converted files go: the shell fills that in.
        let mut request = json!({ "command": "to_pdf", "inputs": [photo], "out_dir": "/etc" });
        *WORK_DIR.lock().unwrap() = Some(std::env::temp_dir().join("aw-work"));
        prepare_request(&mut request);
        assert!(request["out_dir"].as_str().unwrap().ends_with("converted"));
    }

    #[test]
    fn dropped_files_are_sorted_by_kind() {
        let folder = std::env::temp_dir().join("aw-sort-test");
        std::fs::create_dir_all(&folder).unwrap();
        let names = ["a.pdf", "b.JPG", "c.docx", "d.exe"];
        for name in names {
            std::fs::write(folder.join(name), b"x").unwrap();
        }
        let sorted = sort_files(names.iter().map(|n| folder.join(n)));
        assert_eq!(sorted["pdfs"].as_array().unwrap().len(), 1);
        assert_eq!(sorted["others"].as_array().unwrap().len(), 2); // the .exe is ignored
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn links_are_limited_to_accredworks() {
        assert!(open_url("https://example.com/".into()).is_err());
        assert!(open_url("https://accredworks.com.evil.test/".into()).is_err());
    }
}

/// The Mac menu bar. The standard one binds ⌘W to "Close Window", which would close the whole app
/// instead of one tab, and its Undo and Select All would never reach the page. These items send a
/// "menu" event to the page instead (handled in app.js). Windows has no menu bar: the same keys
/// arrive at the page's keyboard handler there.
#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let item = |id: &str, text: &str, keys: &str| MenuItemBuilder::with_id(id, text).accelerator(keys).build(app);
    let app_menu = SubmenuBuilder::new(app, "AW PDF Editor")
        .about(None).separator().services().separator().hide().hide_others().show_all().separator().quit().build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("open", "Open…", "CmdOrCtrl+O")?)
        .separator()
        .item(&item("save", "Save", "CmdOrCtrl+S")?)
        .item(&item("save-as", "Save As…", "CmdOrCtrl+Shift+S")?)
        .separator()
        .item(&item("close-tab", "Close Tab", "CmdOrCtrl+W")?)
        .item(&item("close-window", "Close Window", "CmdOrCtrl+Shift+W")?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", "CmdOrCtrl+Z")?)
        .item(&item("redo", "Redo", "CmdOrCtrl+Shift+Z")?)
        .separator().cut().copy().paste()
        .item(&item("select-all", "Select All", "CmdOrCtrl+A")?)
        .build()?;
    // Reading (READER-PLAN.md R1). Each item goes to the page as a "menu" event, like the ones above.
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("find", "Find…", "CmdOrCtrl+F")?)
        .item(&item("find-next", "Find Next", "CmdOrCtrl+G")?)
        .item(&item("find-previous", "Find Previous", "CmdOrCtrl+Shift+G")?)
        .separator()
        .item(&item("zoom-in", "Zoom In", "CmdOrCtrl+=")?)
        .item(&item("zoom-out", "Zoom Out", "CmdOrCtrl+-")?)
        .item(&item("fit-width", "Fit Width", "CmdOrCtrl+0")?)
        .item(&item("fit-page", "Fit Page", "CmdOrCtrl+9")?)
        .separator()
        .item(&item("two-pages", "Two Pages Side by Side", "CmdOrCtrl+Shift+2")?)
        .item(&item("rotate-view-left", "Rotate View Left", "CmdOrCtrl+Shift+L")?)
        .item(&item("rotate-view-right", "Rotate View Right", "CmdOrCtrl+Shift+R")?)
        .item(&item("night", "Night Reading", "CmdOrCtrl+Shift+N")?)
        .item(&item("bookmarks", "Show Bookmarks", "CmdOrCtrl+Shift+B")?)
        .separator()
        .item(&item("back", "Back", "CmdOrCtrl+[")?)
        .item(&item("forward", "Forward", "CmdOrCtrl+]")?)
        .separator()
        .item(&item("present", "Presentation", "CmdOrCtrl+Shift+P")?)
        .item(&item("full-screen", "Full Screen", "Ctrl+CmdOrCtrl+F")?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().bring_all_to_front().build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window]).build()
}

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu);
    builder
        .on_menu_event(|app, event| {
            use tauri::Manager;
            let id = event.id().as_ref().to_string();
            if id == "close-window" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close(); // goes through the unsaved-changes check below
                }
            } else {
                let _ = app.emit("menu", id);
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The app's work folder: converted files from an earlier run are cleared; the background
            // LibreOffice profile is kept, so later conversions start faster.
            use tauri::Manager;
            if let Ok(cache) = app.path().app_cache_dir() {
                let _ = std::fs::remove_dir_all(cache.join("converted"));
                if std::fs::create_dir_all(cache.join("converted")).is_ok() {
                    *WORK_DIR.lock().unwrap() = Some(cache);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Unsaved changes: keep the window open and let the page ask "Save, discard or cancel?".
            if let WindowEvent::CloseRequested { api, .. } = event {
                if DIRTY.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("confirm-close", ());
                }
            }
            // Drag-and-drop arrives here with real paths; only PDFs are allowed, then the page is told.
            if let WindowEvent::DragDrop(drop) = event {
                match drop {
                    DragDropEvent::Enter { .. } | DragDropEvent::Over { .. } => {
                        let _ = window.emit("drop-hover", true);
                    }
                    DragDropEvent::Leave => {
                        let _ = window.emit("drop-hover", false);
                    }
                    DragDropEvent::Drop { paths, .. } => {
                        let _ = window.emit("drop-hover", false);
                        let _ = window.emit("files-dropped", sort_files(paths.iter().cloned()));
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![run_worker, pick_pdf, pick_pdfs, pick_any_files, pick_save_path, pick_folder, pick_image,
            reveal, read_pdf, recent_files, launch_files, open_url, open_link, set_fullscreen, app_version, set_dirty, close_window,
            open_in_signer])
        .build(tauri::generate_context!())
        .expect("AW PDF Editor could not start")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                open_from_system(app, urls.into_iter().filter_map(|url| url.to_file_path().ok()).collect());
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
