import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: false,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  // No `external`/`noExternal`: tsup's default externalizes exactly the
  // `dependencies` in package.json and bundles everything else. That's the
  // split we want, and scripts/build-sidecar.sh installs those same
  // `dependencies` (with their transitive tree) beside the bundle — so
  // package.json stays the single source of truth for the runtime deps.
  esbuildOptions(options) {
    options.jsx = 'automatic';
    options.jsxImportSource = 'kerfjs';
  },
});
