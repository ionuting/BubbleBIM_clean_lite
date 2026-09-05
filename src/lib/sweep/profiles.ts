/**
 * Sweep profiles — every source funnels into one format: a closed simple CCW
 * polygon in mm, in the profile's own plane (x right, y up).
 *
 * Three sources:
 *  - parametric builders (rect, circle, L, T, inverted T, U) driven by p_* props;
 *  - a small catalogue of named standard sizes (timber T{w}x{h}, the beam and
 *    column tables from elementLibrary) that resolve to rectangles/circles;
 *  - QCAD DXF files served by the bglib pipeline (`profileFromBglib`).
 *
 * Placement order is fixed and pinned by tests: mirror → rotate → anchor →
 * lateral offset → ensureCcw. The anchor is read off the bbox AFTER mirror and
 * rotation, so "top-left" means top-left of what you actually see.
 */
import { ensureCcw, isSimplePolygon, polygonArea } from '@/lib/geom/plan2d';
import { invertedTeeProfile } from '@/lib/stair/profile';
import { BEAM_TYPES, COLUMN_TYPES } from '@/lib/elementLibrary';
import { applySlidersToVertices, type BglibSymbol } from '@/lib/dxfSymbolRenderer';
import type { Pt2, SweepDiagnostic, SweepIntent, SweepProfile } from './types';

// ─── Parametric builders ─────────────────────────────────────────────────────

export function rectProfile(wMm: number, hMm: number): Pt2[] | null {
  if (!(wMm > 0) || !(hMm > 0)) return null;
  const hw = wMm / 2, hh = hMm / 2;
  return [
    { x: -hw, y: -hh }, { x: hw, y: -hh },
    { x: hw, y: hh }, { x: -hw, y: hh },
  ];
}

