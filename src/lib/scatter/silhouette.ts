/**
 * silhouette.ts — what each planting kind looks like from the side.
 *
 * A section or a facade used to draw a tree as two prisms — a disc extruded
 * for the canopy, a hexagon for the trunk — and a prism seen from the side
 * is a box: the tree came out as a green square on a stick, and a rock as a
 * crate. The 3D viewers, meanwhile, build a sphere and a jittered
 * icosahedron (`mesh.ts`), so the drawing contradicted the model.
 *
 * These are the side-view outlines of exactly those bodies, in pure
 * numbers: an ellipse where the mesh is a scaled sphere, a trapezoid where
 * it is a tapered cylinder, a blob with the same seed where it is a
 * jittered stone. Same proportions as `mesh.ts`, so the elevation shows the
 * silhouette of what the viewer shows — nothing botanical, and nothing
 * that could drift from the mesh without the numbers here drifting too.
 *
 * Coordinates are relative to the instance's base point: `du` across the
 * drawing (mm, centred on the trunk), `dv` up from the ground (mm).
 */
import { scatterRng } from './place';
import type { ScatterInstance } from './types';

export type SilhouetteBucket = 'foliage' | 'wood' | 'stone';

export interface SilhouettePart {
  /** Which material the part resolves as: canopy, trunk, or stone. */
  bucket: SilhouetteBucket;
  /** Closed outline, counter-clockwise. */
  pts: { du: number; dv: number }[];
}

/** Points on an ellipse — enough of them to read as a curve at any scale. */
const ELLIPSE_STEPS = 20;

function ellipse(cx: number, cy: number, a: number, b: number, n = ELLIPSE_STEPS): { du: number; dv: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { du: cx + Math.cos(t) * a, dv: cy + Math.sin(t) * b };
  });
}

/**
 * A stone's outline: a ring of radii wobbled by the same seed `mesh.ts`
 * jitters its vertices with, then squashed to the instance's height.
 */
function stone(d: number, h: number, seed: number): { du: number; dv: number }[] {
  const rnd = scatterRng(seed);
  const r = d / 2;
  const n = 9;
  const out: { du: number; dv: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = r * (0.75 + rnd() * 0.5);          // the mesh's ±25 % jitter
    out.push({ du: Math.cos(t) * rr, dv: h * 0.4 + Math.sin(t) * rr * (h / d) });
  }
  return out;
}

export function scatterSilhouette(inst: ScatterInstance): SilhouettePart[] {
  const d = inst.sizeMm, h = inst.heightMm;
  switch (inst.kind) {
    case 'tree': {
      // A tapered trunk for the bottom 35 %, a canopy ellipse above it.
      const trunkH = h * 0.35;
      const rTop = d * 0.04, rBot = d * 0.055;
      const canopyH = h - trunkH;
      return [
        { bucket: 'wood', pts: [
          { du: -rBot, dv: 0 }, { du: rBot, dv: 0 }, { du: rTop, dv: trunkH }, { du: -rTop, dv: trunkH },
        ] },
        { bucket: 'foliage', pts: ellipse(0, trunkH + canopyH / 2, d / 2, canopyH / 2) },
      ];
    }
    case 'shrub':
    case 'hedge':
      return [{ bucket: 'foliage', pts: ellipse(0, h / 2, d / 2, h / 2, 16) }];
    case 'rock':
    case 'boulder':
      return [{ bucket: 'stone', pts: stone(d, h, Math.round(inst.variant * 1e6) + 1) }];
    case 'grass': {
      // Three blades, as three thin cones side by side.
      const out: SilhouettePart[] = [];
      for (let i = 0; i < 3; i++) {
        const cx = Math.cos(i * 2.1) * d * 0.2;
        const w = d * 0.15;
        out.push({ bucket: 'foliage', pts: [{ du: cx - w, dv: 0 }, { du: cx + w, dv: 0 }, { du: cx, dv: h }] });
      }
      return out;
    }
  }
}
