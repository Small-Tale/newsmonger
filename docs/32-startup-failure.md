# 32 — When the App Can't Start

**Status: shipped.** Written for NEWS-338, the follow-up [FR-4.13](4-cli-server-storage.md) could not deliver itself.

Every other document here describes the app working. This one is about the window that opens onto nothing — and it exists because that window told a user their news was gone when it wasn't.

## What went wrong

A migration bug ([NEWS-335](4-cli-server-storage.md)) made a healthy database throw on open. [FR-4.13](4-cli-server-storage.md) fixed the dangerous half: the server now refuses to start rather than setting the data aside, and it says so in a message naming the file, the error, and — the sentence that matters most — that the data has not been touched.

In a terminal that message is exactly right. In the desktop app it went nowhere. The shell spawned the server with `stderr` **inherited**, so the message went past the shell to a terminal that a double-clicked `.app` does not have. The shell was watching *stdout* for its `running at ` readiness line, never saw one, and left the window on its spinner. The loading page's only failure copy was *"The news server exited before it was ready. Check the terminal output."*

So the person best placed to be reassured got the least: a frozen window, no reason, and an instruction they could not follow. This is the [NEWS-309](3-ui.md) rule — a dead end with no adjacent explanation — in its most expensive form, because the natural next move is to start deleting things.

## The requirements

- **FR-32.1** *(Shipped, NEWS-338)* **The shell captures the server's stderr rather than inheriting it.** Piped, drained on its own thread, and echoed line by line with the same `[server]` prefix stdout already uses — so running from a terminal looks exactly as it did, and the shell has the text besides.

  Its own thread because a full stderr pipe blocks the child just as a full stdout one does, and the stdout reader is busy waiting for a readiness line that a failing server will never print. Inheriting was the whole root cause, and it is pinned by a test that fails on `Stdio::inherit()`.

- **FR-32.2** *(Shipped, NEWS-338)* **A server that exits before readiness explains itself on the loading page**, with what it wrote to stderr shown **verbatim**.

  Verbatim is deliberate. The server is the only thing that knows why it stopped; any paraphrase in the shell would discard the sentence the reader needs, and the shell would have to be taught about every future failure to keep up. The shell's job is delivery, not editorial.

  The stdout reader joins the stderr thread before reading the buffer — stdout can reach EOF while the last stderr line is still in flight, and that line is generally the one worth showing.

- **FR-32.3** *(Shipped, NEWS-338)* **The tail is kept, not the head** — the last 40 lines, capped at 4000 bytes, cut on a character boundary. A dying process says why at the end, and a Node stack trace fits comfortably inside that window. Trimming to a boundary is not fussiness: a stack trace carries whatever paths the filesystem allows, and slicing mid-codepoint panics.

- **FR-32.4** *(Shipped, NEWS-338)* **A server that says nothing still gets a sentence.** Empty or whitespace-only output falls back to the exit code (`It exited with code 1 without reporting a reason.`), and to a code-less form when a signal killed it — `exited with code null` is not a sentence to show anybody.

- **FR-32.5** *(Shipped, NEWS-338)* **The page says a failed start does not delete topics or stories, and asks the reader not to remove anything.**

  This is the requirement the incident was actually about. Someone looking at an app that won't open reaches for the uninstall, or the data folder, and the damage after that is real even when the original fault was not. The claim is narrow enough to be true in every case that reaches this page: if this page is showing, the server did not start.

- **FR-32.6** *(Shipped, NEWS-338)* **The failure text is selectable and wrapped**, in a scrolling monospace block. The first useful thing anyone does with an error is copy it into a bug report.

- **FR-32.7** *(Shipped, NEWS-338)* **Both failure paths get the same treatment.** `showError` (the server never started — a missing sidecar, a command that would not run) and `showExited` (it started, then stopped) differ only in their lead sentence. The distinction matters to us and not at all to the reader, whose need is identical either way.

- **FR-32.8** *(Shipped, NEWS-338)* **The generic case is covered, not just the database one.** Nothing in the shell knows what a schema error is; it reports whatever the server said on its way out. Any sidecar that dies before readiness — a missing bundle, a port collision under `--strict-port`, a crash in a future feature — surfaces the same way, with no further work.

## Deliberately not here

- **No native dialog.** The window is already open with the loading page in it, so the page is the surface that is guaranteed to exist. A modal would also have to be dismissed before the user could read what is underneath it.
- **No retry button.** Every failure that reaches this page needs something changed outside the app — a file restored, a bug fixed, a release upgraded. A button that re-ran the same command and failed the same way would be worse than none.
- **No log file.** A tempting fix and the wrong one: it moves the message to somewhere else the user has to be told to look. The point is that they should not have to look anywhere.

## Not covered by tests

The Rust half's logic is unit-tested in `src-tauri/src/lib.rs` (empty output, signal deaths, the tail cut, the character boundary), and `tests/unit/startup-failure.test.ts` runs the page's script against a stub DOM and checks the contract between the two — every `window.show*` the Rust calls is defined by the page, and takes its argument.

What no test reaches is the shell actually spawning a failing server and painting the result. That needs a GUI and a Rust toolchain; see [manual-test-plan.md](manual-test-plan.md).

## Related

- [4 — CLI, Server, and Storage](4-cli-server-storage.md) — FR-4.13, the hard stop whose message this delivers.
- [5 — Desktop App](5-desktop-app.md) — the shell, the sidecar, and the readiness line.