export function circleProfile(dMm: number, segments = 24): Pt2[] | null {
  if (!(dMm > 0)) return null;
  const n = Math.max(8, Math.floor(segments));
  const r = dMm / 2;
  const pts: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

/** L-angle: legs along the left and bottom edges of a w×h bbox, thickness t. */
export function lProfile(wMm: number, hMm: number, tMm: number): Pt2[] | null {
  if (!(wMm > 0) || !(hMm > 0) || !(tMm > 0) || tMm >= wMm || tMm >= hMm) return null;
  return [
    { x: 0, y: 0 }, { x: wMm, y: 0 }, { x: wMm, y: tMm },
    { x: tMm, y: tMm }, { x: tMm, y: hMm }, { x: 0, y: hMm },
  ];
}

/** T-section: flange across the top of a w×h bbox, web hanging beneath. */
export function tProfile(wMm: number, hMm: number, twMm: number, tfMm: number): Pt2[] | null {
  if (!(wMm > 0) || !(hMm > 0) || !(twMm > 0) || !(tfMm > 0)) return null;
  if (twMm >= wMm - 1e-6) return rectProfile(wMm, hMm);
  if (tfMm >= hMm - 1e-6) return rectProfile(wMm, hMm);
  const hw = wMm / 2, ht = twMm / 2;
  return [
    { x: -ht, y: 0 }, { x: ht, y: 0 },
    { x: ht, y: hMm - tfMm }, { x: hw, y: hMm - tfMm },
    { x: hw, y: hMm }, { x: -hw, y: hMm },
    { x: -hw, y: hMm - tfMm }, { x: -ht, y: hMm - tfMm },
  ];
}

/** U-channel: open at the top, walls and floor of thickness t inside a w×h bbox. */
export function uProfile(wMm: number, hMm: number, tMm: number): Pt2[] | null {
  if (!(wMm > 0) || !(hMm > 0) || !(tMm > 0) || 2 * tMm >= wMm || tMm >= hMm) return null;
  const hw = wMm / 2;
  return [
    { x: -hw, y: 0 }, { x: hw, y: 0 }, { x: hw, y: hMm },
    { x: hw - tMm, y: hMm }, { x: hw - tMm, y: tMm },
    { x: -hw + tMm, y: tMm }, { x: -hw + tMm, y: hMm }, { x: -hw, y: hMm },
  ];
}

export interface ProfileParamDescriptor {
  key: string;
  label: string;
  defaultMm: number;
}

export interface ParametricProfileDef {
  id: string;
  label: string;
  params: ProfileParamDescriptor[];
  build: (p: Record<string, number>) => Pt2[] | null;
}

const P = (key: string, label: string, defaultMm: number): ProfileParamDescriptor =>
  ({ key, label, defaultMm });

const get = (p: Record<string, number>, key: string, d: number): number =>
  Number.isFinite(p[key]) ? p[key] : d;

export const PARAMETRIC_PROFILES: ParametricProfileDef[] = [
  {
    id: 'rect', label: 'Dreptunghi',
    params: [P('p_w_mm', 'Lățime', 300), P('p_h_mm', 'Înălțime', 600)],
    build: (p) => rectProfile(get(p, 'p_w_mm', 300), get(p, 'p_h_mm', 600)),
  },
  {
    id: 'circle', label: 'Cerc',
    params: [P('p_d_mm', 'Diametru', 100)],
    build: (p) => circleProfile(get(p, 'p_d_mm', 100), get(p, 'p_segments', 24)),
  },
  {
    id: 'l', label: 'Cornier L',
    params: [P('p_w_mm', 'Lățime', 100), P('p_h_mm', 'Înălțime', 100), P('p_t_mm', 'Grosime', 12)],
    build: (p) => lProfile(get(p, 'p_w_mm', 100), get(p, 'p_h_mm', 100), get(p, 'p_t_mm', 12)),
  },
  {
    id: 't', label: 'Secțiune T',
    params: [
      P('p_w_mm', 'Lățime talpă', 300), P('p_h_mm', 'Înălțime', 400),
      P('p_tw_mm', 'Grosime inimă', 120), P('p_tf_mm', 'Grosime talpă', 120),
    ],
    build: (p) => tProfile(
      get(p, 'p_w_mm', 300), get(p, 'p_h_mm', 400),
      get(p, 'p_tw_mm', 120), get(p, 'p_tf_mm', 120),
    ),
  },
  {
    id: 'inv_t', label: 'T întors (fundație)',
    params: [
      P('p_w_mm', 'Lățime talpă', 600), P('p_h_mm', 'Adâncime', 400),
      P('p_tw_mm', 'Lățime inimă', 300), P('p_tf_mm', 'Înălțime talpă', 150),
    ],
    build: (p) => invertedTeeProfile(
      get(p, 'p_tw_mm', 300), get(p, 'p_w_mm', 600),
      get(p, 'p_tf_mm', 150), get(p, 'p_h_mm', 400),
    ),
  },
  {
    id: 'u', label: 'Profil U (jgheab)',
    params: [P('p_w_mm', 'Lățime', 150), P('p_h_mm', 'Înălțime', 100), P('p_t_mm', 'Grosime', 10)],
    build: (p) => uProfile(get(p, 'p_w_mm', 150), get(p, 'p_h_mm', 100), get(p, 'p_t_mm', 10)),
  },
];

// ─── Catalogue: named standard sizes → rect/circle ───────────────────────────

export interface CatalogueProfileDef {
  id: string;       // 'cat:B30x60'
  label: string;
  polygon: Pt2[];
}

/** Timber sections offered alongside the concrete tables — T{w}x{h} in cm. */
const TIMBER_SECTIONS: Array<[string, number, number]> = [
  ['T5x10', 50, 100], ['T8x16', 80, 160], ['T10x10', 100, 100],
  ['T10x20', 100, 200], ['T12x24', 120, 240], ['T15x15', 150, 150],
];

function buildCatalogue(): CatalogueProfileDef[] {
  const out: CatalogueProfileDef[] = [];
  for (const [id, w, h] of TIMBER_SECTIONS) {
    const poly = rectProfile(w, h);
    if (poly) out.push({ id: `cat:${id}`, label: `Lemn ${id}`, polygon: poly });
  }
  for (const b of BEAM_TYPES) {
    const poly = rectProfile(b.width_mm, b.height_mm);
    if (poly) out.push({ id: `cat:${b.id}`, label: b.label, polygon: poly });
  }
  for (const c of COLUMN_TYPES) {
    const poly = c.shape === 'circle'
      ? circleProfile(c.width_mm)
      : rectProfile(c.width_mm, c.depth_mm);
    if (poly) out.push({ id: `cat:${c.id}`, label: c.label, polygon: poly });
  }
  return out;
}

export const CATALOGUE_PROFILES: CatalogueProfileDef[] = buildCatalogue();

// ─── DXF (bglib) → profile polygon ───────────────────────────────────────────

const TOL = 0.5; // mm — first≈last means the author closed the loop by hand

/**
 * Extract THE profile polygon from a parsed QCAD symbol.
 *
 * The backend parser keeps polylines as drawn — CW or CCW, sometimes with the
 * closing vertex repeated, arcs as chords (bulges are dropped upstream) — so
 * everything is normalised here: repeated last vertex dropped, first≈last
 * treated as closed, insertionPoint subtracted, CCW enforced. The largest
 * closed loop by |area| is the outer boundary; any other closed loop would be
 * a hole, which phase 1 ignores with a diagnostic rather than silently.
 */
export function profileFromBglib(
  sym: BglibSymbol,
  /**
   * Target size, mm. Only meaningful for a symbol drawn with `slider_*` layers:
   * the vertices inside a slider region move by (actual − default) × factor, so
   * a cornice drawn at 180 mm can be stretched to 240 without redrawing. An
   * axis with no slider is left alone — unlike the 2D symbol renderer, which
   * scales Y uniformly when it finds no Y slider. Scaling a profile that way
   * would silently thicken the mouldings.
   */
  size?: { widthMm?: number; heightMm?: number },
): { polygon: Pt2[] | null; diagnostics: SweepDiagnostic[] } {
  const diagnostics: SweepDiagnostic[] = [];
  const loops: Pt2[][] = [];

  const stretch = (pts: Pt2[]): Pt2[] => {
    if (!sym.sliders?.length || !size) return pts;
    const w = size.widthMm && size.widthMm > 0 ? size.widthMm : sym.defaultWidth;
    const h = size.heightMm && size.heightMm > 0 ? size.heightMm : sym.defaultHeight;
    if (w === sym.defaultWidth && h === sym.defaultHeight) return pts;
    return applySlidersToVertices(
      pts.map((p): [number, number] => [p.x, p.y]),
      sym.sliders, w, h, sym.defaultWidth, sym.defaultHeight,
    ).map(([x, y]) => ({ x, y }));
  };

  for (const ent of sym.geometry) {
    if (ent.type === 'lwpolyline' && ent.vertices && ent.vertices.length >= 3) {
      let pts = ent.vertices.map(([x, y]) => ({ x, y }));
      const first = pts[0], last = pts[pts.length - 1];
      const touching = Math.hypot(first.x - last.x, first.y - last.y) <= TOL;
      if (touching) pts = pts.slice(0, -1);
      if (pts.length >= 3 && (ent.closed || touching)) loops.push(stretch(pts));
    } else if (ent.type === 'circle' && ent.center && ent.radius && ent.radius > 0) {
      const n = 24;
      const pts: Pt2[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push({ x: ent.center[0] + Math.cos(a) * ent.radius, y: ent.center[1] + Math.sin(a) * ent.radius });
      }
      loops.push(pts);
    }
  }

  if (loops.length === 0) {
    diagnostics.push({
      code: 'PROFILE_NO_LOOP',
      severity: 'error',
      message: `"${sym.name}" nu conține nicio polilinie închisă — profilul are nevoie de un contur închis.`,
    });
    return { polygon: null, diagnostics };
  }

  loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  if (loops.length > 1) {
    diagnostics.push({
      code: 'PROFILE_HOLES_IGNORED',
      severity: 'warning',
      message: `"${sym.name}" are ${loops.length} contururi închise — doar cel mai mare e folosit; golurile vin într-o fază viitoare.`,
    });
  }

  const ip = sym.insertionPoint ?? { x: 0, y: 0 };
  const polygon = ensureCcw(loops[0].map((p) => ({ x: p.x - ip.x, y: p.y - ip.y })));

  if (!isSimplePolygon(polygon)) {
    diagnostics.push({
      code: 'PROFILE_NOT_SIMPLE',
      severity: 'error',
      message: `Conturul din "${sym.name}" se auto-intersectează — corectează desenul DXF.`,
    });
    return { polygon: null, diagnostics };
  }
  if (Math.abs(polygonArea(polygon)) < 1) {
    diagnostics.push({
      code: 'PROFILE_DEGENERATE',
      severity: 'error',
      message: `Conturul din "${sym.name}" are arie zero.`,
    });
    return { polygon: null, diagnostics };
  }
  return { polygon, diagnostics };
}

// ─── Placement ───────────────────────────────────────────────────────────────

export function profileBounds(polygon: Pt2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

const pick = (min: number, max: number, a: 'min' | 'mid' | 'max'): number =>
  a === 'min' ? min : a === 'max' ? max : (min + max) / 2;

/**
 * mirror → rotate → anchor → lateral offset, then CCW. Mirror flips winding,
 * rotation does not — ending with ensureCcw is what keeps the mesh outward.
 */
export function applyProfilePlacement(polygon: Pt2[], intent: SweepIntent): Pt2[] {
  let pts = intent.mirror ? polygon.map((p) => ({ x: -p.x, y: p.y })) : polygon.slice();

  if (intent.rotationDeg !== 0) {
    const a = (intent.rotationDeg * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    pts = pts.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
  }

  const b = profileBounds(pts);
  const ax = pick(b.minX, b.maxX, intent.anchorX);
  const ay = pick(b.minY, b.maxY, intent.anchorY);
  pts = pts.map((p) => ({ x: p.x - ax + intent.offsetXMm, y: p.y - ay }));

  return ensureCcw(pts);
}

// ─── Thumbnail ───────────────────────────────────────────────────────────────

/** SVG path string of the polygon fitted into a size×size box, y up. */
export function profileSvgPath(polygon: Pt2[], size = 40): string {
  if (polygon.length < 3) return '';
  const b = profileBounds(polygon);
  const w = Math.max(1e-6, b.maxX - b.minX), h = Math.max(1e-6, b.maxY - b.minY);
  const s = (size * 0.84) / Math.max(w, h);
  const ox = (size - w * s) / 2, oy = (size - h * s) / 2;
  const map = (p: Pt2) =>
    `${(ox + (p.x - b.minX) * s).toFixed(1)} ${(size - oy - (p.y - b.minY) * s).toFixed(1)}`;
  return `M ${map(polygon[0])} ` + polygon.slice(1).map((p) => `L ${map(p)}`).join(' ') + ' Z';
}

/** Resolve just the parametric/catalogue sources — DXF lives in profileLibrary. */
export function resolveBuiltinProfile(id: string, params: Record<string, number>): SweepProfile | null {
  const par = PARAMETRIC_PROFILES.find((d) => d.id === id);
  if (par) {
    const polygon = par.build(params);
    return polygon ? { id, label: par.label, group: 'parametric', polygon: ensureCcw(polygon) } : null;
  }
  const cat = CATALOGUE_PROFILES.find((d) => d.id === id);
  if (cat) return { id, label: cat.label, group: 'catalogue', polygon: cat.polygon };
  return null;
}
