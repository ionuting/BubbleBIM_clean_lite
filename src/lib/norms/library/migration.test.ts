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
import { ANCHOR_REATTACHMENTS, reattachedFrom } from '../anchorReattachments';

/**
 * Cheie canonică pentru un set de reguli (independentă de ordine), cu
 * re-atașările DELIBERATE scoase din ancoră — vezi `anchorReattachments.ts`.
 * Ce s-a mutat e verificat separat, la noua adresă, deci o mutare greșită tot
 * pică testul.
 */
function ruleFingerprint(rules: EngineRule[], applyReattachments = false): string[] {
  return rules
    .map((r) => {
      const key = `${r.nodeType}/${r.elementTypeId}`;
      const moved = applyReattachments ? reattachedFrom(key) : new Set<string>();
      const outs = r.outputs
        .filter((o) => !moved.has(o.normId))
        .map((o) => `${o.normId}:${o.measure}:${o.formula ?? ''}:${o.netOfOpenings ? 1 : 0}`)
        .sort()
        .join(',');
      return `${key} => ${outs}`;
    })
    .sort();
}

/** Fiecare re-atașare trebuie să existe efectiv la noua adresă. */
function expectReattachmentsLanded(mapping: EngineRule[]): void {
  for (const r of ANCHOR_REATTACHMENTS) {
    const [nodeType, elementTypeId] = r.to.split('/');
    const found = mapping.some(
      (m) => m.nodeType === nodeType && m.elementTypeId === elementTypeId
        && m.outputs.some((o) => o.normId === r.normId),
    );
    expect(found, `re-atașare neaplicată: ${r.normId} ar trebui să fie pe ${r.to} (${r.reason})`).toBe(true);
  }
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

// Ancora e porțiunea MIGRATĂ a librăriei; MD-ul poate conține în plus
// categorii care n-au existat niciodată în TS (lemnul). De aceea comparațiile
// cu catalogul activ sunt de incluziune (ancora ⊆ activ), nu de egalitate —
// vezi și catalogCompiled.fidelity.test.ts.
describe('migrare catalog → librărie (golden)', () => {
  it('articolele ancorei apar identic în catalogul actual', () => {
    const compiled = compileLibrary(buildLibraryFromActiveCatalog());
    const cur = getActiveCatalog();

    const byId = (arr: { id: string }[]) => new Map(arr.map((a) => [a.id, a]));
    const a = byId(compiled.articles);
    const b = byId(cur.articles);
    expect(b.size).toBeGreaterThanOrEqual(a.size);
    for (const [id, art] of a) {
      expect(b.get(id), `articol lipsă: ${id}`).toEqual(art);
    }
  });

  it('mapările ancorei apar identic în catalogul actual (independent de ordine)', () => {
    const compiled = compileLibrary(buildLibraryFromActiveCatalog());
    const cur = new Set(ruleFingerprint(getActiveCatalog().mapping, true));
    for (const f of ruleFingerprint(compiled.mapping, true)) expect(cur.has(f), `mapare lipsă: ${f}`).toBe(true);
    expectReattachmentsLanded(getActiveCatalog().mapping);
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
