import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import path from 'path';

export default defineConfig({
  plugins: [react(), cesium()],
  // './' for Electron/WebView2; '/' for web deployment (Render/Vercel).
  // Set VITE_BASE_URL=/ in the Render environment variables.
  base: (process.env.VITE_BASE_URL as string) || './',
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // NOTE: no alias for '@ifc-lite/create' — it resolves to the real npm package
      // (added as a direct dependency) now that IFC export is implemented for real.
      // The other @ifc-lite/* aliases below still point at a monorepo `packages/`
      // layout that doesn't exist in this standalone distribution (dead aliases,
      // matching the still-stubbed BubbleGraphPlanSVG.tsx / @ifc-lite/drawing-2d).
      { find: '@ifc-lite/drawing-2d', replacement: path.resolve(__dirname, './packages/drawing-2d/src') },
      { find: '@ifc-lite/geometry', replacement: path.resolve(__dirname, './packages/geometry/src') },
      // NOTE: no aliases for '@ifc-lite/data' or '@ifc-lite/wasm' — @ifc-lite/create's
      // own dependency chain (parser → data/wasm) needs the REAL npm packages, which
      // are already installed transitively; aliasing them to the missing local
      // packages/ layout broke the production build (ENOENT in rollup).
      { find: '@armare/nucleu', replacement: path.resolve(__dirname, './packages/armare-nucleu/src') },
    ],
  },
  server: {
    port: 3100,
    fs: {
      // Allow serving node_modules for @thatopen/fragments worker.mjs in dev
      allow: ['..'],
    },
    watch: {
      // Ignore backend data files — writing bubble_graph.json would otherwise
      // trigger a full page reload via Vite HMR.
      ignored: ['**/backend/**', '**/backups/**'],
    },
  },
  optimizeDeps: {
    // Prevent Vite from bundling the fragments web worker
    // manifold-3d resolves its WASM with `new URL('manifold.wasm', import.meta.url)`;
    // pre-bundling moves the module into .vite/deps without the .wasm beside it,
    // so the fetch falls through to index.html and fails to instantiate.
    exclude: ['@thatopen/fragments', 'manifold-3d'],
  },
  build: {
    target: 'es2020',
  },
  // @ifc-lite/parser → @ifc-lite/ifcx → @ifc-lite/pointcloud ships a
  // `new Worker(new URL(...))` streaming worker; Vite defaults worker output
  // to 'iife', which Rollup rejects once the main build is code-split
  // ("UMD and IIFE output formats are not supported for code-splitting
  // builds"). 'es' matches the rest of this build's module format.
  worker: {
    format: 'es',
  },
  test: {
    globals: false,
    environment: 'node',
  },
});
