/**
 * fromCatalog.ts — construiește o `NormLibrary` din catalogul hardcodat actual.
 *
 * E puntea de migrare: catalogul curent (articole JSON + mapări TS + prețuri TS)
 * devine forma de librărie, din care apoi se emit fișierele `.md`. Reverse-ul e
 * pur, ca să poată fi verificat printr-un test golden (catalog → librărie →
 * compilat trebuie să dea articole/mapări/prețuri identice cu originalul).
 */
import { getLegacyZidarieCatalog } from '../catalog';
import { PRETURI_DEFAULT_RO } from '../preturiDefault';
import type { LibraryArticle, LibraryCategory, LibraryMapping, NormLibrary } from './types';

/**
 * Reconstruiește librăria din catalogul HARDCODAT (ancora de migrare).
 *
 * Deliberat pe ancoră, nu pe `getActiveCatalog()`: la runtime activul e deja
 * librăria compilată, deci a construi din el ar face testul golden circular.
 * Ancora hardcodată rămâne originalul independent față de care se verifică
 * fidelitatea întregii conducte MD → JSON.
 */
export function buildLibraryFromActiveCatalog(): NormLibrary {
  const cat = getLegacyZidarieCatalog();

  // Grupăm articolele pe categorie; reținem capitolul (constant pe categorie).
  const byCat = new Map<string, { capitol: string; articles: LibraryArticle[] }>();
  for (const a of cat.articles) {
    let g = byCat.get(a.categorie);
    if (!g) { g = { capitol: a.capitol, articles: [] }; byCat.set(a.categorie, g); }
    const p = PRETURI_DEFAULT_RO[a.id];
    g.articles.push({
      normId: a.id,
      symbol: a.symbol,
      denumire: a.denumire,
      unit: a.unit,
      price: p ? { ...p } : undefined,
    });
  }

  // Găsim categoria fiecărui articol (pentru a plasa maparea în fișierul corect).
  const catOfArticle = new Map(cat.articles.map((a) => [a.id, a.categorie]));

  // Mapările: câte un rând per (regulă × output). elementType explicit = lossless.
  const mapsByCat = new Map<string, LibraryMapping[]>();
  for (const rule of cat.mapping) {
    for (const o of rule.outputs) {
      const categorie = catOfArticle.get(o.normId);
      if (!categorie) continue; // output orfan — semnalat separat de validator
      const m: LibraryMapping = {
        normId: o.normId,
        nodeType: rule.nodeType,
        elementType: rule.elementTypeId,
        measure: o.measure,
        ...(o.formula ? { formula: o.formula } : {}),
        ...(o.netOfOpenings ? { netOfOpenings: true } : {}),
      };
      const arr = mapsByCat.get(categorie) ?? [];
      arr.push(m);
      mapsByCat.set(categorie, arr);
    }
  }

  const categories: LibraryCategory[] = [...byCat.entries()].map(([categorie, g]) => ({
    categorie,
    capitol: g.capitol,
    articles: g.articles,
    mappings: mapsByCat.get(categorie) ?? [],
    sourceFile: `${slug(categorie)}.md`,
  }));

  return {
    meta: { id: cat.id, version: cat.version, currency: 'lei' },
    categories,
  };
}

/** Slug de fișier dintr-un nume de categorie (diacritice → ascii, spații → -). */
export function slug(name: string): string {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
