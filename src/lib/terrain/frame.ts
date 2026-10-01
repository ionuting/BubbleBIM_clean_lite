/**
 * frame.ts — the transform between terrain metres and BIM millimetres.
 *
 * Its own module so that things which need only the transform (the pads, the
 * scatter items) do not have to import `site.ts`, which needs THEM. One
 * direction of dependency, no cycle. `site.ts` re-exports all of it, so every
 * existing importer is unaffected.
 */
import type { Pt2 } from '@/lib/geom/plan2d';

export interface SiteFrame {
  /** BIM mm of the terrain origin. */
  originX: number;
  originY: number;
  /** Terrain X measured from BIM X, radians, counter-clockwise. */
  rotRad: number;
  /** BIM elevation, mm, the ground at the anchor is pinned to. */
  datumMm: number;
  /** Terrain height at the anchor, metres — what `datumMm` corresponds to. */
  h0M: number;
}

export function bimToTerrain(f: SiteFrame, xMm: number, yMm: number): { x: number; z: number } {
  const dx = (xMm - f.originX) / 1000, dy = (yMm - f.originY) / 1000;
  const c = Math.cos(f.rotRad), s = Math.sin(f.rotRad);
  return { x: dx * c + dy * s, z: -dx * s + dy * c };
}

export function terrainToBim(f: SiteFrame, xM: number, zM: number): Pt2 {
  const c = Math.cos(f.rotRad), s = Math.sin(f.rotRad);
  return { x: f.originX + (xM * c - zM * s) * 1000, y: f.originY + (xM * s + zM * c) * 1000 };
}

export const terrainZToBim = (f: SiteFrame, hM: number) => f.datumMm + (hM - f.h0M) * 1000;
export const bimZToTerrain = (f: SiteFrame, zMm: number) => f.h0M + (zMm - f.datumMm) / 1000;
