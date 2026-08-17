/**
 * catalogCompiled.fidelity.test.ts — plasa de siguranță a Fazei 3.
 *
 * La runtime, `getActiveCatalog()` servește librăria COMPILATĂ (JSON generat din
 * MD), nu modulele TS hardcodate. Acest test dovedește că cele două NU au
 * divergat: JSON-ul de pe disc trebuie să producă articole, mapări și prețuri
 * IDENTICE cu ancora hardcodată.
 *
 * Dacă cineva editează TS-ul legacy fără să recompileze MD-ul (sau invers),
 * testul pică — exact semnalul care lipsea când o traducere ro→en a golit tăcut
 * lista de pereți din deviz.
 */
import { describe, it, expect } from 'vitest';
import { getActiveCatalog, getLegacyZidarieCatalog } from './catalog';
import { getCompiledUnitPrices } from './catalogCompiled';
import { preturiDefaultTotale } from './preturiDefault';
import type { NormMappingRule } from './types';

/** Cheie canonică pentru un set de reguli (independentă de ordine). */
function fingerprint(rules: NormMappingRule[]): string[] {
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

describe('fidelitate runtime: JSON compilat = ancoră hardcodată', () => {
  const runtime = getActiveCatalog();
  const legacy = getLegacyZidarieCatalog();

  it('servește catalogul compilat (id + versiune)', () => {
    expect(runtime.id).toBe('zidarie-confinata');
    expect(runtime.version).toBe(legacy.version);
  });

  it('articolele runtime = articolele ancorei', () => {
    const byId = (arr: { id: string }[]) => new Map(arr.map((a) => [a.id, a]));
    const a = byId(runtime.articles);
    const b = byId(legacy.articles);
    expect(a.size).toBe(b.size);
    for (const [id, art] of b) expect(a.get(id), `articol lipsă: ${id}`).toEqual(art);
  });

  it('mapările runtime = mapările ancorei (independent de ordine)', () => {
    expect(fingerprint(runtime.mapping)).toEqual(fingerprint(legacy.mapping));
  });

  it('prețurile compilate = preturiDefault actuale', () => {
    expect(getCompiledUnitPrices()).toEqual(preturiDefaultTotale());
  });

  it('map-ul de articole e coerent cu lista', () => {
    expect(runtime.map.size).toBe(runtime.articles.length);
    for (const a of runtime.articles) expect(runtime.map.get(a.id)).toEqual(a);
  });
});
