//! Tauri shell for the Newsmonger app.
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
//! - **Release**: the bundled Node sidecar (`newsmonger-node`, shipped beside the app
//!   binary as an `externalBin`) running the tsup bundle staged under
//!   `resources/server/`. See `scripts/build-sidecar.sh`.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

/// Holds the server PID so it can be killed on app exit.
struct ServerPid(Mutex<Option<u32>>);

/// Version string of an update found at startup, if any (NEWS-89).
///
/// The startup check runs on a spawned task so it never delays the window, and it
/// parks its result here rather than pushing to the webview — the client may not
/// have loaded yet. The client polls `get_pending_update` instead, which is the
/// same shape glassbox uses.
struct PendingUpdate(Mutex<Option<String>>);

/// The version of a pending update, or `None`. Read by the client to decide
/// whether to show the update banner.
#[tauri::command]
fn get_pending_update(app: AppHandle) -> Option<String> {
    app.state::<PendingUpdate>().0.lock().unwrap().clone()
}

/// Ask the update endpoint whether a newer version exists (NEWS-89).
///
/// Behind `#[cfg(not(debug_assertions))]` so a dev build never tries to update
/// itself — `tauri dev` runs an unsigned binary whose version is whatever is in
/// `tauri.conf.json`, so a check there is meaningless at best.
#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_updater::UpdaterExt;
        let updater = app.updater().map_err(|e| format!("{e}"))?;
        let update = updater.check().await.map_err(|e| format!("{e}"))?;
        if let Some(update) = update {
            *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update.version.clone());
            return Ok(Some(update.version));
        }
        return Ok(None);
    }
    #[allow(unreachable_code)]
    {
        let _ = &app;
        Ok(None)
    }
}

/// Download and install the pending update. The caller restarts the app.
///
/// Clears the stored version first: if the install fails the banner should not
/// keep offering an update the user has already tried, and a fresh check is cheap.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_updater::UpdaterExt;
        *app.state::<PendingUpdate>().0.lock().unwrap() = None;
        let updater = app.updater().map_err(|e| format!("{e}"))?;
        let update = updater.check().await.map_err(|e| format!("{e}"))?;
        if let Some(update) = update {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| format!("{e}"))?;
        }
    }
    let _ = &app;
    Ok(())
}

/// Substring of the readiness line printed by `src/cli.ts`. KEEP IN SYNC.
const READY_MARKER: &str = "running at ";

/// How many trailing stderr lines to keep for the startup-failure page (NEWS-338).
///
/// A window rather than everything: the server can be chatty, and the whole
/// point is to hand the webview something a person will read. Forty lines
/// comfortably holds a Node stack trace, which is the shape most failures take.
const STDERR_TAIL_LINES: usize = 40;

/// Hard cap on the detail string handed to the webview, in bytes.
const STDERR_TAIL_BYTES: usize = 4000;

/// Build the explanation shown when the server dies before it was ready (NEWS-338).
///
/// Split out from the thread that produces it so it can be tested — it is the
/// part with decisions in it, and none of them need a running Tauri app.
///
/// Keeps the **tail** of what was written. The last thing a dying process says
/// is generally why it died, and for the failure this was written for — a
/// database that refuses to open ([FR-4.13](../../docs/4-cli-server-storage.md))
/// — the whole message is the last thing on the stream.
fn startup_failure_detail(lines: &[String], exit_code: Option<i32>) -> String {
    let said: Vec<&String> = lines.iter().filter(|l| !l.trim().is_empty()).collect();
    if said.is_empty() {
        return match exit_code {
            Some(code) => format!("It exited with code {code} without reporting a reason."),
            None => "It exited without reporting a reason.".to_string(),
        };
    }

    let joined = said
        .iter()
        .map(|l| l.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if joined.len() <= STDERR_TAIL_BYTES {
        return joined;
    }
    // Trim to a char boundary so the string stays valid UTF-8 — a stack trace
    // can carry any path the user's filesystem allows.
    let mut start = joined.len() - STDERR_TAIL_BYTES;
    while start < joined.len() && !joined.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &joined[start..])
}

