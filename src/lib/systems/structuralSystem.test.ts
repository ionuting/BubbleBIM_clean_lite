import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import {
  parseStructuralSystem, resolveStructuralSystem, hasSystemOverride, summarizeSystems,
  STRUCTURAL_SYSTEMS, STRUCTURAL_SYSTEM_LABELS, SYSTEM_PROPERTY_KEY,
} from './structuralSystem';

function node(id: string, properties: Record<string, unknown> = {}): BubbleGraphNode {
  return { id, type: 'wall', name: '', x: 0, y: 0, z: 0, properties };
}

describe('parseStructuralSystem', () => {
  it('accepts every value in the vocabulary', () => {
    for (const s of STRUCTURAL_SYSTEMS) expect(parseStructuralSystem(s)).toBe(s);
  });

  it('is case- and whitespace-tolerant on input', () => {
    expect(parseStructuralSystem('  RC_Frame ')).toBe('rc_frame');
  });

  it('rejects anything outside the vocabulary', () => {
    // The whole point: free-form strings across projects make analysis worthless.
    expect(parseStructuralSystem('beton armat')).toBeUndefined();
    expect(parseStructuralSystem('C20/25')).toBeUndefined();
    expect(parseStructuralSystem('')).toBeUndefined();
    expect(parseStructuralSystem(null)).toBeUndefined();
    expect(parseStructuralSystem(42)).toBeUndefined();
    expect(parseStructuralSystem(undefined)).toBeUndefined();
  });

  it('has a label for every system, so the UI can never show a raw key', () => {
    for (const s of STRUCTURAL_SYSTEMS) expect(STRUCTURAL_SYSTEM_LABELS[s]).toBeTruthy();
  });
});

describe('resolveStructuralSystem', () => {
  it('falls back to the project default when the element has no override', () => {
    expect(resolveStructuralSystem(node('n1'), 'confined_masonry')).toBe('confined_masonry');
  });

  it('lets the element override the project', () => {
    const n = node('n1', { [SYSTEM_PROPERTY_KEY]: 'timber_frame' });
    expect(resolveStructuralSystem(n, 'confined_masonry')).toBe('timber_frame');
  });

  it('is unset when neither level chose anything', () => {
    expect(resolveStructuralSystem(node('n1'), undefined)).toBe('unset');
    expect(resolveStructuralSystem(undefined, undefined)).toBe('unset');
  });

  it('IGNORES an unrecognised override rather than propagating it', () => {
    // A typo in a hand-edited file must not silently create a seventh system.
    const n = node('n1', { [SYSTEM_PROPERTY_KEY]: 'zidarie' });
    expect(resolveStructuralSystem(n, 'rc_frame')).toBe('rc_frame');
  });

  it('ignores an unrecognised project default too', () => {
    expect(resolveStructuralSystem(node('n1'), 'nonsense' as never)).toBe('unset');
  });
});

describe('hasSystemOverride', () => {
  it('is true only when the element differs from the project default', () => {
    const timber = node('n1', { [SYSTEM_PROPERTY_KEY]: 'timber_frame' });
    expect(hasSystemOverride(timber, 'confined_masonry')).toBe(true);
    expect(hasSystemOverride(timber, 'timber_frame')).toBe(false); // same value, not an override
    expect(hasSystemOverride(node('n1'), 'confined_masonry')).toBe(false);
  });

  it('does not count an invalid property as an override', () => {
    expect(hasSystemOverride(node('n1', { [SYSTEM_PROPERTY_KEY]: 'xxx' }), 'rc_frame')).toBe(false);
  });
});

describe('summarizeSystems', () => {
  it('counts elements per resolved system across a mixed-system building', () => {
    const nodes = [
      node('a'),                                              // → project default
      node('b'),                                              // → project default
      node('c', { [SYSTEM_PROPERTY_KEY]: 'timber_frame' }),   // → override
    ];
    const summary = summarizeSystems(nodes, 'confined_masonry');
    expect(summary.get('confined_masonry')).toBe(2);
    expect(summary.get('timber_frame')).toBe(1);
  });

  it('reports unset elements so an unconfigured project is visible, not hidden', () => {
    expect(summarizeSystems([node('a'), node('b')], undefined).get('unset')).toBe(2);
  });
});
