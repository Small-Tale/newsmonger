fn main() {
    // The webview navigates to a loopback HTTP origin, so application commands
    // need explicit ACL permissions just like plugin commands (NEWS-447).
    const COMMANDS: &[&str] = &["get_pending_update", "check_for_update", "install_update"];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application manifest")
}
