/**
 * Material resolution — the chain that decides what colour anything renders in.
 *
 * The roof bug these cover: `roof` was missing from the backend YAML's
 * element_defaults, and the roof system's own material names ("Lemn rasinos",
 * "Tigla ceramica") matched no material id, so both routes to a roof colour
 * silently did nothing and every roof fell back to a fixed built-in.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ELEMENT_DEFAULTS,
  BUILTIN_MATERIAL_CONFIG,
  FALLBACK_VISUALS,
  lookupMaterial,
  resolveVisuals,
  withBuiltinDefaults,
  type MaterialConfig,
} from './materialConfig';

/** A config shaped like the backend YAML that shipped without any roof entry. */
const LEGACY_CONFIG: MaterialConfig = {
  version: 1,
  element_defaults: { wall: { ...FALLBACK_VISUALS, color_3d: '#ffffff' } },
  materials: BUILTIN_MATERIAL_CONFIG.materials,
};

describe('resolveVisuals', () => {
  it('falls back to the built-in element default when the config omits the type', () => {
    expect(LEGACY_CONFIG.element_defaults.roof).toBeUndefined();
    expect(resolveVisuals('roof', undefined, LEGACY_CONFIG).color_3d)
      .toBe(BUILTIN_ELEMENT_DEFAULTS.roof.color_3d);
  });

  it('lets a config element default win over the built-in', () => {
    const cfg: MaterialConfig = {
      ...LEGACY_CONFIG,
      element_defaults: { ...LEGACY_CONFIG.element_defaults, roof: { ...FALLBACK_VISUALS, color_3d: '#123456' } },
    };
    expect(resolveVisuals('roof', undefined, cfg).color_3d).toBe('#123456');
  });

  it('lets a named material win over the element default', () => {
    expect(resolveVisuals('roof', 'roof_tile', BUILTIN_MATERIAL_CONFIG).color_3d)
      .toBe(BUILTIN_MATERIAL_CONFIG.materials.roof_tile.color_3d);
  });

  it('gives skylights and dormers their own defaults instead of grey fallback', () => {
    for (const t of ['skylight', 'dormer']) {
      expect(resolveVisuals(t, undefined, null).color_3d).not.toBe(FALLBACK_VISUALS.color_3d);
    }
  });

  it('still falls back for a genuinely unknown type', () => {
    expect(resolveVisuals('no_such_type', undefined, null)).toEqual(FALLBACK_VISUALS);
  });
});

describe('lookupMaterial', () => {
  const cfg = BUILTIN_MATERIAL_CONFIG;

  it('resolves the roof system\'s own material names', () => {
    // These are what roof/types.ts and roof/details.ts actually write.
    expect(lookupMaterial('Tigla ceramica', cfg)).toBe(cfg.materials.roof_tile);
    expect(lookupMaterial('Lemn rasinos', cfg)).toBe(cfg.materials.timber_structural);
  });

  it('ignores case and diacritics', () => {
    expect(lookupMaterial('Țiglă ceramică', cfg)).toBe(cfg.materials.roof_tile);
    expect(lookupMaterial('TIGLA', cfg)).toBe(cfg.materials.roof_tile);
  });

  it('matches by display label as well as id', () => {
    expect(lookupMaterial('Structural timber', cfg)).toBe(cfg.materials.timber_structural);
  });

  it('prefers an exact id over any alias or label match', () => {
    expect(lookupMaterial('wood', cfg)).toBe(cfg.materials.wood);
  });

  it('returns undefined for a name nothing knows, so resolution falls through', () => {
    expect(lookupMaterial('unobtainium', cfg)).toBeUndefined();
    expect(resolveVisuals('roof', 'unobtainium', cfg).color_3d)
      .toBe(BUILTIN_ELEMENT_DEFAULTS.roof.color_3d);
  });

  it('is safe when the config has no materials at all', () => {
    expect(lookupMaterial('Tigla ceramica', null)).toBeUndefined();
  });
});

describe('withBuiltinDefaults', () => {
  it('adds element types and materials the stored config never had', () => {
    const merged = withBuiltinDefaults(LEGACY_CONFIG);
    expect(merged.element_defaults.roof).toBeDefined();
    expect(merged.element_defaults.skylight).toBeDefined();
    expect(merged.materials.roof_tile).toBeDefined();
  });

  it('never overwrites what the stored config already defines', () => {
    const stored: MaterialConfig = {
      version: 1,
      element_defaults: { roof: { ...FALLBACK_VISUALS, color_3d: '#abcdef' } },
      materials: { roof_tile: { label: 'Mine', ...FALLBACK_VISUALS, color_3d: '#fedcba' } },
    };
    const merged = withBuiltinDefaults(stored);
    expect(merged.element_defaults.roof.color_3d).toBe('#abcdef');
    expect(merged.materials.roof_tile.color_3d).toBe('#fedcba');
    // …while still gaining the types it lacked.
    expect(merged.element_defaults.wall).toBeDefined();
  });

  it('is what makes a roof colourable against a config that predates roofs', () => {
    // The deployed backend YAML is exactly this shape: no roof anywhere.
    expect(LEGACY_CONFIG.element_defaults.roof).toBeUndefined();
    expect(resolveVisuals('roof', 'Tigla ceramica', withBuiltinDefaults(LEGACY_CONFIG)).color_3d)
      .toBe(BUILTIN_MATERIAL_CONFIG.materials.roof_tile.color_3d);
  });
});
