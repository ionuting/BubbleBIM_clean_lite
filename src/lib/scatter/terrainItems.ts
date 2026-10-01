/**
 * terrainItems.ts — the Terrain tab's own rocks and plants, as instances.
 *
 * The terrain model keeps what was placed by hand in the modeller (and by the
 * 3D brush). Reading them through the same `ScatterInstance` means the plan
 * symbols, the 3D meshes and the elevations treat a hand-placed tree and a
 * scattered one identically — there is one kind of tree in the drawings.
 */
import type { SiteResult } from '@/lib/terrain/site';
import { terrainToBim } from '@/lib/terrain/site';
import type { PlantType } from '@/lib/terrain/types';
import { SCATTER_KIND_DEFAULTS, type ScatterInstance, type ScatterKind } from './types';

const PLANT_KIND: Record<PlantType, ScatterKind> = { tree: 'tree', bush: 'shrub', grass: 'grass' };

export function terrainItemInstances(site: SiteResult): ScatterInstance[] {
  const f = site.frame;
  if (!f) return [];
  const out: ScatterInstance[] = [];
  const at = (xM: number, zM: number) => {
    const p = terrainToBim(f, xM, zM);
    return { ...p, z: site.heightAtBim(p.x, p.y) ?? f.datumMm };
  };
  for (const p of site.model.plants) {
    const kind = PLANT_KIND[p.type] ?? 'shrub';
    const d = SCATTER_KIND_DEFAULTS[kind];
    const s = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
    const q = at(p.x, p.z);
    out.push({ x: q.x, y: q.y, z: q.z, sizeMm: d.sizeMm * s, heightMm: d.heightMm * s, rotDeg: 0, kind, variant: 0.5 });
  }
  for (const r of site.model.rocks) {
    const d = SCATTER_KIND_DEFAULTS.rock;
    const s = Number.isFinite(r.scale) && r.scale > 0 ? r.scale : 1;
    const q = at(r.x, r.z);
    out.push({ x: q.x, y: q.y, z: q.z, sizeMm: d.sizeMm * s, heightMm: d.heightMm * s, rotDeg: (r.rotY * 180) / Math.PI, kind: 'rock', variant: ((r.rotY * 1000) % 1 + 1) % 1 });
  }
  return out;
}
