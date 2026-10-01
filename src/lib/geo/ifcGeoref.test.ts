/**
 * The georeference has to survive the whole way out and back: model →
 * GeoReference → STEP text → parsed STEP → GeoReference. Each hop has its own
 * way of losing a sign or a convention, and only the full loop catches them.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge, WorldLocation } from '@/store';
import { buildIfcModel } from '@/lib/ifc/buildIfcModel';
import { parseIfcPlan } from '@/lib/ifcStepParser';
import { georefFromWorldLocation, worldLocationFromGeoref } from './georeference';
import { readGeoreference, writeGeoreference } from './ifcGeoref';
import { utmCrs } from './crs';
import { tokeniseArgs, STEP_LINE_RE } from '@/lib/ifc/stepText';

/** A real third-party IFC, kept out of the repository: its tests run where the file is. */
const FIXTURE = 'idas/Fotovoltaic_panels_2.ifc';
const itWithFixture = it.skipIf(!existsSync(FIXTURE));

const STEREO = 'EPSG:3844';

const loc = (over: Partial<WorldLocation> = {}): WorldLocation => ({
  lat: 44.4268, lng: 26.1025, alt: 85, offsetE: 0, offsetN: 0, offsetZ: 0, rotation: 0, ...over,
});

/** The smallest graph `buildIfcModel` will emit a site and a storey for. */
function tinyGraph(): { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } {
  const storey: BubbleGraphNode = {
    id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
    properties: { bottomElevation: 0, topElevation: 3000 },
  } as BubbleGraphNode;
  const ax = (id: string, x: number, y: number): BubbleGraphNode => ({
    id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
    properties: { bimX: x, bimY: y, has_column: 'True', column_type: 'C30x30' },
  } as unknown as BubbleGraphNode);
  const a = ax('a', 0, 0);
  const b = ax('b', 5000, 0);
  const w: BubbleGraphNode = {
    id: 'w', type: 'wall', name: 'w', x: 0, y: 0, z: 0, parentId: 'st',
    properties: { wall_type: 'W20' },
  } as BubbleGraphNode;
  return {
    nodes: [storey, a, b, w],
    edges: [{ id: 'e0', from: 'a', to: 'w' }, { id: 'e1', from: 'w', to: 'b' }],
  };
}

function exportWith(location: WorldLocation, schema: 'IFC2X3' | 'IFC4' = 'IFC4') {
  const { nodes, edges } = tinyGraph();
  const gr = georefFromWorldLocation(location, STEREO);
  const { content } = buildIfcModel(nodes, edges, 'Test', {
    schema, georeference: gr,
    georeferenceOptions: { geodeticDatum: 'Pulkovo 1942(58)', mapProjection: 'Stereo 70' },
  });
  return { content, gr };
}

/** Pull one entity's arguments straight out of the STEP text. */
function entityArgs(text: string, type: string): string[] | null {
  for (const line of text.split('\n')) {
    const m = STEP_LINE_RE.exec(line.trim());
    if (m && m[2].toUpperCase() === type) return tokeniseArgs(m[3]);
  }
  return null;
}

/** Arguments of `#id`. Needed because a file is full of IfcDirections and
 *  only the one the context points at is the true north. */
function argsById(text: string, idRef: string): string[] | null {
  const want = idRef.replace('#', '');
  for (const line of text.split('\n')) {
    const m = STEP_LINE_RE.exec(line.trim());
    if (m && m[1] === want) return tokeniseArgs(m[3]);
  }
  return null;
}

