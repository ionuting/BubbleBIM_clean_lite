/**
 * vite.minimal.config.ts — Minimal test build: BubbleGraphCanvas + OpenGeoViewer + Save/Load
 *
 * Excluded vs the full build:
 *  - Cesium / WorldViewer    → stub (no ~20 MB Cesium assets)
 *  - Babylon.js / TerrainViewer → stub
 *  - WebIfcViewer / IFCTilesViewer → stubs
 *  - BabylonViewer           → stub (we only want OpenGeoViewer for 3D)
 *  - @/lib/api               → api.lite (localStorage, no FastAPI required)
 *
 * OpenGeoViewer + its WASM kernel (openGeoInit, ogBimMapper) are NOT stubbed.
 *
 * Entry:    index.minimal.html  →  src/main.minimal.tsx  →  AppMinimal
 * Output:   dist-minimal/
 * Dev port: 3102
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],

  // Relative base → works under file:// AND any subdirectory on a web server
  base: './',

  resolve: {
    alias: [
      // ── Minimal-build substitutions (must come BEFORE the general @ alias) ──

      // Cesium globe viewer — not needed
      { find: /^@\/components\/views\/WorldViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/WorldViewer.stub.tsx') },

      // Babylon.js terrain sculptor — not needed
      { find: /^@\/components\/views\/TerrainViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/TerrainViewer.stub.tsx') },

      // Babylon.js 3D BIM viewer — we use OpenGeoViewer instead
      { find: /^@\/components\/views\/BabylonViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/BabylonViewer.stub.tsx') },

      // web-ifc viewers — not needed
      { find: /^@\/components\/views\/WebIfcViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/WebIfcViewer.stub.tsx') },
      { find: /^@\/components\/views\/IFCTilesViewer$/,
        replacement: path.resolve(__dirname, './src/stubs/IFCTilesViewer.stub.tsx') },

      // Replace backend API client with localStorage implementation (no FastAPI required)
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

      // ── Standard aliases ──────────────────────────────────────────────────
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // '@ifc-lite/create' resolves to the real npm package — no alias needed.
      { find: '@ifc-lite/drawing-2d', replacement: path.resolve(__dirname, './packages/drawing-2d/src') },
      { find: '@ifc-lite/geometry',   replacement: path.resolve(__dirname, './packages/geometry/src') },
      // No aliases for '@ifc-lite/data'/'@ifc-lite/wasm' — see vite.config.ts's note.
    ],
  },

  server: {
    port: 3102,
    open: '/index.minimal.html',
    fs: { allow: ['..'] },
    watch: { ignored: ['**/backend/**', '**/backups/**'] },
  },

  optimizeDeps: {
    exclude: ['@thatopen/fragments', 'manifold-3d'],
  },

  build: {
    target: 'es2020',
    outDir: 'dist-minimal',
    rollupOptions: {
      input: { main: path.resolve(__dirname, 'index.minimal.html') },
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
