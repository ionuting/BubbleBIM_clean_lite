/**
 * catalogCompiled.fidelity.test.ts — plasa de siguranță a Fazei 3.
 *
 * La runtime, `getActiveCatalog()` servește librăria COMPILATĂ (JSON generat din
 * MD), nu modulele TS hardcodate. Acest test dovedește că cele două NU au
 * divergat: fiecare articol, mapare și preț din ancora hardcodată trebuie să
 * apară IDENTIC în JSON-ul de pe disc.
 *
 * Relația e de INCLUZIUNE, nu de egalitate: MD-ul e sursa de adevăr și crește
 * (categoriile de lemn există doar acolo), pe când ancora e fotografia
 * porțiunii migrate. Ce e în ancoră nu are voie să se schimbe pe furiș; ce e
 * doar în MD e conținut nou, nu divergență.
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
import { ANCHOR_REATTACHMENTS, reattachedFrom } from './anchorReattachments';

/**
 * Cheie canonică pentru un set de reguli (independentă de ordine), cu
 * re-atașările DELIBERATE scoase din ancoră — vezi `anchorReattachments.ts`.
 * Ce s-a mutat e verificat separat, la noua adresă, deci o mutare greșită tot
 * pică testul.
 */
function fingerprint(rules: NormMappingRule[], applyReattachments = false): string[] {
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
function expectReattachmentsLanded(mapping: NormMappingRule[]): void {
  for (const r of ANCHOR_REATTACHMENTS) {
    const [nodeType, elementTypeId] = r.to.split('/');
    const found = mapping.some(
      (m) => m.nodeType === nodeType && m.elementTypeId === elementTypeId
        && m.outputs.some((o) => o.normId === r.normId),
    );
    expect(found, `re-atașare neaplicată: ${r.normId} ar trebui să fie pe ${r.to} (${r.reason})`).toBe(true);
  }
}

describe('fidelitate runtime: JSON compilat = ancoră hardcodată', () => {
  const runtime = getActiveCatalog();
  const legacy = getLegacyZidarieCatalog();

  it('servește catalogul compilat (id + versiune)', () => {
    expect(runtime.id).toBe('zidarie-confinata');
    expect(runtime.version).toBe(legacy.version);
  });

  it('articolele ancorei apar identic la runtime', () => {
    const byId = (arr: { id: string }[]) => new Map(arr.map((a) => [a.id, a]));
    const a = byId(runtime.articles);
    const b = byId(legacy.articles);
    expect(a.size).toBeGreaterThanOrEqual(b.size);
    for (const [id, art] of b) expect(a.get(id), `articol lipsă: ${id}`).toEqual(art);
  });

  it('mapările ancorei apar identic la runtime (independent de ordine)', () => {
    const rt = new Set(fingerprint(runtime.mapping, true));
    for (const f of fingerprint(legacy.mapping, true)) expect(rt.has(f), `mapare lipsă/schimbată: ${f}`).toBe(true);
  });

  it('ce s-a re-atașat deliberat chiar există la noua adresă', () => {
    expectReattachmentsLanded(runtime.mapping);
  });

  it('prețurile ancorei apar identic în librăria compilată', () => {
    const compiled = getCompiledUnitPrices();
    for (const [id, p] of Object.entries(preturiDefaultTotale())) {
      expect(compiled[id], `preț lipsă/schimbat: ${id}`).toBe(p);
    }
  });

  it('map-ul de articole e coerent cu lista', () => {
    expect(runtime.map.size).toBe(runtime.articles.length);
    for (const a of runtime.articles) expect(runtime.map.get(a.id)).toEqual(a);
  });
});
