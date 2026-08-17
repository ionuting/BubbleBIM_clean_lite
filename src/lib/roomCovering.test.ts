import { describe, it, expect } from 'vitest';
import {
  resolveCoveringLayers,
  getRoomHeightMm,
  scaleCoveringPreset,
  COVERING_PRESETS,
  serializeCoveringLayers,
  parseCoveringLayersFromProps,
  DEFAULT_COVERING_HEIGHT_MM,
  DEFAULT_COVERING_THICKNESS_MM,
} from './roomCovering';

describe('roomCovering', () => {
  it('defaults to single full-height layer at 2800 mm / 15 mm', () => {
    const layers = resolveCoveringLayers({});
    expect(layers).toHaveLength(1);
    expect(layers[0].fromMm).toBe(0);
    expect(layers[0].toMm).toBe(DEFAULT_COVERING_HEIGHT_MM);
    expect(layers[0].heightMm).toBe(DEFAULT_COVERING_HEIGHT_MM);
    expect(layers[0].thicknessMm).toBe(DEFAULT_COVERING_THICKNESS_MM);
  });

  it('parses multi-layer covering_layers JSON', () => {
    const props = {
      height: 2800,
      covering_layers: serializeCoveringLayers([
        { from_mm: 0, to_mm: 1500, material: 'ceramic_tile', thickness_mm: 15, color_3d: '#EEE' },
        { from_mm: 1500, to_mm: 2800, material: 'plaster', thickness_mm: 15 },
      ]),
    };
    const layers = resolveCoveringLayers(props);
    expect(layers).toHaveLength(2);
    expect(layers[0].material).toBe('ceramic_tile');
    expect(layers[0].color3d).toBe('#EEE');
    expect(layers[1].fromMm).toBe(1500);
    expect(layers[1].heightMm).toBe(1300);
  });

  it('migrates legacy single covering_height/thickness props', () => {
    const layers = resolveCoveringLayers({
      height: 2650,
      covering_height: 2650,
      covering_thickness: 20,
      covering_material: 'gypsum',
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].toMm).toBe(2650);
    expect(layers[0].thicknessMm).toBe(20);
    expect(layers[0].material).toBe('gypsum');
  });

  it('converts legacy metre height (2.80) to mm', () => {
    expect(getRoomHeightMm({ height: 2.8 })).toBe(2800);
  });

  it('scales bathroom preset to room height', () => {
    const scaled = scaleCoveringPreset(COVERING_PRESETS.bathroom.layers, 3000);
    expect(scaled[0].from_mm).toBe(0);
    expect(scaled[scaled.length - 1].to_mm).toBe(3000);
    expect(parseCoveringLayersFromProps({ covering_layers: serializeCoveringLayers(scaled) })).not.toBeNull();
  });
});
