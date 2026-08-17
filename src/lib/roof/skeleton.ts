/**
 * Roof skeleton + envelope faces for gable / shed (Phase 1).
 * Hip/mansard return diagnostics and a flat fallback envelope.
 */
import type {
  Pt2,
  Pt3,
  RidgeDirection,
  RoofFace3D,
  RoofType,
  SkeletonSeg,
  RoofDiagnostic,
  RoofContour,
} from './types';
import { solveRoofSkeleton } from './straightSkeleton';

function bbox(pts: Pt2[]): { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function resolveRidgeAxis(
  pts: Pt2[],
  ridgeDirection: RidgeDirection,
): 'x' | 'y' {
  if (ridgeDirection === 'x' || ridgeDirection === 'y') return ridgeDirection;
  const b = bbox(pts);
  // Ridge runs along the longer plan dimension
  return b.w >= b.h ? 'x' : 'y';
}

/**
 * Build gable skeleton + two slope faces on a (near-)rectangular contour.
 * Uses bounding box for robust ridge placement; contour verts are projected to eaves.
 */
export function buildGableEnvelope(
  contour: RoofContour,
  pitchDeg: number,
  ridgeDirection: RidgeDirection,
  ridgeOffsetMm: number,
  roofId: string,
  diagnostics: RoofDiagnostic[],
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } {
  const pitch = (pitchDeg * Math.PI) / 180;
  if (pitchDeg <= 1 || pitchDeg >= 75) {
    diagnostics.push({
      code: 'PITCH_INVALID',
      severity: 'error',
      message: `pitch_deg=${pitchDeg} out of range (1–75).`,
    });
    return { skeleton: [], faces: [] };
  }

  const pts = contour.points;
  const b = bbox(pts);
  const axis = resolveRidgeAxis(pts, ridgeDirection);
  const baseZ = contour.baseZ;

  let ridgeA: Pt3;
  let ridgeB: Pt3;
  let halfSpan: number;

  if (axis === 'x') {
    // Ridge parallel to X (East), at mid Y ± offset
    const yR = (b.minY + b.maxY) / 2 + ridgeOffsetMm;
    halfSpan = Math.abs(yR - b.minY);
    const zR = baseZ + halfSpan * Math.tan(pitch);
    ridgeA = { x: b.minX, y: yR, z: zR };
    ridgeB = { x: b.maxX, y: yR, z: zR };
  } else {
    const xR = (b.minX + b.maxX) / 2 + ridgeOffsetMm;
    halfSpan = Math.abs(xR - b.minX);
    const zR = baseZ + halfSpan * Math.tan(pitch);
    ridgeA = { x: xR, y: b.minY, z: zR };
    ridgeB = { x: xR, y: b.maxY, z: zR };
  }

  const skeleton: SkeletonSeg[] = [
    {
      id: `roof_ridge_${roofId}`,
      role: 'ridge',
      a: ridgeA,
      b: ridgeB,
    },
  ];

  // Four eaves corners of bbox at baseZ
  const sw: Pt3 = { x: b.minX, y: b.minY, z: baseZ };
  const se: Pt3 = { x: b.maxX, y: b.minY, z: baseZ };
  const ne: Pt3 = { x: b.maxX, y: b.maxY, z: baseZ };
  const nw: Pt3 = { x: b.minX, y: b.maxY, z: baseZ };

  let faces: RoofFace3D[];
  if (axis === 'x') {
    // South slope: sw-se-ridgeB-ridgeA ; North: nw-ridgeA-ridgeB-ne
    faces = [
      {
        id: `${roofId}_face_s`,
        role: 'slope',
        vertices: [sw, se, { ...ridgeB }, { ...ridgeA }],
      },
      {
        id: `${roofId}_face_n`,
        role: 'slope',
        vertices: [nw, { ...ridgeA }, { ...ridgeB }, ne],
      },
    ];
  } else {
    // West / East slopes
    faces = [
      {
        id: `${roofId}_face_w`,
        role: 'slope',
        vertices: [sw, { ...ridgeA }, { ...ridgeB }, nw],
      },
      {
        id: `${roofId}_face_e`,
        role: 'slope',
        vertices: [se, ne, { ...ridgeB }, { ...ridgeA }],
      },
    ];
  }

  return { skeleton, faces };
}

/** Single-slope shed: high edge opposite low edge along pitch direction. */
export function buildShedEnvelope(
  contour: RoofContour,
  pitchDeg: number,
  ridgeDirection: RidgeDirection,
  roofId: string,
  diagnostics: RoofDiagnostic[],
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } {
  if (pitchDeg <= 1 || pitchDeg >= 75) {
    diagnostics.push({
      code: 'PITCH_INVALID',
      severity: 'error',
      message: `pitch_deg=${pitchDeg} out of range (1–75).`,
    });
    return { skeleton: [], faces: [] };
  }

  const pitch = (pitchDeg * Math.PI) / 180;
  const pts = contour.points;
  const b = bbox(pts);
  const axis = resolveRidgeAxis(pts, ridgeDirection);
  const baseZ = contour.baseZ;

  // High edge = "ridge" side (max of the short axis)
  let highA: Pt3, highB: Pt3, lowA: Pt3, lowB: Pt3, span: number;

  if (axis === 'x') {
    // Pitch along Y: high at maxY
    span = b.h;
    const zH = baseZ + span * Math.tan(pitch);
    lowA = { x: b.minX, y: b.minY, z: baseZ };
    lowB = { x: b.maxX, y: b.minY, z: baseZ };
    highA = { x: b.minX, y: b.maxY, z: zH };
    highB = { x: b.maxX, y: b.maxY, z: zH };
  } else {
    span = b.w;
    const zH = baseZ + span * Math.tan(pitch);
    lowA = { x: b.minX, y: b.minY, z: baseZ };
    lowB = { x: b.minX, y: b.maxY, z: baseZ };
    highA = { x: b.maxX, y: b.minY, z: zH };
    highB = { x: b.maxX, y: b.maxY, z: zH };
  }

  const skeleton: SkeletonSeg[] = [
    { id: `roof_ridge_${roofId}`, role: 'ridge', a: highA, b: highB },
    { id: `roof_eave_${roofId}`, role: 'eave', a: lowA, b: lowB },
  ];

  const faces: RoofFace3D[] = [
    {
      id: `${roofId}_face_shed`,
      role: 'slope',
      vertices: [lowA, lowB, highB, highA],
    },
  ];

  return { skeleton, faces };
}

/**
 * Equal-pitch hip on rectangular bbox: ridge shorter than long side by half-span at each end,
 * four hip lines, two trapezoid + two triangular faces.
 */
export function buildHipEnvelope(
  contour: RoofContour,
  pitchDeg: number,
  ridgeDirection: RidgeDirection,
  ridgeOffsetMm: number,
  roofId: string,
  diagnostics: RoofDiagnostic[],
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } {
  if (pitchDeg <= 1 || pitchDeg >= 75) {
    diagnostics.push({
      code: 'PITCH_INVALID',
      severity: 'error',
      message: `pitch_deg=${pitchDeg} out of range (1–75).`,
    });
    return { skeleton: [], faces: [] };
  }

  const pitch = (pitchDeg * Math.PI) / 180;
  const pts = contour.points;
  const b = bbox(pts);
  const axis = resolveRidgeAxis(pts, ridgeDirection);
  const baseZ = contour.baseZ;

  const sw: Pt3 = { x: b.minX, y: b.minY, z: baseZ };
  const se: Pt3 = { x: b.maxX, y: b.minY, z: baseZ };
  const ne: Pt3 = { x: b.maxX, y: b.maxY, z: baseZ };
  const nw: Pt3 = { x: b.minX, y: b.maxY, z: baseZ };

  let ridgeA: Pt3;
  let ridgeB: Pt3;
  let halfSpan: number;

  if (axis === 'x') {
    halfSpan = b.h / 2;
    if (b.w < halfSpan * 2 + 100) {
      diagnostics.push({
        code: 'HIP_TOO_NARROW',
        severity: 'warning',
        message: 'Plan too short for hip ridge — falling back to gable.',
      });
      return buildGableEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
    }
    const yR = (b.minY + b.maxY) / 2 + ridgeOffsetMm;
    const zR = baseZ + halfSpan * Math.tan(pitch);
    ridgeA = { x: b.minX + halfSpan, y: yR, z: zR };
    ridgeB = { x: b.maxX - halfSpan, y: yR, z: zR };
  } else {
    halfSpan = b.w / 2;
    if (b.h < halfSpan * 2 + 100) {
      diagnostics.push({
        code: 'HIP_TOO_NARROW',
        severity: 'warning',
        message: 'Plan too short for hip ridge — falling back to gable.',
      });
      return buildGableEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
    }
    const xR = (b.minX + b.maxX) / 2 + ridgeOffsetMm;
    const zR = baseZ + halfSpan * Math.tan(pitch);
    ridgeA = { x: xR, y: b.minY + halfSpan, z: zR };
    ridgeB = { x: xR, y: b.maxY - halfSpan, z: zR };
  }

  let skeleton: SkeletonSeg[];
  let faces: RoofFace3D[];

  if (axis === 'x') {
    // Ridge along X: SW/NW → ridgeA (west), SE/NE → ridgeB (east)
    skeleton = [
      { id: `roof_ridge_${roofId}`, role: 'ridge', a: ridgeA, b: ridgeB },
      { id: `roof_hip_${roofId}_sw`, role: 'hip', a: sw, b: ridgeA },
      { id: `roof_hip_${roofId}_nw`, role: 'hip', a: nw, b: ridgeA },
      { id: `roof_hip_${roofId}_se`, role: 'hip', a: se, b: ridgeB },
      { id: `roof_hip_${roofId}_ne`, role: 'hip', a: ne, b: ridgeB },
      { id: `roof_eave_${roofId}_s`, role: 'eave', a: sw, b: se },
      { id: `roof_eave_${roofId}_e`, role: 'eave', a: se, b: ne },
      { id: `roof_eave_${roofId}_n`, role: 'eave', a: ne, b: nw },
      { id: `roof_eave_${roofId}_w`, role: 'eave', a: nw, b: sw },
    ];
    faces = [
      { id: `${roofId}_face_s`, role: 'slope', vertices: [sw, se, { ...ridgeB }, { ...ridgeA }] },
      { id: `${roofId}_face_n`, role: 'slope', vertices: [nw, { ...ridgeA }, { ...ridgeB }, ne] },
      { id: `${roofId}_face_w`, role: 'slope', vertices: [sw, { ...ridgeA }, nw] },
      { id: `${roofId}_face_e`, role: 'slope', vertices: [se, ne, { ...ridgeB }] },
    ];
  } else {
    // Ridge along Y: SW/SE → ridgeA (south), NW/NE → ridgeB (north)
    skeleton = [
      { id: `roof_ridge_${roofId}`, role: 'ridge', a: ridgeA, b: ridgeB },
      { id: `roof_hip_${roofId}_sw`, role: 'hip', a: sw, b: ridgeA },
      { id: `roof_hip_${roofId}_se`, role: 'hip', a: se, b: ridgeA },
      { id: `roof_hip_${roofId}_nw`, role: 'hip', a: nw, b: ridgeB },
      { id: `roof_hip_${roofId}_ne`, role: 'hip', a: ne, b: ridgeB },
      { id: `roof_eave_${roofId}_s`, role: 'eave', a: sw, b: se },
      { id: `roof_eave_${roofId}_e`, role: 'eave', a: se, b: ne },
      { id: `roof_eave_${roofId}_n`, role: 'eave', a: ne, b: nw },
      { id: `roof_eave_${roofId}_w`, role: 'eave', a: nw, b: sw },
    ];
    faces = [
      { id: `${roofId}_face_w`, role: 'slope', vertices: [sw, { ...ridgeA }, { ...ridgeB }, nw] },
      { id: `${roofId}_face_e`, role: 'slope', vertices: [se, ne, { ...ridgeB }, { ...ridgeA }] },
      { id: `${roofId}_face_s`, role: 'slope', vertices: [sw, se, { ...ridgeA }] },
      { id: `${roofId}_face_n`, role: 'slope', vertices: [nw, { ...ridgeB }, ne] },
    ];
  }

  return { skeleton, faces };
}

/**
 * True two-pitch mansard: a STEEP lower skirt from the eaves up to a break line,
 * then a SHALLOW upper hip from the break line to the ridge.
 *
 *   pitchDeg      → lower (steep) slope
 *   upperPitchDeg → upper (shallow) slope
 *   breakInsetMm  → horizontal inset from eave to the break line
 *
 * bbox-based (like the hip), so it stays robust for near-rectangular plans and
 * falls back to a plain hip when the plan is too small to fit the break ring.
 */
export function buildMansardEnvelope(
  contour: RoofContour,
  pitchDeg: number,
  upperPitchDeg: number,
  breakInsetMm: number,
  ridgeDirection: RidgeDirection,
  ridgeOffsetMm: number,
  roofId: string,
  diagnostics: RoofDiagnostic[],
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } {
  if (pitchDeg <= 1 || pitchDeg >= 85 || upperPitchDeg <= 0 || upperPitchDeg >= 75) {
    diagnostics.push({
      code: 'PITCH_INVALID',
      severity: 'error',
      message: `mansard pitches out of range (lower ${pitchDeg}°, upper ${upperPitchDeg}°).`,
    });
    return { skeleton: [], faces: [] };
  }

  const b = bbox(contour.points);
  const ins = Math.max(200, breakInsetMm);
  // Not enough plan to fit a break ring → a mansard degenerates to a hip.
  if (b.w <= ins * 2 + 200 || b.h <= ins * 2 + 200) {
    diagnostics.push({
      code: 'MANSARD_TOO_SMALL',
      severity: 'warning',
      message: 'Plan too small for a mansard break — using hip.',
    });
    return buildHipEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
  }

  const baseZ = contour.baseZ;
  const axis = resolveRidgeAxis(contour.points, ridgeDirection);
  const zBreak = baseZ + ins * Math.tan((pitchDeg * Math.PI) / 180);

  // Eave (outer) corners at baseZ.
  const sw: Pt3 = { x: b.minX, y: b.minY, z: baseZ };
  const se: Pt3 = { x: b.maxX, y: b.minY, z: baseZ };
  const ne: Pt3 = { x: b.maxX, y: b.maxY, z: baseZ };
  const nw: Pt3 = { x: b.minX, y: b.maxY, z: baseZ };
  // Break (inner) corners at zBreak.
  const bsw: Pt3 = { x: b.minX + ins, y: b.minY + ins, z: zBreak };
  const bse: Pt3 = { x: b.maxX - ins, y: b.minY + ins, z: zBreak };
  const bne: Pt3 = { x: b.maxX - ins, y: b.maxY - ins, z: zBreak };
  const bnw: Pt3 = { x: b.minX + ins, y: b.maxY - ins, z: zBreak };

  // Upper hip ridge over the break rectangle at the shallow pitch.
  const upper = (upperPitchDeg * Math.PI) / 180;
  const bw = (b.maxX - ins) - (b.minX + ins);
  const bh = (b.maxY - ins) - (b.minY + ins);
  let ridgeA: Pt3, ridgeB: Pt3;
  if (axis === 'x') {
    const halfU = bh / 2;
    const yR = (b.minY + b.maxY) / 2 + ridgeOffsetMm;
    const zR = zBreak + halfU * Math.tan(upper);
    const rInset = Math.min(halfU, bw / 2);
    ridgeA = { x: b.minX + ins + rInset, y: yR, z: zR };
    ridgeB = { x: b.maxX - ins - rInset, y: yR, z: zR };
  } else {
    const halfU = bw / 2;
    const xR = (b.minX + b.maxX) / 2 + ridgeOffsetMm;
    const zR = zBreak + halfU * Math.tan(upper);
    const rInset = Math.min(halfU, bh / 2);
    ridgeA = { x: xR, y: b.minY + ins + rInset, z: zR };
    ridgeB = { x: xR, y: b.maxY - ins - rInset, z: zR };
  }

  const skeleton: SkeletonSeg[] = [
    { id: `roof_ridge_${roofId}`, role: 'ridge', a: ridgeA, b: ridgeB },
    // Break ring
    { id: `roof_break_${roofId}_s`, role: 'break', a: bsw, b: bse },
    { id: `roof_break_${roofId}_e`, role: 'break', a: bse, b: bne },
    { id: `roof_break_${roofId}_n`, role: 'break', a: bne, b: bnw },
    { id: `roof_break_${roofId}_w`, role: 'break', a: bnw, b: bsw },
    // Eave ring
    { id: `roof_eave_${roofId}_s`, role: 'eave', a: sw, b: se },
    { id: `roof_eave_${roofId}_e`, role: 'eave', a: se, b: ne },
    { id: `roof_eave_${roofId}_n`, role: 'eave', a: ne, b: nw },
    { id: `roof_eave_${roofId}_w`, role: 'eave', a: nw, b: sw },
    // Lower corner folds (eave corner → break corner)
    { id: `roof_hip_${roofId}_l_sw`, role: 'hip', a: sw, b: bsw },
    { id: `roof_hip_${roofId}_l_se`, role: 'hip', a: se, b: bse },
    { id: `roof_hip_${roofId}_l_ne`, role: 'hip', a: ne, b: bne },
    { id: `roof_hip_${roofId}_l_nw`, role: 'hip', a: nw, b: bnw },
  ];

  // Upper hips (break corner → nearest ridge end)
  if (axis === 'x') {
    skeleton.push(
      { id: `roof_hip_${roofId}_u_sw`, role: 'hip', a: bsw, b: ridgeA },
      { id: `roof_hip_${roofId}_u_nw`, role: 'hip', a: bnw, b: ridgeA },
      { id: `roof_hip_${roofId}_u_se`, role: 'hip', a: bse, b: ridgeB },
      { id: `roof_hip_${roofId}_u_ne`, role: 'hip', a: bne, b: ridgeB },
    );
  } else {
    skeleton.push(
      { id: `roof_hip_${roofId}_u_sw`, role: 'hip', a: bsw, b: ridgeA },
      { id: `roof_hip_${roofId}_u_se`, role: 'hip', a: bse, b: ridgeA },
      { id: `roof_hip_${roofId}_u_nw`, role: 'hip', a: bnw, b: ridgeB },
      { id: `roof_hip_${roofId}_u_ne`, role: 'hip', a: bne, b: ridgeB },
    );
  }

  // Lower steep trapezoids (eave edge → break edge)
  const faces: RoofFace3D[] = [
    { id: `${roofId}_low_s`, role: 'slope', vertices: [sw, se, bse, bsw] },
    { id: `${roofId}_low_e`, role: 'slope', vertices: [se, ne, bne, bse] },
    { id: `${roofId}_low_n`, role: 'slope', vertices: [ne, nw, bnw, bne] },
    { id: `${roofId}_low_w`, role: 'slope', vertices: [nw, sw, bsw, bnw] },
  ];

  // Upper shallow hip faces on the break rectangle
  if (axis === 'x') {
    faces.push(
      { id: `${roofId}_up_s`, role: 'slope', vertices: [bsw, bse, { ...ridgeB }, { ...ridgeA }] },
      { id: `${roofId}_up_n`, role: 'slope', vertices: [bnw, { ...ridgeA }, { ...ridgeB }, bne] },
      { id: `${roofId}_up_w`, role: 'slope', vertices: [bsw, { ...ridgeA }, bnw] },
      { id: `${roofId}_up_e`, role: 'slope', vertices: [bse, bne, { ...ridgeB }] },
    );
  } else {
    faces.push(
      { id: `${roofId}_up_w`, role: 'slope', vertices: [bsw, { ...ridgeA }, { ...ridgeB }, bnw] },
      { id: `${roofId}_up_e`, role: 'slope', vertices: [bse, bne, { ...ridgeB }, { ...ridgeA }] },
      { id: `${roofId}_up_s`, role: 'slope', vertices: [bsw, bse, { ...ridgeA }] },
      { id: `${roofId}_up_n`, role: 'slope', vertices: [bnw, { ...ridgeB }, bne] },
    );
  }

  return { skeleton, faces };
}

/** Flat / unsupported types: horizontal slab on contour. */
export function buildFlatEnvelope(
  contour: RoofContour,
  roofId: string,
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } {
  const verts: Pt3[] = contour.points.map((p) => ({ x: p.x, y: p.y, z: contour.baseZ }));
  return {
    skeleton: [],
    faces: [{ id: `${roofId}_face_flat`, role: 'slope', vertices: verts }],
  };
}

// ── Rectilinear decomposition → cross-gable with real valleys ────────────────

export interface Rect { minX: number; minY: number; maxX: number; maxY: number; }

/** True when every polygon edge is axis-aligned (L/T/U footprints). */
export function isRectilinear(pts: Pt2[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (Math.abs(b.x - a.x) > 1 && Math.abs(b.y - a.y) > 1) return false;
  }
  return true;
}

/** True when the polygon is (near) an axis-aligned rectangle — the only shape a
 *  bbox-based gable/hip is valid for. Detected by "fills its bounding box". */
export function isAxisAlignedRect(pts: Pt2[]): boolean {
  if (pts.length !== 4) return false;
  const b = bbox(pts);
  const bboxArea = b.w * b.h;
  if (bboxArea < 1) return false;
  let a2 = 0;
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; a2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  return Math.abs(Math.abs(a2 / 2) / bboxArea - 1) < 0.02;
}

/** CCW-reflex (concave) corners — where valleys originate. */
export function reflexCorners(pts: Pt2[]): Pt2[] {
  const n = pts.length;
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (cross < -1) out.push(p1); // contour is CCW → reflex when the turn is right (negative)
  }
  return out;
}

