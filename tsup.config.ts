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
  // Bundle everything except heavyweight runtime deps that resolve fine from node_modules.
  noExternal: [/^(?!@anthropic-ai|hono|@hono|kerfjs|zod)/],
  esbuildOptions(options) {
    options.jsx = 'automatic';
    options.jsxImportSource = 'kerfjs';
  },
});
