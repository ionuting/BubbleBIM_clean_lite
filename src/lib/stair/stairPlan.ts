/**
 * stairPlan.ts — 2D plan symbol for a solved stair.
 *
 * A stair in plan is not a projection, it is a convention: the plan is cut at
 * about a metre above the floor, so you draw the steps BELOW that cut solid, mark
 * where the cut falls with a break line, and leave the steps above it off (they
 * belong to the storey above). Add the walking line with an arrow showing which
 * way is up, and a small circle at the bottom step where the climb starts.
 *
 * Everything here is plain 2D geometry in BIM mm; the viewer maps it to SVG.
 * Pure — no framework, no store.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { treadsOf } from './layout';
import { computeStairGeometry } from './solver';
import type { Pt2, StairDiagnostic } from './types';

export interface PlanLine { a: Pt2; b: Pt2 }

export interface StairPlan {
  /** Footprint of the whole stairwell. */
  outline: Pt2[];
  /** Landing outlines, drawn as plain slabs. */
  landings: Pt2[][];
  /** Nosing line of each step below the cut — the steps you actually draw. */
  treads: PlanLine[];
  /** Steps above the cut, kept separately so the viewer can omit or ghost them. */
  treadsAboveCut: PlanLine[];
  /** Centre line of the climb, bottom to top. */
  walkingLine: Pt2[];
  /** Last leg of the walking line, for the arrowhead. */
  upArrow: PlanLine | null;
  /** Where the climb begins — drawn as a small circle. */
  start: Pt2 | null;
  /** The two parallel diagonals marking the cut. */
  breakLines: PlanLine[];
  diagnostics: StairDiagnostic[];
}

/** Nosing line across a flight at one step, perpendicular to the run. */
function nosing(centre: Pt2, dir: Pt2, widthMm: number): PlanLine {
  const across = { x: -dir.y, y: dir.x };
  const half = widthMm / 2;
  return {
    a: { x: centre.x + across.x * half, y: centre.y + across.y * half },
    b: { x: centre.x - across.x * half, y: centre.y - across.y * half },
  };
}

/**
 * Build the plan symbol for one stairwell node.
 *
 * `cutAbsElevMm` is the storey's cut plane in absolute mm — the same one the
 * floor-plan viewer uses for walls. Steps at or below it are drawn; the rest
 * belong to the plan above.
 *
 * Returns null when the stair does not solve, so a broken stairwell leaves the
 * rest of the plan alone rather than taking it down.
 */
export function buildStairPlan(
  stairwell: BubbleGraphNode,
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  cutAbsElevMm: number,
): StairPlan | null {
  const { geometry, intent, diagnostics } = computeStairGeometry(stairwell, nodes, edges);
  if (!geometry) return null;

  const treads: PlanLine[] = [];
  const treadsAboveCut: PlanLine[] = [];
  let cutPoint: { centre: Pt2; dir: Pt2 } | null = null;

  for (const f of geometry.flights) {
    for (const t of treadsOf(f)) {
      const line = nosing(t.centre, t.dir, f.widthMm);
      if (t.centre.z <= cutAbsElevMm) {
        treads.push(line);
        // The last step below the cut is where the break line goes.
        cutPoint = { centre: { x: t.centre.x, y: t.centre.y }, dir: t.dir };
      } else {
        treadsAboveCut.push(line);
      }
    }
  }

  // Winder steps carry their own nosing edge — the fan line you step over —
  // so the plan draws the fan (or the whole spiral) with no extra geometry.
  for (const w of geometry.winders) {
    const line = { a: w.nosing.a, b: w.nosing.b };
    if (w.zTopMm <= cutAbsElevMm) {
      treads.push(line);
      const ex = w.nosing.b.x - w.nosing.a.x, ey = w.nosing.b.y - w.nosing.a.y;
      const len = Math.hypot(ex, ey) || 1;
      cutPoint = {
        centre: { x: (w.nosing.a.x + w.nosing.b.x) / 2, y: (w.nosing.a.y + w.nosing.b.y) / 2 },
        // Walking direction is perpendicular to the nosing.
        dir: { x: -ey / len, y: ex / len },
      };
    } else {
      treadsAboveCut.push(line);
    }
  }

  // Break line: two parallel diagonals across the flight at the cut. Drawn at
  // roughly 60° to the run, which is what reads as a break rather than as
  // another step.
  const breakLines: PlanLine[] = [];
  if (cutPoint && treadsAboveCut.length) {
    const { centre, dir } = cutPoint;
    const across = { x: -dir.y, y: dir.x };
    const half = intent.widthMm * 0.62;   // overshoot the flight, as drawn
    const skew = intent.widthMm * 0.36;   // how far the diagonal leans up-run
    const gap = Math.max(60, intent.widthMm * 0.09);
    for (const s of [-gap / 2, gap / 2]) {
      const o = { x: centre.x + dir.x * s, y: centre.y + dir.y * s };
      breakLines.push({
        a: { x: o.x + across.x * half - dir.x * skew, y: o.y + across.y * half - dir.y * skew },
        b: { x: o.x - across.x * half + dir.x * skew, y: o.y - across.y * half + dir.y * skew },
      });
    }
  }

  const walkingLine = geometry.baseline.map((p) => ({ x: p.x, y: p.y }));
  const upArrow = walkingLine.length >= 2
    ? { a: walkingLine[walkingLine.length - 2], b: walkingLine[walkingLine.length - 1] }
    : null;

  return {
    outline: geometry.footprint,
    landings: geometry.landings.map((l) => l.polygon),
    treads,
    treadsAboveCut,
    walkingLine,
    upArrow,
    start: walkingLine[0] ?? null,
    breakLines,
    diagnostics,
  };
}
