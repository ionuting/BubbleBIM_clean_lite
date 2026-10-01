/**
 * profileDraft.ts — a profile you draw in the app, in the format the library
 * already speaks.
 *
 * Sweeps take their profiles from three places: parametric builders, the
 * catalogue, and DXF drawings dropped into `backend/library/profiles/symbols2d`.
 * The third is the open door — any shape at all — but it means leaving the app,
 * opening a CAD, drawing, exporting, and coming back.
 *
 * A drafted profile takes that same door. It produces a `BglibSymbol`, the very
 * structure `dxf_parser.py` produces from a DXF, so everything downstream —
 * `profileFromBglib`, the slider stretching, the resolver's cache, the sweep
 * itself — is reached without a single new branch. The editor is a way of
 * WRITING the format, not a second format.
 *
 * ## Sliders
 *
 * A DXF profile becomes resizable by drawing rectangles on `slider_length` /
 * `slider_height` layers: vertices inside one move by the full size change,
 * vertices inside a `0.5` variant move by half. A drafted profile declares the
 * same regions directly. Without them the profile is a fixed shape — which is
 * correct for a moulding, and wrong for a rail you meant to stretch.
 */

import type { BglibSlider, BglibSymbol } from '@/lib/dxfSymbolRenderer';
import { isSimplePolygon, polygonArea, type Pt2 } from '@/lib/geom/plan2d';
import type { SweepDiagnostic } from '@/lib/sweep/types';

/** The layer name each slider kind is written as, matching `dxf_parser.py`. */
const SLIDER_LAYERS: Record<string, string> = {
  'x:1': 'slider_length',
  'x:0.5': 'slider_0.5length',
  'y:1': 'slider_height',
  'y:0.5': 'slider_0.5height',
};

export const SLIDER_FACTORS = [1, 0.5] as const;

export interface ProfileRegion { x0: number; y0: number; x1: number; y1: number }

export interface ProfileSlider {
  /** Which size change this region follows. */
  axis: 'x' | 'y';
  /** How much of it: 1 moves with the full change, 0.5 with half. */
  factor: number;
  /** Rectangle in the profile's own millimetres. */
  region: ProfileRegion;
}

export interface ProfileDraft {
  name: string;
  /** The closed outline, mm. The first point is NOT repeated at the end. */
  outline: Pt2[];
  sliders: ProfileSlider[];
}

export const EMPTY_PROFILE_DRAFT: ProfileDraft = { name: '', outline: [], sliders: [] };

// ─── Geometry ─────────────────────────────────────────────────────────────────

export interface ProfileBounds { minX: number; minY: number; maxX: number; maxY: number }

