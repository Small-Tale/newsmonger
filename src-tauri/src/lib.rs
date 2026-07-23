//! Tauri shell for the News app.
//!
//! The app's logic lives in the Node server (`src/cli.ts`); this shell only
//! launches it and points the webview at it, mirroring the glassbox
//! architecture (Node sidecar, not a Rust backend).
//!
//! Dev mode (`npm run tauri:dev`) spawns the server from source via tsx and
//! navigates once the "running at <url>" readiness line appears on stdout.
//! Release mode is NOT wired up yet — bundling a Node sidecar is tracked as a
//! follow-up; release builds show a message on the loading page.

use std::sync::Mutex;

use tauri::Manager;

/// Holds the dev-server PID so it can be killed on app exit.
struct ServerPid(Mutex<Option<u32>>);

/// Substring of the readiness line printed by `src/cli.ts`. KEEP IN SYNC.
const READY_MARKER: &str = "running at ";

pub fn run() {
    tauri::Builder::default()
        .manage(ServerPid(Mutex::new(None)))
        .setup(|app| {
            // Dev mode: spawn the Node server via tsx and navigate once ready.
            #[cfg(debug_assertions)]
            {
                let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("CARGO_MANIFEST_DIR has no parent")
                    .to_path_buf();

                // `node --import tsx` (not `npx tsx`) so the spawned child IS
                // the server process and is directly killable on quit.
                let mut child = std::process::Command::new("node")
                    .args(["--import", "tsx", "src/cli.ts", "--no-open"])
                    .current_dir(&project_root)
                    .env("TSX_TSCONFIG_PATH", "tsconfig.json")
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::inherit())
                    .spawn()
                    .expect("failed to spawn dev server (node --import tsx)");

                *app.state::<ServerPid>().0.lock().unwrap() = Some(child.id());

                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");

                // Read stdout on a background thread to find the server URL,
                // then keep draining so the pipe doesn't block the child.
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader};
                    let stdout = child.stdout.take().expect("stdout not captured");
                    let reader = BufReader::new(stdout);
                    let mut navigated = false;
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        eprintln!("[dev-server] {}", line);
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

            // Release mode: production sidecar bundling is not wired up yet.
            #[cfg(not(debug_assertions))]
            {
                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");
                let _ = window.eval("window.showNotBundled && window.showNotBundled()");
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