/**
 * Decompose a rectilinear polygon into non-overlapping rectangles via a vertical
 * scanline, merging horizontally adjacent slabs that share a Y-extent.
 */
export function decomposeToRects(pts: Pt2[]): Rect[] {
  const xs = [...new Set(pts.map((p) => Math.round(p.x)))].sort((a, b) => a - b);
  const hEdges: { x0: number; x1: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (Math.abs(a.y - b.y) < 1 && Math.abs(a.x - b.x) > 1) {
      hEdges.push({ x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y: a.y });
    }
  }
  const slabs: Rect[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i], x1 = xs[i + 1];
    if (x1 - x0 < 1) continue;
    const xm = (x0 + x1) / 2;
    const ys = hEdges.filter((e) => e.x0 < xm && xm < e.x1).map((e) => e.y).sort((a, b) => a - b);
    for (let k = 0; k + 1 < ys.length; k += 2) {
      slabs.push({ minX: x0, minY: ys[k], maxX: x1, maxY: ys[k + 1] });
    }
  }
  const merged: Rect[] = [];
  for (const r of slabs) {
    const prev = merged.find((m) =>
      Math.abs(m.maxX - r.minX) < 1 && Math.abs(m.minY - r.minY) < 1 && Math.abs(m.maxY - r.maxY) < 1);
    if (prev) prev.maxX = r.maxX;
    else merged.push({ ...r });
  }
  return merged;
}

