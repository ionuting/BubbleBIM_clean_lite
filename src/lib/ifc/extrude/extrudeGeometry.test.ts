import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  contourLineGeometry, extrudedSolidEdges, extrudedSolidGeometry, toThree,
} from './extrudeGeometry';
import {
  createExtrusion, setHeight, withPlacement, type ExtrudedSolid, type Pt2,
} from './extrudedSolid';

const p = (x: number, y: number): Pt2 => ({ x, y });
const RECT = [p(10, 20), p(14, 20), p(14, 26), p(10, 26)];   // 4 × 6, centroid (12, 23)

function solid(): ExtrudedSolid {
  const made = createExtrusion(RECT, { height: 3 });
  if (!made.ok) throw new Error('fixture rejected');
  return made.solid;
}

function bounds(geo: THREE.BufferGeometry) {
  geo.computeBoundingBox();
  return geo.boundingBox!;
}

describe('axis mapping', () => {
  it('sends up to Three Y and north to negative Three Z', () => {
    // Compared component-wise: negating a zero gives -0, which is the same
    // point and a different value to a deep-equality check.
    const close = (got: number[], want: number[]) =>
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 12));
    close(toThree(1, 0, 0), [1, 0, 0]);     // east  → +x
    close(toThree(0, 1, 0), [0, 0, -1]);    // north → −z
    close(toThree(0, 0, 1), [0, 1, 0]);     // up    → +y
  });
});

describe('extrudedSolidGeometry', () => {
  it('closes the prism: two caps plus one quad per edge', () => {
    const geo = extrudedSolidGeometry(solid())!;
    const verts = geo.getAttribute('position').count;
    // 4-gon → 2 fan triangles per cap × 2 caps = 4, plus 4 edges × 2 = 8.
    expect(verts).toBe((4 + 8) * 3);
  });

  it('spans exactly the footprint and the height, in Three axes', () => {
    const b = bounds(extrudedSolidGeometry(setHeight(solid(), 3))!);
    expect(b.min.x).toBeCloseTo(10, 5);
    expect(b.max.x).toBeCloseTo(14, 5);
    expect(b.min.y).toBeCloseTo(0, 5);       // base at z = 0
    expect(b.max.y).toBeCloseTo(3, 5);       // height 3 m up
    expect(b.min.z).toBeCloseTo(-26, 5);     // north is −z
    expect(b.max.z).toBeCloseTo(-20, 5);
  });

  it('follows the elevation, so a solid raised 10 m starts at 10 m', () => {
    const b = bounds(extrudedSolidGeometry(withPlacement(setHeight(solid(), 3), { z: 10 }))!);
    expect(b.min.y).toBeCloseTo(10, 5);
    expect(b.max.y).toBeCloseTo(13, 5);
  });

  it('bakes rotation and scale into the vertices, so the mesh needs no transform', () => {
    const turned = bounds(extrudedSolidGeometry(withPlacement(solid(), { rotation: 90 }))!);
    expect(turned.max.x - turned.min.x).toBeCloseTo(6, 4);   // 4 × 6 became 6 × 4
    expect(turned.max.z - turned.min.z).toBeCloseTo(4, 4);

    const big = bounds(extrudedSolidGeometry(withPlacement(setHeight(solid(), 3), { sx: 2, sz: 2 }))!);
    expect(big.max.x - big.min.x).toBeCloseTo(8, 4);
    expect(big.max.y - big.min.y).toBeCloseTo(6, 4);
  });

  it('gives the caps opposite normals, so the prism is solid from outside', () => {
    const geo = extrudedSolidGeometry(solid())!;
    const n = geo.getAttribute('normal');
    // First triangle is the top cap, fourth vertex starts the bottom one.
    expect(n.getY(0)).toBeCloseTo(1, 5);
    expect(n.getY(3)).toBeCloseTo(-1, 5);
  });

  it('declines a ring that is not a ring', () => {
    const bad = { ...solid(), profile: [p(0, 0), p(1, 0)] };
    expect(extrudedSolidGeometry(bad)).toBeNull();
  });
});

describe('extrudedSolidEdges', () => {
  it('draws both rings and every vertical', () => {
    const geo = extrudedSolidEdges(solid())!;
    // 4 edges × (bottom + top + one vertical) × 2 endpoints.
    expect(geo.getAttribute('position').count).toBe(4 * 3 * 2);
  });
});

describe('contourLineGeometry', () => {
  it('needs two points before there is a line to draw', () => {
    expect(contourLineGeometry([p(0, 0)], 0)).toBeNull();
    expect(contourLineGeometry([], 0)).toBeNull();
  });

  it('adds the closing segment only when asked', () => {
    const open = contourLineGeometry([p(0, 0), p(4, 0), p(4, 3)], 0)!;
    const shut = contourLineGeometry([p(0, 0), p(4, 0), p(4, 3)], 0, true)!;
    expect(open.getAttribute('position').count).toBe(3);
    expect(shut.getAttribute('position').count).toBe(4);
  });

  it('sits on the plane it was given', () => {
    const geo = contourLineGeometry([p(0, 0), p(4, 0)], 7.5)!;
    expect(geo.getAttribute('position').getY(0)).toBeCloseTo(7.5, 5);
  });
});
