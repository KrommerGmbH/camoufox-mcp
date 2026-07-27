import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/smoke.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  // better-sqlite3 은 네이티브 모듈이라 번들에 넣지 않고 그대로 require 합니다.
  external: ['better-sqlite3', 'camoufox-js', 'playwright-core'],
  banner: { js: '#!/usr/bin/env node' },
});