/** One gable over a rectangle: ridge along its longer side + two slope faces. */
function rectGable(r: Rect, pitch: number, baseZ: number, roofId: string, idx: number):
  { ridge: SkeletonSeg; faces: RoofFace3D[]; eaves: SkeletonSeg[] } {
  const w = r.maxX - r.minX, h = r.maxY - r.minY;
  const axisX = w >= h;
  const sw: Pt3 = { x: r.minX, y: r.minY, z: baseZ };
  const se: Pt3 = { x: r.maxX, y: r.minY, z: baseZ };
  const ne: Pt3 = { x: r.maxX, y: r.maxY, z: baseZ };
  const nw: Pt3 = { x: r.minX, y: r.maxY, z: baseZ };
  if (axisX) {
    const yR = (r.minY + r.maxY) / 2;
    const zR = baseZ + (h / 2) * Math.tan(pitch);
    const rA: Pt3 = { x: r.minX, y: yR, z: zR };
    const rB: Pt3 = { x: r.maxX, y: yR, z: zR };
    return {
      ridge: { id: `roof_ridge_${roofId}_${idx}`, role: 'ridge', a: rA, b: rB },
      faces: [
        { id: `${roofId}_${idx}_s`, role: 'slope', vertices: [sw, se, { ...rB }, { ...rA }] },
        { id: `${roofId}_${idx}_n`, role: 'slope', vertices: [nw, { ...rA }, { ...rB }, ne] },
      ],
      eaves: [
        { id: `roof_eave_${roofId}_${idx}_s`, role: 'eave', a: sw, b: se },
        { id: `roof_eave_${roofId}_${idx}_n`, role: 'eave', a: nw, b: ne },
      ],
    };
  }
  const xR = (r.minX + r.maxX) / 2;
  const zR = baseZ + (w / 2) * Math.tan(pitch);
  const rA: Pt3 = { x: xR, y: r.minY, z: zR };
  const rB: Pt3 = { x: xR, y: r.maxY, z: zR };
  return {
    ridge: { id: `roof_ridge_${roofId}_${idx}`, role: 'ridge', a: rA, b: rB },
    faces: [
      { id: `${roofId}_${idx}_w`, role: 'slope', vertices: [sw, { ...rA }, { ...rB }, nw] },
      { id: `${roofId}_${idx}_e`, role: 'slope', vertices: [se, ne, { ...rB }, { ...rA }] },
    ],
    eaves: [
      { id: `roof_eave_${roofId}_${idx}_w`, role: 'eave', a: sw, b: nw },
      { id: `roof_eave_${roofId}_${idx}_e`, role: 'eave', a: se, b: ne },
    ],
  };
}

