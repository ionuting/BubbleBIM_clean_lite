/**
 * Teste pentru evaluatorul grafului de calcul editabil (custom).
 */
import { describe, it, expect } from 'vitest';
import type { NodeMeasures } from '@/lib/norms';
import { EMPTY_MEASURES } from '@/lib/norms';
import { evaluateCustomCalc, type CustomCalcGraph } from './customCalc';

const measures = (over: Partial<NodeMeasures>): NodeMeasures => ({ ...EMPTY_MEASURES, ...over });

describe('evaluateCustomCalc', () => {
  it('parametru direct → result', () => {
    const g: CustomCalcGraph = {
      id: 'g', name: 't',
      nodes: [
        { id: 'p', kind: 'param', position: { x: 0, y: 0 }, measureKey: 'volume_m3' },
        { id: 'r', kind: 'result', position: { x: 0, y: 0 }, unit: 'mc' },
      ],
      edges: [{ id: 'e', source: 'p', target: 'r' }],
    };
    expect(evaluateCustomCalc(g, measures({ volume_m3: 3.6 })).value).toBe(3.6);
  });

  it('param × const (parametru calculat)', () => {
    const g: CustomCalcGraph = {
      id: 'g', name: 't',
      nodes: [
        { id: 'a', kind: 'param', position: { x: 0, y: 0 }, measureKey: 'area_m2' },
        { id: 'k', kind: 'const', position: { x: 0, y: 0 }, value: 2 },
        { id: 'm', kind: 'op', position: { x: 0, y: 0 }, op: 'mul' },
        { id: 'r', kind: 'result', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'm' },
        { id: 'e2', source: 'k', target: 'm' },
        { id: 'e3', source: 'm', target: 'r' },
      ],
    };
    expect(evaluateCustomCalc(g, measures({ area_m2: 12.5 })).value).toBe(25);
  });

  it('formulă custom cu variabile a, b (ordonate după handle)', () => {
    const g: CustomCalcGraph = {
      id: 'g', name: 't',
      nodes: [
        { id: 'L', kind: 'param', position: { x: 0, y: 0 }, measureKey: 'length_m' },
        { id: 'H', kind: 'param', position: { x: 0, y: 0 }, measureKey: 'height_m' },
        { id: 'f', kind: 'op', position: { x: 0, y: 0 }, op: 'formula', formula: 'a * b * 0.2' },
        { id: 'r', kind: 'result', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'L', target: 'f', targetHandle: 'in-0' },
        { id: 'e2', source: 'H', target: 'f', targetHandle: 'in-1' },
        { id: 'e3', source: 'f', target: 'r' },
      ],
    };
    // 6 × 3 × 0.2 = 3.6
    expect(evaluateCustomCalc(g, measures({ length_m: 6, height_m: 3 })).value).toBeCloseTo(3.6, 6);
  });

  it('împărțire la zero → 0, fără excepție', () => {
    const g: CustomCalcGraph = {
      id: 'g', name: 't',
      nodes: [
        { id: 'a', kind: 'const', position: { x: 0, y: 0 }, value: 10 },
        { id: 'b', kind: 'const', position: { x: 0, y: 0 }, value: 0 },
        { id: 'd', kind: 'op', position: { x: 0, y: 0 }, op: 'div' },
        { id: 'r', kind: 'result', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'd', targetHandle: 'in-0' },
        { id: 'e2', source: 'b', target: 'd', targetHandle: 'in-1' },
        { id: 'e3', source: 'd', target: 'r' },
      ],
    };
    expect(evaluateCustomCalc(g, null).value).toBe(0);
  });

  it('ciclu → raportat în errors, fără buclă infinită', () => {
    const g: CustomCalcGraph = {
      id: 'g', name: 't',
      nodes: [
        { id: 'x', kind: 'op', position: { x: 0, y: 0 }, op: 'add' },
        { id: 'y', kind: 'op', position: { x: 0, y: 0 }, op: 'add' },
        { id: 'r', kind: 'result', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'x', target: 'y' },
        { id: 'e2', source: 'y', target: 'x' },
        { id: 'e3', source: 'y', target: 'r' },
      ],
    };
    const res = evaluateCustomCalc(g, null);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
