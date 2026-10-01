/**
 * symbols.ts — the generic architectural plan symbol of each kind.
 *
 * Nothing botanical: a tree is the circle-and-cross every site plan draws, a
 * shrub is a scalloped blob, a rock an irregular stone. They exist so a
 * planting plan reads as a planting plan before anyone picks a species.
 * Primitives are in BIM mm; the viewer maps them like any other geometry.
 */
import type { Pt2 } from '@/lib/geom/plan2d';
import { scatterRng } from './place';
import type { ScatterInstance } from './types';

export type SymbolPrim =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'poly'; pts: Pt2[]; closed: boolean };

/** A closed polygon with radius wobble — the stone and the scallop share it. */
function blob(cx: number, cy: number, r: number, n: number, wobble: number, seed: number, rotDeg: number): Pt2[] {
  const rnd = scatterRng(seed);
  const rot = (rotDeg * Math.PI) / 180;
  const pts: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const rr = r * (1 - wobble + rnd() * wobble * 2);
    pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
  }
  return pts;
}

export function scatterSymbol(inst: ScatterInstance): SymbolPrim[] {
  const r = inst.sizeMm / 2;
  const seed = Math.round(inst.variant * 1e6) + 7;
  switch (inst.kind) {
    case 'tree': {
      // Canopy circle, trunk dot, four short branch ticks from the centre.
      const rot = (inst.rotDeg * Math.PI) / 180;
      const prims: SymbolPrim[] = [
        { kind: 'circle', cx: inst.x, cy: inst.y, r },
        { kind: 'circle', cx: inst.x, cy: inst.y, r: Math.max(20, r * 0.06) },
      ];
      for (let i = 0; i < 4; i++) {
        const a = rot + (i * Math.PI) / 2 + Math.PI / 4;
        prims.push({ kind: 'poly', closed: false, pts: [
          { x: inst.x + Math.cos(a) * r * 0.15, y: inst.y + Math.sin(a) * r * 0.15 },
          { x: inst.x + Math.cos(a) * r * 0.8, y: inst.y + Math.sin(a) * r * 0.8 },
        ] });
      }
      return prims;
    }
    case 'shrub':
    case 'hedge':
      return [{ kind: 'poly', closed: true, pts: blob(inst.x, inst.y, r, 10, 0.18, seed, inst.rotDeg) }];
    case 'rock':
    case 'boulder':
      return [{ kind: 'poly', closed: true, pts: blob(inst.x, inst.y, r, 7, 0.3, seed, inst.rotDeg) }];
    case 'grass': {
      // Three blades fanning up from the base point.
      const prims: SymbolPrim[] = [];
      for (let i = -1; i <= 1; i++) {
        const a = Math.PI / 2 + i * 0.5 + ((inst.rotDeg * Math.PI) / 180);
        prims.push({ kind: 'poly', closed: false, pts: [
          { x: inst.x, y: inst.y },
          { x: inst.x + Math.cos(a) * r, y: inst.y + Math.sin(a) * r },
        ] });
      }
      return prims;
    }
  }
}