/**
 * Cross-gable over a rectilinear polygon: one gable per decomposed rectangle,
 * with valley lines emitted from each reflex corner to the intersection of the
 * two perpendicular ridges it sits between. Equal pitch → equal ridge height for
 * equal-span wings, giving clean 45° valleys (the common L/T/U case).
 *
 * Returns null when the plan isn't rectilinear or decomposes to a single rect
 * (caller falls back to the bbox gable/hip).
 */
export function buildCrossGableEnvelope(
  contour: RoofContour,
  pitchDeg: number,
  roofId: string,
  diagnostics: RoofDiagnostic[],
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } | null {
  const pts = contour.points;
  if (!isRectilinear(pts)) return null;
  const rects = decomposeToRects(pts);
  if (rects.length < 2) return null;
  if (pitchDeg <= 1 || pitchDeg >= 75) {
    diagnostics.push({ code: 'PITCH_INVALID', severity: 'error', message: `pitch_deg=${pitchDeg} out of range (1–75).` });
    return { skeleton: [], faces: [] };
  }

  const pitch = (pitchDeg * Math.PI) / 180;
  const baseZ = contour.baseZ;
  const skeleton: SkeletonSeg[] = [];
  const faces: RoofFace3D[] = [];
  const ridges: SkeletonSeg[] = [];

  rects.forEach((r, i) => {
    const g = rectGable(r, pitch, baseZ, roofId, i);
    ridges.push(g.ridge);
    skeleton.push(g.ridge, ...g.eaves);
    faces.push(...g.faces);
  });

  // Valleys: each reflex corner → intersection of the nearest horizontal & vertical
  // ridge, walking the interior angle bisector (robust even when the centroid
  // coincides with the corner, as on a symmetric L).
  const horiz = ridges.filter((r) => Math.abs(r.a.y - r.b.y) < 1); // ridge runs along X
  const vert = ridges.filter((r) => Math.abs(r.a.x - r.b.x) < 1);  // ridge runs along Y
  const unit = (dx: number, dy: number) => {
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };
  const n = pts.length;
  let valleyN = 0;
  let reflexN = 0;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (cross >= -1) continue; // only reflex (concave) corners spawn valleys
    reflexN++;
    // Interior bisector at a reflex corner = −(unit(p0−p1) + unit(p2−p1)).
    const e0 = unit(p0.x - p1.x, p0.y - p1.y);
    const e1 = unit(p2.x - p1.x, p2.y - p1.y);
    const sx = Math.sign(-(e0.x + e1.x)) || 1;
    const sy = Math.sign(-(e0.y + e1.y)) || 1;
    const hR = horiz
      .filter((r) => Math.sign(r.a.y - p1.y) === sy)
      .sort((a, b) => Math.abs(a.a.y - p1.y) - Math.abs(b.a.y - p1.y))[0];
    const vR = vert
      .filter((r) => Math.sign(r.a.x - p1.x) === sx)
      .sort((a, b) => Math.abs(a.a.x - p1.x) - Math.abs(b.a.x - p1.x))[0];
    if (!hR || !vR) continue;
    skeleton.push({
      id: `roof_valley_${roofId}_${valleyN++}`,
      role: 'valley',
      a: { x: p1.x, y: p1.y, z: baseZ },
      b: { x: vR.a.x, y: hR.a.y, z: Math.min(hR.a.z, vR.a.z) },
    });
  }

  diagnostics.push({
    code: 'CROSS_GABLE',
    severity: 'info',
    message: `Cross-gable: ${rects.length} wings, ${valleyN} valley(s) from ${reflexN} reflex corner(s).`,
  });

  return { skeleton, faces };
}

