import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import {
  defaultSpecSelection, hasNonDefaultSpec, nonDefaultSpecs, parseSpecSelection, resolveSpecs,
  specGroup, specGroups, specGroupsFor, specOptionLabel, specPropertyKey, suppressedArticles,
} from './specs';
import { findMappingRules, getActiveCatalog } from './catalog';

const node = (type: string, properties: Record<string, unknown> = {}): BubbleGraphNode =>
  ({ id: 'n', type, name: 'n', x: 0, y: 0, z: 0, properties });

describe('the declared groups', () => {
  it('the library declares the decisions the simulator can turn', () => {
    const ids = specGroups().map((g) => g.id);
    for (const g of ['zidarie', 'beton', 'lemn', 'tencuiala_int', 'termoizolatie', 'sapa', 'pardoseala', 'faianta', 'rigips']) {
      expect(ids, `grup lipsă: ${g}`).toContain(g);
    }
  });

  it('every group has at least two options and a default among them', () => {
    for (const g of specGroups()) {
      expect(g.options.length, g.id).toBeGreaterThanOrEqual(2);
      expect(g.options.map((o) => o.id), g.id).toContain(g.defaultOption);
      expect(g.appliesTo.length, g.id).toBeGreaterThan(0);
    }
  });

  it('every article a group claims as its default really exists', () => {
    const map = getActiveCatalog().map;
    for (const g of specGroups()) {
      for (const a of g.defaultArticles) expect(map.has(a), `${g.id} → ${a}`).toBe(true);
    }
  });

  it('groups are offered only on the node types they apply to', () => {
    expect(specGroupsFor('room').map((g) => g.id)).toContain('pardoseala');
    expect(specGroupsFor('room').map((g) => g.id)).not.toContain('zidarie');
    expect(specGroupsFor('wall').map((g) => g.id)).toContain('zidarie');
    expect(specGroupsFor('window')).toHaveLength(0);
  });

  it('labels come from the library, never a raw id', () => {
    expect(specOptionLabel('zidarie', 'bca25')).toMatch(/BCA/);
    expect(specOptionLabel('zidarie', 'nope')).toBe('nope');
    expect(specGroup('zidarie')?.label).toBeTruthy();
  });
});

describe('resolveSpecs', () => {
  it('falls back to the group default when nothing is chosen', () => {
    const s = resolveSpecs(node('wall'), undefined);
    expect(s.zidarie).toBe(specGroup('zidarie')!.defaultOption);
  });

  it('the project choice beats the default, the element beats the project', () => {
    expect(resolveSpecs(node('wall'), { zidarie: 'bca25' }).zidarie).toBe('bca25');
    const own = node('wall', { [specPropertyKey('zidarie')]: 'caramida_plina' });
    expect(resolveSpecs(own, { zidarie: 'bca25' }).zidarie).toBe('caramida_plina');
  });

  it('an unknown option is ignored rather than propagated', () => {
    const typo = node('wall', { spec_zidarie: 'porotherm_38' });
    expect(resolveSpecs(typo, undefined).zidarie).toBe('porotherm38');
    expect(resolveSpecs(node('wall'), { zidarie: 'nonsense' }).zidarie).toBe('porotherm38');
  });

  it('only groups that apply to the node type appear', () => {
    const s = resolveSpecs(node('room'), { zidarie: 'bca25', pardoseala: 'gresie' });
    expect(s.pardoseala).toBe('gresie');
    expect(s.zidarie).toBeUndefined();
  });
});

describe('parseSpecSelection', () => {
  it('keeps known groups and options, drops everything else', () => {
    expect(parseSpecSelection({ zidarie: 'bca25', nope: 'x', pardoseala: 'nope' })).toEqual({ zidarie: 'bca25' });
    expect(parseSpecSelection(null)).toEqual({});
    expect(parseSpecSelection('bca25')).toEqual({});
  });
});

