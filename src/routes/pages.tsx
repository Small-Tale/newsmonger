import type { Hono } from 'hono';

import { Layout } from '../components/layout.js';
import type { AppEnv } from '../types.js';

/**
 * Web app manifest (NEWS-115).
 *
 * Served from a route rather than shipped as a static file, deliberately: a file
 * would need copying by `build:client` *and* by the sidecar staging, and the
 * favicon just taught us that a client asset with two build paths is an asset
 * with two chances to be forgotten. A route has none.
 *
 * Two icons, and the distinction between them is the whole point of having a
 * manifest here:
 *
 * - `favicon.svg` is `purpose: "any"` — drawn as-is, so it is the mark on a
 *   transparent ground.
 * - `logo-full-bleed.svg` is `purpose: "maskable"` — the platform crops it to
 *   whatever shape it likes (circle, squircle, rounded rect), so it must bleed
 *   to the edges with the mark inside the safe zone. The rounded `logo.svg`
 *   would get its corners cut off twice.
 *
 * `logo.svg` is absent on purpose: it is the *desktop* app icon, and macOS does
 * not mask `.icns` — it expects the shape to be drawn in. Full-bleed there would
 * be a hard square among rounded neighbours in the Dock.
 */
function manifest(): unknown {
  return {
    name: 'Newsmonger',
    short_name: 'Newsmonger',
    description: 'Topic-based news tracker.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // The pine the wordmark's dot uses, and the paper the app sits on.
    theme_color: '#17604f',
    background_color: '#f2f4f3',
    icons: [
      { src: '/static/favicon.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any' },
      { src: '/static/logo-full-bleed.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'maskable' },
    ],
  };
}

export function registerPages(app: Hono<AppEnv>): void {
  // `application/manifest+json` is the registered type; browsers are lenient
  // about it, but Lighthouse and some installers are not.
  app.get('/manifest.webmanifest', (c) =>
    c.body(JSON.stringify(manifest(), null, 2), 200, { 'Content-Type': 'application/manifest+json' }),
  );

  app.get('/', (c) => {
    const html = (
      <Layout title="Newsmonger">
        <div id="app"></div>
      </Layout>
    );
    return c.html(`<!doctype html>${html.toString()}`);
  });
}