/**
 * Hip roof over an ARBITRARY footprint via the straight skeleton: correct
 * ridges, hips and valleys with faces that tile the plan exactly. Returns null
 * on degenerate input (caller falls back to the bbox hip).
 */
export function buildStraightSkeletonEnvelope(
  contour: RoofContour,
  pitchDeg: number,
  roofId: string,
  diagnostics: RoofDiagnostic[],
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } | null {
  if (pitchDeg <= 1 || pitchDeg >= 75) {
    diagnostics.push({ code: 'PITCH_INVALID', severity: 'error', message: `pitch_deg=${pitchDeg} out of range (1–75).` });
    return { skeleton: [], faces: [] };
  }
  const sol = solveRoofSkeleton(contour.points);
  if (!sol || sol.faces.length === 0) return null;
  const { poly: pts, arcs, faces: faces2d } = sol;

  const tanP = Math.tan((pitchDeg * Math.PI) / 180);
  const baseZ = contour.baseZ;
  const liftZ = (t: number) => baseZ + t * tanP;

  const faces: RoofFace3D[] = faces2d.map((f, i) => ({
    id: `${roofId}_ss_${i}`,
    role: 'slope',
    vertices: f.map((p) => ({ x: p.x, y: p.y, z: liftZ(p.time) })),
  }));

  // Reflex polygon vertices (valley origins) keyed like the face extractor.
  const key = (p: Pt2) => `${Math.round(p.x * 10)}_${Math.round(p.y * 10)}`;
  const n = pts.length;
  const reflex = new Set<string>();
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const c = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (c < -1) reflex.add(key(p1));
  }

  const skeleton: SkeletonSeg[] = [];
  let ri = 0;
  for (const a of arcs) {
    const aGround = a.a.time < 1, bGround = a.b.time < 1;
    let role: SkeletonSeg['role'];
    if (aGround && !bGround) role = reflex.has(key(a.a)) ? 'valley' : 'hip';
    else if (bGround && !aGround) role = reflex.has(key(a.b)) ? 'valley' : 'hip';
    else if (!aGround && !bGround) role = 'ridge';
    else continue;
    skeleton.push({
      id: `roof_${role}_${roofId}_${ri++}`,
      role,
      a: { x: a.a.x, y: a.a.y, z: liftZ(a.a.time) },
      b: { x: a.b.x, y: a.b.y, z: liftZ(a.b.time) },
    });
  }
  // Eave ring (polygon edges) for wall plates + markers.
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    skeleton.push({
      id: `roof_eave_${roofId}_${i}`, role: 'eave',
      a: { x: p.x, y: p.y, z: baseZ }, b: { x: q.x, y: q.y, z: baseZ },
    });
  }

  diagnostics.push({
    code: 'STRAIGHT_SKELETON',
    severity: 'info',
    message: `Straight skeleton: ${faces.length} faces, `
      + `${skeleton.filter((s) => s.role === 'valley').length} valley(s), `
      + `${skeleton.filter((s) => s.role === 'hip').length} hip(s).`,
  });
  return { skeleton, faces };
}

