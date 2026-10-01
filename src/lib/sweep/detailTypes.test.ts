/**
 * A detail type has to survive the trip it is built for: pick one, merge its
 * patch into a node, and the sweep engine must produce the geometry the type
 * describes — with no leftovers from whatever the node was before.
 */
import { describe, expect, it } from 'vitest';
import {
  DETAIL_TYPES, DETAIL_TYPE_MAP, detailTypeOf, detailTypeProperties, detailTypesForRole,
} from './detailTypes';
import { SWEEP_ROLES, sweepRole } from './roles';
import { parseSweepIntent } from './types';
import { computeSweep } from './index';
import { PARAMETRIC_PROFILES } from './profiles';
import type { BubbleGraphNode } from '@/store';

const node = (props: Record<string, unknown> = {}): BubbleGraphNode => ({
  id: 'sw', type: 'sweep', name: 'Sweep', x: 0, y: 0, z: 0,
  parentId: 'st', properties: props,
});

/** A storey with two axes, so a patched sweep has somewhere to run. */
function scene(props: Record<string, unknown>) {
  const st: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  };
  const a: BubbleGraphNode = {
    id: 'a', type: 'ax', name: 'a', x: 0, y: 0, z: 0, parentId: 'st',
    properties: { bimX: 0, bimY: 0 },
  };
  const b: BubbleGraphNode = {
    id: 'b', type: 'ax', name: 'b', x: 4000, y: 0, z: 0, parentId: 'st',
    properties: { bimX: 4000, bimY: 0 },
  };
  const sw = node(props);
  const nodes = [st, a, b, sw];
  return {
    sw,
    nodeMap: new Map(nodes.map((n) => [n.id, n])),
    edges: [{ id: 'e1', from: 'sw', to: 'a' }, { id: 'e2', from: 'sw', to: 'b' }],
  };
}

describe('the catalogue', () => {
  it('has unique ids and a description for each', () => {
    expect(new Set(DETAIL_TYPES.map((d) => d.id)).size).toBe(DETAIL_TYPES.length);
    for (const d of DETAIL_TYPES) {
      expect(d.label, d.id).toBeTruthy();
      expect(d.description, d.id).toBeTruthy();
      expect(d.material, d.id).toBeTruthy();
    }
  });

  it('every type declares a role the role table knows', () => {
    for (const d of DETAIL_TYPES) expect(SWEEP_ROLES, d.id).toContain(d.role);
  });

  it('every type names a profile that exists, with the parameters it needs', () => {
    for (const d of DETAIL_TYPES) {
      const def = PARAMETRIC_PROFILES.find((p) => p.id === d.profileId);
      // Only parametric profiles are asserted: a 'dxf:' id depends on the
      // user's library, which a unit test has no business requiring.
      if (!def) continue;
      for (const p of def.params) {
        expect(d.params, `${d.id} needs ${p.key}`).toHaveProperty(p.key);
      }
    }
  });

  it('indexes by id, and finds the types for a role', () => {
    expect(DETAIL_TYPE_MAP.get('CORN-L250x150')?.role).toBe('cornice');
    expect(detailTypesForRole('cornice').map((d) => d.id)).toEqual(['CORN-L250x150']);
    expect(detailTypesForRole('beam')).toEqual([]);
  });
});

describe('detailTypeProperties', () => {
  it('declares the role along with the shape — the two travel together', () => {
    const patch = detailTypeProperties(DETAIL_TYPE_MAP.get('CORN-L250x150')!);
    expect(patch.sweep_role).toBe('cornice');
    expect(patch.detail_type).toBe('CORN-L250x150');
    expect(sweepRole(node(patch as Record<string, unknown>))).toBe('cornice');
  });

  it('clears the previous profile\'s dimensions instead of leaving them behind', () => {
    // An L has p_t_mm; a rectangle does not. Switching must not keep it.
    const before = { ...detailTypeProperties(DETAIL_TYPE_MAP.get('CORN-L250x150')!) };
    expect(before.p_t_mm).toBe(60);
    const after = { ...before, ...detailTypeProperties(DETAIL_TYPE_MAP.get('BAND-R120x40')!) };
    expect(after.p_t_mm).toBeUndefined();
    expect(after.p_w_mm).toBe(40);
  });

  it('is a patch, not a replacement — the node keeps what the type says nothing about', () => {
    const merged = { ...node({ rise_mm: 250, closed: 'True', custom: 'keep me' }).properties,
      ...detailTypeProperties(DETAIL_TYPE_MAP.get('BAND-R120x40')!) };
    expect(merged.rise_mm).toBe(250);
    expect(merged.closed).toBe('True');
    expect(merged.custom).toBe('keep me');
  });
});

describe('the whole way through — pick a type, get the geometry', () => {
  it('every built-in type builds a solid on a plain two-axis run', () => {
    for (const d of DETAIL_TYPES) {
      const { sw, nodeMap, edges } = scene(detailTypeProperties(d) as Record<string, unknown>);
      const res = computeSweep(sw, nodeMap, edges);
      const errors = res.diagnostics.filter((x) => x.severity === 'error');
      expect(errors.map((e) => e.code), d.id).toEqual([]);
      expect(res.solids.length, d.id).toBeGreaterThan(0);
      expect(res.areaMm2, d.id).toBeGreaterThan(0);
      expect(res.volumeMm3, d.id).toBeGreaterThan(0);
    }
  });

  it('a vertical role laid along a horizontal run warns, but still builds', () => {
    const { sw, nodeMap, edges } = scene(
      detailTypeProperties(DETAIL_TYPE_MAP.get('PIL-R400x60')!) as Record<string, unknown>,
    );
    const res = computeSweep(sw, nodeMap, edges);
    expect(res.diagnostics.map((d) => d.code)).toContain('ROLE_ORIENTATION');
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(res.solids.length).toBeGreaterThan(0);
  });

  it('the patch reaches the intent the engine reads', () => {
    const d = DETAIL_TYPE_MAP.get('GUTTER-U150')!;
    const intent = parseSweepIntent(node(detailTypeProperties(d) as Record<string, unknown>));
    expect(intent.profileId).toBe('u');
    expect(intent.params.p_w_mm).toBe(150);
    expect(intent.anchorX).toBe(d.anchorX);
    expect(intent.level).toBe(d.level);
    expect(intent.material).toBe('Tablă');
  });
});

describe('detailTypeOf', () => {
  it('reads the declared type back', () => {
    expect(detailTypeOf(node({ detail_type: 'SILL-R250x40' }))?.role).toBe('sill');
  });

  it('a type this build no longer knows reads as none, not as a guess', () => {
    expect(detailTypeOf(node({ detail_type: 'CORN-BAROC-1890' }))).toBeNull();
    expect(detailTypeOf(node())).toBeNull();
    expect(detailTypeOf(undefined)).toBeNull();
  });
});
