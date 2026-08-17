/**
 * Teste pentru librăria de categorii de lucrări: parsare, compilare, validare.
 */
import { describe, it, expect } from 'vitest';
import { parseCategoryMd, parseCatalogMd, LibraryParseError } from './parseLibrary';
import { compileLibrary, resolveMaterialKey, compiledUnitPrices } from './compileLibrary';
import { validateLibrary } from './validateLibrary';
import type { NormLibrary } from './types';

const CATALOG_MD = `---
id: zidarie-confinata
version: deviz-zidarie-confinata-1
currency: lei
---
`;

const ZIDARIE_MD = `---
categorie: Zidarie
capitol: 4. Investiție de bază
---

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport |
|---|---|---|---|---|---|---|---|
| Z-001 | 00201A01 | Zidărie Porotherm | mc | 420 | 240 | 25 | 40 |
| Z-002 | RPCE26A | Hidroizolație | mp | 14 | 12 | 1 | 2 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | măsură | formulă |
|---|---|---|---|---|---|
| Z-001 | wall | | brick | volume | |
| Z-002 | room | * | | formula | perimeter_m * height_m |
`;

function lib(md = ZIDARIE_MD): NormLibrary {
  return {
    meta: parseCatalogMd(CATALOG_MD),
    categories: [parseCategoryMd(md, 'zidarie.md')],
  };
}

describe('parseLibrary', () => {
  it('parsează frontmatter, articole și mapări', () => {
    const cat = parseCategoryMd(ZIDARIE_MD, 'zidarie.md');
    expect(cat.categorie).toBe('Zidarie');
    expect(cat.capitol).toBe('4. Investiție de bază');
    expect(cat.articles).toHaveLength(2);
    expect(cat.articles[0]).toMatchObject({ normId: 'Z-001', unit: 'mc' });
    expect(cat.articles[0].price).toEqual({ material: 420, manopera: 240, utilaj: 25, transport: 40 });
    expect(cat.mappings).toHaveLength(2);
    expect(cat.mappings[0]).toMatchObject({ normId: 'Z-001', nodeType: 'wall', materialKey: 'brick', measure: 'volume' });
    expect(cat.mappings[1]).toMatchObject({ measure: 'formula', formula: 'perimeter_m * height_m' });
  });

  it('parsează metadatele catalogului', () => {
    expect(parseCatalogMd(CATALOG_MD)).toEqual({
      id: 'zidarie-confinata', version: 'deviz-zidarie-confinata-1', currency: 'lei',
    });
  });

  it('respinge UM invalidă, cu fișier și linie', () => {
    const bad = ZIDARIE_MD.replace('| mc |', '| metri |');
    expect(() => parseCategoryMd(bad, 'zidarie.md')).toThrow(LibraryParseError);
    try {
      parseCategoryMd(bad, 'zidarie.md');
    } catch (e) {
      const err = e as LibraryParseError;
      expect(err.issues[0].message).toContain('UM invalidă');
      expect(err.issues[0].file).toBe('zidarie.md');
      expect(err.issues[0].line).toBeGreaterThan(0);
    }
  });

  it('respinge măsura `formula` fără expresie', () => {
    const bad = ZIDARIE_MD.replace('| formula | perimeter_m * height_m |', '| formula |  |');
    expect(() => parseCategoryMd(bad, 'zidarie.md')).toThrow(/formulă.*goal/i);
  });

  it('respinge frontmatter lipsă', () => {
    expect(() => parseCategoryMd('## Articole\n', 'x.md')).toThrow(LibraryParseError);
  });
});

