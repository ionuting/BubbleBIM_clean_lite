#!/usr/bin/env node
/**
 * Post-build script for the minimal static build.
 * Run automatically by `pnpm build:minimal`.
 *
 * 1. Renames index.minimal.html → index.html
 * 2. Writes .htaccess for Apache shared hosting (Hostico etc.)
 */

import { renameSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../dist-minimal');

// 1. Rename HTML entry
const src  = `${OUT}/index.minimal.html`;
const dest = `${OUT}/index.html`;

if (existsSync(src)) {
  renameSync(src, dest);
  console.log('✓ Renamed index.minimal.html → index.html');
} else if (existsSync(dest)) {
  console.log('✓ index.html already exists');
} else {
  console.error('✗ index.minimal.html not found in dist-minimal/');
  process.exit(1);
}

// 2. Write .htaccess for Apache
const htaccess = `# BubbleBIM Minimal — Apache config

# ── MIME types ──────────────────────────────────────────────────────────────
AddType application/wasm .wasm
AddType text/javascript  .mjs
AddType text/javascript  .js

# ── Compression ─────────────────────────────────────────────────────────────
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript text/javascript
</IfModule>

# ── Cache headers for hashed assets ─────────────────────────────────────────
<IfModule mod_expires.c>
  ExpiresActive On
  <FilesMatch "\\.(js|css|wasm|mjs)$">
    ExpiresDefault "access plus 1 year"
  </FilesMatch>
</IfModule>

# ── Directory listing off ────────────────────────────────────────────────────
Options -Indexes

# ── SPA fallback (optional) ──────────────────────────────────────────────────
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /bubblebim_demo/
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^ index.html [L]
</IfModule>
`;

writeFileSync(`${OUT}/.htaccess`, htaccess);
console.log('✓ .htaccess written (Apache MIME + cache + rewrite for /bubblebim_demo/)');
console.log('✓ dist-minimal/index.html ready');

