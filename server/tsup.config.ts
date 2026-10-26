import { defineConfig } from 'tsup';

// Bundles the server and the shared workspace into one file; runtime npm
// dependencies (better-sqlite3 has a native addon) stay external.
export default defineConfig({
  entry: ['src/index.ts', 'src/seed.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  noExternal: ['@crafty/shared'],
});
