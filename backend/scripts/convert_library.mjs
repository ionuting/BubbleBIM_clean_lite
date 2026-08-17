#!/usr/bin/env node
/**
 * convert_library.mjs — Convert all IFC library elements to .frag format.
 *
 * Scans backend/library/ recursively for .ifc files and converts each to
 * a self-contained .frag binary (same directory, .frag extension) using
 * IfcImporter from @thatopen/fragments.
 *
 * Run once from project root:
 *   node backend/scripts/convert_library.mjs
 *
 * The .frag files are committed to the repo alongside the .ifc originals.
 * Subsequent app starts load .frag directly (10–100x faster than .ifc parsing).
 */

import { IfcImporter } from '@thatopen/fragments';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Paths ──────────────────────────────────────────────────────────────────
// backend/scripts/ → up two levels → project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LIBRARY_DIR  = path.join(PROJECT_ROOT, 'backend', 'library');

// web-ifc WASM files live in project node_modules.
// IfcImporter requires a directory path WITH trailing separator.
const WASM_PATH = path.join(PROJECT_ROOT, 'node_modules', 'web-ifc') + path.sep;

// ── Find all .ifc files recursively ───────────────────────────────────────
function findIfc(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findIfc(full, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ifc')) {
      results.push(full);
    }
  }
  return results;
}

const ifcFiles = findIfc(LIBRARY_DIR);

console.log('╔══════════════════════════════════════════════════════════');
console.log('║  BubbleGraph — IFC Library Converter  (.ifc → .frag)');
console.log('╚══════════════════════════════════════════════════════════\n');
console.log(`Library: ${LIBRARY_DIR}`);
console.log(`WASM:    ${WASM_PATH}`);
console.log(`Found:   ${ifcFiles.length} IFC file(s)\n`);

ifcFiles.forEach(f => console.log(`  ${path.relative(PROJECT_ROOT, f)}`));
console.log('');

if (ifcFiles.length === 0) {
  console.log('No IFC files found. Nothing to convert.');
  process.exit(0);
}

// ── Convert each IFC → .frag ───────────────────────────────────────────────
let ok = 0, skip = 0;

for (const ifcPath of ifcFiles) {
  const rel      = path.relative(PROJECT_ROOT, ifcPath);
  const fragPath = ifcPath.replace(/\.ifc$/i, '.frag');
  const baseName = path.basename(ifcPath, '.ifc');

  process.stdout.write(`  ${rel}  →  ${baseName}.frag  ... `);

  try {
    const bytes = new Uint8Array(fs.readFileSync(ifcPath));

    const importer = new IfcImporter();
    // absolute: true means path is filesystem-absolute (required for Node.js)
    importer.wasm  = { path: WASM_PATH, absolute: true };

    const fragBytes = new Uint8Array(
      await importer.process({ bytes, id: baseName })
    );

    fs.writeFileSync(fragPath, fragBytes);

    const sizeKB = (fragBytes.byteLength / 1024).toFixed(1);
    console.log(`OK  (${sizeKB} KB)`);
    ok++;
  } catch (err) {
    console.log(`SKIP  — ${err.message}`);
    skip++;
  }
}

console.log(`\n──────────────────────────────────────────────────────────`);
console.log(`Converted: ${ok}   Skipped: ${skip}   Total: ${ifcFiles.length}`);

if (ok > 0) {
  console.log('\nGenerated .frag files:');
  findIfc(LIBRARY_DIR, [])
    .map(p => p.replace(/\.ifc$/i, '.frag'))
    .filter(p => fs.existsSync(p))
    .forEach(p => {
      const sizeKB = (fs.statSync(p).size / 1024).toFixed(1);
      console.log(`  ${path.relative(PROJECT_ROOT, p)}  (${sizeKB} KB)`);
    });
}

console.log('\nNext step: run  node backend/scripts/convert_library.mjs  again');
console.log('to re-convert if you add new IFC files to the library.\n');