export function buildRoofEnvelope(
  contour: RoofContour,
  roofType: RoofType,
  pitchDeg: number,
  ridgeDirection: RidgeDirection,
  ridgeOffsetMm: number,
  roofId: string,
  diagnostics: RoofDiagnostic[],
  upperPitchDeg = 15,
  mansardBreakInsetMm = 1500,
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } {
  // Concave gable (L/T/U/…): the straight skeleton is the robust choice — it
  // tiles the plan exactly with real hips and valleys and no self-intersection.
  // The old rectangle-decomposition cross-gable (independent per-wing gables,
  // mismatched ridge heights on unequal arms) is kept only as a fallback.
  if (roofType === 'gable' && reflexCorners(contour.points).length > 0) {
    const ss = buildStraightSkeletonEnvelope(contour, pitchDeg, roofId, diagnostics);
    if (ss && ss.faces.length) {
      diagnostics.push({
        code: 'GABLE_TO_SKELETON',
        severity: 'info',
        message: 'Concave gable plan — resolved via straight skeleton (hips + valleys).',
      });
      return ss;
    }
    const cross = buildCrossGableEnvelope(contour, pitchDeg, roofId, diagnostics);
    if (cross && cross.faces.length) return cross;
  }
  switch (roofType) {
    case 'gable':
      // A true two-slope gable is only well-defined on an axis-aligned rectangle
      // (parallel eaves). Any other footprint — a rotated box, a pentagon, a
      // non-rectilinear concave shape — must use the straight skeleton, else the
      // bbox gable grossly overshoots the real plan.
      if (!isAxisAlignedRect(contour.points)) {
        const ss = buildStraightSkeletonEnvelope(contour, pitchDeg, roofId, diagnostics);
        if (ss && ss.faces.length) {
          diagnostics.push({
            code: 'GABLE_TO_SKELETON',
            severity: 'info',
            message: 'Non-rectangular plan — gable resolved via straight skeleton (hipped).',
          });
          return ss;
        }
      }
      return buildGableEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
    case 'shed':
      return buildShedEnvelope(contour, pitchDeg, ridgeDirection, roofId, diagnostics);
    case 'hip': {
      // Straight skeleton handles any footprint (rectangle → classic hip; L/T/… → valleys).
      const ss = buildStraightSkeletonEnvelope(contour, pitchDeg, roofId, diagnostics);
      if (ss && ss.faces.length) return ss;
      return buildHipEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
    }
    case 'flat':
      return buildFlatEnvelope(contour, roofId);
    case 'mansard':
      return buildMansardEnvelope(
        contour, pitchDeg, upperPitchDeg, mansardBreakInsetMm,
        ridgeDirection, ridgeOffsetMm, roofId, diagnostics,
      );
    default:
      return buildGableEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
  }
}

/** Plan-projected ridge segment for graph canvas (z ignored). */
export function skeletonToPlanSegs(skeleton: SkeletonSeg[]): { id: string; role: string; ax: number; ay: number; bx: number; by: number }[] {
  return skeleton.map((s) => ({
    id: s.id,
    role: s.role,
    ax: s.a.x,
    ay: s.a.y,
    bx: s.b.x,
    by: s.b.y,
  }));
}
