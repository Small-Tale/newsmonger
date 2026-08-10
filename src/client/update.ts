/**
 * Turn a rejected native updater command into a useful Settings answer.
 *
 * Tauri rejects `invoke()` with the Rust command's string error. Keep that
 * detail: collapsing DNS, TLS, HTTP, target and manifest failures into the same
 * sentence made a live updater failure impossible to diagnose (NEWS-446).
 */
export function updateCheckFailure(error: unknown): string {
  const detail = typeof error === 'string'
    ? error.trim()
    : error instanceof Error
      ? error.message.trim()
      : '';
  return detail === ''
    ? 'Could not check for updates.'
    : `Could not check for updates: ${detail}`;
}
