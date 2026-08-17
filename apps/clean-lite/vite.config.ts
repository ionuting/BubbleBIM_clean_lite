/**
 * BubbleBIM Clean Lite — curated feature set in a dedicated app folder.
 *
 * Included:
 *  - Graph editor (storeys, nodes, edges)
 *  - OpenGeometry 3D (single 3D engine)
 *  - Floor plans, sections, elevations (SVG)
 *  - World (Cesium), Terrain (Babylon), Sheets
 *  - English locale (element library + material catalogue)
 *
 * Excluded (stubs / hidden UI):
 *  - Ara3D, WebIfc / That Open, IFC Tiles, IFC Plan
 *  - OG 2D duplicate views, Composer, engine switcher
 *  - Armare 2D (rebar) — RebarPanel / RebarLayer / @armare/nucleu
 *  - Quantities / takeoff / schedules / cost panel
 *
 * Data: FastAPI + JWT auth + per-user projects (api.cloud).
 * Dev:  pnpm dev:clean   → http://localhost:3103
 * Build: pnpm build:clean → dist-clean-lite/
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

export default defineConfig({
  plugins: [react(), cesium()],
  root: __dirname,
  base: (process.env.VITE_BASE_URL as string) || './',
  publicDir: path.resolve(root, 'public'),
  resolve: {
    alias: [
      // ── Stub redundant 3D / IFC viewers ─────────────────────────────────
      { find: /^@\/components\/views\/Ara3DViewer$/,
        replacement: path.resolve(root, 'src/stubs/Ara3DViewer.stub.tsx') },
      { find: /^@\/components\/views\/WebIfcViewer$/,
        replacement: path.resolve(root, 'src/stubs/WebIfcViewer.stub.tsx') },
      { find: /^@\/components\/views\/IFCTilesViewer$/,
        replacement: path.resolve(root, 'src/stubs/IFCTilesViewer.stub.tsx') },
      { find: /^@\/components\/views\/BabylonViewer$/,
        replacement: path.resolve(root, 'src/stubs/BabylonViewer.stub.tsx') },
      { find: /^@\/components\/views\/OGFloorPlanViewer$/,
        replacement: path.resolve(root, 'src/stubs/OGFloorPlanViewer.stub.tsx') },
      { find: /^@\/components\/views\/IFCPlanView$/,
        replacement: path.resolve(root, 'src/stubs/IFCPlanView.stub.tsx') },
      { find: /^@\/components\/views\/ComposerCanvas$/,
        replacement: path.resolve(root, 'src/stubs/ComposerCanvas.stub.tsx') },
      { find: /^@\/components\/views\/FloorPlanOrthoViewer$/,
        replacement: path.resolve(root, 'src/stubs/FloorPlanOrthoViewer.stub.tsx') },
      { find: /^@\/components\/views\/ElevationOrthoViewer$/,
        replacement: path.resolve(root, 'src/stubs/ElevationOrthoViewer.stub.tsx') },
      { find: /^@\/components\/views\/SectionOrthoViewer$/,
        replacement: path.resolve(root, 'src/stubs/SectionOrthoViewer.stub.tsx') },

      // Cloud API (JWT + per-user projects) — replaces localStorage lite API
      { find: /^@\/lib\/api$/,
        replacement: path.resolve(root, 'src/lib/api.cloud.ts') },
      { find: /^@\/lib\/useMaterialConfig$/,
        replacement: path.resolve(root, 'src/lib/useMaterialConfig.lite.ts') },

      // Exclude Armare 2D (rebar) from Clean Lite
      { find: /^@\/store\/armareStore$/,
        replacement: path.resolve(root, 'src/stubs/armareStore.stub.ts') },
      { find: /^@\/components\/views\/armare\/RebarLayer$/,
        replacement: path.resolve(root, 'src/stubs/RebarLayer.stub.tsx') },
      { find: /^@\/components\/views\/armare\/RebarPanel$/,
        replacement: path.resolve(root, 'src/stubs/RebarPanel.stub.tsx') },
      { find: '@armare/nucleu',
        replacement: path.resolve(root, 'src/stubs/armareNucleu.stub.ts') },

      // Exclude quantities / documents (Clean keeps Sheets only)
      { find: /^@\/components\/quantities\/QuantitiesPanel$/,
        replacement: path.resolve(root, 'src/stubs/QuantitiesPanel.stub.tsx') },
      { find: /^@\/components\/quantities\/ReportTabView$/,
        replacement: path.resolve(root, 'src/stubs/ReportTabView.stub.tsx') },
      { find: /^@\/components\/quantities\/CostFloatingPanel$/,
        replacement: path.resolve(root, 'src/stubs/CostFloatingPanel.stub.tsx') },
      { find: /^@\/lib\/quantityTakeoff$/,
        replacement: path.resolve(root, 'src/stubs/quantityTakeoff.stub.ts') },

      // Shared source
      { find: '@', replacement: path.resolve(root, 'src') },
      // '@ifc-lite/create' resolves to the real npm package — no alias needed.
      { find: '@ifc-lite/drawing-2d', replacement: path.resolve(root, 'packages/drawing-2d/src') },
      { find: '@ifc-lite/geometry',   replacement: path.resolve(root, 'packages/geometry/src') },
      // No aliases for '@ifc-lite/data'/'@ifc-lite/wasm' — see vite.config.ts's note.
    ],
  },
  server: {
    port: 3103,
    fs: { allow: [root, path.resolve(root, '..')] },
    watch: { ignored: ['**/backend/**', '**/backups/**', '**/packages/armare-nucleu/**'] },
  },
  optimizeDeps: {
    exclude: ['@thatopen/fragments', 'manifold-3d'],
  },
  build: {
    target: 'es2020',
    // Relative outDir — absolute path breaks vite-plugin-cesium (assets land under apps/clean-lite/Users/…)
    outDir: '../../dist-clean-lite',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
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