describe('compileLibrary', () => {
  it('produce articole cu capitol/categorie din frontmatter', () => {
    const c = compileLibrary(lib());
    expect(c.articles).toHaveLength(2);
    expect(c.articles[0]).toMatchObject({ id: 'Z-001', capitol: '4. Investiție de bază', categorie: 'Zidarie' });
    expect(c.categories).toEqual(['Zidarie']);
  });

  it('rezolvă materialKey în tipuri explicite (fără potrivire la runtime)', () => {
    const c = compileLibrary(lib());
    const wallRules = c.mapping.filter((r) => r.nodeType === 'wall');
    expect(wallRules.length).toBeGreaterThan(0);
    // Nicio regulă nu mai depinde de text de material.
    for (const r of wallRules) {
      expect(r.elementTypeId).not.toBe('*');
      expect(r.materialFilter).toBeUndefined();
    }
  });

  it('grupează mai multe articole pe aceeași regulă', () => {
    const md = ZIDARIE_MD.replace(
      '| Z-002 | room | * | | formula | perimeter_m * height_m |',
      '| Z-002 | wall | | brick | volume | |',
    );
    const c = compileLibrary(lib(md));
    const wallRule = c.mapping.find((r) => r.nodeType === 'wall');
    expect(wallRule!.outputs.map((o) => o.normId).sort()).toEqual(['Z-001', 'Z-002']);
  });

  it('extrage prețurile unitare (suma componentelor)', () => {
    expect(compiledUnitPrices(compileLibrary(lib()))).toEqual({ 'Z-001': 725, 'Z-002': 29 });
  });
});

describe('validateLibrary', () => {
  it('librăria corectă trece', () => {
    const l = lib();
    const res = validateLibrary(l, compileLibrary(l));
    expect(res.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(res.ok).toBe(true);
  });

  it('prinde referință la articol inexistent', () => {
    const md = ZIDARIE_MD.replace('| Z-002 | room |', '| Z-999 | room |');
    const l = lib(md);
    const res = validateLibrary(l, compileLibrary(l));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'unknown-article')).toBe(true);
  });

  it('prinde articol duplicat', () => {
    const cat = parseCategoryMd(ZIDARIE_MD, 'a.md');
    const l: NormLibrary = { meta: parseCatalogMd(CATALOG_MD), categories: [cat, { ...cat, sourceFile: 'b.md' }] };
    const res = validateLibrary(l, compileLibrary(l));
    expect(res.issues.some((i) => i.code === 'duplicate-article')).toBe(true);
  });

  it('prinde cheie de material necunoscută', () => {
    const md = ZIDARIE_MD.replace('| brick |', '| unobtanium |');
    const l = lib(md);
    const res = validateLibrary(l, compileLibrary(l));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'unknown-material-key')).toBe(true);
  });

  it('raportează acoperirea: tipuri nemapate și articole nefolosite', () => {
    const l = lib();
    const res = validateLibrary(l, compileLibrary(l));
    // Plăcile/ușile nu sunt mapate în această librărie minimală.
    expect(res.coverage.unmappedTypes.some((t) => t.startsWith('slab/'))).toBe(true);
    expect(res.coverage.totalTypeCount).toBeGreaterThan(0);
    expect(res.coverage.mappedTypeCount).toBeLessThan(res.coverage.totalTypeCount);
  });
});

describe('regresia ro→en ar fi fost prinsă la build', () => {
  it('o cheie de material care nu se potrivește cu niciun tip = EROARE, nu tăcere', () => {
    // `steel` e o cheie validă, dar niciun tip de perete nu are material de oțel —
    // exact forma pe care a avut-o regresia: potrivire goală, zero reguli, zero cantități.
    expect(resolveMaterialKey('wall', 'steel')).toHaveLength(0);

    const md = ZIDARIE_MD.replace('| brick |', '| steel |');
    const l = lib(md);
    const res = validateLibrary(l, compileLibrary(l));

    expect(res.ok).toBe(false);
    const issue = res.issues.find((i) => i.code === 'material-key-unresolved');
    expect(issue).toBeDefined();
    // Mesajul arată ce materiale există, ca să fie reparabil imediat.
    expect(issue!.message).toMatch(/Brick|Concrete|Gypsum/i);
  });
});
