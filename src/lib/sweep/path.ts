/**
 * path.ts — the guide line, read off the graph.
 *
 * The rule the whole element hangs on: the number of ax/column anchors wired to
 * the sweep decides the line. One anchor is a vertical over the storey band,
 * two are a horizontal segment, three or more a polyline in edge order. Nothing
 * here is a property — connecting nodes IS the gesture, the same one the roof
 * contour and the stair boundary already use.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { getOrderedAnchorNodes, getStoreyBand } from '@/lib/bimGeometry';
import { planPos } from '@/lib/geom/plan2d';
import type { SweepDiagnostic, SweepIntent, SweepPath } from './types';

export function resolveSweepPath(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  intent: SweepIntent,
): { path: SweepPath | null; diagnostics: SweepDiagnostic[] } {
  const diagnostics: SweepDiagnostic[] = [];
  const anchors = getOrderedAnchorNodes(node.id, edges, nodeMap);

  if (anchors.length === 0) {
    diagnostics.push({
      code: 'NO_ANCHORS',
      severity: 'error',
      message: 'Sweep-ul nu e legat de niciun ax — conectează-l la 1 (vertical), 2 (segment) sau mai multe axe (polilinie).',
    });
    return { path: null, diagnostics };
  }

  const parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
  if (!parent || parent.type !== 'storey') {
    diagnostics.push({
      code: 'NO_STOREY',
      severity: 'warning',
      message: 'Sweep-ul nu aparține unui etaj — cotele cad pe banda implicită 0–3000 mm și elementul nu apare în planul de nivel.',
    });
  }
  const band = getStoreyBand(node, nodeMap);

  if (anchors.length === 1) {
    const p = planPos(anchors[0], nodeMap);
    const z0 = band.bot + intent.offsetZMm;
    const z1 = intent.heightMm > 0 ? z0 + intent.heightMm : band.top;
    if (z1 - z0 < 1) {
      diagnostics.push({
        code: 'ZERO_LENGTH',
        severity: 'error',
        message: `Linia verticală are înălțime ${Math.round(z1 - z0)} mm — verifică height_mm și cotele etajului.`,
      });
      return { path: null, diagnostics };
    }
    return {
      path: {
        points: [{ x: p.x, y: p.y, z: z0 }, { x: p.x, y: p.y, z: z1 }],
        closed: false,
        kind: 'vertical',
      },
      diagnostics,
    };
  }

  const z = (intent.level === 'bottom' ? band.bot : band.top) + intent.offsetZMm;
  const raw = anchors.map((a) => {
    const p = planPos(a, nodeMap);
    return { x: p.x, y: p.y, z };
  });

  // Consecutive coincident points would produce NaN tangents downstream.
  const pts: typeof raw = [];
  for (const p of raw) {
    const prev = pts[pts.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 1) {
      diagnostics.push({
        code: 'DUPLICATE_POINT',
        severity: 'warning',
        message: 'Două axe consecutive au aceeași poziție în plan — punctul dublat a fost ignorat.',
      });
      continue;
    }
    pts.push(p);
  }

  let closed = intent.closed;
  if (closed && pts.length >= 3
    && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1) {
    pts.pop(); // the author wired the first ax again — the loop closes itself
  }
  if (closed && pts.length < 3) {
    closed = false;
    diagnostics.push({
      code: 'CLOSED_NEEDS_3',
      severity: 'warning',
      message: 'Un traseu închis are nevoie de cel puțin 3 puncte distincte — sweep-ul rămâne deschis.',
    });
  }

  if (pts.length < 2) {
    diagnostics.push({
      code: 'ZERO_LENGTH',
      severity: 'error',
      message: 'Traseul nu are lungime — axele legate coincid în plan.',
    });
    return { path: null, diagnostics };
  }

  let len = 0;
  const segCount = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const A = pts[i], B = pts[(i + 1) % pts.length];
    len += Math.hypot(B.x - A.x, B.y - A.y);
  }
  if (len < 1) {
    diagnostics.push({
      code: 'ZERO_LENGTH',
      severity: 'error',
      message: 'Traseul nu are lungime — axele legate coincid în plan.',
    });
    return { path: null, diagnostics };
  }

  return { path: { points: pts, closed, kind: 'horizontal' }, diagnostics };
}