pub fn run() {
    tauri::Builder::default()
        // Native OS notifications (NEWS-66): the web Notification API's
        // permission request doesn't raise the real OS prompt inside the
        // WKWebView, so the client routes notifications through this plugin,
        // whose requestPermission() shows the system dialog.
        .plugin(tauri_plugin_notification::init())
        // Auto-update (NEWS-89), matching the glassbox setup. Registering the
        // plugin is what makes `bundle.createUpdaterArtifacts` meaningful: the
        // bundler emits signed update artifacts and a `latest.json` manifest that
        // tauri-action publishes alongside the release.
        //
        // Update-*capability* had to land before the in-app surface: an installed
        // build can only ever be updated by a manifest whose public key it already
        // carries, so shipping the plugin late would leave early installs
        // permanently un-updatable.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Needed by the client's post-install restart.
        .plugin(tauri_plugin_process::init())
        .manage(ServerPid(Mutex::new(None)))
        .manage(PendingUpdate(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_pending_update,
            check_for_update,
            install_update
        ])
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

            // Check for an update once at startup, on a spawned task so a slow or
            // unreachable endpoint never delays the window. Failures are silent by
            // design: an update check that can't reach GitHub is not something to
            // interrupt someone's news feed over. The result is parked in
            // `PendingUpdate` for the client to poll — pushing to the webview here
            // would race the client's own load.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                #[cfg(not(debug_assertions))]
                {
                    use tauri_plugin_updater::UpdaterExt;
                    let Ok(updater) = handle.updater() else {
                        return;
                    };
                    let Ok(Some(update)) = updater.check().await else {
                        return;
                    };
                    *handle.state::<PendingUpdate>().0.lock().unwrap() = Some(update.version);
                }
                let _ = &handle;
            });

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
            "newsmonger-node.exe"
        } else {
            "newsmonger-node"
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
    // Explicit, never inherited (NEWS-219). A GUI app's cwd is whatever launched
    // it, and everything the server spawns inherits it in turn — so on macOS a
    // subprocess reading that directory makes the OS ask whether *Newsmonger* may
    // read the user's Documents. Anchoring to a directory the app owns keeps the
    // question from ever being asked.
    if let Some(dir) = server_js.parent() {
        cmd.current_dir(dir);
    }
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
        .env("NEWSMONGER_WATCH_PARENT", "1")
        .stdout(Stdio::piped())
        // Piped, not inherited (NEWS-338). Inheriting sent the server's own
        // account of why it died straight past us to a terminal a bundled .app
        // does not have — so the shell had nothing to show and the window sat
        // on the spinner forever. Every line is still echoed below, so running
        // from a terminal looks the same as it always did.
        .stderr(Stdio::piped())
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

    // Drain stderr on its own thread, echoing every line and keeping the tail
    // for the failure page. Its own thread because a full stderr pipe blocks
    // the child just as a full stdout one does, and the reader below is busy
    // waiting for a readiness line that a failing server will never print.
    let stderr = child.stderr.take().expect("stderr not captured");
    let captured = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&captured);
    let stderr_thread = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            eprintln!("[server] {line}");
            let mut lines = sink.lock().unwrap();
            if lines.len() == STDERR_TAIL_LINES {
                lines.remove(0);
            }
            lines.push(line);
        }
    });

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
                // NOTE: navigating here makes the page a **remote origin**
                // (http://127.0.0.1:PORT), not the local tauri:// one. A Tauri
                // capability without a `remote` block grants its permissions to
                // local origins only, so this single call is what decides
                // whether *any* IPC works at runtime.
                //
                // It silently didn't, until NEWS-40: notifications, the updater
                // and relaunch were all refused before reaching the OS. The
                // notification symptom was the visible one — macOS never got
                // asked, so System Settings had no entry to find, and the app
                // reported "blocked". `capabilities/default.json` now lists the
                // loopback URLs; keep it in step with whatever this navigates to.
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
        if navigated {
            let _ = child.wait();
            return;
        }
        // Nothing to navigate to, so say why. Join the stderr reader first —
        // stdout can reach EOF before the last stderr line has been read, and
        // the reason for the failure is exactly the line that would be missed.
        let _ = stderr_thread.join();
        let exit_code = child.wait().ok().and_then(|status| status.code());
        let detail = startup_failure_detail(&captured.lock().unwrap(), exit_code);
        eprintln!("[shell] server exited before it was ready");
        show_exited(&window, &detail);
    });
}

