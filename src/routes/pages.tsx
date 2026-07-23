import type { Hono } from 'hono';

import { Layout } from '../components/layout.js';
import type { AppEnv } from '../types.js';

export function registerPages(app: Hono<AppEnv>): void {
  app.get('/', (c) => {
    const html = (
      <Layout title="News">
        <div id="app"></div>
      </Layout>
    );
    return c.html(`<!doctype html>${html.toString()}`);
  });
}
