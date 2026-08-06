import type { SafeHtml } from 'kerfjs';

/**
 * The served shell.
 *
 * `theme` is stamped on `<html>` **server-side** (FR-3.76, NEWS-334) rather than
 * applied by the client after it boots. The page is otherwise entirely
 * client-rendered, so a theme applied in script would paint the wrong palette
 * first and correct it — a flash of the opposite scheme on every load, which is
 * exactly what someone who pinned dark asked not to see.
 *
 * `auto` writes **no attribute at all**: the stylesheet's `prefers-color-scheme`
 * query is the whole implementation of following the system, and an explicit
 * `data-theme="auto"` would be a third state the CSS has to know about for no
 * gain.
 */
export function Layout({
  title,
  theme = 'auto',
  children,
}: {
  title: string;
  theme?: 'auto' | 'light' | 'dark';
  children?: unknown;
}): SafeHtml {
  return (
    <html lang="en" data-theme={theme === 'auto' ? undefined : theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {/* SVG favicon only (NEWS-115). Every browser this app runs in — and the
            Tauri webview — supports it, and one vector file beats a ladder of
            PNG sizes. */}
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#17604f" />
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body>
        {children}
        <script src="/static/app.js"></script>
      </body>
    </html>
  );
}
