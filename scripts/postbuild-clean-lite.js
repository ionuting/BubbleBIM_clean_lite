#!/usr/bin/env node
/**
 * Post-build for clean-lite static deploy.
 * Ensures dist-clean-lite/index.html exists, Cesium assets are present, writes .htaccess.
 */

import { writeFileSync, readFileSync, existsSync, copyFileSync, cpSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'dist-clean-lite');
const index = `${OUT}/index.html`;

if (!existsSync(index)) {
  console.error('✗ index.html not found in dist-clean-lite/');
  process.exit(1);
}
console.log('✓ dist-clean-lite/index.html ready');

/** vite-plugin-cesium sometimes writes to apps/clean-lite/Users/<abs-path>/cesium when outDir was absolute. */
function findMisplacedCesium() {
  const wrongBase = resolve(ROOT, 'apps/clean-lite/Users');
  if (!existsSync(wrongBase)) return null;
  const candidate = resolve(wrongBase, ROOT.slice(1), 'dist-clean-lite/cesium');
  if (existsSync(`${candidate}/Cesium.js`)) return candidate;
  return null;
}

function ensureCesiumAssets() {
  const dest = `${OUT}/cesium`;
  if (existsSync(`${dest}/Cesium.js`)) {
    console.log('✓ cesium/ already in dist-clean-lite');
    return;
  }

  const misplaced = findMisplacedCesium();
  const nodeSrc = resolve(ROOT, 'node_modules/cesium/Build/Cesium');
  const src = misplaced && existsSync(`${misplaced}/Cesium.js`) ? misplaced : nodeSrc;

  if (!existsSync(`${src}/Cesium.js`)) {
    console.error('✗ Cesium.js not found — run pnpm install');
    process.exit(1);
  }

  cpSync(src, dest, { recursive: true });
  console.log(`✓ Copied cesium assets → dist-clean-lite/cesium (from ${misplaced ? 'plugin misplaced path' : 'node_modules'})`);

  // Clean up erroneous nested copy under apps/clean-lite/Users if present
  const wrongUsers = resolve(ROOT, 'apps/clean-lite/Users');
  if (existsSync(wrongUsers)) {
    try {
      rmSync(wrongUsers, { recursive: true, force: true });
      console.log('✓ Removed misplaced apps/clean-lite/Users/ (cesium plugin artifact)');
    } catch { /* ignore */ }
  }
}

ensureCesiumAssets();

// Bust Cloudflare/browser cache for Cesium after deploy (CF may cache old 404s)
const buildTag = Date.now().toString(36);
let html = readFileSync(index, 'utf8');
html = html.replace(/href="cesium\/Widgets\/widgets\.css"/, `href="cesium/Widgets/widgets.css?v=${buildTag}"`);
html = html.replace(/src="cesium\/Cesium\.js"/, `src="cesium/Cesium.js?v=${buildTag}"`);
writeFileSync(index, html);
console.log(`✓ Cache-busted cesium refs in index.html (?v=${buildTag})`);

const htaccess = `# BubbleBIM Clean Lite — Apache

AddType application/wasm .wasm
AddType text/javascript  .mjs
AddType text/javascript  .js

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json
</IfModule>

<IfModule mod_headers.c>
  <FilesMatch "\\.(wasm)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
</IfModule>

DirectoryIndex index.html
FallbackResource /index.html
`;

writeFileSync(`${OUT}/.htaccess`, htaccess);
console.log('✓ Wrote .htaccess');

// Ensure example project is present if public copy failed
const exampleSrc = resolve(ROOT, 'public/example-project.bbim');
const exampleDest = `${OUT}/example-project.bbim`;
if (existsSync(exampleSrc) && !existsSync(exampleDest)) {
  copyFileSync(exampleSrc, exampleDest);
  console.log('✓ Copied example-project.bbim');
}