/// Show a failure message on the loading page (see `loading/index.html`).
///
/// For failures *before* the server was spawned — a missing sidecar, a command
/// that would not start. There is no server output to report, because there was
/// no server.
fn show_error(window: &tauri::WebviewWindow, message: &str) {
    let escaped = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".to_string());
    let _ = window.eval(format!("window.showError && window.showError({escaped})"));
}

/// Show what the server said on its way out (NEWS-338).
///
/// For failures *after* the spawn succeeded: the process ran, wrote something,
/// and died before it was ready. `detail` is that something, verbatim — the
/// server is the only thing that knows why, and paraphrasing it here would
/// throw away the sentence the reader needs.
fn show_exited(window: &tauri::WebviewWindow, detail: &str) {
    let escaped = serde_json::to_string(detail).unwrap_or_else(|_| "\"\"".to_string());
    let _ = window.eval(format!("window.showExited && window.showExited({escaped})"));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn reports_the_exit_code_when_the_server_said_nothing() {
        let detail = startup_failure_detail(&[], Some(1));
        assert_eq!(detail, "It exited with code 1 without reporting a reason.");
    }

    #[test]
    fn copes_with_a_server_killed_by_a_signal() {
        // No exit code at all on unix when a signal did it, and "exited with
        // code null" is not a sentence to show anybody.
        let detail = startup_failure_detail(&[], None);
        assert_eq!(detail, "It exited without reporting a reason.");
    }

    #[test]
    fn treats_blank_output_as_no_output() {
        // A process that writes only newlines has told the reader nothing, and
        // rendering that as an empty detail box is the dead end this replaces.
        let detail = startup_failure_detail(&lines(&["", "   ", "\t"]), Some(2));
        assert_eq!(detail, "It exited with code 2 without reporting a reason.");
    }

    #[test]
    fn passes_the_server_message_through_verbatim() {
        // The sentence this whole ticket exists to deliver. It must arrive
        // unedited — the reassurance is the load-bearing half of it.
        let detail = startup_failure_detail(
            &lines(&[
                "newsmonger: cannot open the database at /home/x/.newsmonger/newsmonger.db — Error: duplicate column name: thread_id",
                "Your data has NOT been touched. This is a schema problem in newsmonger itself, not a damaged file; please report it rather than deleting anything.",
            ]),
            Some(1),
        );
        assert!(detail.contains("cannot open the database"));
        assert!(detail.contains("Your data has NOT been touched."));
        assert!(!detail.starts_with('…'));
    }

    #[test]
    fn drops_blank_lines_from_between_real_ones() {
        let detail = startup_failure_detail(&lines(&["first", "", "second"]), Some(1));
        assert_eq!(detail, "first\nsecond");
    }

    #[test]
    fn keeps_the_tail_when_the_output_is_too_long() {
        // The end is where a dying process says why, so a cap has to cut the
        // front. Cutting the back would drop the one line worth showing.
        let mut raw = vec!["x".repeat(STDERR_TAIL_BYTES)];
        raw.push("the actual error".to_string());
        let detail = startup_failure_detail(&raw, Some(1));
        assert!(detail.starts_with('…'));
        assert!(detail.ends_with("the actual error"));
        assert!(detail.len() <= STDERR_TAIL_BYTES + 4);
    }

    #[test]
    fn truncates_on_a_character_boundary() {
        // A stack trace carries whatever paths the filesystem allows, so the
        // cut can land mid-codepoint. Slicing there panics.
        let raw = vec!["é".repeat(STDERR_TAIL_BYTES)];
        let detail = startup_failure_detail(&raw, Some(1));
        assert!(detail.starts_with('…'));
        assert!(detail.ends_with('é'));
    }
}
