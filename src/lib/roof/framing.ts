/**
 * Roof framing — wall plates, ridge beam, rafters, hip rafters, posts, covering nodes.
 */
import type { BubbleGraphNode } from '@/store';
import type {
  Pt3,
  RoofContour,
  RoofFace3D,
  RoofIntent,
  SkeletonSeg,
} from './types';

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function segLen(a: Pt3, b: Pt3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function lerp3(a: Pt3, b: Pt3, t: number): Pt3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function memberNode(
  type: string,
  name: string,
  a: Pt3,
  b: Pt3,
  roofId: string,
  parentId: string | undefined,
  section: string,
  material: string,
  extra: Record<string, unknown> = {},
): BubbleGraphNode {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const mz = (a.z + b.z) / 2;
  return {
    id: `${type}_${roofId}_${uid()}`,
    type,
    name,
    x: mx,
    y: my,
    z: mz,
    parentId,
    properties: {
      source_roof_id: roofId,
      generated: true,
      section,
      material,
      length_mm: segLen(a, b),
      ax: a.x,
      ay: a.y,
      az: a.z,
      bx: b.x,
      by: b.y,
      bz: b.z,
      ...extra,
    },
  };
}

/** Sample positions along a plan segment at approximate spacing (always include ends). */
function samplesAlong(a: Pt3, b: Pt3, spacingMm: number): Pt3[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return [a];
  const n = Math.max(1, Math.round(len / Math.max(spacingMm, 200)));
  const out: Pt3[] = [];
  for (let i = 0; i <= n; i++) out.push(lerp3(a, b, i / n));
  return out;
}

/** Forward ray×segment param t (>eps) or null. Ray o+t·dir (unit), seg [a,b]. */
function raySegT(o: Pt3, dir: { x: number; y: number }, a: Pt3, b: Pt3): number | null {
  const ex = b.x - a.x, ey = b.y - a.y;
  const det = ex * dir.y - ey * dir.x;
  if (Math.abs(det) < 1e-9) return null;
  const t = (-(a.x - o.x) * ey + ex * (a.y - o.y)) / det;
  const u = (dir.x * (a.y - o.y) - dir.y * (a.x - o.x)) / det;
  return t > 1 && u > -1e-6 && u < 1 + 1e-6 ? t : null;
}

/** Nearest eave point of the roof CONTOUR polygon along a ray, at `baseZ`. */
function contourRayFoot(
  o: Pt3, dir: { x: number; y: number }, contourPts: { x: number; y: number }[], baseZ: number,
): Pt3 | null {
  let best = Infinity;
  const n = contourPts.length;
  for (let i = 0; i < n; i++) {
    const a = contourPts[i], b = contourPts[(i + 1) % n];
    const t = raySegT(o, dir, { x: a.x, y: a.y, z: baseZ }, { x: b.x, y: b.y, z: baseZ });
    if (t !== null && t < best) best = t;
  }
  return isFinite(best) ? { x: o.x + dir.x * best, y: o.y + dir.y * best, z: baseZ } : null;
}

/**
 * Two eave foot points either side of a ridge point, found by casting perpendicular
 * to the RIDGE'S ACTUAL DIRECTION against the real roof contour — correct for any
 * ridge orientation (diagonal straight-skeleton ridges included) and for asymmetric
 * spans (e.g. an offset ridge), not just axis-aligned bbox roofs.
 * Falls back to a symmetric tanP-based reconstruction if the contour cast misses
 * (degenerate/very small plans).
 */
function ridgeFeet(rg: SkeletonSeg, rp: Pt3, baseZ: number, tanP: number, contourPts: { x: number; y: number }[]):
  { a: Pt3; b: Pt3 } {
  const dx = rg.b.x - rg.a.x, dy = rg.b.y - rg.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const perp = { x: -dy / len, y: dx / len };
  const fa = contourRayFoot(rp, perp, contourPts, baseZ);
  const fb = contourRayFoot(rp, { x: -perp.x, y: -perp.y }, contourPts, baseZ);
  if (fa && fb) return { a: fa, b: fb };
  const halfSpan = tanP > 0 ? (rp.z - baseZ) / tanP : 0;
  return {
    a: fa ?? { x: rp.x - perp.x * halfSpan, y: rp.y - perp.y * halfSpan, z: baseZ },
    b: fb ?? { x: rp.x + perp.x * halfSpan, y: rp.y + perp.y * halfSpan, z: baseZ },
  };
}

function bboxFromContour(contour: RoofContour) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of contour.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * Build framing + covering graph nodes from envelope skeleton/faces.
 * Supports gable, shed, hip (bbox-based, matching skeleton.ts).
 */
export function buildRoofFraming(
  roofId: string,
  parentId: string | undefined,
  contour: RoofContour,
  intent: RoofIntent,
  skeleton: SkeletonSeg[],
  faces: RoofFace3D[],
): BubbleGraphNode[] {
  const nodes: BubbleGraphNode[] = [];
  const ridge = skeleton.find((s) => s.role === 'ridge');
  const hips = skeleton.filter((s) => s.role === 'hip');
  const eaves = skeleton.filter((s) => s.role === 'eave');
  const spacing = Math.max(300, intent.rafterSpacingMm);
  const b = bboxFromContour(contour);
  const baseZ = contour.baseZ;

  // Wall plates — eaves when present, else bbox perimeter for gable
  const plateSegs: { a: Pt3; b: Pt3; name: string }[] = [];
  if (eaves.length) {
    for (const e of eaves) {
      plateSegs.push({ a: e.a, b: e.b, name: 'Wall plate' });
    }
  } else if (intent.roofType === 'gable' && ridge) {
    const axisX = Math.abs(ridge.a.y - ridge.b.y) < Math.abs(ridge.a.x - ridge.b.x);
    if (axisX) {
      plateSegs.push(
        { a: { x: b.minX, y: b.minY, z: baseZ }, b: { x: b.maxX, y: b.minY, z: baseZ }, name: 'Wall plate S' },
        { a: { x: b.minX, y: b.maxY, z: baseZ }, b: { x: b.maxX, y: b.maxY, z: baseZ }, name: 'Wall plate N' },
      );
    } else {
      plateSegs.push(
        { a: { x: b.minX, y: b.minY, z: baseZ }, b: { x: b.minX, y: b.maxY, z: baseZ }, name: 'Wall plate W' },
        { a: { x: b.maxX, y: b.minY, z: baseZ }, b: { x: b.maxX, y: b.maxY, z: baseZ }, name: 'Wall plate E' },
      );
    }
  } else if (intent.roofType === 'shed' && ridge) {
    const eave = eaves[0];
    if (eave) plateSegs.push({ a: eave.a, b: eave.b, name: 'Wall plate (eave)' });
    plateSegs.push({ a: ridge.a, b: ridge.b, name: 'Wall plate (high)' });
  }

  for (const p of plateSegs) {
    nodes.push(memberNode(
      'wall_plate', p.name, p.a, p.b, roofId, parentId,
      intent.ridgeSection, intent.material, { role: 'wall_plate' },
    ));
  }

  const ridges = skeleton.filter((s) => s.role === 'ridge');
  const valleys = skeleton.filter((s) => s.role === 'valley');
  const tanP = Math.tan((Math.max(1, intent.pitchDeg) * Math.PI) / 180) || 1;

  // Ridge beams — one per ridge (cross-gable has several)
  if (intent.roofType !== 'flat') {
    for (const rg of ridges) {
      nodes.push(memberNode(
        'ridge_beam', 'Ridge beam', rg.a, rg.b, roofId, parentId,
        intent.ridgeSection, intent.material, { role: 'ridge' },
      ));
    }
  }

  // Hip rafters
  for (const h of hips) {
    nodes.push(memberNode(
      'hip_rafter', 'Hip rafter', h.a, h.b, roofId, parentId,
      intent.rafterSection, intent.material, { role: 'hip' },
    ));
  }

  // Valley rafters (cross-gable / L-shape)
  for (const v of valleys) {
    nodes.push(memberNode(
      'valley_rafter', 'Valley rafter', v.a, v.b, roofId, parentId,
      intent.rafterSection, intent.material, { role: 'valley' },
    ));
  }

  // ── Common framing — branch by structural system ──
  const genRafters = (rg: SkeletonSeg) => {
    const along = samplesAlong(rg.a, rg.b, spacing);
    const pts = intent.roofType === 'hip' && along.length > 2 ? along.slice(1, -1) : along;
    for (const rp of pts) {
      const f = ridgeFeet(rg, rp, baseZ, tanP, contour.points);
      nodes.push(memberNode('rafter', 'Rafter', f.a, rp, roofId, parentId, intent.rafterSection, intent.material));
      nodes.push(memberNode('rafter', 'Rafter', f.b, rp, roofId, parentId, intent.rafterSection, intent.material));
    }
  };

  const genTrusses = (rg: SkeletonSeg) => {
    const along = samplesAlong(rg.a, rg.b, Math.max(1200, intent.trussSpacingMm));
    for (const rp of along) {
      const f = ridgeFeet(rg, rp, baseZ, tanP, contour.points);
      nodes.push(memberNode('rafter', 'Truss rafter', f.a, rp, roofId, parentId, intent.rafterSection, intent.material, { role: 'truss_chord' }));
      nodes.push(memberNode('rafter', 'Truss rafter', f.b, rp, roofId, parentId, intent.rafterSection, intent.material, { role: 'truss_chord' }));
      nodes.push(memberNode('tie_beam', 'Tie beam', f.a, f.b, roofId, parentId, intent.ridgeSection, intent.material, { role: 'tie' }));
      const tieMid: Pt3 = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2, z: baseZ };
      if (segLen(tieMid, rp) > 200) {
        nodes.push(memberNode('post', 'King post', tieMid, rp, roofId, parentId, intent.postSection, intent.material, { role: 'king_post' }));
      }
    }
  };

  // Purlins parallel to the ridge, stepping up each slope. Sampled at MULTIPLE
  // points along the ridge (not just its two ends), so each purlin course
  // follows the real eave shape — required whenever the span isn't constant
  // along the ridge (e.g. the two long sides of the building aren't parallel,
  // which happens on non-rectangular plans even though the ridge itself is a
  // straight skeleton segment: a straight ridge is the bisector of its two
  // bounding edges, and the distance to each edge only stays constant along
  // it when those edges are parallel). Each course is a polyline stitched
  // from consecutive same-height samples — exact for a planar roof face,
  // correct for a warped one.
  const genPurlins = (rg: SkeletonSeg) => {
    const principals = samplesAlong(rg.a, rg.b, Math.max(1200, intent.trussSpacingMm));
    for (const rp of principals) {
      const f = ridgeFeet(rg, rp, baseZ, tanP, contour.points);
      nodes.push(memberNode('rafter', 'Principal rafter', f.a, rp, roofId, parentId, intent.rafterSection, intent.material, { role: 'principal' }));
      nodes.push(memberNode('rafter', 'Principal rafter', f.b, rp, roofId, parentId, intent.rafterSection, intent.material, { role: 'principal' }));
    }

    const ridgeSamples = samplesAlong(rg.a, rg.b, Math.max(300, intent.rafterSpacingMm));
    const feetSamples = ridgeSamples.map((rp) => ridgeFeet(rg, rp, baseZ, tanP, contour.points));
    const slopeLen = Math.max(
      ...feetSamples.map((f, i) => Math.max(segLen(f.a, ridgeSamples[i]), segLen(f.b, ridgeSamples[i]))),
    );
    const count = Math.max(1, Math.round(slopeLen / Math.max(600, intent.purlinSpacingMm)));

    for (let k = 1; k < count; k++) {
      const t = k / count;
      for (const side of ['a', 'b'] as const) {
        for (let i = 0; i < ridgeSamples.length - 1; i++) {
          const p0 = lerp3(feetSamples[i][side], ridgeSamples[i], t);
          const p1 = lerp3(feetSamples[i + 1][side], ridgeSamples[i + 1], t);
          nodes.push(memberNode('purlin', 'Purlin', p0, p1, roofId, parentId, intent.ridgeSection, intent.material, { role: 'purlin' }));
        }
      }
    }
  };

  // Rafters perpendicular to each eave, up the slope plane — works for any face
  // orientation (arbitrary straight-skeleton hips), not just axis-aligned ones.
  /**
   * Rafters for one slope face, keyed off the face's own PLANE rather than off
   * an edge of it.
   *
   * Framing used to start from the face's eave edge and walk inward. That works
   * for the common faces but assumes every face has a level bottom edge to
   * measure from, and on a re-entrant corner (an L- or T-shaped plan) the
   * skeleton produces a small face wedged between two valleys whose edges ALL
   * slope. Such a face got no rafters at all, silently — the hole visible in
   * the middle of an L-shaped roof.
   *
   * Working from the plane removes the assumption entirely: rafters run along
   * the line of steepest ascent and are spaced across it, which is the actual
   * carpentry rule and is defined for any face shape. For a face that does have
   * a level eave this gives exactly the previous layout, since steepest ascent
   * is perpendicular to a horizontal eave.
   */
  const genFaceRafters = (f: RoofFace3D) => {
    const V = f.vertices;
    if (V.length < 3) return;

    // Plane normal from the first non-degenerate vertex triple.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 1; i + 1 < V.length; i++) {
      const ux = V[i].x - V[0].x, uy = V[i].y - V[0].y, uz = V[i].z - V[0].z;
      const vx = V[i + 1].x - V[0].x, vy = V[i + 1].y - V[0].y, vz = V[i + 1].z - V[0].z;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (Math.hypot(cx, cy, cz) > 1e-6) { nx = cx; ny = cy; nz = cz; break; }
    }
    if (Math.abs(nz) < 1e-9) return; // vertical face — not a slope

    // z = z0 + g·(p − p0); steepest ascent is along g.
    const gx = -nx / nz, gy = -ny / nz;
    const gLen = Math.hypot(gx, gy);
    if (gLen < 1e-6) return; // dead level, nothing to rafter
    const up = { x: gx / gLen, y: gy / gLen };        // uphill, in plan
    const across = { x: -up.y, y: up.x };             // along the eave
    const zAt = (x: number, y: number) => V[0].z + gx * (x - V[0].x) + gy * (y - V[0].y);

    // Spread of the face across the slope, then evenly divided courses.
    const ss = V.map((p) => p.x * across.x + p.y * across.y);
    const sMin = Math.min(...ss), sMax = Math.max(...ss);
    const width = sMax - sMin;
    if (width < 1) return;
    const steps = Math.max(1, Math.round(width / spacing));

    // Nudge the outermost courses inwards: a course exactly on the face's
    // extreme grazes a single vertex and yields nothing useful.
    const EPS = 1e-3;
    for (let k = 0; k <= steps; k++) {
      const s = Math.min(sMax - EPS, Math.max(sMin + EPS, sMin + (width * k) / steps));

      // Every crossing of this course with the outline, as a distance along
      // `up`. The half-open test counts a shared vertex once, so the sorted
      // crossings pair up into spans that lie INSIDE the face — which is what
      // keeps a concave face (a valley notch) from being bridged straight
      // across its own opening.
      const hits: number[] = [];
      for (let j = 0; j < V.length; j++) {
        const a = V[j], b = V[(j + 1) % V.length];
        const sa = a.x * across.x + a.y * across.y;
        const sb = b.x * across.x + b.y * across.y;
        if ((sa <= s && sb > s) || (sb <= s && sa > s)) {
          const r = (s - sa) / (sb - sa);
          const px = a.x + (b.x - a.x) * r, py = a.y + (b.y - a.y) * r;
          hits.push(px * up.x + py * up.y);
        }
      }
      hits.sort((p, q) => p - q);

      for (let h = 0; h + 1 < hits.length; h += 2) {
        const tLo = hits[h], tHi = hits[h + 1];
        if (tHi - tLo < 50) continue; // sliver at a corner
        const low = { x: up.x * tLo + across.x * s, y: up.y * tLo + across.y * s };
        const high = { x: up.x * tHi + across.x * s, y: up.y * tHi + across.y * s };
        nodes.push(memberNode(
          'rafter', 'Rafter',
          { x: low.x, y: low.y, z: zAt(low.x, low.y) },
          { x: high.x, y: high.y, z: zAt(high.x, high.y) },
          roofId, parentId, intent.rafterSection, intent.material,
        ));
      }
    }
  };

  if (intent.roofType === 'shed' && ridge) {
    const eave = eaves[0] ?? {
      a: { x: b.minX, y: b.minY, z: baseZ },
      b: { x: b.maxX, y: b.minY, z: baseZ },
    };
    const highs = samplesAlong(ridge.a, ridge.b, spacing);
    const lows = samplesAlong(eave.a, eave.b, spacing);
    const n = Math.min(highs.length, lows.length);
    for (let i = 0; i < n; i++) {
      nodes.push(memberNode('rafter', 'Rafter', lows[i], highs[i], roofId, parentId, intent.rafterSection, intent.material));
    }
  } else if (intent.roofType === 'hip' && faces.some((f) => f.role === 'slope')) {
    if ((intent.system === 'truss' || intent.system === 'purlin') && ridges.length) {
      // Trapezoidal "body" faces (the ones with a real ridge) get the chosen
      // structural system; the triangular hip ENDS have no ridge to frame off
      // of and always take jack rafters — that matches real carpentry, where
      // hip ends are never trussed regardless of the system used mid-span.
      const gen = intent.system === 'truss' ? genTrusses : genPurlins;
      for (const rg of ridges) gen(rg);
      for (const f of faces) {
        if (f.role === 'slope' && f.vertices.length === 3) genFaceRafters(f);
      }
    } else {
      // Straight-skeleton hip, rafter system (default): rafter each slope face
      // directly (any orientation) — also the robust fallback when a chosen
      // system has no ridge to anchor to (e.g. a full hip apex, no ridges at all).
      for (const f of faces) if (f.role === 'slope' && f.vertices.length >= 3) genFaceRafters(f);
    }
  } else if (intent.roofType !== 'flat' && ridges.length) {
    const gen = intent.system === 'truss' ? genTrusses
      : intent.system === 'purlin' ? genPurlins
      : genRafters;
    for (const rg of ridges) gen(rg);
  }

  // Posts (popi) under ridge — rafter/purlin systems; trusses carry their own king posts.
  if (intent.roofType !== 'shed' && intent.roofType !== 'flat' && intent.system !== 'truss') {
    const postSpacing = Math.max(spacing * 2, 1200);
    for (const rg of ridges) {
      const posts = samplesAlong(rg.a, rg.b, postSpacing);
      for (const rp of posts) {
        const base: Pt3 = { x: rp.x, y: rp.y, z: baseZ };
        if (segLen(base, rp) < 200) continue;
        nodes.push(memberNode('post', 'Post', base, rp, roofId, parentId, intent.postSection, intent.material, { role: 'post' }));
      }
    }
  }

  // Covering — one node per slope face (for quantities / BOM)
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (f.role !== 'slope' || f.vertices.length < 3) continue;
    const cx = f.vertices.reduce((s, v) => s + v.x, 0) / f.vertices.length;
    const cy = f.vertices.reduce((s, v) => s + v.y, 0) / f.vertices.length;
    const cz = f.vertices.reduce((s, v) => s + v.z, 0) / f.vertices.length;
    nodes.push({
      id: `covering_${roofId}_${i}_${uid()}`,
      type: 'covering',
      name: `Covering ${i + 1}`,
      x: cx,
      y: cy,
      z: cz,
      parentId,
      properties: {
        source_roof_id: roofId,
        generated: true,
        material: intent.coveringMaterial,
        thickness: intent.coveringThicknessMm,
        pitched: true,
        face_id: f.id,
        face_vertices: JSON.stringify(f.vertices),
      },
    });
  }

  return nodes;
}
