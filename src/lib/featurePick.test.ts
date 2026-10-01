/**
 * What a picked feature has to say.
 *
 * The failures worth guarding are the ones that still render: a value that
 * prints as `[object Object]`, a `BigInt` that throws inside React rather
 * than in the parser, a panel headed by a batch index when the feature has a
 * perfectly good name. None of those look like bugs in a screenshot.
 */
import { describe, expect, it } from 'vitest';
import {
  cityJsonFeature, formatValue, isCityPick, tilesFeature, type TileFeatureLike,
} from './featurePick';

describe('formatValue', () => {
  it('prints scalars the way a drawing would', () => {
    expect(formatValue('Casa')).toBe('Casa');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(2.5)).toBe('2.5');
    expect(formatValue(true)).toBe('da');
    expect(formatValue(false)).toBe('nu');
  });

  it('shows an absent value as a dash rather than as nothing', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue('')).toBe('—');
    expect(formatValue('   ')).toBe('   ');   // whitespace is content, not absence
  });

  it('trims the float noise a coordinate picks up', () => {
    expect(formatValue(0.1 + 0.2)).toBe('0.3');
    expect(formatValue(1 / 3)).toBe('0.333333');
  });

  it('survives a BigInt, which React refuses to render', () => {
    expect(formatValue(BigInt('9007199254740993'))).toBe('9007199254740993');
  });

  it('reads a numeric array as a list, not as JSON', () => {
    expect(formatValue([1, 2, 3])).toBe('1, 2, 3');
    expect(formatValue([85_000.5, 446_000.25])).toBe('85000.5, 446000.25');
  });

  it('falls back to JSON for anything nested, instead of [object Object]', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([{ a: 1 }])).toBe('[{"a":1}]');
  });

  it('cuts a very long value short rather than filling the panel', () => {
    const out = formatValue({ blob: 'x'.repeat(2000) });
    expect(out.length).toBeLessThan(450);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not choke on a circular object', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => formatValue(a)).not.toThrow();
  });

  it('keeps a non-finite number visible instead of hiding it', () => {
    expect(formatValue(NaN)).toBe('NaN');
    expect(formatValue(Infinity)).toBe('Infinity');
  });
});

describe('isCityPick', () => {
  it('recognises a CityJSON instance id and nothing else', () => {
    expect(isCityPick({ cityObjectId: 'b1', type: 'Building', attributes: {} })).toBe(true);
    expect(isCityPick({ _bbIfcPinId: 'x' })).toBe(false);
    expect(isCityPick('a string')).toBe(false);
    expect(isCityPick(null)).toBe(false);
    expect(isCityPick(undefined)).toBe(false);
  });
});

describe('cityJsonFeature', () => {
  const pick = {
    cityObjectId: '2n00KBeJX7zPkHvs11EOn4',
    type: 'BuildingInstallation',
    lod: '2.2',
    parents: ['building'],
    attributes: { name: 'tr4', ifcType: 'IFCELECTRICDISTRIBUTIONBOARD', expressId: 2194 },
  };

  it('heads the panel with the name, not the identifier', () => {
    const f = cityJsonFeature(pick, 'Fotovoltaic.city.json');
    expect(f.title).toBe('tr4');
    expect(f.subtitle).toBe('BuildingInstallation');
    expect(f.layer).toBe('Fotovoltaic.city.json');
  });

  it('falls back to the id when there is no name', () => {
    const f = cityJsonFeature({ ...pick, attributes: {} }, 'x');
    expect(f.title).toBe('2n00KBeJX7zPkHvs11EOn4');
  });

  it('shows the identity CityJSON gives an object, LoD and parent included', () => {
    const f = cityJsonFeature(pick, 'x');
    expect(Object.fromEntries(f.identity)).toEqual({
      id: '2n00KBeJX7zPkHvs11EOn4',
      tip: 'BuildingInstallation',
      LoD: '2.2',
      părinte: 'building',
    });
  });

  it('does not repeat the name as a row under its own title', () => {
    const rows = Object.fromEntries(cityJsonFeature(pick, 'x').groups[0].rows);
    expect(rows.name).toBeUndefined();
    expect(rows.ifcType).toBe('IFCELECTRICDISTRIBUTIONBOARD');
    expect(rows.expressId).toBe('2194');
  });

  it('says nothing rather than showing an empty table', () => {
    expect(cityJsonFeature({ ...pick, attributes: {} }, 'x').groups).toEqual([]);
  });

  it('leaves out a level of detail and a parent it does not have', () => {
    const f = cityJsonFeature({ cityObjectId: 'b', type: 'Building', attributes: {} }, 'x');
    expect(f.identity.map(([k]) => k)).toEqual(['id', 'tip']);
  });
});

describe('tilesFeature', () => {
  const stub = (props: Record<string, unknown>, featureId?: number): TileFeatureLike => ({
    getPropertyIds: () => Object.keys(props),
    getProperty: (n) => props[n],
    featureId,
  });

  it('lists whatever the tileset author called their properties', () => {
    const f = tilesFeature(stub({ height: 12.5, bouwjaar: 1932 }), 'tiles.zip');
    expect(Object.fromEntries(f.groups[0].rows)).toEqual({ height: '12.5', bouwjaar: '1932' });
    expect(f.layer).toBe('tiles.zip');
    expect(f.source).toBe('tiles');
  });

  it('promotes a name to the title, whichever way it is spelled', () => {
    expect(tilesFeature(stub({ Name: 'Perete 24' }), 'x').title).toBe('Perete 24');
    expect(tilesFeature(stub({ title: 'Casa' }), 'x').title).toBe('Casa');
  });

  it('falls back to the feature index when there is no name at all', () => {
    expect(tilesFeature(stub({ h: 3 }, 17), 'x').title).toBe('Element 17');
    expect(tilesFeature(stub({}), 'x').title).toBe('Element');
  });

  it('reports an empty metadata table as empty instead of as broken', () => {
    const f = tilesFeature(stub({}), 'x');
    expect(f.groups).toEqual([]);
    expect(Object.fromEntries(f.identity).proprietăți).toBe('0');
  });

  it('survives a feature whose accessors throw', () => {
    const hostile: TileFeatureLike = {
      getPropertyIds: () => { throw new Error('no table'); },
      getProperty: () => { throw new Error('no table'); },
    };
    expect(() => tilesFeature(hostile, 'x')).not.toThrow();
    expect(tilesFeature(hostile, 'x').groups).toEqual([]);
  });

  it('keeps a property that throws as a row rather than losing the rest', () => {
    const partly: TileFeatureLike = {
      getPropertyIds: () => ['ok', 'bad'],
      getProperty: (n) => { if (n === 'bad') throw new Error('nope'); return 1; },
    };
    expect(Object.fromEntries(tilesFeature(partly, 'x').groups[0].rows)).toEqual({ ok: '1', bad: '—' });
  });
});
