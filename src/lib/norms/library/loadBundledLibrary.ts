/**
 * loadBundledLibrary.ts — încarcă librăria din fișierele MD bundluite la build.
 *
 * Editorul vizual are nevoie de forma EDITABILĂ (articole cu componente de preț,
 * mapări cu materialKey / formulă), pe care doar sursele MD o păstrează — JSON-ul
 * compilat e deja aplatizat. Încărcăm aceleași fișiere pe care le consumă și
 * compilatorul, ca editorul să vadă exact sursa de adevăr.
 *
 * Globul e RELATIV la acest modul (nu absolut `/data`), ca să funcționeze
 * identic indiferent de `root`-ul Vite (standalone vs clean-lite).
 */
import { parseCategoryMdCollecting, parseCatalogMd } from './parseLibrary';
import type { ParseIssue } from './parseLibrary';
import type { NormLibrary } from './types';

// Toate fișierele MD ale librăriei, ca text brut, evaluate la build.
const RAW = import.meta.glob('../../../../data/norms/library/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Basename-ul unui path de glob (ex. `.../zidarie.md` → `zidarie.md`). */
function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export interface BundledLibrary {
  library: NormLibrary;
  issues: ParseIssue[];
}

/** Parsează librăria bundluită. Problemele sunt colectate, nu aruncate. */
export function loadBundledLibrary(): BundledLibrary {
  const issues: ParseIssue[] = [];
  const entries = Object.entries(RAW)
    .map(([path, text]) => ({ file: basename(path), text }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const catalogEntry = entries.find((e) => e.file === '_catalog.md');
  const meta = catalogEntry
    ? safeCatalog(catalogEntry.text, issues)
    : { id: '', version: '', currency: 'lei' };

  const categories = entries
    .filter((e) => e.file !== '_catalog.md')
    .map((e) => parseCategoryMdCollecting(e.text, e.file, issues));

  return { library: { meta, categories }, issues };
}

function safeCatalog(text: string, issues: ParseIssue[]): NormLibrary['meta'] {
  try {
    return parseCatalogMd(text);
  } catch (e) {
    issues.push({ file: '_catalog.md', line: 1, message: (e as Error).message });
    return { id: '', version: '', currency: 'lei' };
  }
}