export function draftBounds(outline: Pt2[]): ProfileBounds {
  if (outline.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

const rectPolygon = (r: ProfileRegion): [number, number][] => {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
  const y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
};

/**
 * What is wrong with the draft, in the sweep's own diagnostic vocabulary — the
 * same codes `computeSweep` would raise later, so the editor can refuse to save
 * something the sweep would refuse to build.
 */
export function validateProfileDraft(draft: ProfileDraft): SweepDiagnostic[] {
  const out: SweepDiagnostic[] = [];
  if (!draft.name.trim()) {
    out.push({ code: 'PROFILE_NO_NAME', severity: 'error', message: 'Profilul are nevoie de un nume.' });
  }
  if (draft.outline.length < 3) {
    out.push({
      code: 'PROFILE_NO_LOOP', severity: 'error',
      message: 'Un profil are nevoie de cel puțin 3 puncte pentru un contur închis.',
    });
    return out;
  }
  if (!isSimplePolygon(draft.outline)) {
    out.push({
      code: 'PROFILE_NOT_SIMPLE', severity: 'error',
      message: 'Conturul se auto-intersectează — o latură taie alta.',
    });
  }
  const area = Math.abs(polygonArea(draft.outline));
  if (area < 1) {
    out.push({ code: 'PROFILE_DEGENERATE', severity: 'error', message: 'Conturul are arie zero.' });
  }
  const b = draftBounds(draft.outline);
  for (const s of draft.sliders) {
    const r = s.region;
    if (Math.abs(r.x1 - r.x0) < 1 || Math.abs(r.y1 - r.y0) < 1) {
      out.push({
        code: 'SLIDER_DEGENERATE', severity: 'warning',
        message: 'O zonă de întindere are lățime sau înălțime zero — nu va muta niciun punct.',
      });
      continue;
    }
    const inside = draft.outline.some((p) =>
      p.x >= Math.min(r.x0, r.x1) && p.x <= Math.max(r.x0, r.x1)
      && p.y >= Math.min(r.y0, r.y1) && p.y <= Math.max(r.y0, r.y1));
    if (!inside) {
      out.push({
        code: 'SLIDER_EMPTY', severity: 'warning',
        message: 'O zonă de întindere nu conține niciun punct al conturului — redimensionarea o va ignora.',
      });
    }
  }
  // A profile with no slider on an axis cannot be resized along it; that is a
  // choice, not a fault, but it is worth saying once.
  if (draft.sliders.length === 0 && b.maxX > b.minX) {
    out.push({
      code: 'PROFILE_FIXED', severity: 'info',
      message: 'Fără zone de întindere profilul rămâne la dimensiunea desenată — corect pentru o profilatură, limitativ pentru un element care trebuie redimensionat.',
    });
  }
  return out;
}

// ─── Conversion ───────────────────────────────────────────────────────────────

/**
 * The draft as a library symbol.
 *
 * The insertion point stays at the origin: a sweep positions its profile with
 * `anchor_x` / `anchor_y` off the bounding box, so baking an origin in here
 * would fight the anchor the user picks later.
 */
export function draftToBglib(draft: ProfileDraft): BglibSymbol {
  const b = draftBounds(draft.outline);
  const sliders: BglibSlider[] = draft.sliders.map((s, i) => ({
    id: SLIDER_LAYERS[`${s.axis}:${s.factor}`] ?? `slider_${i}`,
    axis: s.axis,
    factor: s.factor,
    polygon: rectPolygon(s.region),
  }));

  return {
    name: draft.name.trim(),
    defaultWidth: b.maxX - b.minX,
    defaultHeight: b.maxY - b.minY,
    bounds: b,
    insertionPoint: { x: 0, y: 0 },
    sliders,
    geometry: [{
      type: 'lwpolyline',
      layer: 'profile',
      color: '#FFFFFF',
      lineweight: 0.25,
      closed: true,
      vertices: draft.outline.map((p): [number, number] => [p.x, p.y]),
    }],
    labels: [],
  };
}

/**
 * A library symbol as a draft, so a profile that arrived as a DXF can be opened
 * and corrected here.
 *
 * Only the largest closed loop survives, because that is the only one the sweep
 * reads (`profileFromBglib` warns and drops the rest). A slider whose region is
 * not a rectangle is squared off to its bounding box — the editor draws
 * rectangles, and pretending otherwise would lose the shape silently on save.
 */
export function bglibToDraft(sym: BglibSymbol): ProfileDraft {
  const loops: Pt2[][] = [];
  for (const ent of sym.geometry ?? []) {
    if (ent.type !== 'lwpolyline' || !ent.vertices || ent.vertices.length < 3) continue;
    let pts = ent.vertices.map(([x, y]) => ({ x, y }));
    const first = pts[0], last = pts[pts.length - 1];
    if (pts.length > 3 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) pts = pts.slice(0, -1);
    if (pts.length >= 3) loops.push(pts);
  }
  loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));

  const ip = sym.insertionPoint ?? { x: 0, y: 0 };
  const outline = (loops[0] ?? []).map((p) => ({ x: p.x - ip.x, y: p.y - ip.y }));

  const sliders: ProfileSlider[] = (sym.sliders ?? []).map((s) => {
    const xs = s.polygon.map(([x]) => x - ip.x);
    const ys = s.polygon.map(([, y]) => y - ip.y);
    return {
      axis: s.axis,
      factor: s.factor,
      region: {
        x0: Math.min(...xs), y0: Math.min(...ys),
        x1: Math.max(...xs), y1: Math.max(...ys),
      },
    };
  });

  return { name: sym.name ?? '', outline, sliders };
}

/** The id a drafted profile is referred to by, once saved. */
export const profileFileName = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'profil';
