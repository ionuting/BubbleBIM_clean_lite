/**
 * The export has one job: put on disk exactly the solid that was on screen.
 * These tests read the STEP text back, because a number that is right in the
 * model and wrong in the file is the only failure that matters here.
 */
import { describe, expect, it } from 'vitest';
import { STEP_LINE_RE, tokeniseArgs } from '@/lib/ifc/stepText';
import { georefFromWorldLocation } from '@/lib/geo/georeference';
import { readGeoreference } from '@/lib/geo/ifcGeoref';
import { parseIfcPlan } from '@/lib/ifcStepParser';
import { buildExtrusionIfc, exportProfile, exportRefDirection, exportSummary } from './extrudeIfc';
import {
  createExtrusion, setHeight, withPlacement, type ExtrudedSolid, type Pt2,
} from './extrudedSolid';

const p = (x: number, y: number): Pt2 => ({ x, y });
/** 4 × 6 m, centroid at (12, 23). */
const RECT = [p(10, 20), p(14, 20), p(14, 26), p(10, 26)];

function solid(over: Partial<ExtrudedSolid> = {}): ExtrudedSolid {
  const made = createExtrusion(RECT, { id: 'xs-1', name: 'Corp A', height: 3 });
  if (!made.ok) throw new Error('fixture rejected');
  return { ...made.solid, ...over };
}

function entityArgs(text: string, type: string): string[] | null {
  for (const line of text.split('\n')) {
    const m = STEP_LINE_RE.exec(line.trim());
    if (m && m[2].toUpperCase() === type) return tokeniseArgs(m[3]);
  }
  return null;
}

function argsById(text: string, idRef: string): string[] | null {
  const want = idRef.replace('#', '');
  for (const line of text.split('\n')) {
    const m = STEP_LINE_RE.exec(line.trim());
    if (m && m[1] === want) return tokeniseArgs(m[3]);
  }
  return null;
}

/** Product → ObjectPlacement → IfcLocalPlacement → RelativePlacement → Location. */
function elementLocation(text: string, type: string): [number, number, number] {
  const prod = entityArgs(text, type);
  if (!prod) throw new Error(`no ${type} in the file`);
  const local = argsById(text, prod[5]);          // ObjectPlacement
  if (!local) throw new Error('product has no local placement');
  const axis = argsById(text, local[1]);          // RelativePlacement
  if (!axis) throw new Error('local placement has no relative placement');
  const loc = argsById(text, axis[0]);            // Location
  if (!loc) throw new Error('placement has no location');
  const [x, y, z] = tokeniseArgs(loc[0].replace(/^\(|\)$/g, '')).map(Number);
  return [x, y, z];
}

/** The (x, y) pairs of the IfcPolyline the profile points at. */
function profilePoints(text: string): Array<[number, number]> {
  const prof = entityArgs(text, 'IFCARBITRARYCLOSEDPROFILEDEF');
  if (!prof) throw new Error('no arbitrary profile in the file');
  const poly = argsById(text, prof[2]);
  if (!poly) throw new Error('profile curve is a dangling reference');
  return tokeniseArgs(poly[0].replace(/^\(|\)$/g, '')).map((ref) => {
    const pt = argsById(text, ref)!;
    const [x, y] = tokeniseArgs(pt[0].replace(/^\(|\)$/g, '')).map(Number);
    return [x, y] as [number, number];
  });
}

