/**
 * Gardă de ACOPERIRE a mapărilor BIM → articole de normă.
 *
 * Context: maparea pereților se face potrivind textul liber `material` din
 * `elementLibrary`. Acel text a fost tradus o dată (ro → en), ceea ce a golit
 * silențios lista de pereți de zidărie: fără reguli pentru `wall`, zidăria
 * dispare complet din deviz, iar takeoff-ul rămâne „verde" pentru că absența
 * unei reguli nu e o eroare, ci pur și simplu zero cantități.
 *
 * Testele de mai jos transformă acea ruptură tăcută într-un eșec zgomotos.
 */
import { describe, it, expect } from 'vitest';
import { ELEMENT_LIBRARY, WALL_TYPES } from '@/lib/elementLibrary';
import { getActiveCatalog, findMappingRules } from './catalog';

describe('acoperirea mapărilor', () => {
  it('tipurile de elemente structurale au cel puțin o regulă', () => {
    // Tipuri BIM care TREBUIE să producă cantități în catalogul de zidărie confinată.
    const mustBeMapped = ['wall', 'column', 'beam', 'foundation'] as const;
    const empty: string[] = [];

    for (const nodeType of mustBeMapped) {
      const list = (ELEMENT_LIBRARY as Record<string, readonly { id: string; material?: string }[]>)[nodeType] ?? [];
      const anyMapped = list.some((t) => findMappingRules(nodeType, t.id, t.material).length > 0);
      if (!anyMapped) empty.push(nodeType);
    }

    expect(empty, `tipuri BIM fără nicio regulă de mapare: ${empty.join(', ')}`).toHaveLength(0);
  });

  it('pereții de zidărie sunt mapați indiferent de limba etichetei de material', () => {
    const masonry = WALL_TYPES.filter((t) => /caramid|brick|beton|concrete/i.test(t.material));
    expect(
      masonry.length,
      `niciun perete de zidărie recunoscut; materiale prezente: ${[...new Set(WALL_TYPES.map((t) => t.material))].join(' | ')}`,
    ).toBeGreaterThan(0);

    for (const t of masonry) {
      expect(
        findMappingRules('wall', t.id, t.material).length,
        `peretele ${t.id} (${t.material}) nu are regulă`,
      ).toBeGreaterThan(0);
    }
  });

  it('articolul principal de zidărie este emis pentru un perete de cărămidă', () => {
    const brick = WALL_TYPES.find((t) => /caramid|brick/i.test(t.material));
    expect(brick, 'niciun tip de perete din cărămidă în elementLibrary').toBeDefined();

    const rules = findMappingRules('wall', brick!.id, brick!.material);
    const normIds = rules.flatMap((r) => r.outputs.map((o) => o.normId));
    expect(normIds).toContain('0001_00201A01_02'); // ZIDARIE POROTHERM (mc)
  });

  it('nicio regulă nu referă un articol inexistent în catalog', () => {
    const { articles, mapping } = getActiveCatalog();
    const ids = new Set(articles.map((a) => a.id));
    const broken = [
      ...new Set(mapping.flatMap((r) => r.outputs.map((o) => o.normId)).filter((id) => !ids.has(id))),
    ];
    expect(broken, `normId inexistente: ${broken.join(', ')}`).toHaveLength(0);
  });
});
