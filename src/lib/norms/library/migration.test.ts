/**
 * Test GOLDEN de migrare: catalogul hardcodat actual → librărie → MD → compilat
 * trebuie să producă articole / mapări / prețuri IDENTICE cu originalul.
 *
 * Aceasta e plasa de siguranță a Fazei 2: dovedește că trecerea la librărie nu
 * schimbă accidental nicio cifră din deviz.
 */
import { describe, it, expect } from 'vitest';
import { getActiveCatalog } from '../catalog';
import { preturiDefaultTotale } from '../preturiDefault';
import { buildLibraryFromActiveCatalog } from './fromCatalog';
import { serializeLibrary } from './serializeLibrary';
import { parseCategoryMd, parseCatalogMd } from './parseLibrary';
import { compileLibrary, compiledUnitPrices } from './compileLibrary';
import { validateLibrary } from './validateLibrary';
import type { NormLibrary } from './types';
import type { NormMappingRule as EngineRule } from '../types';

/** Cheie canonică pentru o regulă compilată (independentă de ordine). */
function ruleFingerprint(rules: EngineRule[]): string[] {
  return rules
    .map((r) => {
      const outs = r.outputs
        .map((o) => `${o.normId}:${o.measure}:${o.formula ?? ''}:${o.netOfOpenings ? 1 : 0}`)
        .sort()
        .join(',');
      return `${r.nodeType}/${r.elementTypeId} => ${outs}`;
    })
    .sort();
}

/** Reîncarcă o librărie din fișierele ei serializate (round-trip prin MD). */
function reparse(lib: NormLibrary): NormLibrary {
  const files = serializeLibrary(lib);
  const meta = parseCatalogMd(files['_catalog.md']);
  const categories = Object.entries(files)
    .filter(([f]) => f !== '_catalog.md')
    .map(([f, text]) => parseCategoryMd(text, f));
  return { meta, categories };
}

describe('migrare catalog → librărie (golden)', () => {
  it('compilat din librărie = catalogul actual (articole)', () => {
    const compiled = compileLibrary(buildLibraryFromActiveCatalog());
    const cur = getActiveCatalog();

    const byId = (arr: { id: string }[]) => new Map(arr.map((a) => [a.id, a]));
    const a = byId(compiled.articles);
    const b = byId(cur.articles);
    expect(a.size).toBe(b.size);
    for (const [id, art] of b) {
      expect(a.get(id), `articol lipsă: ${id}`).toEqual(art);
    }
  });

  it('compilat din librărie = catalogul actual (mapări, independent de ordine)', () => {
    const compiled = compileLibrary(buildLibraryFromActiveCatalog());
    const cur = getActiveCatalog();
    expect(ruleFingerprint(compiled.mapping)).toEqual(ruleFingerprint(cur.mapping));
  });

  it('prețurile compilate = preturiDefault actuale', () => {
    const compiled = compileLibrary(buildLibraryFromActiveCatalog());
    expect(compiledUnitPrices(compiled)).toEqual(preturiDefaultTotale());
  });

  it('round-trip prin MD nu pierde nimic (serialize → parse → compile identic)', () => {
    const lib = buildLibraryFromActiveCatalog();
    const direct = compileLibrary(lib);
    const viaMd = compileLibrary(reparse(lib));
    expect(ruleFingerprint(viaMd.mapping)).toEqual(ruleFingerprint(direct.mapping));
    expect(viaMd.articles).toEqual(direct.articles);
    expect(compiledUnitPrices(viaMd)).toEqual(compiledUnitPrices(direct));
  });

  it('librăria migrată e validă (fără erori)', () => {
    const lib = buildLibraryFromActiveCatalog();
    const res = validateLibrary(lib, compileLibrary(lib));
    const errors = res.issues.filter((i) => i.severity === 'error');
    expect(errors, errors.map((e) => e.message).join('\n')).toHaveLength(0);
  });
});
