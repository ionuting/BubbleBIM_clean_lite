import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import { heightZonesOf, isZonable, parseZoneSpecs, renderBandsOf, zoneNode, ZONE_PROPERTY } from './heightZones';
import { specMaterial } from '@/lib/norms/specs';

const node = (type: string, properties: Record<string, unknown>): BubbleGraphNode =>
  ({ id: 'n1', type, name: 'n1', x: 0, y: 0, z: 0, properties } as BubbleGraphNode);

const bathroom = JSON.stringify([
  { from_mm: 0, to_mm: 1500, material: 'ceramic_tile', spec: 'faianta:standard, tencuiala_int:fara' },
  { from_mm: 1500, to_mm: 2800, material: 'plaster' },
]);

describe('isZonable', () => {
  it('covers exactly the three the user asked for', () => {
    expect(['room', 'wall', 'shell'].every(isZonable)).toBe(true);
    expect(isZonable('slab')).toBe(false);
    expect(ZONE_PROPERTY.room).toBe('covering_layers');
    expect(ZONE_PROPERTY.wall).toBe('wall_layers');
  });
});

describe('parseZoneSpecs', () => {
  it('reads `group:option` pairs for the node type', () => {
    expect(parseZoneSpecs('faianta:standard, tencuiala_int:fara', 'room'))
      .toEqual({ faianta: 'standard', tencuiala_int: 'fara' });
  });

  it('ignores a group the node type cannot carry', () => {
    // `zidarie` applies to walls, not rooms — a room must not start producing masonry.
    expect(parseZoneSpecs('zidarie:bca25', 'room')).toEqual({});
    expect(parseZoneSpecs('zidarie:bca25', 'wall')).toEqual({ zidarie: 'bca25' });
  });

  it('ignores an option that does not exist — a typo invents nothing', () => {
    expect(parseZoneSpecs('faianta:marmura_de_carrara', 'room')).toEqual({});
  });

  it('accepts an object as well as a string', () => {
    expect(parseZoneSpecs({ faianta: 'portelanata' }, 'room')).toEqual({ faianta: 'portelanata' });
    expect(parseZoneSpecs(null, 'room')).toEqual({});
  });
});

describe('heightZonesOf', () => {
  it('reads the room covering layers the app already had', () => {
    const z = heightZonesOf(node('room', { covering_layers: bathroom }), 2.8)!;
    expect(z).toHaveLength(2);
    expect(z[0].fromM).toBe(0);
    expect(z[0].toM).toBe(1.5);
    expect(z[0].specs).toEqual({ faianta: 'standard', tencuiala_int: 'fara' });
    expect(z[1].heightM).toBeCloseTo(1.3, 6);
  });

  it('reads the wall layers, and a band may carry its own wall type', () => {
    const wall = node('wall', {
      wall_layers: JSON.stringify([
        { from_mm: 0, to_mm: 300, wall_type: 'W25', spec: 'zidarie:bca25' },
        { from_mm: 300, to_mm: 3000, wall_type: 'W20' },
      ]),
    });
    const z = heightZonesOf(wall, 3)!;
    expect(z[0].props).toEqual({ wall_type: 'W25' });
    expect(z[0].specs).toEqual({ zidarie: 'bca25' });
    expect(z[1].props).toEqual({ wall_type: 'W20' });
  });

  it('reads shell_zones — the envelope bands too', () => {
    const shell = node('shell', {
      shell_zones: JSON.stringify([
        { from_mm: 0, to_mm: 500, spec: 'termoizolatie:eps15' },
        { from_mm: 500, to_mm: 3000 },
      ]),
    });
    expect(heightZonesOf(shell, 3)!.map((z) => z.specs))
      .toEqual([{ termoizolatie: 'eps15' }, {}]);
  });

  it('a single band is not a zoning — null means "measure as before"', () => {
    expect(heightZonesOf(node('room', { covering_layers: JSON.stringify([{ from_mm: 0, to_mm: 2800 }]) }), 2.8)).toBeNull();
    expect(heightZonesOf(node('room', {}), 2.8)).toBeNull();
    expect(heightZonesOf(node('slab', { covering_layers: bathroom }), 2.8)).toBeNull();
  });

  it('a room with the covering switched off carries no bands', () => {
    expect(heightZonesOf(node('room', { covering_layers: bathroom, has_covering: 'False' }), 2.8)).toBeNull();
  });

  it('bands are cut on the MEASURED height, not the one written in the properties', () => {
    // The stored layers stop at 2.8; the element really is 2.5 tall.
    const z = heightZonesOf(node('room', { covering_layers: bathroom }), 2.5)!;
    expect(z[1].toM).toBe(2.5);
    expect(z.reduce((s, b) => s + b.heightM, 0)).toBeCloseTo(2.5, 6);
  });

  it('the top band is stretched to the top — a gap would be quantity lost in silence', () => {
    const short = JSON.stringify([{ from_mm: 0, to_mm: 1000 }, { from_mm: 1000, to_mm: 2000 }]);
    const z = heightZonesOf(node('room', { covering_layers: short }), 3)!;
    expect(z[z.length - 1].toM).toBe(3);
    expect(z.reduce((s, b) => s + b.heightM, 0)).toBeCloseTo(3, 6);
  });

  it('bands always cover the whole element, whatever the order they were written in', () => {
    const reversed = JSON.stringify([
      { from_mm: 1500, to_mm: 2800 },
      { from_mm: 0, to_mm: 1500, spec: 'faianta:standard' },
    ]);
    const z = heightZonesOf(node('room', { covering_layers: reversed }), 2.8)!;
    expect(z[0].fromM).toBe(0);
    expect(z[0].specs).toEqual({ faianta: 'standard' });
    expect(z.reduce((s, b) => s + b.heightM, 0)).toBeCloseTo(2.8, 6);
  });

  it('labels the band by its elevations, for the calculation memo', () => {
    expect(heightZonesOf(node('room', { covering_layers: bathroom }), 2.8)![0].label).toBe('0.00–1.50 m');
  });
});

