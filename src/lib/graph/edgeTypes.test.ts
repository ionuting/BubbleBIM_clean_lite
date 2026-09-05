import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  inferEdgeType, resolveEdgeType, annotateEdgeTypes, relatedBy, HUB_TYPES,
} from './edgeTypes';

function node(id: string, type: string): BubbleGraphNode {
  return { id, type, name: '', x: 0, y: 0, z: 0, properties: {} };
}

const ax1 = node('ax1', 'ax');
const ax2 = node('ax2', 'ax');
const ax3 = node('ax3', 'ax');
const col = node('col1', 'column');
const wall = node('w1', 'wall');
const beam = node('b1', 'beam');
const room = node('r1', 'room');
const roof = node('rf1', 'roof');
const win = node('win1', 'window');
const door = node('d1', 'door');

describe('inferEdgeType', () => {
  it('classifies a linear element between two anchors as spans', () => {
    expect(inferEdgeType(wall, ax1)).toBe('spans');
    expect(inferEdgeType(beam, col)).toBe('spans');
  });

  it('is direction-agnostic — the relation belongs to the pair, not the draw order', () => {
    expect(inferEdgeType(ax1, wall)).toBe('spans');
    expect(inferEdgeType(win, wall)).toBe('hosts');
    expect(inferEdgeType(ax1, room)).toBe('bounds');
  });

  it('classifies a hub fanning out to ax corners as bounds', () => {
    expect(inferEdgeType(room, ax1)).toBe('bounds');
    expect(inferEdgeType(roof, ax1)).toBe('bounds');
    for (const t of HUB_TYPES) {
      expect(inferEdgeType(node('h', t), ax1)).toBe('bounds');
    }
  });

  it('classifies openings carried by a wall as hosts', () => {
    expect(inferEdgeType(wall, win)).toBe('hosts');
    expect(inferEdgeType(wall, door)).toBe('hosts');
  });

  it('prefers hosts over spans when a wall meets an opening', () => {
    // Both rules could look plausible; hosts must win — an opening is not an endpoint.
    expect(inferEdgeType(wall, win)).toBe('hosts');
  });

  it('never guesses supports — that is a structural claim, not a topological one', () => {
    // A column and a beam sharing an edge means "the beam ends here" (spans);
    // whether the column carries it is decided geometrically in buildFemModel.
    expect(inferEdgeType(beam, col)).toBe('spans');
    expect(inferEdgeType(col, beam)).toBe('spans');
  });

  it('returns undefined for pairs it does not recognise, rather than a wrong bucket', () => {
    expect(inferEdgeType(ax1, ax2)).toBeUndefined();
    expect(inferEdgeType(room, wall)).toBeUndefined();
    expect(inferEdgeType(undefined, ax1)).toBeUndefined();
    expect(inferEdgeType(ax1, undefined)).toBeUndefined();
  });
});

describe('resolveEdgeType', () => {
  const nodeMap = new Map([ax1, wall, room].map((n) => [n.id, n]));

  it('uses an explicit type when present', () => {
    const e: BubbleGraphEdge = { id: 'e1', from: 'w1', to: 'ax1', type: 'supports' };
    expect(resolveEdgeType(e, nodeMap)).toBe('supports');
  });

  it('falls back to inference for legacy untyped edges', () => {
    expect(resolveEdgeType({ id: 'e1', from: 'w1', to: 'ax1' }, nodeMap)).toBe('spans');
  });

  it('is undefined when the edge points at a missing node', () => {
    expect(resolveEdgeType({ id: 'e1', from: 'w1', to: 'gone' }, nodeMap)).toBeUndefined();
  });
});

describe('annotateEdgeTypes', () => {
  const nodes = [wall, ax1, ax2, room, win];

  it('backfills types on a legacy edge list', () => {
    const edges: BubbleGraphEdge[] = [
      { id: 'e1', from: 'w1', to: 'ax1' },
      { id: 'e2', from: 'w1', to: 'ax2' },
      { id: 'e3', from: 'r1', to: 'ax1' },
      { id: 'e4', from: 'w1', to: 'win1' },
    ];
    expect(annotateEdgeTypes(edges, nodes).map((e) => e.type))
      .toEqual(['spans', 'spans', 'bounds', 'hosts']);
  });

  it('never overwrites an explicit type', () => {
    const edges: BubbleGraphEdge[] = [{ id: 'e1', from: 'w1', to: 'ax1', type: 'supports' }];
    expect(annotateEdgeTypes(edges, nodes)[0].type).toBe('supports');
  });

  it('preserves grips and every other field', () => {
    const edges: BubbleGraphEdge[] = [{ id: 'e1', from: 'w1', to: 'ax1', fromGrip: 3, toGrip: 5 }];
    const out = annotateEdgeTypes(edges, nodes)[0];
    expect(out).toEqual({ id: 'e1', from: 'w1', to: 'ax1', fromGrip: 3, toGrip: 5, type: 'spans' });
  });

  it('returns the SAME array reference when nothing changed', () => {
    // Callers rely on this to skip a state update — and the auto-save it would
    // trigger — on an already annotated graph.
    const edges: BubbleGraphEdge[] = [{ id: 'e1', from: 'w1', to: 'ax1', type: 'spans' }];
    expect(annotateEdgeTypes(edges, nodes)).toBe(edges);

    const unknowable: BubbleGraphEdge[] = [{ id: 'e1', from: 'ax1', to: 'ax2' }];
    expect(annotateEdgeTypes(unknowable, nodes)).toBe(unknowable);
  });

  it('leaves unrecognised pairs untyped instead of inventing a relation', () => {
    const edges: BubbleGraphEdge[] = [{ id: 'e1', from: 'ax1', to: 'ax2' }];
    expect(annotateEdgeTypes(edges, nodes)[0].type).toBeUndefined();
  });
});

describe('relatedBy', () => {
  const nodes = [wall, ax1, ax2, ax3, room, win];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edges: BubbleGraphEdge[] = [
    { id: 'e1', from: 'w1', to: 'ax1' },
    { id: 'e2', from: 'w1', to: 'ax2' },
    { id: 'e3', from: 'w1', to: 'win1' },
    { id: 'e4', from: 'r1', to: 'ax3' },
  ];

  it('returns only the other end of edges of the requested relation', () => {
    expect(relatedBy('w1', 'spans', edges, nodeMap).map((n) => n.id)).toEqual(['ax1', 'ax2']);
    expect(relatedBy('w1', 'hosts', edges, nodeMap).map((n) => n.id)).toEqual(['win1']);
  });

  it('expresses the query the read sites used to do with node-type filters', () => {
    // Equivalent to: getConnectedNodes('w1',…).filter(c => c.type === 'ax')
    // — but asks about the RELATION, so it will not pick up an ax that happens
    // to be connected for some other reason.
    expect(relatedBy('w1', 'bounds', edges, nodeMap)).toEqual([]);
  });

  it('works from either end of the edge', () => {
    expect(relatedBy('ax1', 'spans', edges, nodeMap).map((n) => n.id)).toEqual(['w1']);
  });
});
