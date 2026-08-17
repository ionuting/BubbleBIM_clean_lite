/**
 * serializeLibrary.ts — `NormLibrary` → fișiere `.md`.
 *
 * Invers exact al parserului: `parse(serialize(lib))` trebuie să reproducă `lib`.
 * Pur (întoarce string-uri), scrierea pe disc o face scriptul de generare.
 */
import type { LibraryCategory, NormLibrary } from './types';
import { slug } from './fromCatalog';

function n(v: number): string {
  return Number.isInteger(v) ? String(v) : String(v);
}

/** Serializează o categorie într-un document markdown. */
export function serializeCategory(cat: LibraryCategory): string {
  const out: string[] = [];
  out.push('---');
  out.push(`categorie: ${cat.categorie}`);
  out.push(`capitol: ${cat.capitol}`);
  out.push('---');
  out.push('');
  out.push('## Articole');
  out.push('| normId | simbol | denumire | UM | material | manoperă | utilaj | transport |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const a of cat.articles) {
    const p = a.price;
    out.push(
      `| ${a.normId} | ${a.symbol} | ${a.denumire} | ${a.unit} | ` +
        `${p ? n(p.material) : ''} | ${p ? n(p.manopera) : ''} | ${p ? n(p.utilaj) : ''} | ${p ? n(p.transport) : ''} |`,
    );
  }
  out.push('');
  out.push('## Mapări BIM');
  out.push('| normId | nodeType | elementType | materialKey | măsură | formulă | netOfOpenings |');
  out.push('|---|---|---|---|---|---|---|');
  for (const m of cat.mappings) {
    out.push(
      `| ${m.normId} | ${m.nodeType} | ${m.elementType} | ${m.materialKey ?? ''} | ` +
        `${m.measure} | ${m.formula ?? ''} | ${m.netOfOpenings ? 'da' : ''} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

/** Serializează metadatele catalogului (`_catalog.md`). */
export function serializeCatalog(lib: NormLibrary): string {
  return [
    '---',
    `id: ${lib.meta.id}`,
    `version: ${lib.meta.version}`,
    `currency: ${lib.meta.currency}`,
    '---',
    '',
    `# Catalog: ${lib.meta.id}`,
    '',
    'Fișier generat / editabil. Categoriile sunt în fișierele `.md` din acest folder.',
    '',
  ].join('\n');
}

/** Toate fișierele librăriei: numeFișier → conținut. */
export function serializeLibrary(lib: NormLibrary): Record<string, string> {
  const files: Record<string, string> = { '_catalog.md': serializeCatalog(lib) };
  for (const cat of lib.categories) {
    files[cat.sourceFile || `${slug(cat.categorie)}.md`] = serializeCategory(cat);
  }
  return files;
}