describe('zoneNode', () => {
  it('writes the band choices where resolveSpecs already looks for them', () => {
    const room = node('room', { covering_layers: bathroom, height: 2800 });
    const z = heightZonesOf(room, 2.8)!;
    const zn = zoneNode(room, z[0]);
    expect(zn.properties.spec_faianta).toBe('standard');
    expect(zn.properties.spec_tencuiala_int).toBe('fara');
    expect(zn.id).toBe(room.id);          // F3 rows still point at the real element
    expect(room.properties.spec_faianta).toBeUndefined();  // the original is untouched
  });
});

describe('renderBandsOf — the bridge from the bill of quantities to the 3D view', () => {
  it('gives the envelope bands the material its specification puts in place', () => {
    const shell = node('shell', {
      shell_zones: JSON.stringify([
        { from_mm: 0, to_mm: 500, spec: 'tencuiala_ext:decorativa' },
        { from_mm: 500, to_mm: 3000 },
      ]),
    });
    const bands = renderBandsOf(shell, 3)!;
    expect(bands).toHaveLength(2);
    expect(bands[0]).toMatchObject({ fromM: 0, heightM: 0.5, material: 'plaster' });
    // A band that chooses nothing inherits the element — never a guess.
    expect(bands[1].material).toBeUndefined();
  });

  it('a tiled room band draws as tile', () => {
    const bands = renderBandsOf(node('room', { covering_layers: bathroom }), 2.8)!;
    expect(bands[0].material).toBe('ceramic_tile');
  });

  it('an AAC socle band draws as AAC', () => {
    const wall = node('wall', {
      wall_layers: JSON.stringify([
        { from_mm: 0, to_mm: 300, spec: 'zidarie:bca25' },
        { from_mm: 300, to_mm: 3000 },
      ]),
    });
    expect(renderBandsOf(wall, 3)![0].material).toBe('aac_block');
  });

  it('an unbanded element returns null — the viewers draw one ring, as before', () => {
    expect(renderBandsOf(node('shell', {}), 3)).toBeNull();
  });
});

describe('specMaterial', () => {
  it('reads only what was explicitly chosen — defaults must not repaint the model', () => {
    // `tencuiala_int:ipsos` IS the default. Resolving defaults and painting from
    // them would turn every room in every existing project plaster-coloured.
    expect(specMaterial({})).toBeUndefined();
    expect(specMaterial({ tencuiala_int: 'ipsos' })).toBe('plaster');
    expect(specMaterial({ faianta: 'standard' })).toBe('ceramic_tile');
    expect(specMaterial({ faianta: 'fara' })).toBeUndefined();
  });
});
