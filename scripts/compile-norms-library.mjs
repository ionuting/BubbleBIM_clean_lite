#!/usr/bin/env node
/**
 * compile-norms-library.mjs — compilează librăria de categorii de lucrări.
 *
 *   data/norms/library/*.md  →  src/lib/norms/generated/norms.compiled.json
 *
 * Validează înainte de a scrie. Erorile opresc compilarea (exit 1) — o librărie
 * ruptă nu trebuie să ajungă niciodată în build, fiindcă simptomul ei nu e o
 * excepție, ci un deviz incomplet fără niciun semnal.
 *
 * Uz:
 *   node scripts/compile-norms-library.mjs [--check]
 *     --check  validează fără a scrie (pentru CI)
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const LIB_DIR = resolve(root, 'data/norms/library');
const OUT = resolve(root, 'src/lib/norms/generated/norms.compiled.json');
const checkOnly = process.argv.includes('--check');

// Modulele pure sunt TS; le rulăm prin vite-node ca să respectăm alias-ul `@/`.
const { createServer } = await import('vite');
const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  appType: 'custom',
});

async function load(p) {
  return server.ssrLoadModule(pathToFileURL(resolve(root, p)).pathname);
}

try {
  const { parseCategoryMdCollecting, parseCatalogMd } = await load('src/lib/norms/library/parseLibrary.ts');
  const { compileLibrary } = await load('src/lib/norms/library/compileLibrary.ts');
  const { validateLibrary, formatValidation } = await load('src/lib/norms/library/validateLibrary.ts');

  if (!existsSync(LIB_DIR)) {
    console.error(`✖ Lipsește ${LIB_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(LIB_DIR).filter((f) => f.endsWith('.md')).sort();
  const catalogFile = files.find((f) => f === '_catalog.md');
  if (!catalogFile) {
    console.error('✖ Lipsește data/norms/library/_catalog.md');
    process.exit(1);
  }

  const meta = parseCatalogMd(readFileSync(resolve(LIB_DIR, catalogFile), 'utf-8'), catalogFile);

  const issues = [];
  const categories = [];
  for (const f of files) {
    if (f === '_catalog.md') continue;
    const cat = parseCategoryMdCollecting(readFileSync(resolve(LIB_DIR, f), 'utf-8'), f, issues);
    categories.push(cat);
  }

  if (issues.length > 0) {
    console.error(`✖ Erori de parsare (${issues.length}):`);
    for (const i of issues) console.error(`  ${i.file}:${i.line} — ${i.message}`);
    process.exit(1);
  }

  const library = { meta, categories };
  const compiled = compileLibrary(library);
  const result = validateLibrary(library, compiled);

  console.log(`Librărie: ${basename(LIB_DIR)} · ${categories.length} categorii · ${compiled.articles.length} articole · ${compiled.mapping.length} reguli`);
  console.log(formatValidation(result));

  if (!result.ok) {
    console.error('\n✖ Validare eșuată — nu scriu JSON-ul.');
    process.exit(1);
  }

  if (checkOnly) {
    console.log('\n✓ Validare OK (--check: nu am scris nimic).');
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(compiled, null, 2) + '\n');
    console.log(`\n✓ Scris ${OUT.replace(root + '/', '')}`);
  }
} finally {
  await server.close();
}
