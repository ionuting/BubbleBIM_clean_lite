/**
 * Sweep element — public surface.
 *
 * `computeSweep` is the single pure entry point every consumer shares: the 3D
 * viewers, the plan, the section engine, the quantity takeoff and the
 * Inspector's diagnostics all read the same result, so what you see is what
 * gets measured. It never throws — failure is a diagnostic, not an exception.
 */
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { isSimplePolygon } from '@/lib/geom/plan2d';
import { applyProfilePlacement } from './profiles';
import { resolveSweepPath } from './path';
import {
  computeSweepSolids,
  pathLength,
  polygonPerimeter,
  profileArea,
  sweepFootprint,
  sweepVolume,
  triangulateSimple,
} from './rings';
import { resolveSweepProfile, type SweepProfileResolver } from './profileLibrary';
import { parseSweepIntent, type SweepResult } from './types';

export * from './types';
export * from './profiles';
export * from './path';
export * from './rings';
export * from './profileLibrary';
export { sweepBufferGeometry } from './mesh';

export function computeSweep(
  node: BubbleGraphNode,
  nodeMap: Map<string, BubbleGraphNode>,
  edges: BubbleGraphEdge[],
  resolveProfile: SweepProfileResolver = resolveSweepProfile,
): SweepResult {
  const intent = parseSweepIntent(node);
  const result: SweepResult = {
    intent,
    path: null,
    profile: null,
    placed: null,
    solids: [],
    footprint: [],
    lengthMm: 0,
    areaMm2: 0,
    perimeterMm: 0,
    volumeMm3: 0,
    zMinMm: 0,
    zMaxMm: 0,
    diagnostics: [],
  };

  try {
    const { path, diagnostics: pathDiags } = resolveSweepPath(node, nodeMap, edges, intent);
    result.path = path;
    result.diagnostics.push(...pathDiags);

    const { profile, diagnostics: profDiags } = resolveProfile(intent.profileId, intent.params);
    result.profile = profile;
    result.diagnostics.push(...profDiags);
    if (!profile) {
      if (!result.diagnostics.some((d) => d.severity === 'error')) {
        result.diagnostics.push({
          code: 'PROFILE_UNAVAILABLE',
          severity: 'error',
          message: `Profilul "${intent.profileId}" nu e disponibil — verifică biblioteca de profile.`,
        });
      }
      return result;
    }

    const placed = applyProfilePlacement(profile.polygon, intent);
    if (!isSimplePolygon(placed) || placed.length < 3) {
      result.diagnostics.push({
        code: 'PROFILE_NOT_SIMPLE',
        severity: 'error',
        message: 'Profilul rezultat se auto-intersectează — verifică dimensiunile.',
      });
      return result;
    }
    result.placed = placed;
    result.areaMm2 = profileArea(placed);
    result.perimeterMm = polygonPerimeter(placed);

    if (!path) return result;

    const { solids, diagnostics: cornerDiags } = computeSweepSolids(path, placed, intent.corners);
    result.solids = solids;
    result.diagnostics.push(...cornerDiags);
    result.footprint = sweepFootprint(solids, path, placed);
    result.lengthMm = pathLength(path);
    result.volumeMm3 = sweepVolume(solids, triangulateSimple(placed));

    let zMin = Infinity, zMax = -Infinity;
    for (const s of solids) for (const r of s.rings) for (const p of r) {
      if (p.z < zMin) zMin = p.z;
      if (p.z > zMax) zMax = p.z;
    }
    if (zMin <= zMax) { result.zMinMm = zMin; result.zMaxMm = zMax; }
  } catch (err) {
    result.diagnostics.push({
      code: 'SWEEP_FAILED',
      severity: 'error',
      message: `Geometria sweep-ului a eșuat: ${err instanceof Error ? err.message : String(err)}`,
    });
    result.solids = [];
    result.footprint = [];
  }
  return result;
}
