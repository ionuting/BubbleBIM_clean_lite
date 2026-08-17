/**
 * loadBundledLibrary.test.ts — garantează că fișierele MD de pe disc rămân
 * parsabile și valide. E același traseu pe care îl folosește editorul vizual,
 * deci dacă cineva strică un tabel, testul (și editorul) o semnalează imediat.
 */
import { describe, it, expect } from 'vitest';
import { loadBundledLibrary } from './loadBundledLibrary';
import { compileLibrary } from './compileLibrary';
import { validateLibrary } from './validateLibrary';

describe('librăria bundluită (MD → parse)', () => {
  const { library, issues } = loadBundledLibrary();

  it('se parsează fără probleme', () => {
    expect(issues, issues.map((i) => `${i.file}:${i.line} ${i.message}`).join('\n')).toHaveLength(0);
  });

  it('are metadate și categorii', () => {
    expect(library.meta.id).toBeTruthy();
    expect(library.meta.version).toBeTruthy();
    expect(library.categories.length).toBeGreaterThan(0);
  });

  it('compilează fără erori de validare', () => {
    const res = validateLibrary(library, compileLibrary(library));
    const errors = res.issues.filter((i) => i.severity === 'error');
    expect(errors, errors.map((e) => e.message).join('\n')).toHaveLength(0);
  });
});
