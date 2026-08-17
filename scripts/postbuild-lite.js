#!/usr/bin/env node
/**
 * Post-build script for the lite static build.
 * Run automatically by `pnpm build:lite`.
 *
 * 1. Renames index.lite.html → index.html
 * 2. Writes .htaccess for Apache shared hosting:
 *    - Correct MIME types for .wasm and .mjs
 *    - Gzip compression for JS/CSS/WASM
 *    - Cache headers for hashed assets
 *    - Directory listing disabled
 */

import { renameSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../dist-lite');

// 1. Rename HTML entry
const src  = `${OUT}/index.lite.html`;
const dest = `${OUT}/index.html`;
if (existsSync(src)) {
  renameSync(src, dest);
  console.log('✓ Renamed index.lite.html → index.html');
} else if (existsSync(dest)) {
  console.log('✓ index.html already exists');
} else {
  console.error('✗ index.lite.html not found in dist-lite/');
  process.exit(1);
}

// 2. Write .htaccess
const htaccess = `# BubbleBIM Lite — Apache config

# ── MIME types ──────────────────────────────────────────────────────────────
AddType application/wasm .wasm
AddType text/javascript  .mjs
AddType text/javascript  .js

# ── Disable directory listing ───────────────────────────────────────────────
Options -Indexes

# ── Gzip compression ────────────────────────────────────────────────────────
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript
  AddOutputFilterByType DEFLATE application/wasm
</IfModule>

# ── Cache hashed assets forever, HTML never ─────────────────────────────────
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/html                  "access plus 0 seconds"
  ExpiresByType application/javascript     "access plus 1 year"
  ExpiresByType text/css                   "access plus 1 year"
  ExpiresByType application/wasm           "access plus 1 year"
  ExpiresByType image/png                  "access plus 1 year"
  ExpiresByType image/svg+xml              "access plus 1 year"
</IfModule>

# ── Security headers ─────────────────────────────────────────────────────────
<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "SAMEORIGIN"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  # Required for SharedArrayBuffer (used by web-ifc WASM threading)
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set Cross-Origin-Embedder-Policy "require-corp"
</IfModule>
`;

writeFileSync(`${OUT}/.htaccess`, htaccess);
console.log('✓ Written .htaccess');
console.log(`\nReady to upload: ${OUT}/`);