describe('suppression', () => {
  it('nothing is suppressed while everything sits on its default', () => {
    expect(suppressedArticles(defaultSpecSelection()).size).toBe(0);
    expect(suppressedArticles(undefined).size).toBe(0);
    expect(hasNonDefaultSpec(defaultSpecSelection())).toBe(false);
  });

  it('a non-default option removes the articles its group owns', () => {
    const s = suppressedArticles({ zidarie: 'bca25' });
    expect(s.has('0001_00201A01_02')).toBe(true);
    expect(hasNonDefaultSpec({ zidarie: 'bca25' })).toBe(true);
    expect(nonDefaultSpecs({ zidarie: 'bca25', pardoseala: 'parchet_laminat' })).toEqual({ zidarie: 'bca25' });
  });

  it('a group with no default articles suppresses nothing — its default option carries its own rules', () => {
    expect(suppressedArticles({ pardoseala: 'gresie' }).size).toBe(0);
  });
});

describe('findMappingRules with specifications', () => {
  const specsFor = (over: Record<string, string> = {}) => ({ ...defaultSpecSelection(), ...over });

  it('default choices give exactly the rules that existed before specifications', () => {
    const rules = findMappingRules('wall', 'W25', 'Brick', 'unset', specsFor());
    const ids = rules.flatMap((r) => r.outputs.map((o) => o.normId));
    expect(ids).toContain('0001_00201A01_02');
    expect(ids).not.toContain('0001_BCA25_02');
  });

  it('choosing an option makes its rules candidates', () => {
    const ids = findMappingRules('wall', 'W25', 'Brick', 'unset', specsFor({ zidarie: 'bca25' }))
      .flatMap((r) => r.outputs.map((o) => o.normId));
    expect(ids).toContain('0001_BCA25_02');
    expect(ids).toContain('0001_00201A01_02');   // scos abia de suppressedArticles, în motor
  });

  it('a rule for another option is never a candidate', () => {
    const ids = findMappingRules('wall', 'W25', 'Brick', 'unset', specsFor({ zidarie: 'bca25' }))
      .flatMap((r) => r.outputs.map((o) => o.normId));
    expect(ids).not.toContain('0001_CARPLIN_02');
  });

  it('a wildcard alternative survives next to exact-type defaults', () => {
    // `wall * #lemn:lamelar` must not be filtered out by the exact `wall TF20`
    // default rules: the specificity contest happens inside each specification.
    const ids = findMappingRules('wall', 'TF20', 'Timber frame', 'unset', specsFor({ lemn: 'lamelar' }))
      .flatMap((r) => r.outputs.map((o) => o.normId));
    expect(ids).toContain('0019_LF11_GL');
    expect(ids).toContain('0019_LF02_OSB');
  });

  it('a specification written without a system still applies inside one', () => {
    // Termoizolația se măsoară pe anvelopă (shell/envelope), nu pe cameră.
    const ids = findMappingRules('shell', 'envelope', '', 'timber_frame', specsFor({ termoizolatie: 'vata15' }))
      .flatMap((r) => r.outputs.map((o) => o.normId));
    expect(ids).toContain('0012_VATA15_02');
  });

  it('the façade groups live on the shell, the interior ones on the room', () => {
    expect(specGroupsFor('shell').map((g) => g.id).sort()).toEqual(['termoizolatie', 'tencuiala_ext', 'vopsitorie'].sort());
    const roomGroups = specGroupsFor('room').map((g) => g.id);
    expect(roomGroups).toContain('tencuiala_int');
    expect(roomGroups).not.toContain('termoizolatie');
  });

  it('passing no specifications at all behaves like the defaults', () => {
    const withDefaults = findMappingRules('wall', 'W25', 'Brick', 'unset', specsFor())
      .flatMap((r) => r.outputs.map((o) => o.normId)).sort();
    const withNone = findMappingRules('wall', 'W25', 'Brick', 'unset')
      .flatMap((r) => r.outputs.map((o) => o.normId)).sort();
    expect(withNone).toEqual(withDefaults);
  });
});
