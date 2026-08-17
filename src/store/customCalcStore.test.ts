/**
 * Round-trip de persistență pentru grafurile de calcul custom.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useCustomCalc, exportCustomCalc, importCustomCalc } from './customCalcStore';

beforeEach(() => {
  importCustomCalc(undefined); // reset
});

describe('persistență custom calc', () => {
  it('export → import restaurează grafurile', () => {
    const id = useCustomCalc.getState().createGraph('Test volum');
    const paramId = useCustomCalc.getState().addNode('param', { x: 0, y: 0 });
    useCustomCalc.getState().updateNode(paramId, { measureKey: 'area_m2' });

    const persist = exportCustomCalc();
    expect(persist.graphs[id]).toBeDefined();
    expect(persist.currentId).toBe(id);

    // Golește apoi restaurează.
    importCustomCalc(undefined);
    expect(Object.keys(useCustomCalc.getState().graphs)).toHaveLength(0);

    importCustomCalc(persist);
    const restored = useCustomCalc.getState().graphs[id];
    expect(restored).toBeDefined();
    expect(restored.name).toBe('Test volum');
    expect(restored.nodes.some((n) => n.measureKey === 'area_m2')).toBe(true);
    expect(useCustomCalc.getState().currentId).toBe(id);
    // previewNodeId nu se persistă (runtime).
    expect(useCustomCalc.getState().previewNodeId).toBeNull();
  });

  it('import(undefined) golește starea (nu scurge grafuri între proiecte)', () => {
    useCustomCalc.getState().createGraph('X');
    importCustomCalc(undefined);
    expect(Object.keys(useCustomCalc.getState().graphs)).toHaveLength(0);
    expect(useCustomCalc.getState().currentId).toBeNull();
  });
});
