import { describe, it, expect } from 'vitest';
import {
  resolveWallLayers,
  scaleWallLayerPreset,
  WALL_LAYER_PRESETS,
  serializeWallLayers,
  getWallHeightMm,
} from './wallLayers';

describe('wallLayers', () => {
  it('defaults to single full-height layer from legacy material', () => {
    const layers = resolveWallLayers({ height: 3000, material: 'brick', wall_type: 'W20' });
    expect(layers).toHaveLength(1);
    expect(layers[0].fromMm).toBe(0);
    expect(layers[0].toMm).toBe(3000);
    expect(layers[0].material).toBe('brick');
  });

  it('parses multi-layer wall_layers JSON', () => {
    const props = {
      height: 3000,
      wall_layers: serializeWallLayers([
        { from_mm: 0, to_mm: 600, material: 'aac_block', wall_type: 'W20' },
        { from_mm: 600, to_mm: 3000, material: 'brick', wall_type: 'W20' },
      ]),
    };
    const layers = resolveWallLayers(props);
    expect(layers).toHaveLength(2);
    expect(layers[0].material).toBe('aac_block');
    expect(layers[1].heightMm).toBe(2400);
  });

  it('scales BCA socle preset to wall height', () => {
    const scaled = scaleWallLayerPreset(WALL_LAYER_PRESETS.bca_socle.layers, 3200);
    expect(scaled[0].from_mm).toBe(0);
    expect(scaled[scaled.length - 1].to_mm).toBe(3200);
  });

  it('converts legacy metre height', () => {
    expect(getWallHeightMm({ height: 3 })).toBe(3000);
  });
});