describe('a drawn solid becomes an IfcExtrudedAreaSolid', () => {
  it('writes the contour as a profile, not as triangles', () => {
    const { content } = buildExtrusionIfc([solid()]);
    expect(content).toContain('IFCEXTRUDEDAREASOLID');
    expect(content).toContain('IFCARBITRARYCLOSEDPROFILEDEF');
    // Nothing got tessellated on the way out — that is the whole promise.
    expect(content).not.toContain('IFCTRIANGULATEDFACESET');
    expect(content).not.toContain('IFCFACETEDBREP');
  });

  it('puts the solid where its placement says, in metres', () => {
    const { content } = buildExtrusionIfc([solid()]);
    const solidArgs = entityArgs(content, 'IFCEXTRUDEDAREASOLID')!;
    // Depth is the last argument of IfcExtrudedAreaSolid.
    expect(parseFloat(solidArgs[3])).toBeCloseTo(3, 9);

    // The element's OWN placement, followed from the product rather than
    // taken as the first one in the file: a file is full of placements and
    // the context's sits at the origin.
    const [x, y, z] = elementLocation(content, 'IFCBUILDINGELEMENTPROXY');
    expect(x).toBeCloseTo(12, 6);
    expect(y).toBeCloseTo(23, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('writes the profile centred on the placement, so the footprint lands where it was drawn', () => {
    const pts = profilePoints(buildExtrusionIfc([solid()]).content);
    // Centred: ±2 across, ±3 up, about the centroid the placement carries.
    expect(Math.min(...pts.map((q) => q[0]))).toBeCloseTo(-2, 6);
    expect(Math.max(...pts.map((q) => q[0]))).toBeCloseTo(2, 6);
    expect(Math.min(...pts.map((q) => q[1]))).toBeCloseTo(-3, 6);
    expect(Math.max(...pts.map((q) => q[1]))).toBeCloseTo(3, 6);
  });

  it('carries the rotation in RefDirection, where it stays readable as a rotation', () => {
    expect(exportRefDirection(withPlacement(solid(), { rotation: 0 }))).toEqual([1, 0, 0]);
    const [x, y] = exportRefDirection(withPlacement(solid(), { rotation: 90 }));
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(1, 12);

    // And the profile itself is NOT pre-rotated — that would bake the angle in.
    const turned = withPlacement(solid(), { rotation: 90 });
    expect(exportProfile(turned)).toEqual(exportProfile(solid()));
  });

  it('bakes the scale, because IfcExtrudedAreaSolid has nowhere to put it', () => {
    const s = withPlacement(setHeight(solid(), 3), { sx: 2, sy: 3, sz: 4 });
    const { content } = buildExtrusionIfc([s]);
    const pts = profilePoints(content);
    expect(Math.max(...pts.map((q) => q[0]))).toBeCloseTo(4, 6);    // 2 × 2
    expect(Math.max(...pts.map((q) => q[1]))).toBeCloseTo(9, 6);    // 3 × 3
    expect(parseFloat(entityArgs(content, 'IFCEXTRUDEDAREASOLID')![3])).toBeCloseTo(12, 6);  // 3 × 4
  });

  it('extrudes straight up', () => {
    const { content } = buildExtrusionIfc([solid()]);
    const dir = argsById(content, entityArgs(content, 'IFCEXTRUDEDAREASOLID')![2])!;
    const parts = tokeniseArgs(dir[0].replace(/^\(|\)$/g, '')).map(Number);
    expect(parts).toEqual([0, 0, 1]);
  });

  it('names each solid and tags it with the id it had on screen', () => {
    const { content } = buildExtrusionIfc([solid()]);
    expect(content).toContain("'Corp A'");
    expect(content).toContain("'xs-1'");
  });

  it('writes quantities that agree with the exported solid, and can be told not to', () => {
    const s = withPlacement(setHeight(solid(), 3), { sx: 2, sy: 2 });
    const { content } = buildExtrusionIfc([s]);
    expect(content).toContain('Qto_BodyGeometry');
    // 4 × 6 doubled in both plan directions = 8 × 12 = 96 m², × 3 m = 288 m³.
    const vol = /IFCQUANTITYVOLUME\('GrossVolume',[^)]*?,([0-9.E+-]+)\)/i.exec(content);
    expect(vol).not.toBeNull();
    expect(parseFloat(vol![1])).toBeCloseTo(288, 3);

    expect(buildExtrusionIfc([s], { quantities: false }).content).not.toContain('Qto_BodyGeometry');
  });

  it('writes every solid it is given, and an empty list is still a valid file', () => {
    const many = buildExtrusionIfc([solid(), solid({ id: 'xs-2', name: 'Corp B' })]).content;
    expect(many.match(/IFCEXTRUDEDAREASOLID/g)).toHaveLength(2);

    const empty = buildExtrusionIfc([]).content;
    expect(empty).toContain('IFCPROJECT');
    expect(empty.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
  });

  it('stays a valid STEP file — one entity per line, ids unique', () => {
    const { content } = buildExtrusionIfc([solid(), solid({ id: 'xs-2' })]);
    const ids = new Set<number>();
    for (const line of content.split('\n')) {
      const m = STEP_LINE_RE.exec(line.trim());
      if (!m) continue;
      const id = parseInt(m[1], 10);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBeGreaterThan(10);
  });
});

describe('a solid drawn on the map', () => {
  it('carries its georeference, so it opens where it was drawn', async () => {
    const gr = georefFromWorldLocation(
      { lat: 44.4268, lng: 26.1025, alt: 85, offsetE: 0, offsetN: 0, offsetZ: 0, rotation: 0 },
      'EPSG:3844',
    );
    const { content } = buildExtrusionIfc([solid()], { georeference: gr });
    expect(content).toContain('IFCMAPCONVERSION');

    const back = (await parseIfcPlan(
      new TextEncoder().encode(content).buffer as ArrayBuffer,
    )).georeference;
    expect(back).not.toBeNull();
    expect(back!.crs).toBe('EPSG:3844');
    expect(back!.eastings).toBeCloseTo(gr.eastings, 3);
    expect(back!.northings).toBeCloseTo(gr.northings, 3);
  });

  it('omits the georeference when there is none, rather than inventing one', () => {
    const { content } = buildExtrusionIfc([solid()]);
    expect(content).not.toContain('IFCMAPCONVERSION');
    expect(readGeoreference(new Map())).toBeNull();
  });
});

describe('exportSummary', () => {
  it('adds up what is about to be written', () => {
    const s = setHeight(solid(), 3);
    expect(exportSummary([s, s])).toEqual({ count: 2, volumeM3: 144, areaM2: 48 });
    expect(exportSummary([])).toEqual({ count: 0, volumeM3: 0, areaM2: 0 });
  });
});
