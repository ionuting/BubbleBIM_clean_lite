/**
 * An IFC extrusion is a profile in a local frame, and the frame is the part
 * that is easy to get subtly wrong — a panel exported with the wrong RefDir
 * is still a valid file, just glass lying at an angle nobody drew. So the
 * frames are checked as frames: orthonormal, right-handed, and mapping the
 * local profile back onto the world outline it came from.
 */
import { describe, expect, it } from 'vitest';
import { computeDome } from './index';
import { domeMemberPieces, domePanelPieces } from './ifc';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';

const storey: BubbleGraphNode = {
  id: 'st1', type: 'storey', name: 'P', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const R = 4000;
const anchors: BubbleGraphNode[] = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  const x = Math.round(R * Math.cos(a)), y = Math.round(R * Math.sin(a));
  return { id: `ax${i}`, type: 'ax', name: `ax${i}`, x, y, z: 0, parentId: 'st1', properties: { bimX: x, bimY: y } };
});
const dome: BubbleGraphNode = {
  id: 'd1', type: 'dome', name: 'Dom', x: 0, y: 0, z: 0, parentId: 'st1',
  properties: { dome_height_mm: 3000, cell_count: 20, cell_seed: 4, p_w_mm: 60, p_h_mm: 120 },
};
const nodeMap = new Map([storey, ...anchors, dome].map((n) => [n.id, n]));
const edges: BubbleGraphEdge[] = anchors.map((a, i) => ({ id: `e${i}`, from: 'd1', to: a.id }));
const res = computeDome(dome, nodeMap, edges);

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];

function expectFrame(axis: number[], refDir: number[]) {
  expect(Math.hypot(...axis)).toBeCloseTo(1, 6);
  expect(Math.hypot(...refDir)).toBeCloseTo(1, 6);
  expect(dot(axis, refDir)).toBeCloseTo(0, 6);
}

describe('domeMemberPieces', () => {
  const pieces = domeMemberPieces(res.members, res.placed!, 0);

  it('emits one extrusion per rib segment, with the rib profile', () => {
    const segments = res.members.reduce((s, m) => s + (m.points.length - 1), 0);
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.length).toBeLessThanOrEqual(segments);
    for (const p of pieces) expect(p.profile).toHaveLength(res.placed!.length);
  });

  it('every placement is an orthonormal frame', () => {
    for (const p of pieces) expectFrame(p.axis, p.refDirection);
  });

  it('the profile stands ON the shell: local Y is the surface normal, not world up', () => {
    // Y = Axis × RefDir. On a dome flank that must lean outward — a world-up
    // frame would give a Y with no horizontal component to speak of.
    const flank = pieces.reduce((best, p) =>
      Math.hypot(p.location[0], p.location[1]) > Math.hypot(best.location[0], best.location[1]) ? p : best);
    const y = cross(flank.axis, flank.refDirection);
    expect(Math.hypot(y[0], y[1])).toBeGreaterThan(0.15);
    expect(y[2]).toBeGreaterThan(0);          // still points out of the dome, upward
  });

  it('depths are the segment lengths in metres, and sum to the rib length', () => {
    const total = pieces.reduce((s, p) => s + p.depthM, 0);
    expect(total).toBeCloseTo(res.memberLengthMm / 1000, 1);
  });

  it('locations are relative to the storey base', () => {
    const atStorey = domeMemberPieces(res.members, res.placed!, 3000);
    expect(atStorey[0].location[2]).toBeCloseTo(pieces[0].location[2] - 3, 6);
  });
});

describe('domePanelPieces', () => {
  const pieces = domePanelPieces(res.panels, 12, 0);

  it('emits one plate per panel, at the glass thickness', () => {
    expect(pieces).toHaveLength(res.panels.length);
    for (const p of pieces) expect(p.depthM).toBeCloseTo(0.012, 9);
  });

  it('every placement is an orthonormal frame whose axis is the panel normal', () => {
    pieces.forEach((p, i) => {
      expectFrame(p.axis, p.refDirection);
      expect(p.axis[2]).toBeGreaterThan(0);
      expect(p.axis[0]).toBeCloseTo(res.panels[i].normal.x, 9);
    });
  });

  it('the local profile maps back onto the panel\'s world outline', () => {
    const k = 0;
    const piece = pieces[k], panel = res.panels[k];
    const yAxis = cross(piece.axis, piece.refDirection);
    piece.profile.forEach(([u, v], i) => {
      const world = [
        piece.location[0] + piece.refDirection[0] * u + yAxis[0] * v,
        piece.location[1] + piece.refDirection[1] * u + yAxis[1] * v,
        piece.location[2] + piece.refDirection[2] * u + yAxis[2] * v,
      ];
      expect(world[0] * 1000).toBeCloseTo(panel.outline[i].x, 3);
      expect(world[1] * 1000).toBeCloseTo(panel.outline[i].y, 3);
      expect(world[2] * 1000).toBeCloseTo(panel.outline[i].z, 3);
    });
  });

  it('the profile starts at its own origin, so the placement is not doubled', () => {
    for (const p of pieces) {
      expect(p.profile[0][0]).toBeCloseTo(0, 9);
      expect(p.profile[0][1]).toBeCloseTo(0, 9);
    }
  });
});
