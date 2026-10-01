/**
 * The export must show what the 3D viewer shows. These pin the precedence —
 * node override, then named material, then element default — against the
 * built-in catalogue, and the transparency pass against a hand-written file.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import { BUILTIN_MATERIAL_CONFIG, type MaterialConfig } from '@/lib/materialConfig';
import { appearanceOf, applyStyleTransparency, rgbOf } from './ifcAppearance';

const node = (type: string, properties: Record<string, unknown> = {}): BubbleGraphNode => ({
  id: 'n', type, name: 'N', x: 0, y: 0, z: 0, properties,
});

const close = (a: [number, number, number], hex: string) => {
  const e = rgbOf(hex);
  expect(a[0]).toBeCloseTo(e[0], 6);
  expect(a[1]).toBeCloseTo(e[1], 6);
  expect(a[2]).toBeCloseTo(e[2], 6);
};

describe('appearanceOf', () => {
  it('falls back to the element default, with no material written', () => {
    const a = appearanceOf(node('wall'), BUILTIN_MATERIAL_CONFIG);
    close(a.rgb, BUILTIN_MATERIAL_CONFIG.element_defaults.wall.color_3d);
    expect(a.materialName).toBeNull();
    expect(a.styleName).toBe('wall');
    expect(a.opacity).toBe(1);
  });

  it('takes a named material: its colour and its label as the IfcMaterial name', () => {
    const a = appearanceOf(node('wall', { material: 'brick' }), BUILTIN_MATERIAL_CONFIG);
    close(a.rgb, BUILTIN_MATERIAL_CONFIG.materials.brick.color_3d);
    expect(a.materialName).toBe('Brick');
    expect(a.styleName).toBe('Brick');
    expect(a.materialCategory).toBe('Wall');
  });

  it('resolves the Romanian names the roof system writes, through the alias table', () => {
    const a = appearanceOf(node('roof', { material: 'Lemn rasinos' }), BUILTIN_MATERIAL_CONFIG);
    close(a.rgb, BUILTIN_MATERIAL_CONFIG.materials.timber_structural.color_3d);
    expect(a.materialName).toBe('Structural timber');
  });

  it('lets a node\'s own colour beat its material, exactly as the viewer does', () => {
    const a = appearanceOf(node('wall', { material: 'brick', color_3d: '#112233' }), BUILTIN_MATERIAL_CONFIG);
    close(a.rgb, '#112233');
    expect(a.materialName).toBe('Brick');     // the material is still the material
  });

  it('keeps an unknown material name rather than dropping it', () => {
    const a = appearanceOf(node('wall', { material: 'Zidărie specială' }), BUILTIN_MATERIAL_CONFIG);
    expect(a.materialName).toBe('Zidărie specială');
    close(a.rgb, BUILTIN_MATERIAL_CONFIG.element_defaults.wall.color_3d);   // colour from the default
  });

  it('draws as another element kind when asked — a room\'s slab is a slab', () => {
    const a = appearanceOf(node('room'), BUILTIN_MATERIAL_CONFIG, 'slab');
    close(a.rgb, BUILTIN_MATERIAL_CONFIG.element_defaults.slab.color_3d);
    expect(a.styleName).toBe('slab');
  });

  it('carries opacity in the style name, so translucent and opaque never share a style', () => {
    const a = appearanceOf(node('window'), BUILTIN_MATERIAL_CONFIG);
    expect(a.opacity).toBeCloseTo(0.55, 9);
    expect(a.styleName).toBe('window 55%');
  });

  it('reads the user\'s settings, not the built-ins, when given them', () => {
    const custom: MaterialConfig = {
      ...BUILTIN_MATERIAL_CONFIG,
      element_defaults: {
        ...BUILTIN_MATERIAL_CONFIG.element_defaults,
        wall: { ...BUILTIN_MATERIAL_CONFIG.element_defaults.wall, color_3d: '#ffffff', opacity_3d: 0.5 },
      },
    };
    const a = appearanceOf(node('wall'), custom);
    close(a.rgb, '#ffffff');
    expect(a.styleName).toBe('wall 50%');
  });

  it('never writes NaN into a colour', () => {
    expect(rgbOf('not a colour')).toEqual([0.5, 0.5, 0.5]);
    expect(rgbOf(undefined)).toEqual([0.5, 0.5, 0.5]);
    expect(rgbOf('#abc')).toEqual(rgbOf('#aabbcc'));
  });
});

describe('applyStyleTransparency', () => {
  const file = [
    '#10=IFCCOLOURRGB($,0.2,0.7,0.9);',
    "#11=IFCSURFACESTYLERENDERING(#10,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.);",
    "#12=IFCSURFACESTYLE('window 55%',.BOTH.,(#11));",
    '#20=IFCCOLOURRGB($,0.9,0.6,0.1);',
    "#21=IFCSURFACESTYLERENDERING(#20,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.);",
    "#22=IFCSURFACESTYLE('wall',.BOTH.,(#21));",
  ].join('\n');

  it('sets Transparency = 1 − opacity on the named style\'s rendering only', () => {
    const out = applyStyleTransparency(file, new Map([['window 55%', 0.55]]));
    expect(out).toContain('#11=IFCSURFACESTYLERENDERING(#10,0.45,');
    expect(out).toContain('#21=IFCSURFACESTYLERENDERING(#20,0.,');
    expect(out.split('\n')).toHaveLength(6);
  });

  it('leaves the file alone when there is nothing translucent', () => {
    expect(applyStyleTransparency(file, new Map())).toBe(file);
    expect(applyStyleTransparency(file, new Map([['wall', 1]]))).toBe(file);
  });

  it('follows a name with a quote in it', () => {
    const quoted = file.replace("'wall'", "'Bob''s wall'");
    const out = applyStyleTransparency(quoted, new Map([["Bob's wall", 0.25]]));
    expect(out).toContain('#21=IFCSURFACESTYLERENDERING(#20,0.75,');
  });
});
