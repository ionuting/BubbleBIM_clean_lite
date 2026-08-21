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
import { sanitizePolygon, solveRoofSkeleton } from './straightSkeleton';
import { pointInPolygon2D } from './faceGeometry';

/** Drop consecutive (near-)duplicate vertices of a 3D face outline. */
function dedupe3(verts: Pt3[]): Pt3[] {
  const out: Pt3[] = [];
  for (const v of verts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(v.x - last.x, v.y - last.y, v.z - last.z) < 1) continue;
    out.push(v);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1) out.pop();
    else break;
  }
  return out;
}

/**
 * Vertical gable-end (fronton) face at a ridge end, set back at the exterior
 * wall face — i.e. `ov` (the eave overhang) inside the roof-contour edge. The
 * outline is a pentagon: base at wall-plate level spanning between the two
 * side-wall faces, short vertical edges rising to the roof underside (which
 * sits `ov·slope` above the plate at the wall line), apex at the ridge.
 *
 * Works in an axis frame where the ridge runs along X:
 *   x       — plan position of the fronton plane (wall face of the end wall)
 *   y0/y1   — eave-side roof edges (minY / maxY of the span)
 *   yR/zR   — ridge position and height; slopes may be asymmetric (ridge offset)
 */
function gableEndFace(
  id: string,
  x: number,
  y0: number,
  y1: number,
  yR: number,
  zR: number,
  baseZ: number,
  ov: number,
  swapXY: boolean,
): RoofFace3D | null {
  const s0 = (zR - baseZ) / Math.max(1, yR - y0);
  const s1 = (zR - baseZ) / Math.max(1, y1 - yR);
  const yW0 = y0 + ov;
  const yW1 = y1 - ov;
  if (yW1 - yW0 < 10 || yW0 > yR || yW1 < yR) return null;
  const pts: Pt3[] = [
    { x, y: yW0, z: baseZ },
    { x, y: yW0, z: baseZ + ov * s0 },
    { x, y: yR, z: zR },
    { x, y: yW1, z: baseZ + ov * s1 },
    { x, y: yW1, z: baseZ },
  ];
  const verts = dedupe3(swapXY ? pts.map((p) => ({ x: p.y, y: p.x, z: p.z })) : pts);
  if (verts.length < 3) return null;
  return { id, role: 'gable_end', vertices: verts };
}

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

  // Gable-end frontons at the exterior wall face (inset by the eave overhang).
  const ov = Math.max(0, contour.overhangMm ?? 0);
  if (axis === 'x') {
    const g1 = gableEndFace(`${roofId}_gable_w`, b.minX + ov, b.minY, b.maxY, ridgeA.y, ridgeA.z, baseZ, ov, false);
    const g2 = gableEndFace(`${roofId}_gable_e`, b.maxX - ov, b.minY, b.maxY, ridgeA.y, ridgeA.z, baseZ, ov, false);
    if (b.maxX - b.minX > ov * 2 + 10) {
      if (g1) faces.push(g1);
      if (g2) faces.push(g2);
    }
  } else {
    const g1 = gableEndFace(`${roofId}_gable_s`, b.minY + ov, b.minX, b.maxX, ridgeA.x, ridgeA.z, baseZ, ov, true);
    const g2 = gableEndFace(`${roofId}_gable_n`, b.maxY - ov, b.minX, b.maxX, ridgeA.x, ridgeA.z, baseZ, ov, true);
    if (b.maxY - b.minY > ov * 2 + 10) {
      if (g1) faces.push(g1);
      if (g2) faces.push(g2);
    }
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

interface RectFrame { o: Pt2; u: Pt2; v: Pt2 }

/**
 * Local frame of a (near-)rectangle in ANY orientation: all four corners ≈90°.
 * `u` runs along the first edge, `v` is its CCW-left normal, `o` is pts[0].
 * Returns null when the polygon isn't a 4-corner right-angled quad.
 */
export function rotatedRectFrame(pts: Pt2[]): RectFrame | null {
  if (pts.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const p0 = pts[(i + 3) % 4], p1 = pts[i], p2 = pts[(i + 1) % 4];
    const ax = p1.x - p0.x, ay = p1.y - p0.y;
    const cx = p2.x - p1.x, cy = p2.y - p1.y;
    const la = Math.hypot(ax, ay), lc = Math.hypot(cx, cy);
    if (la < 10 || lc < 10) return null;
    if (Math.abs((ax * cx + ay * cy) / (la * lc)) > 0.02) return null; // ≈1.1° tolerance
  }
  const ex = pts[1].x - pts[0].x, ey = pts[1].y - pts[0].y;
  const L = Math.hypot(ex, ey);
  const u: Pt2 = { x: ex / L, y: ey / L };
  return { o: pts[0], u, v: { x: -u.y, y: u.x } };
}

const toLocal = (p: Pt2, f: RectFrame): Pt2 => ({
  x: (p.x - f.o.x) * f.u.x + (p.y - f.o.y) * f.u.y,
  y: (p.x - f.o.x) * f.v.x + (p.y - f.o.y) * f.v.y,
});
const toWorld3 = (p: Pt3, f: RectFrame): Pt3 => ({
  x: f.o.x + f.u.x * p.x + f.v.x * p.y,
  y: f.o.y + f.u.y * p.x + f.v.y * p.y,
  z: p.z,
});

/**
 * Two-slope gable on a rectangle in ANY orientation: build in the rectangle's
 * local frame, then rotate the result back. Returns null when the contour
 * isn't a right-angled quad.
 */
export function buildRotatedGableEnvelope(
  contour: RoofContour,
  pitchDeg: number,
  ridgeDirection: RidgeDirection,
  ridgeOffsetMm: number,
  roofId: string,
  diagnostics: RoofDiagnostic[],
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } | null {
  const frame = rotatedRectFrame(contour.points);
  if (!frame) return null;
  // Map a forced world ridge direction onto the closer local axis.
  let localDir: RidgeDirection = 'auto';
  if (ridgeDirection === 'x') localDir = Math.abs(frame.u.x) >= Math.abs(frame.v.x) ? 'x' : 'y';
  if (ridgeDirection === 'y') localDir = Math.abs(frame.u.y) >= Math.abs(frame.v.y) ? 'x' : 'y';
  const localContour: RoofContour = {
    ...contour,
    points: contour.points.map((p) => toLocal(p, frame)),
  };
  const { skeleton, faces } = buildGableEnvelope(
    localContour, pitchDeg, localDir, ridgeOffsetMm, roofId, diagnostics,
  );
  return {
    skeleton: skeleton.map((s) => ({ ...s, a: toWorld3(s.a, frame), b: toWorld3(s.b, frame) })),
    faces: faces.map((f) => ({ ...f, vertices: f.vertices.map((p) => toWorld3(p, frame)) })),
  };
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

/**
 * One gable over a rectangle: ridge along its longer side + two slope faces,
 * plus a vertical gable-end (fronton) at each FREE ridge end — a wing end that
 * abuts another wing gets no fronton, it opens into the rest of the roof.
 * `isFree(p)` decides that; `ov` is the eave overhang the fronton sets back by.
 */
function rectGable(
  r: Rect, pitch: number, baseZ: number, roofId: string, idx: number,
  ov = 0, isFree: (p: Pt2) => boolean = () => true,
): { ridge: SkeletonSeg; faces: RoofFace3D[]; eaves: SkeletonSeg[] } {
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
    const faces: RoofFace3D[] = [
      { id: `${roofId}_${idx}_s`, role: 'slope', vertices: [sw, se, { ...rB }, { ...rA }] },
      { id: `${roofId}_${idx}_n`, role: 'slope', vertices: [nw, { ...rA }, { ...rB }, ne] },
    ];
    if (w > ov * 2 + 10) {
      const gW = isFree({ x: r.minX, y: yR })
        && gableEndFace(`${roofId}_${idx}_gable_w`, r.minX + ov, r.minY, r.maxY, yR, zR, baseZ, ov, false);
      const gE = isFree({ x: r.maxX, y: yR })
        && gableEndFace(`${roofId}_${idx}_gable_e`, r.maxX - ov, r.minY, r.maxY, yR, zR, baseZ, ov, false);
      if (gW) faces.push(gW);
      if (gE) faces.push(gE);
    }
    return {
      ridge: { id: `roof_ridge_${roofId}_${idx}`, role: 'ridge', a: rA, b: rB },
      faces,
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
  const faces: RoofFace3D[] = [
    { id: `${roofId}_${idx}_w`, role: 'slope', vertices: [sw, { ...rA }, { ...rB }, nw] },
    { id: `${roofId}_${idx}_e`, role: 'slope', vertices: [se, ne, { ...rB }, { ...rA }] },
  ];
  if (h > ov * 2 + 10) {
    const gS = isFree({ x: xR, y: r.minY })
      && gableEndFace(`${roofId}_${idx}_gable_s`, r.minY + ov, r.minX, r.maxX, xR, zR, baseZ, ov, true);
    const gN = isFree({ x: xR, y: r.maxY })
      && gableEndFace(`${roofId}_${idx}_gable_n`, r.maxY - ov, r.minX, r.maxX, xR, zR, baseZ, ov, true);
    if (gS) faces.push(gS);
    if (gN) faces.push(gN);
  }
  return {
    ridge: { id: `roof_ridge_${roofId}_${idx}`, role: 'ridge', a: rA, b: rB },
    faces,
    eaves: [
      { id: `roof_eave_${roofId}_${idx}_w`, role: 'eave', a: sw, b: nw },
      { id: `roof_eave_${roofId}_${idx}_e`, role: 'eave', a: se, b: ne },
    ],
  };
}

// ── Gabled arms: the correct concave-gable roof ──────────────────────────────

const polyArea2 = (pts: Pt2[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  return a / 2;
};

/** Affine function of plan position: `a·x + b·y + c`. */
interface Affine { a: number; b: number; c: number }
const evalAff = (g: Affine, p: Pt2) => g.a * p.x + g.b * p.y + g.c;
const subAff = (g: Affine, h: Affine): Affine => ({ a: g.a - h.a, b: g.b - h.b, c: g.c - h.c });

/** Sutherland–Hodgman clip of a polygon to the half-plane `g(p) ≥ 0`. */
function clipHalfPlane(poly: Pt2[], g: Affine): Pt2[] {
  const TOL = 1e-6;
  const out: Pt2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i], Q = poly[(i + 1) % poly.length];
    const eP = evalAff(g, P), eQ = evalAff(g, Q);
    if (eP >= -TOL) out.push(P);
    if ((eP > TOL && eQ < -TOL) || (eP < -TOL && eQ > TOL)) {
      const s = eP / (eP - eQ);
      out.push({ x: P.x + (Q.x - P.x) * s, y: P.y + (Q.y - P.y) * s });
    }
  }
  return out;
}

/**
 * Maximal axis-aligned rectangles contained in a rectilinear polygon — the
 * building's "arms". Unlike `decomposeToRects` these OVERLAP at the corners,
 * which is what makes a real L/T/U gable possible: each arm spans its own full
 * length, and the roof is their union rather than a butt-joint tiling.
 */
export function maximalRects(pts: Pt2[]): Rect[] | null {
  const xs = [...new Set(pts.map((p) => Math.round(p.x)))].sort((a, b) => a - b);
  const ys = [...new Set(pts.map((p) => Math.round(p.y)))].sort((a, b) => a - b);
  const nx = xs.length - 1, ny = ys.length - 1;
  if (nx < 1 || ny < 1 || nx * ny > 400) return null;

  const inside: boolean[][] = [];
  for (let i = 0; i < nx; i++) {
    inside.push([]);
    for (let j = 0; j < ny; j++) {
      inside[i].push(pointInPolygon2D({ x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 }, pts));
    }
  }

  const cands: Rect[] = [];
  for (let i0 = 0; i0 < nx; i0++) {
    for (let i1 = i0; i1 < nx; i1++) {
      for (let j0 = 0; j0 < ny; j0++) {
        cell: for (let j1 = j0; j1 < ny; j1++) {
          for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (!inside[i][j]) break cell;
          cands.push({ minX: xs[i0], minY: ys[j0], maxX: xs[i1 + 1], maxY: ys[j1 + 1] });
        }
      }
    }
  }
  const contains = (o: Rect, r: Rect) =>
    o.minX <= r.minX && o.minY <= r.minY && o.maxX >= r.maxX && o.maxY >= r.maxY;
  return cands.filter((r, i) =>
    !cands.some((o, k) => k !== i && contains(o, r) && (!contains(r, o) || k < i)));
}

interface Arm { r: Rect; axis: 'x' | 'y'; half: number; ridgeAt: number }

/** The two slope planes of one gabled arm, as height-above-eave functions. */
function armSideValue(arm: Arm, side: 0 | 1): Affine {
  if (arm.axis === 'x') {
    return side === 0 ? { a: 0, b: 1, c: -arm.r.minY } : { a: 0, b: -1, c: arm.r.maxY };
  }
  return side === 0 ? { a: 1, b: 0, c: -arm.r.minX } : { a: -1, b: 0, c: arm.r.maxX };
}

/**
 * Gable roof over a rectilinear concave plan (L / T / U / plus), as the UNION
 * of one gabled arm per maximal rectangle.
 *
 * Each arm's surface is `baseZ + tan(pitch)·min(distance to its two eaves)` —
 * a tent along its cross-ridge axis. The roof is the pointwise MAX over arms
 * (union of the arm solids), so where two arms cross, the taller one wins and
 * the crease between them is a true valley. That is the classic L-roof: each
 * arm keeps its own ridge and its own gable ends, and they drain into a valley
 * — instead of `buildCrossGableEnvelope`'s butt-jointed wings, which on unequal
 * arms leaves two parallel ridges and a dead-flat gutter between them.
 *
 * Faces are the plan regions where one specific (arm, slope) is the maximum:
 * every such condition is linear, so each region is a half-plane clip of the
 * footprint. Returns null when the plan isn't rectilinear or has no real arms.
 */
export function buildGabledArmsEnvelope(
  contour: RoofContour,
  pitchDeg: number,
  roofId: string,
  diagnostics: RoofDiagnostic[],
): { skeleton: SkeletonSeg[]; faces: RoofFace3D[] } | null {
  const pts = contour.points;
  if (!isRectilinear(pts)) return null;
  const rects = maximalRects(pts);
  // >4 arms would need 2^n·n region clips and is past what a gabled roof means.
  if (!rects || rects.length < 2 || rects.length > 4) return null;
  if (pitchDeg <= 1 || pitchDeg >= 75) {
    diagnostics.push({ code: 'PITCH_INVALID', severity: 'error', message: `pitch_deg=${pitchDeg} out of range (1–75).` });
    return { skeleton: [], faces: [] };
  }

  const tanP = Math.tan((pitchDeg * Math.PI) / 180);
  const baseZ = contour.baseZ;
  const ov = Math.max(0, contour.overhangMm ?? 0);
  const arms: Arm[] = rects.map((r) => {
    const w = r.maxX - r.minX, h = r.maxY - r.minY;
    const axis: 'x' | 'y' = w >= h ? 'x' : 'y';
    return {
      r, axis,
      half: (axis === 'x' ? h : w) / 2,
      ridgeAt: axis === 'x' ? (r.minY + r.maxY) / 2 : (r.minX + r.maxX) / 2,
    };
  });
  // Dominance: the taller ridge (then the longer arm) is the main body; the
  // others are wings that die into it.
  const armLen = (a: Arm) => (a.axis === 'x' ? a.r.maxX - a.r.minX : a.r.maxY - a.r.minY);
  arms.sort((p, q) => (q.half - p.half) || (armLen(q) - armLen(p)));

  // Trim each wing where it does NOT reach past a more dominant arm: it stops
  // at that arm's ridge instead of running on to the far wall and re-emerging
  // there. A wing that overhangs on BOTH sides (a plus/cross plan) crosses
  // untouched — that is a genuine cross-gable, not an artefact.
  const lo = (a: Arm) => (a.axis === 'x' ? a.r.minX : a.r.minY);
  const hi = (a: Arm) => (a.axis === 'x' ? a.r.maxX : a.r.maxY);
  const setLo = (a: Arm, v: number) => { if (a.axis === 'x') a.r.minX = v; else a.r.minY = v; };
  const setHi = (a: Arm, v: number) => { if (a.axis === 'x') a.r.maxX = v; else a.r.maxY = v; };
  for (let i = 1; i < arms.length; i++) {
    for (let j = 0; j < i; j++) {
      const wing = arms[i], main = arms[j];
      if (wing.axis === main.axis) continue;            // parallel — no crossing
      if (main.ridgeAt <= lo(wing) || main.ridgeAt >= hi(wing)) continue;
      const mLo = wing.axis === 'x' ? main.r.minX : main.r.minY;
      const mHi = wing.axis === 'x' ? main.r.maxX : main.r.maxY;
      if (lo(wing) >= mLo - 1) setLo(wing, Math.max(lo(wing), main.ridgeAt));
      if (hi(wing) <= mHi + 1) setHi(wing, Math.min(hi(wing), main.ridgeAt));
    }
  }
  const n = arms.length;

  /** Ridge-axis coordinate — an arm exists only between its two ends. */
  const along = (a: Arm): Affine => (a.axis === 'x' ? { a: 1, b: 0, c: 0 } : { a: 0, b: 1, c: 0 });
  const faces: RoofFace3D[] = [];
  const owner: { arm: number; side: number }[] = [];

  // Per arm: 0/1 = that slope is the arm's surface here, 2/3 = the point lies
  // before/after the arm, so the arm imposes no height at all.
  const STATES = 4;
  const total = STATES ** n;
  for (let code = 0; code < total; code++) {
    const st: number[] = [];
    for (let i = 0, c = code; i < n; i++, c = Math.floor(c / STATES)) st.push(c % STATES);

    let poly: Pt2[] = pts;
    const active: number[] = [];
    for (let i = 0; i < n && poly.length >= 3; i++) {
      const arm = arms[i], u = along(arm);
      if (st[i] >= 2) {
        // Outside the arm's run: before its low end, or after its high end.
        poly = st[i] === 2
          ? clipHalfPlane(poly, { a: -u.a, b: -u.b, c: lo(arm) })
          : clipHalfPlane(poly, { a: u.a, b: u.b, c: -hi(arm) });
        continue;
      }
      poly = clipHalfPlane(poly, { a: u.a, b: u.b, c: -lo(arm) });
      poly = clipHalfPlane(poly, { a: -u.a, b: -u.b, c: hi(arm) });
      const side = st[i] as 0 | 1;
      poly = clipHalfPlane(poly, subAff(armSideValue(arm, (1 - side) as 0 | 1), armSideValue(arm, side)));
      active.push(i);
    }
    if (poly.length < 3 || !active.length) continue;

    for (const w of active) {
      const vw = armSideValue(arms[w], st[w] as 0 | 1);
      let region = poly;
      for (const i of active) {
        if (i === w || region.length < 3) continue;
        region = clipHalfPlane(region, subAff(vw, armSideValue(arms[i], st[i] as 0 | 1)));
      }
      if (region.length < 3) continue;
      const clean = sanitizePolygon(region, 1);
      if (clean.length < 3 || Math.abs(polyArea2(clean)) < 1000) continue; // < 10 cm²
      faces.push({
        id: `${roofId}_arm${w}s${st[w]}_${code}`,
        role: 'slope',
        vertices: clean.map((p) => ({ x: p.x, y: p.y, z: baseZ + evalAff(vw, p) * tanP })),
      });
      owner.push({ arm: w, side: st[w] });
    }
  }
  if (!faces.length) return null;

  // Creases: where two faces meet along a shared line. Same arm, both its
  // slopes → that arm's ridge; two different arms → a valley. A gabled roof has
  // no hips at all, which is the whole point of this builder.
  //
  // Faces meet in T-junctions (one long edge against several short ones), so
  // this matches collinear OVERLAPS rather than identical endpoints, then
  // merges the pieces back into whole ridge/valley lines.
  const overlap = (a: Pt3, b: Pt3, c: Pt3, d: Pt3): [Pt3, Pt3] | null => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1) return null;
    const ux = dx / L, uy = dy / L;
    const off = (p: Pt3) => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
    if (off(c) > 1 || off(d) > 1) return null; // not collinear within 1 mm
    const t = (p: Pt3) => (p.x - a.x) * ux + (p.y - a.y) * uy;
    const t0 = Math.max(0, Math.min(t(c), t(d)));
    const t1 = Math.min(L, Math.max(t(c), t(d)));
    if (t1 - t0 < 1) return null;
    const at = (s: number): Pt3 => ({ x: a.x + ux * s, y: a.y + uy * s, z: a.z + (b.z - a.z) * (s / L) });
    return [at(t0), at(t1)];
  };

  const creases: { role: SkeletonSeg['role']; a: Pt3; b: Pt3 }[] = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const oi = owner[i], oj = owner[j];
      if (oi.arm === oj.arm && oi.side === oj.side) continue; // fragmentation seam
      const role: SkeletonSeg['role'] = oi.arm === oj.arm ? 'ridge' : 'valley';
      const A = faces[i].vertices, B = faces[j].vertices;
      for (let k = 0; k < A.length; k++) {
        for (let m = 0; m < B.length; m++) {
          const seg = overlap(A[k], A[(k + 1) % A.length], B[m], B[(m + 1) % B.length]);
          if (seg) creases.push({ role, a: seg[0], b: seg[1] });
        }
      }
    }
  }

  // Merge collinear, touching pieces of the same role into one line, so a wing
  // reports ONE ridge rather than one per face fragment.
  const merged: { role: SkeletonSeg['role']; a: Pt3; b: Pt3 }[] = [];
  for (const c of creases) {
    const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    const hit = merged.find((m) => {
      if (m.role !== c.role) return false;
      const mdx = m.b.x - m.a.x, mdy = m.b.y - m.a.y;
      const mL = Math.hypot(mdx, mdy) || 1;
      if (Math.abs((mdx / mL) * uy - (mdy / mL) * ux) > 1e-3) return false; // not parallel
      return Math.abs((c.a.x - m.a.x) * (mdy / mL) - (c.a.y - m.a.y) * (mdx / mL)) <= 1; // same line
    });
    if (!hit) { merged.push({ ...c }); continue; }
    const mdx = hit.b.x - hit.a.x, mdy = hit.b.y - hit.a.y;
    const mL = Math.hypot(mdx, mdy) || 1;
    const t = (p: Pt3) => ((p.x - hit.a.x) * mdx + (p.y - hit.a.y) * mdy) / mL;
    const ends = [{ t: 0, p: hit.a }, { t: mL, p: hit.b }, { t: t(c.a), p: c.a }, { t: t(c.b), p: c.b }];
    if (Math.min(t(c.a), t(c.b)) > mL + 1 || Math.max(t(c.a), t(c.b)) < -1) { merged.push({ ...c }); continue; }
    ends.sort((p, q) => p.t - q.t);
    hit.a = ends[0].p;
    hit.b = ends[ends.length - 1].p;
  }

  const skeleton: SkeletonSeg[] = [];
  let ri = 0, vi = 0;
  for (const m of merged) {
    skeleton.push({
      id: m.role === 'ridge' ? `roof_ridge_${roofId}_${ri++}` : `roof_valley_${roofId}_${vi++}`,
      role: m.role, a: m.a, b: m.b,
    });
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    skeleton.push({
      id: `roof_eave_${roofId}_${i}`, role: 'eave',
      a: { x: p.x, y: p.y, z: baseZ }, b: { x: q.x, y: q.y, z: baseZ },
    });
  }

  // Gable ends at every arm end that actually faces outside.
  const free = (p: Pt2, out: Pt2) => !pointInPolygon2D({ x: p.x + out.x * 50, y: p.y + out.y * 50 }, pts);
  arms.forEach((arm, i) => {
    const { r } = arm;
    const zR = baseZ + arm.half * tanP;
    if (arm.axis === 'x') {
      if (r.maxX - r.minX <= ov * 2 + 10) return;
      if (free({ x: r.minX, y: arm.ridgeAt }, { x: -1, y: 0 })) {
        const f = gableEndFace(`${roofId}_arm${i}_gable_w`, r.minX + ov, r.minY, r.maxY, arm.ridgeAt, zR, baseZ, ov, false);
        if (f) faces.push(f);
      }
      if (free({ x: r.maxX, y: arm.ridgeAt }, { x: 1, y: 0 })) {
        const f = gableEndFace(`${roofId}_arm${i}_gable_e`, r.maxX - ov, r.minY, r.maxY, arm.ridgeAt, zR, baseZ, ov, false);
        if (f) faces.push(f);
      }
    } else {
      if (r.maxY - r.minY <= ov * 2 + 10) return;
      if (free({ x: arm.ridgeAt, y: r.minY }, { x: 0, y: -1 })) {
        const f = gableEndFace(`${roofId}_arm${i}_gable_s`, r.minY + ov, r.minX, r.maxX, arm.ridgeAt, zR, baseZ, ov, true);
        if (f) faces.push(f);
      }
      if (free({ x: arm.ridgeAt, y: r.maxY }, { x: 0, y: 1 })) {
        const f = gableEndFace(`${roofId}_arm${i}_gable_n`, r.maxY - ov, r.minX, r.maxX, arm.ridgeAt, zR, baseZ, ov, true);
        if (f) faces.push(f);
      }
    }
  });

  diagnostics.push({
    code: 'GABLED_ARMS',
    severity: 'info',
    message: `Gabled arms: ${n} arm(s), ${faces.filter((f) => f.role === 'slope').length} slopes, `
      + `${ri} ridge(s), ${vi} valley(s), ${faces.filter((f) => f.role === 'gable_end').length} gable end(s).`,
  });
  return { skeleton, faces };
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

  const ov = Math.max(0, contour.overhangMm ?? 0);
  rects.forEach((r, i) => {
    // A ridge end is "free" (gets a fronton) when stepping just past it leaves
    // the roof outline; if it stays inside, the wing opens into another wing.
    const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
    const isFree = (p: Pt2) => {
      const dx = p.x - cx, dy = p.y - cy;
      const L = Math.hypot(dx, dy) || 1;
      return !pointInPolygon2D({ x: p.x + (dx / L) * 50, y: p.y + (dy / L) * 50 }, pts);
    };
    const g = rectGable(r, pitch, baseZ, roofId, i, ov, isFree);
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
  // Concave gable (L/T/U/…): keep real gables per wing (cross-gable) — that is
  // what "gable" was asked for, and each free wing end gets its own fronton.
  // The straight skeleton is the fallback: it tiles any plan exactly, but hips
  // EVERY edge, so it silently turns a two-slope roof into a multi-hip one.
  if (roofType === 'gable' && reflexCorners(contour.points).length > 0) {
    const arms = buildGabledArmsEnvelope(contour, pitchDeg, roofId, diagnostics);
    if (arms && arms.faces.length) return arms;
    const cross = buildCrossGableEnvelope(contour, pitchDeg, roofId, diagnostics);
    if (cross && cross.faces.length) return cross;
    const ss = buildStraightSkeletonEnvelope(contour, pitchDeg, roofId, diagnostics);
    if (ss && ss.faces.length) {
      diagnostics.push({
        code: 'GABLE_TO_SKELETON',
        severity: 'warning',
        message: 'Concave plan not decomposable into gabled wings — hipped via straight '
          + 'skeleton instead (no frontons). Simplify the outline for a true gable.',
      });
      return ss;
    }
  }
  switch (roofType) {
    case 'gable': {
      if (isAxisAlignedRect(contour.points)) {
        return buildGableEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
      }
      // A rectangle at any angle still has parallel eaves — solve the gable in
      // its own frame instead of the (much larger) global bounding box.
      const rot = buildRotatedGableEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
      if (rot && rot.faces.length) {
        diagnostics.push({
          code: 'GABLE_ROTATED',
          severity: 'info',
          message: 'Rotated rectangular plan — gable solved in the plan\'s own axes.',
        });
        return rot;
      }
      // Genuinely non-rectangular (pentagon, curved-ish outline): a two-slope
      // gable isn't defined, and the bbox version would overshoot the plan.
      const ss = buildStraightSkeletonEnvelope(contour, pitchDeg, roofId, diagnostics);
      if (ss && ss.faces.length) {
        diagnostics.push({
          code: 'GABLE_TO_SKELETON',
          severity: 'warning',
          message: 'Non-rectangular plan — gable resolved via straight skeleton (hipped, no frontons).',
        });
        return ss;
      }
      return buildGableEnvelope(contour, pitchDeg, ridgeDirection, ridgeOffsetMm, roofId, diagnostics);
    }
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
