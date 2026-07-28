import type { SafeHtml } from 'kerfjs';

export function Layout({ title, children }: { title: string; children?: unknown }): SafeHtml {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {/* SVG favicon only (NEWS-115). Every browser this app runs in — and the
            Tauri webview — supports it, and one vector file beats a ladder of
            PNG sizes. */}
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body>
        {children}
        <script src="/static/app.js"></script>
      </body>
    </html>
  );
}