async function reparse(content: string) {
  const buf = new TextEncoder().encode(content);
  return parseIfcPlan(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

describe('writing a georeference into IFC', () => {
  it('fills the IfcSite slots that ifc-lite leaves empty', () => {
    const { content } = exportWith(loc());
    const site = entityArgs(content, 'IFCSITE')!;
    expect(site[9]).toBe('(44,25,36,480000)');   // RefLatitude
    expect(site[10]).toBe('(26,6,9,0)');          // RefLongitude
    expect(site[11]).toBe('85.');                 // RefElevation — a STEP real
  });

  it('writes IfcMapConversion against the named CRS', () => {
    const { content, gr } = exportWith(loc());
    const mc = entityArgs(content, 'IFCMAPCONVERSION')!;
    expect(parseFloat(mc[2])).toBeCloseTo(gr.eastings, 6);
    expect(parseFloat(mc[3])).toBeCloseTo(gr.northings, 6);
    expect(parseFloat(mc[4])).toBeCloseTo(85, 6);
    expect(parseFloat(mc[7])).toBe(1);            // Scale
    const crs = entityArgs(content, 'IFCPROJECTEDCRS')!;
    expect(crs[0]).toBe("'EPSG:3844'");
    expect(crs[2]).toBe("'Pulkovo 1942(58)'");
    expect(crs[4]).toBe("'Stereo 70'");
    // The conversion must point at the model's own context, not a dangling id.
    const ctxRef = mc[0];
    expect(ctxRef.startsWith('#')).toBe(true);
    expect(content).toContain(`${ctxRef}=IFCGEOMETRICREPRESENTATIONCONTEXT`);
  });

  it('sets TrueNorth on the context, which ifc-lite leaves as $', () => {
    const plain = buildIfcModel(tinyGraph().nodes, tinyGraph().edges, 'Test', {}).content;
    expect(entityArgs(plain, 'IFCGEOMETRICREPRESENTATIONCONTEXT')![5]).toBe('$');

    const { content } = exportWith(loc({ rotation: 90 }));
    const ctx = entityArgs(content, 'IFCGEOMETRICREPRESENTATIONCONTEXT')!;
    expect(ctx[5]).toMatch(/^#\d+$/);
    const dir = argsById(content, ctx[5])!;
    // At heading 90° the model's +Y faces east, so true north is at -X.
    const parts = tokeniseArgs(dir[0].replace(/^\(|\)$/g, '')).map(Number);
    expect(parts[0]).toBeCloseTo(-1, 5);
    expect(parts[1]).toBeCloseTo(0, 5);
  });

  it('leaves the file alone when no georeference is given', () => {
    const { nodes, edges } = tinyGraph();
    const { content } = buildIfcModel(nodes, edges, 'Test', {});
    expect(content).not.toContain('IFCMAPCONVERSION');
    expect(entityArgs(content, 'IFCSITE')![9]).toBe('$');
  });

  it('omits IfcMapConversion on IFC2X3, where it does not exist', () => {
    const { content } = exportWith(loc(), 'IFC2X3');
    expect(content).not.toContain('IFCMAPCONVERSION');
    expect(content).not.toContain('IFCPROJECTEDCRS');
    // …but the IfcSite position still lands, which is the whole point of
    // writing both mechanisms.
    expect(entityArgs(content, 'IFCSITE')![9]).toBe('(44,25,36,480000)');
  });

  it('refuses to guess when there is no IfcSite to anchor to', () => {
    const text = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCWALL('x');\nENDSEC;\nEND-ISO-10303-21;\n";
    expect(writeGeoreference(text, georefFromWorldLocation(loc(), STEREO))).toBe(text);
  });

  it('stays a valid STEP file — one entity per line, ids unique', () => {
    const { content } = exportWith(loc({ rotation: 33 }));
    const ids = new Set<number>();
    for (const line of content.split('\n')) {
      const m = STEP_LINE_RE.exec(line.trim());
      if (!m) continue;
      const id = parseInt(m[1], 10);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(content.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    // The appended entities went INSIDE the data section, not after its end.
    expect(content.indexOf('IFCMAPCONVERSION')).toBeLessThan(content.lastIndexOf('ENDSEC;'));
  });
});

describe('placing an already georeferenced file again', () => {
  it('rewrites the IfcMapConversion it has instead of adding a second', async () => {
    const first = exportWith(loc({ rotation: 10 })).content;
    const moved = georefFromWorldLocation(loc({ lat: 45.75, lng: 21.23, rotation: 70, alt: 90 }), STEREO);
    const again = writeGeoreference(first, moved, { schema: 'IFC4' });

    expect(again.match(/IFCMAPCONVERSION/g)?.length).toBe(1);
    expect(again.match(/IFCPROJECTEDCRS/g)?.length).toBe(1);
    const back = (await reparse(again)).georeference!;
    expect(back.eastings).toBeCloseTo(moved.eastings, 3);
    expect(back.northings).toBeCloseTo(moved.northings, 3);
    expect(back.orthogonalHeight).toBeCloseTo(90, 6);
    const wl = worldLocationFromGeoref(back);
    expect(Math.abs(wl.lat - 45.75) * 111_320_000).toBeLessThan(5);
    expect(((wl.rotation % 360) + 360) % 360).toBeCloseTo(70, 4);
    // IfcSite followed along too — both mechanisms, both updated.
    expect(entityArgs(again, 'IFCSITE')![9]).toBe('(45,45,0,0)');
  });

  it('changes the CRS name when the second placement uses another grid', () => {
    const first = exportWith(loc()).content;
    const utm = georefFromWorldLocation(loc(), utmCrs(35));
    const again = writeGeoreference(first, utm, { schema: 'IFC4' });
    expect(entityArgs(again, 'IFCPROJECTEDCRS')![0]).toBe("'EPSG:32635'");
    // Datum details that were not re-supplied are kept, not blanked.
    expect(entityArgs(again, 'IFCPROJECTEDCRS')![2]).toBe("'Pulkovo 1942(58)'");
  });

  it('reads the schema family off the header', async () => {
    const { detectIfcSchema } = await import('@/lib/ifc/stepText');
    expect(detectIfcSchema(exportWith(loc(), 'IFC2X3').content)).toBe('IFC2X3');
    expect(detectIfcSchema(exportWith(loc(), 'IFC4').content)).toBe('IFC4');
    expect(detectIfcSchema("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;")).toBe('IFC4X3');
    expect(detectIfcSchema('no header at all')).toBe('IFC4');
  });
});

describe('round trip through a real file', () => {
  it('exports and re-reads the same position and heading', async () => {
    for (const rotation of [0, 37.5, 90, 180, 285]) {
      const { content, gr } = exportWith(loc({ rotation }));
      const parsed = await reparse(content);
      const back = parsed.georeference;
      expect(back).not.toBeNull();
      expect(back!.crs).toBe(STEREO);
      expect(back!.eastings).toBeCloseTo(gr.eastings, 3);
      expect(back!.northings).toBeCloseTo(gr.northings, 3);
      expect(back!.orthogonalHeight).toBeCloseTo(gr.orthogonalHeight, 6);
      expect(back!.xAxisAbscissa).toBeCloseTo(gr.xAxisAbscissa, 6);
      expect(back!.xAxisOrdinate).toBeCloseTo(gr.xAxisOrdinate, 6);

      // And all the way back to a WorldLocation the globe can use.
      const wl = worldLocationFromGeoref(back!);
      expect(Math.abs(wl.lat - 44.4268) * 111_320_000).toBeLessThan(5);
      expect(Math.abs(wl.lng - 26.1025) * 111_320_000).toBeLessThan(5);
      expect(((wl.rotation % 360) + 360) % 360).toBeCloseTo(rotation, 4);
    }
  });

  it('recovers the position from an IFC2X3 file, which has only IfcSite', async () => {
    const { content } = exportWith(loc({ rotation: 20 }), 'IFC2X3');
    const back = (await reparse(content)).georeference;
    expect(back).not.toBeNull();
    // No IfcProjectedCRS to read, so a grid is chosen: the site's UTM zone.
    expect(back!.crs).toBe('EPSG:32635');
    const wl = worldLocationFromGeoref(back!);
    // IfcSite is only good to a millionth of an arc-second — a few
    // centimetres — which is exactly why IfcMapConversion exists.
    expect(Math.abs(wl.lat - 44.4268) * 111_320_000).toBeLessThan(100);
    expect(Math.abs(wl.lng - 26.1025) * 111_320_000).toBeLessThan(100);
    // The heading survives, through TrueNorth rather than through the axes.
    expect(((wl.rotation % 360) + 360) % 360).toBeCloseTo(20, 3);
  });

  it('reports null for a file that says nothing about where it is', async () => {
    const { nodes, edges } = tinyGraph();
    const { content } = buildIfcModel(nodes, edges, 'Test', {});
    expect((await reparse(content)).georeference).toBeNull();
  });
});

describe('reading a foreign file', () => {
  const entities = (rows: [number, string, string[]][]) =>
    new Map(rows.map(([id, type, args]) => [id, [type, args] as [string, string[]]]));

  it('normalises an axis pair that a writer rounded off unit length', () => {
    // 0.7071/0.7071 is not quite unit; left alone it would scale every
    // coordinate read through it by 1.00005.
    const gr = readGeoreference(entities([
      [1, 'IFCPROJECTEDCRS', ["'EPSG:3844'", '$', '$', '$', '$', '$', '$']],
      [2, 'IFCMAPCONVERSION', ['#9', '#1', '500000.', '400000.', '90.', '0.7071', '0.7071', '1.']],
    ]))!;
    expect(Math.hypot(gr.xAxisAbscissa, gr.xAxisOrdinate)).toBeCloseTo(1, 12);
  });

  it('says the CRS is unknown rather than pretending it is WGS84', () => {
    const gr = readGeoreference(entities([
      [2, 'IFCMAPCONVERSION', ['#9', '$', '500000.', '400000.', '90.', '1.', '0.', '1.']],
    ]))!;
    // '' is not a CRS anyone can unproject with — which is the honest answer
    // for grid coordinates whose system the file never named.
    expect(gr.crs).toBe('');
    expect(gr.eastings).toBe(500000);
  });

  it('defaults a missing scale to 1 rather than to zero', () => {
    const gr = readGeoreference(entities([
      [2, 'IFCMAPCONVERSION', ['#9', '$', '500000.', '400000.', '90.', '1.', '0.', '$']],
    ]))!;
    expect(gr.scale).toBe(1);
  });

  it('reads a negative latitude written the way the spec requires', () => {
    const gr = readGeoreference(entities([
      [1, 'IFCSITE', ['$', '$', '$', '$', '$', '$', '$', '$', '.ELEMENT.',
        '(-33,-51,-54,-360000)', '(151,12,34,0)', '19.']],
    ]))!;
    expect(gr.lat).toBeCloseTo(-33.8651, 6);
    expect(gr.lng).toBeCloseTo(151.209444, 5);
    // Sydney — and the chosen grid follows the site, not Romania.
    expect(gr.crs).toBe('EPSG:32656');
  });
});

// ── The grid chosen for where the model is, and the round trip in it ─────
// A Romanian default once followed a model to Granada and wrote Stereo 70
// coordinates from two thousand kilometres outside the grid. The grid now
// follows the model; the placement has to come back through it unchanged,
// and the numbers have to be the ones a Spanish surveyor would recognise.
describe('a model placed abroad', () => {
  const GRANADA = { lat: 37.08372566, lng: -3.75439388 };

  it('is written in the grid of where it stands, with sensible coordinates', async () => {
    const { crsForLocation } = await import('./countries');
    const crs = crsForLocation(GRANADA.lat, GRANADA.lng, 'EPSG:3844');
    expect(crs).toBe('EPSG:25830');
    const gr = georefFromWorldLocation(loc({ ...GRANADA, alt: 787, rotation: 71 }), crs);
    // ETRS89 / UTM 30N around Granada: ~445 km east, ~4,105 km north.
    expect(gr.eastings).toBeGreaterThan(430_000);
    expect(gr.eastings).toBeLessThan(470_000);
    expect(gr.northings).toBeGreaterThan(4_090_000);
    expect(gr.northings).toBeLessThan(4_120_000);
  });

  itWithFixture('survives export and re-import through a real IFC, heading included', async () => {
    const fs = await import('node:fs');
    const { crsForLocation } = await import('./countries');
    const text = fs.readFileSync(FIXTURE, 'utf8');
    // The file says nothing about where it is.
    expect((await reparse(text)).georeference).toBeNull();

    const crs = crsForLocation(GRANADA.lat, GRANADA.lng, 'EPSG:3844');
    for (const rotation of [0, 71, 342]) {
      const placed = georefFromWorldLocation(loc({ ...GRANADA, alt: 787, rotation }), crs);
      const out = writeGeoreference(text, placed, { schema: 'IFC4X3' });
      const back = (await reparse(out)).georeference!;
      expect(back.crs).toBe('EPSG:25830');
      expect(back.eastings).toBeCloseTo(placed.eastings, 3);
      expect(back.northings).toBeCloseTo(placed.northings, 3);
      const wl = worldLocationFromGeoref(back);
      expect(Math.abs(wl.lat - GRANADA.lat) * 111_320_000).toBeLessThan(5);
      expect(Math.abs(wl.lng - GRANADA.lng) * 111_320_000).toBeLessThan(5);
      expect(wl.alt).toBeCloseTo(787, 6);
      expect(((wl.rotation % 360) + 360) % 360).toBeCloseTo(rotation, 4);
      // Placed a second time it is rewritten, not doubled.
      const twice = writeGeoreference(out, placed, { schema: 'IFC4X3' });
      expect(twice.match(/IFCMAPCONVERSION/g)?.length).toBe(1);
    }
  });
});

describe('a file that was georeferenced in the wrong grid', () => {
  itWithFixture('keeps its position and heading, and is re-placed in the grid of where it is', async () => {
    const fs = await import('node:fs');
    const { crsForLocation, crsValidAt } = await import('./countries');
    // A Granada model once written in Stereo 70 by this app's old default.
    const src = fs.readFileSync(FIXTURE, 'utf8');
    const GR = { lat: 37.08337384, lng: -3.75561040 };
    const wrong = writeGeoreference(src, georefFromWorldLocation(loc({ ...GR, alt: 786, rotation: 342 }), STEREO), { schema: 'IFC4X3' });

    const gr = (await reparse(wrong)).georeference!;
    expect(gr.crs).toBe(STEREO);
    // The numbers are self-consistent: the geodetic reading is right…
    const wl = worldLocationFromGeoref(gr);
    expect(Math.abs(wl.lat - GR.lat) * 111_320_000).toBeLessThan(5);
    expect(((wl.rotation % 360) + 360) % 360).toBeCloseTo(342, 4);
    // …but the grid does not cover the point, so the import picks another,
    expect(crsValidAt(gr.crs, wl.lat, wl.lng)).toBe(false);
    const crs = crsForLocation(wl.lat, wl.lng, null);
    expect(crs).toBe('EPSG:25830');
    // and re-exporting in it leaves the same place and heading behind.
    const fixed = writeGeoreference(wrong, georefFromWorldLocation(wl, crs), { schema: 'IFC4X3' });
    expect(fixed.match(/IFCMAPCONVERSION/g)?.length).toBe(1);
    expect(entityArgs(fixed, 'IFCPROJECTEDCRS')![0]).toBe("'EPSG:25830'");
    const back = worldLocationFromGeoref((await reparse(fixed)).georeference!);
    expect(Math.abs(back.lat - GR.lat) * 111_320_000).toBeLessThan(5);
    expect(Math.abs(back.lng - GR.lng) * 111_320_000).toBeLessThan(5);
    expect(((back.rotation % 360) + 360) % 360).toBeCloseTo(342, 4);
  });
});
