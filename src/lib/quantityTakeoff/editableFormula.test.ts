/**
 * Invariant: formula editabilă implicită (`trace.editableFormula`), evaluată pe
 * simbolurile intrărilor, reproduce exact cantitatea calculată de motor. Editarea
 * pornește deci de la valoarea corectă.
 */
import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { computeTakeoffTraced } from './takeoffEngine';
import { evalWithSymbols } from './calcTrace';

describe('editableFormula reproduce rezultatul motorului', () => {
  it('pe proiectul exemplu', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const data = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'public/example-project.bbim'), 'utf-8'),
    ) as { model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } };

    const traced = computeTakeoffTraced(data.model.nodes, data.model.edges);
    expect(traced.length).toBeGreaterThan(0);
    for (const line of traced) {
      const v = evalWithSymbols(line.trace.editableFormula, line.trace.inputs);
      expect(Number.isNaN(v), `NaN pentru "${line.trace.editableFormula}"`).toBe(false);
      expect(v).toBeCloseTo(line.trace.result, 4);
    }
  });

  it('editarea recalculează (dublăm formula → dublăm rezultatul)', () => {
    const inputs = [{ key: 'area_m2' as const, symbol: 'A', label: 'Arie', value: 10, unit: 'm²' }];
    expect(evalWithSymbols('A', inputs)).toBe(10);
    expect(evalWithSymbols('A * 2', inputs)).toBe(20);
    expect(Number.isNaN(evalWithSymbols('A * ', inputs))).toBe(true); // formulă invalidă
  });
});
