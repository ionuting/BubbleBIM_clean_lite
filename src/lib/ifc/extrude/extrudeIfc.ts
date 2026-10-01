/**
 * extrudeIfc.ts — drawn solids → a standalone IFC file.
 *
 * The mapping is one-to-one, which is the point of the whole feature: an
 * `ExtrudedSolid` IS an `IfcExtrudedAreaSolid` over an
 * `IfcArbitraryClosedProfileDef`. Nothing is triangulated on the way out, so
 * what lands in the file is still a contour, a direction and a depth — the
 * same four numbers the user was editing, editable again in whatever opens it.
 *
 * Scale has no home in that representation, so it is BAKED: the plan factors
 * multiply the profile points and the vertical factor multiplies the depth.
 * The exported solid therefore matches what was on screen, and the quantities
 * written beside it match the exported solid.
 *
 * Georeference, when the caller has one, goes in through the same writer the
 * rest of the app uses, so a shape drawn on the map opens at its real place.
 */

import { IfcCreator } from '@ifc-lite/create';
import type { CreateResult } from '@ifc-lite/create';
import { writeGeoreference, type GeoReference, type GeorefWriteOptions } from '@/lib/geo/ifcGeoref';
import { effectiveHeight, solidQuantities, type ExtrudedSolid } from './extrudedSolid';

export interface ExtrudeExportOptions {
  projectName?: string;
  storeyName?: string;
  /** Elevation of the storey the solids hang under, metres. Their own `z`
   *  is measured from it, so leaving this at 0 keeps `z` absolute. */
  storeyElevation?: number;
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  georeference?: GeoReference | null;
  georeferenceOptions?: GeorefWriteOptions;
  /** Write Qto_BodyGeometry quantities next to each solid. Default true. */
  quantities?: boolean;
}

/**
 * The profile as it must appear in the file: oriented and scaled, but NOT
 * rotated — the rotation rides in the placement's RefDirection, where a
 * consumer can still read it as a rotation.
 */
export function exportProfile(s: ExtrudedSolid): Array<[number, number]> {
  return s.profile.map((p): [number, number] => [p.x * s.placement.sx, p.y * s.placement.sy]);
}

/** Local X of the solid's placement — this is where the rotation lives. */
export function exportRefDirection(s: ExtrudedSolid): [number, number, number] {
  const r = (s.placement.rotation * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), 0];
}

/**
 * Build an IFC file containing exactly these solids.
 *
 * Returns whatever `@ifc-lite/create` returns, with the georeference already
 * written into the text when one was given.
 */
export function buildExtrusionIfc(
  solids: ExtrudedSolid[],
  options: ExtrudeExportOptions = {},
): CreateResult {
  const creator = new IfcCreator({
    Name: options.projectName ?? 'Extrudări',
    Schema: options.schema ?? 'IFC4',
  });
  const storeyId = creator.addIfcBuildingStorey({
    Name: options.storeyName ?? 'Nivel 0',
    Elevation: options.storeyElevation ?? 0,
  });

  for (const s of solids) {
    const id = creator.addElement(storeyId, {
      IfcType: s.ifcType,
      Placement: {
        Location: [s.placement.x, s.placement.y, s.placement.z],
        Axis: [0, 0, 1],
        RefDirection: exportRefDirection(s),
      },
      Profile: { ProfileType: 'AREA', OuterCurve: exportProfile(s) },
      Depth: effectiveHeight(s),
      Name: s.name,
      Tag: s.id,
    });

    if (options.quantities !== false) {
      const q = solidQuantities(s);
      creator.addIfcElementQuantity(id, {
        Name: 'Qto_BodyGeometry',
        Quantities: [
          { Name: 'GrossFootprintArea', Kind: 'IfcQuantityArea', Value: q.areaM2 },
          { Name: 'Perimeter', Kind: 'IfcQuantityLength', Value: q.perimeterM },
          { Name: 'Height', Kind: 'IfcQuantityLength', Value: q.heightM },
          { Name: 'GrossVolume', Kind: 'IfcQuantityVolume', Value: q.volumeM3 },
          { Name: 'GrossSideArea', Kind: 'IfcQuantityArea', Value: q.lateralAreaM2 },
        ],
      });
    }
  }

  const result = creator.toIfc();
  if (!options.georeference) return result;
  return {
    ...result,
    content: writeGeoreference(result.content, options.georeference, {
      schema: options.schema ?? 'IFC4',
      ...options.georeferenceOptions,
    }),
  };
}

/** Rough sanity for a UI: how big the file is about to be, in solids. */
export function exportSummary(solids: ExtrudedSolid[]): { count: number; volumeM3: number; areaM2: number } {
  return solids.reduce(
    (acc, s) => {
      const q = solidQuantities(s);
      return { count: acc.count + 1, volumeM3: acc.volumeM3 + q.volumeM3, areaM2: acc.areaM2 + q.areaM2 };
    },
    { count: 0, volumeM3: 0, areaM2: 0 },
  );
}
