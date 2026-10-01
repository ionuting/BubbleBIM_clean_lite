/**
 * A role has to change three things and nothing else: how the sweep is billed,
 * which IFC class it exports as, and whether it warns about being dragged the
 * wrong way. Geometry must not notice it exists.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWEEP_ROLE, SWEEP_ROLES, SWEEP_ROLE_HINTS, SWEEP_ROLE_IFC,
  SWEEP_ROLE_LABELS, SWEEP_ROLE_ORIENTATION,
  ifcTypeForRole, parseSweepRole, roleOrientationDiagnostic, sweepRole,
  type SweepRole,
} from './roles';
import type { BubbleGraphNode } from '@/store';

const node = (props: Record<string, unknown> = {}): BubbleGraphNode => ({
  id: 's1', type: 'sweep', name: 'Sweep1', x: 0, y: 0, z: 0,
  parentId: 'st1', properties: props,
});

describe('the role table', () => {
  it('describes every role it declares — a role with no label is unpickable', () => {
    for (const r of SWEEP_ROLES) {
      expect(SWEEP_ROLE_LABELS[r], r).toBeTruthy();
      expect(SWEEP_ROLE_HINTS[r], r).toBeTruthy();
      expect(SWEEP_ROLE_ORIENTATION[r], r).toBeTruthy();
      expect(SWEEP_ROLE_IFC, r).toHaveProperty(r);
    }
  });

  it('has no duplicates, and the default is one of them', () => {
    expect(new Set(SWEEP_ROLES).size).toBe(SWEEP_ROLES.length);
    expect(SWEEP_ROLES).toContain(DEFAULT_SWEEP_ROLE);
  });

  it('every declared IFC class is an IFC entity name', () => {
    for (const r of SWEEP_ROLES) {
      const t = SWEEP_ROLE_IFC[r];
      if (t !== null) expect(t, r).toMatch(/^IFC[A-Z]+$/);
    }
  });
});

describe('parseSweepRole', () => {
  it('takes a known role, in any case, with stray spaces', () => {
    expect(parseSweepRole('cornice')).toBe('cornice');
    expect(parseSweepRole('  CORNICE ')).toBe('cornice');
  });

  it('refuses anything else rather than inventing a role', () => {
    expect(parseSweepRole('cornisa')).toBeUndefined();
    expect(parseSweepRole('')).toBeUndefined();
    expect(parseSweepRole(42)).toBeUndefined();
    expect(parseSweepRole(undefined)).toBeUndefined();
  });
});

describe('sweepRole', () => {
  it('reads the property', () => {
    expect(sweepRole(node({ sweep_role: 'plinth' }))).toBe('plinth');
  });

  it('an existing sweep — no property at all — is generic', () => {
    expect(sweepRole(node())).toBe('generic');
    expect(sweepRole(undefined)).toBe('generic');
  });

  it('a role that is no longer known reads as generic, not as itself', () => {
    // A project saved against a future build must not bill under a role this
    // one cannot price.
    expect(sweepRole(node({ sweep_role: 'gargoyle' }))).toBe('generic');
  });
});

describe('ifcTypeForRole', () => {
  it('an undeclared sweep keeps the old direction heuristic exactly', () => {
    expect(ifcTypeForRole('generic', 'vertical')).toBe('IFCCOLUMN');
    expect(ifcTypeForRole('generic', 'horizontal')).toBe('IFCBEAM');
    expect(ifcTypeForRole('generic', 'raked')).toBe('IFCBEAM');
  });

  it('a declared role wins over the direction — a vertical handrail is no column', () => {
    expect(ifcTypeForRole('handrail', 'vertical')).toBe('IFCRAILING');
    expect(ifcTypeForRole('cornice', 'vertical')).toBe('IFCCOVERING');
    expect(ifcTypeForRole('pilaster', 'horizontal')).toBe('IFCCOLUMN');
  });

  it('mouldings export as coverings, which is what IFC4 calls applied work', () => {
    for (const r of ['cornice', 'plinth', 'band', 'coping', 'architrave', 'sill'] as SweepRole[]) {
      expect(ifcTypeForRole(r, 'horizontal'), r).toBe('IFCCOVERING');
    }
  });
});

describe('roleOrientationDiagnostic', () => {
  it('says nothing when the run matches the role', () => {
    expect(roleOrientationDiagnostic('cornice', 'horizontal')).toBeNull();
    expect(roleOrientationDiagnostic('pilaster', 'vertical')).toBeNull();
  });

  it('warns when a horizontal element is sent up a wall', () => {
    const d = roleOrientationDiagnostic('cornice', 'vertical');
    expect(d?.severity).toBe('warning');
    expect(d?.code).toBe('ROLE_ORIENTATION');
    expect(d?.message).toContain('Cornișă');
  });

  it('warns when a vertical element is laid flat', () => {
    expect(roleOrientationDiagnostic('pilaster', 'horizontal')?.code).toBe('ROLE_ORIENTATION');
  });

  it('never blocks: it is a warning, never an error', () => {
    for (const r of SWEEP_ROLES) {
      for (const k of ['vertical', 'horizontal', 'raked'] as const) {
        expect(roleOrientationDiagnostic(r, k)?.severity ?? 'warning', `${r}/${k}`).toBe('warning');
      }
    }
  });

  it('lets a raked run through — a raked cornice and a raked handrail are ordinary', () => {
    expect(roleOrientationDiagnostic('cornice', 'raked')).toBeNull();
    expect(roleOrientationDiagnostic('pilaster', 'raked')).toBeNull();
  });

  it('roles with no affinity never complain', () => {
    for (const r of SWEEP_ROLES.filter((r) => SWEEP_ROLE_ORIENTATION[r] === 'any')) {
      expect(roleOrientationDiagnostic(r, 'vertical'), r).toBeNull();
      expect(roleOrientationDiagnostic(r, 'horizontal'), r).toBeNull();
    }
  });
});
