//! Tauri shell for the News app.
//!
//! The app's logic lives in the Node server (`src/cli.ts`); this shell only
//! launches it and points the webview at it, mirroring the glassbox
//! architecture (Node sidecar, not a Rust backend).
//!
//! Both modes run the same server the same way — spawn it, watch stdout for the
//! "running at <url>" readiness line, navigate the webview, kill it on quit.
//! Only the command differs, which is all `server_command` decides:
//!
//! - **Dev** (`npm run tauri:dev`): the system `node` running `src/cli.ts` from
//!   source via tsx.
//! - **Release**: the bundled Node sidecar (`news-node`, shipped beside the app
//!   binary as an `externalBin`) running the tsup bundle staged under
//!   `resources/server/`. See `scripts/build-sidecar.sh`.

use std::process::{Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// Holds the server PID so it can be killed on app exit.
struct ServerPid(Mutex<Option<u32>>);

/// Substring of the readiness line printed by `src/cli.ts`. KEEP IN SYNC.
const READY_MARKER: &str = "running at ";

pub fn run() {
    tauri::Builder::default()
        // Native OS notifications (NEWS-66): the web Notification API's
        // permission request doesn't raise the real OS prompt inside the
        // WKWebView, so the client routes notifications through this plugin,
        // whose requestPermission() shows the system dialog.
        .plugin(tauri_plugin_notification::init())
        .manage(ServerPid(Mutex::new(None)))
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            match server_command(app.handle()) {
                Ok(cmd) => spawn_server(app.handle(), cmd, window),
                Err(message) => {
                    eprintln!("[shell] cannot start server: {message}");
                    show_error(&window, &message);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(pid) = *app_handle.state::<ServerPid>().0.lock().unwrap() {
                    kill_server(pid);
                }
            }
        });
}

/// Dev: run the TypeScript source directly through tsx.
///
/// `node --import tsx` (not `npx tsx`) so the spawned child IS the server
/// process and is directly killable on quit.
#[cfg(debug_assertions)]
fn server_command(_app: &AppHandle) -> Result<Command, String> {
    let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("CARGO_MANIFEST_DIR has no parent")?
        .to_path_buf();

    let mut cmd = Command::new("node");
    cmd.args(["--import", "tsx", "src/cli.ts", "--no-open"])
        .current_dir(&project_root)
        .env("TSX_TSCONFIG_PATH", "tsconfig.json");
    Ok(cmd)
}

/// Release: run the staged server bundle with the bundled Node sidecar.
///
/// Both paths are produced by `scripts/build-sidecar.sh`. Tauri places an
/// `externalBin` beside the app executable with the target triple stripped, and
/// `resources` under the platform's resource dir.
#[cfg(not(debug_assertions))]
fn server_command(app: &AppHandle) -> Result<Command, String> {
    let node = std::env::current_exe()
        .map_err(|e| format!("cannot locate the app executable: {e}"))?
        .parent()
        .ok_or("app executable has no parent directory")?
        .join(if cfg!(windows) {
            "news-node.exe"
        } else {
            "news-node"
        });
    if !node.exists() {
        return Err(format!(
            "bundled Node sidecar is missing: {}",
            node.display()
        ));
    }

    let server_js = app
        .path()
        .resource_dir()
        .map_err(|e| format!("cannot locate the resource directory: {e}"))?
        .join("server")
        .join("cli.js");
    if !server_js.exists() {
        return Err(format!(
            "bundled server is missing: {}",
            server_js.display()
        ));
    }

    let mut cmd = Command::new(node);
    cmd.arg(&server_js).arg("--no-open");
    // Keep the sidecar from flashing a console window on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Spawn the server, then watch its stdout for the readiness line and navigate.
fn spawn_server(app: &AppHandle, mut cmd: Command, window: tauri::WebviewWindow) {
    let mut child = match cmd
        // The server exits itself if this process dies without cleaning up
        // (hard kill, `tauri dev` rebuild restart).
        .env("NEWS_WATCH_PARENT", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            let message = format!("failed to start the news server: {e}");
            eprintln!("[shell] {message}");
            show_error(&window, &message);
            return;
        }
    };

    *app.state::<ServerPid>().0.lock().unwrap() = Some(child.id());

    // Read stdout on a background thread to find the server URL, then keep
    // draining so the pipe doesn't block the child.
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let stdout = child.stdout.take().expect("stdout not captured");
        let reader = BufReader::new(stdout);
        let mut navigated = false;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            eprintln!("[server] {}", line);
            if !navigated {
                if let Some(idx) = line.find(READY_MARKER) {
                    let url = line[idx + READY_MARKER.len()..].trim().to_string();
                    match url.parse() {
                        Ok(parsed) => match window.navigate(parsed) {
                            Ok(()) => {
                                eprintln!("[shell] navigated to {url}");
                                navigated = true;
                            }
                            Err(e) => eprintln!("[shell] navigate failed: {e}"),
                        },
                        Err(e) => eprintln!("[shell] bad server url {url:?}: {e}"),
                    }
                }
            }
        }
        if !navigated {
            let _ = window.eval("window.showExited && window.showExited()");
        }
        let _ = child.wait();
    });
}

/// Show a failure message on the loading page (see `loading/index.html`).
fn show_error(window: &tauri::WebviewWindow, message: &str) {
    let escaped = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".to_string());
    let _ = window.eval(format!("window.showError && window.showError({escaped})"));
}

#[cfg(unix)]
fn kill_server(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(windows)]
fn kill_server(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}
