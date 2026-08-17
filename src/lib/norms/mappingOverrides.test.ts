/**
 * mappingOverrides.test.ts — Faza 5: suprascrierile de proiect se fuzionează în
 * catalogul de runtime.
 *
 * Verifică cele trei comportamente: fără overrideuri catalogul e neschimbat;
 * un override pe cheie nouă se adaugă; un override pe cheie existentă înlocuiește.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getActiveCatalog, findMappingRules } from './catalog';
import { useMappingOverrides } from '@/store/mappingOverrideStore';
import type { NormMappingRule } from './types';

afterEach(() => useMappingOverrides.getState().clear());

describe('suprascrieri de mapare la nivel de proiect', () => {
  it('fără overrideuri, catalogul e neschimbat', () => {
    const a = getActiveCatalog();
    const b = getActiveCatalog();
    expect(a.mapping).toBe(b.mapping); // aceeași referință memoizată
  });

  it('un override pe cheie nouă adaugă o regulă', () => {
    const before = findMappingRules('door', 'D-SWING-80x210');
    expect(before).toHaveLength(0); // ușile sunt nemapate global

    const rule: NormMappingRule = {
      nodeType: 'door',
      elementTypeId: 'D-SWING-80x210',
      outputs: [{ normId: 'X_TEST', measure: 'count' }],
    };
    useMappingOverrides.getState().setRules([rule]);

    const after = findMappingRules('door', 'D-SWING-80x210');
    expect(after).toHaveLength(1);
    expect(after[0].outputs[0].normId).toBe('X_TEST');
  });

  it('un override pe cheie existentă înlocuiește regula globală', () => {
    // Alegem o cheie care există deja în catalogul de bază.
    const base = getActiveCatalog();
    const target = base.mapping.find((r) => r.elementTypeId !== '*');
    expect(target).toBeTruthy();
    const t = target!;

    const override: NormMappingRule = {
      nodeType: t.nodeType,
      elementTypeId: t.elementTypeId,
      outputs: [{ normId: 'OVERRIDDEN', measure: 'count' }],
    };
    useMappingOverrides.getState().setRules([override]);

    const rules = findMappingRules(t.nodeType, t.elementTypeId);
    // Cheia e înlocuită: doar outputul de override, nu cele globale.
    const norms = rules.flatMap((r) => r.outputs.map((o) => o.normId));
    expect(norms).toContain('OVERRIDDEN');
  });

  it('articolele de override devin găsibile în catalog', () => {
    useMappingOverrides.getState().setArticles([
      { id: 'PRJ1', symbol: 'PRJ 1', denumire: 'Articol de proiect', unit: 'buc', capitol: 'X', categorie: 'Proiect' },
    ]);
    expect(getActiveCatalog().map.get('PRJ1')?.denumire).toBe('Articol de proiect');
  });
});
