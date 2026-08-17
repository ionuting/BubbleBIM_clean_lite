/**
 * vite.lite.config.ts — Static demo build for GitHub Pages.
 *
 * Differences from vite.config.ts:
 *  - No cesium() plugin → Cesium assets (~20 MB) excluded
 *  - WorldViewer  aliased to a stub → removes Cesium JS from bundle
 *  - TerrainViewer aliased to a stub → removes Babylon.js from bundle
 *  - @/lib/api     aliased to api.lite → graph stored in localStorage
 *  - Output dir: dist-lite (kept separate from the Electron build)
 *  - base URL from VITE_BASE_URL env var (set in GitHub Actions workflow)
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: (process.env.VITE_BASE_URL as string) || '/',
  resolve: {
    alias: [
      // ── Lite-mode substitutions (must come BEFORE the general @ alias) ───
      // Replace Cesium-dependent viewer with an inert placeholder
      { find: /^@\/components\/views\/WorldViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/WorldViewer.stub.tsx') },
      // Replace Babylon-dependent viewer with an inert placeholder
      { find: /^@\/components\/views\/TerrainViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/TerrainViewer.stub.tsx') },
      // Replace web-ifc viewers with inert placeholders
      { find: /^@\/components\/views\/WebIfcViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/WebIfcViewer.stub.tsx') },
      { find: /^@\/components\/views\/IFCTilesViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/IFCTilesViewer.stub.tsx') },
      // Replace backend API client with localStorage implementation
      { find: /^@\/lib\/api$/,
        replacement: path.resolve(__dirname, './src/lib/api.lite.ts') },
      // Armare 2D (rebar) pulls in '@armare/nucleu', which isn't published/available
      // in this standalone distribution — stub it out (same aliases apps/clean-lite/
      // vite.config.ts already uses; this config just never had them added).
      { find: /^@\/store\/armareStore$/,
        replacement: path.resolve(__dirname, './src/stubs/armareStore.stub.ts') },
      { find: /^@\/components\/views\/armare\/RebarLayer$/,
        replacement: path.resolve(__dirname, './src/stubs/RebarLayer.stub.tsx') },
      { find: /^@\/components\/views\/armare\/RebarPanel$/,
        replacement: path.resolve(__dirname, './src/stubs/RebarPanel.stub.tsx') },
      { find: '@armare/nucleu',
        replacement: path.resolve(__dirname, './src/stubs/armareNucleu.stub.ts') },

      // Standard path aliases (after specific overrides)
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // '@ifc-lite/create' resolves to the real npm package — no alias needed.
      { find: '@ifc-lite/drawing-2d', replacement: path.resolve(__dirname, './packages/drawing-2d/src') },
      { find: '@ifc-lite/geometry',  replacement: path.resolve(__dirname, './packages/geometry/src') },
      // No aliases for '@ifc-lite/data'/'@ifc-lite/wasm' — see vite.config.ts's note.
    ],
  },
  server: {
    port: 3101,
    fs: { allow: ['..'] },
    watch: { ignored: ['**/backend/**', '**/backups/**'] },
  },
  optimizeDeps: {
    exclude: ['@thatopen/fragments', 'manifold-3d'],
  },
  build: {
    target: 'es2020',
    outDir: 'dist-lite',
    rollupOptions: {
      input: { main: path.resolve(__dirname, 'index.lite.html') },
    },
  },
  // @ifc-lite/parser → @ifc-lite/ifcx → @ifc-lite/pointcloud ships a
  // `new Worker(new URL(...))` streaming worker; Vite defaults worker output
  // to 'iife', which Rollup rejects once the main build is code-split — see
  // the same note in the root vite.config.ts.
  worker: {
    format: 'es',
  },
});
