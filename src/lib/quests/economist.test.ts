import { describe, expect, it } from 'vitest';
import { evaluateEconomist, type EconomySnapshot } from './economist';

const snap = (over: Partial<EconomySnapshot> = {}): EconomySnapshot => ({
  baselineTotal: 100000, unpricedCount: 0, articleCount: 12, budget: 0, scenarios: [], projectSystem: 'unset', ...over,
});

describe('evaluateEconomist', () => {
  it('a priced model with nothing else done has one step ticked', () => {
    const p = evaluateEconomist(snap());
    expect(p.total).toBe(6);
    expect(p.completed).toBe(1);
    expect(p.nextStep?.id).toBe('budget');
  });

  it('an unpriced model has nothing ticked', () => {
    expect(evaluateEconomist(snap({ unpricedCount: 3 })).completed).toBe(0);
    expect(evaluateEconomist(snap({ articleCount: 0 })).steps[0].done).toBe(false);
  });

  it('a scenario counts; a different system counts separately', () => {
    const p = evaluateEconomist(snap({ scenarios: [{ total: 98000 }] }));
    expect(p.steps.find((s) => s.id === 'variant')!.done).toBe(true);
    expect(p.steps.find((s) => s.id === 'system')!.done).toBe(false);
    const q = evaluateEconomist(snap({ scenarios: [{ total: 98000, structuralSystem: 'timber_frame' }] }));
    expect(q.steps.find((s) => s.id === 'system')!.done).toBe(true);
    // Same as the project's system is not "another".
    const r = evaluateEconomist(snap({ projectSystem: 'timber_frame', scenarios: [{ total: 1, structuralSystem: 'timber_frame' }] }));
    expect(r.steps.find((s) => s.id === 'system')!.done).toBe(false);
  });

  it('beating the baseline needs a full 5 %', () => {
    const almost = evaluateEconomist(snap({ scenarios: [{ total: 96000 }] }));
    expect(almost.steps.find((s) => s.id === 'cheaper')!.done).toBe(false);
    const enough = evaluateEconomist(snap({ scenarios: [{ total: 95000 }] }));
    expect(enough.steps.find((s) => s.id === 'cheaper')!.done).toBe(true);
  });

  it('landing under budget reads the cheapest EVALUATED scenario', () => {
    const p = evaluateEconomist(snap({ budget: 90000, scenarios: [{ total: null }, { total: 120000 }, { total: 89000 }] }));
    expect(p.steps.find((s) => s.id === 'afford')!.done).toBe(true);
    const q = evaluateEconomist(snap({ budget: 90000, scenarios: [{ total: null }] }));
    expect(q.steps.find((s) => s.id === 'afford')!.done).toBe(false);
  });

  it('everything done reports allDone', () => {
    const p = evaluateEconomist(snap({ budget: 95000, scenarios: [{ total: 90000, structuralSystem: 'timber_frame' }] }));
    expect(p.allDone).toBe(true);
    expect(p.pct).toBe(100);
    expect(p.nextStep).toBeNull();
  });
});
