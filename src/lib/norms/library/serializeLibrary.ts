/**
 * serializeLibrary.ts — `NormLibrary` → fișiere `.md`.
 *
 * Invers exact al parserului: `parse(serialize(lib))` trebuie să reproducă `lib`.
 * Pur (întoarce string-uri), scrierea pe disc o face scriptul de generare.
 */
import type { LibraryCategory, LibrarySpecGroup, NormLibrary } from './types';
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
  const anySource = cat.articles.some((a) => a.priceSource);
  out.push(anySource
    ? '| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |'
    : '| normId | simbol | denumire | UM | material | manoperă | utilaj | transport |');
  out.push(anySource ? '|---|---|---|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|---|');
  for (const a of cat.articles) {
    const p = a.price;
    const base = `| ${a.normId} | ${a.symbol} | ${a.denumire} | ${a.unit} | `
      + `${p ? n(p.material) : ''} | ${p ? n(p.manopera) : ''} | ${p ? n(p.utilaj) : ''} | ${p ? n(p.transport) : ''} |`;
    out.push(anySource ? `${base} ${a.priceSource?.source ?? ''} | ${a.priceSource?.date ?? ''} |` : base);
  }
  out.push('');
  out.push('## Mapări BIM');
  out.push('| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const m of cat.mappings) {
    out.push(
      `| ${m.normId} | ${m.nodeType} | ${m.elementType} | ${m.materialKey ?? ''} | ${m.system ?? ''} | ${m.spec ?? ''} | ` +
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

/** Serializează grupurile de specificații (`_specificatii.md`). */
export function serializeSpecs(groups: LibrarySpecGroup[]): string {
  const out: string[] = [];
  out.push('---');
  out.push('titlu: Specificații');
  out.push('---');
  out.push('');
  out.push('## Grupuri');
  out.push('| grup | etichetă | aplicabil | implicit | articole implicite | descriere |');
  out.push('|---|---|---|---|---|---|');
  for (const g of groups) {
    out.push(`| ${g.id} | ${g.label} | ${g.appliesTo.join(', ')} | ${g.defaultOption} | ${g.defaultArticles.join(', ')} | ${g.description ?? ''} |`);
  }
  out.push('');
  out.push('## Opțiuni');
  out.push('| grup | opțiune | etichetă | material | lambda | grosime | descriere |');
  out.push('|---|---|---|---|---|---|---|');
  for (const g of groups) {
    for (const o of g.options) {
      out.push(`| ${g.id} | ${o.id} | ${o.label} | ${o.material ?? ''} | ${o.lambda ?? ''} | ${o.grosime ?? ''} | ${o.description ?? ''} |`);
    }
  }
  out.push('');
  return out.join('\n');
}

/** Toate fișierele librăriei: numeFișier → conținut. */
export function serializeLibrary(lib: NormLibrary): Record<string, string> {
  const files: Record<string, string> = { '_catalog.md': serializeCatalog(lib) };
  if (lib.specGroups?.length) files['_specificatii.md'] = serializeSpecs(lib.specGroups);
  for (const cat of lib.categories) {
    files[cat.sourceFile || `${slug(cat.categorie)}.md`] = serializeCategory(cat);
  }
  return files;
}
