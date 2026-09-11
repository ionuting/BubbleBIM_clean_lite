/**
 * gable.ts — the part of a wall that survives above the roof's cut, described
 * on its own terms.
 *
 * A gable is rarely the same construction as the wall under it: a brick wall
 * often closes its triangle in timber, thinner than the masonry and flush with
 * one face rather than centred on the axis. So the wall carries three optional
 * properties that describe only that triangle:
 *
 * - `gable_material`     — a material key; empty means "same as the wall"
 * - `gable_thickness_mm` — 0 means "same as the wall"
 * - `gable_offset_mm`    — lateral shift from the wall's own axis, along the
 *                          wall normal `n = (uy, −ux)` for the run A→B, so a
 *                          positive value moves it to the right when walking
 *                          from A to B
 *
 * Two flags come out of that, and they are not the same question:
 *
 * - `reshaped` — thickness or offset differ, so the gable needs its own
 *   footprint instead of the wall's joined one.
 * - `distinct` — `reshaped` OR a material is set, so the gable has to be built
 *   as its own body. A gable that differs only in material shares the wall's
 *   footprint but still gets painted, hatched and exported separately.
 *
 * When neither is true every consumer keeps its original single-body path, so
 * a wall nobody configured is built exactly as it was before this file existed.
 *
 * Pure: no scene, no kernel, no React. Read by 3D, section, elevation and IFC
 * so the four cannot disagree about where the gable is or what it is made of.
 */
import type { BubbleGraphNode } from '@/store';
import { getNodeWallThickness } from '@/lib/bimGeometry';
import type { Pt2 } from './types';

/** Below this a difference is rounding, not an intent. */
const EPS_MM = 0.5;

export interface GableSpec {
  /** Thickness of the gable body in mm — the wall's own when not overridden. */
  thicknessMm: number;
  /** Lateral shift from the wall axis in mm, positive along `n = (uy, −ux)`. */
  offsetMm: number;
  /** Material key for the gable; `''` means it inherits the wall's. */
  material: string;
  /** Thickness or offset differ — the gable needs its own footprint. */
  reshaped: boolean;
  /** `reshaped`, or a material was set — the gable is built as its own body. */
  distinct: boolean;
}

const num = (raw: unknown, fallback: number): number => {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** The wall's own thickness in mm, from its `wall_type` code. */
export const wallThicknessMm = (node: BubbleGraphNode): number =>
  getNodeWallThickness(node) * 1000;

/**
 * How the gable of `node` differs from the wall below it.
 *
 * `wallThkMm` lets a caller that already resolved the thickness (the IFC
 * export, which needs it in metres anyway) pass it in rather than re-parse it.
 */
export function gableSpec(node: BubbleGraphNode, wallThkMm = wallThicknessMm(node)): GableSpec {
  const p = node.properties ?? {};

  const rawThk = num(p.gable_thickness_mm, 0);
  const thicknessMm = rawThk > EPS_MM ? rawThk : wallThkMm;
  const offsetMm = num(p.gable_offset_mm, 0);
  const material = String(p.gable_material ?? '').trim();

  const reshaped =
    Math.abs(thicknessMm - wallThkMm) > EPS_MM || Math.abs(offsetMm) > EPS_MM;

  return { thicknessMm, offsetMm, material, reshaped, distinct: reshaped || material !== '' };
}

/** The material the gable is drawn and exported with — its own, else the wall's. */
export const gableMaterial = (node: BubbleGraphNode, spec: GableSpec): string =>
  spec.material || String(node.properties?.material ?? '');

/**
 * The gable's plan footprint in BIM mm: a plain rectangle on the wall's
 * centre-line, `thicknessMm` wide and shifted by `offsetMm`.
 *
 * Deliberately NOT the wall's joined footprint. A gable of a different
 * thickness meets its neighbours differently, and inventing a miter for it
 * would be a guess; a rectangle on the axis is what the property says and what
 * the section, the 3D solid and the IFC solid can all reproduce identically.
 */
export function gableFootprintMm(A: Pt2, B: Pt2, spec: GableSpec): Pt2[] {
  const dx = B.x - A.x, dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [];
  const ux = dx / len, uy = dy / len;
  const nx = uy, ny = -ux;                 // right of A→B
  const half = spec.thicknessMm / 2;
  const cx = spec.offsetMm * nx, cy = spec.offsetMm * ny;
  return [
    { x: A.x + cx + nx * half, y: A.y + cy + ny * half },
    { x: B.x + cx + nx * half, y: B.y + cy + ny * half },
    { x: B.x + cx - nx * half, y: B.y + cy - ny * half },
    { x: A.x + cx - nx * half, y: A.y + cy - ny * half },
  ];
}
