import { describe, it, expect } from 'vitest';
import {
  boxSolid, bounds, buildTopology, centroid, cylinderSolid, extrudeFootprint, extrudePolygon3,
  faceArea, flipSolid, isManifold, makeSolid, signedVolume, surfaceArea, sweepBox,
  tessellate, translateSolid, triangulateFace, validateSolid, volume, volumeM3,
  type Solid, type Vec2, type Vec3,
} from './index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Every edge used by exactly two faces, in opposite directions. */
function expectManifold(solid: Solid) {
  const diags = validateSolid(solid);
  expect(diags.filter((d) => d.severity === 'error')).toEqual([]);
  const topo = buildTopology(solid);
  for (const uses of topo.byEdge.values()) expect(uses.length).toBe(2);
  for (const he of topo.halfEdges) expect(he.twin).toBeGreaterThanOrEqual(0);
}

const square = (s: number): Vec2[] => [
  { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
];

// ─── Prisms ───────────────────────────────────────────────────────────────────

describe('extrudeFootprint', () => {
  it('a 1 m cube is closed, manifold and measures correctly', () => {
    const s = extrudeFootprint(square(1000), 0, 1000)!;
    expectManifold(s);
    expect(s.vertices.length).toBe(8);
    expect(s.faces.length).toBe(6);
    expect(volume(s)).toBeCloseTo(1e9, 3);   // mm³
    expect(volumeM3(s)).toBeCloseTo(1, 9);
    expect(surfaceArea(s)).toBeCloseTo(6e6, 3);
  });

  it('normals point outward regardless of input winding', () => {
    const ccw = extrudeFootprint(square(1000), 0, 1000)!;
    const cw = extrudeFootprint([...square(1000)].reverse(), 0, 1000)!;
    for (const s of [ccw, cw]) {
      expect(signedVolume(s)).toBeGreaterThan(0);
      const top = s.faces.find((f) => f.tag === 'top')!;
      const bottom = s.faces.find((f) => f.tag === 'bottom')!;
      expect(top.normal.z).toBeCloseTo(1, 9);
      expect(bottom.normal.z).toBeCloseTo(-1, 9);
    }
  });

  it('caps are tagged and sides counted per footprint edge', () => {
    const s = extrudeFootprint(square(500), 100, 200)!;
    expect(s.faces.filter((f) => f.tag === 'side').length).toBe(4);
    expect(s.faces.filter((f) => f.tag === 'top').length).toBe(1);
    const b = bounds(s)!;
    expect(b.min.z).toBeCloseTo(100, 9);
    expect(b.max.z).toBeCloseTo(300, 9);
  });

  it('an L-shaped (concave) footprint still closes and measures right', () => {
    // 2×2 square with the top-right 1×1 quadrant removed → area 3.
    const L: Vec2[] = [
      { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 1000 },
      { x: 1000, y: 1000 }, { x: 1000, y: 2000 }, { x: 0, y: 2000 },
    ];
    const s = extrudeFootprint(L, 0, 1000)!;
    expectManifold(s);
    expect(volumeM3(s)).toBeCloseTo(3, 9);
  });

  it('rejects degenerate input', () => {
    expect(extrudeFootprint(square(1000), 0, 0)).toBeNull();
    expect(extrudeFootprint(square(1000), 0, -5)).toBeNull();
    expect(extrudeFootprint([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, 100)).toBeNull();
  });
});

describe('extrudePolygon3', () => {
  it('sweeps a tilted profile along its own normal', () => {
    // Unit square in the XZ plane (normal ±Y), swept 100 mm along +Y.
    const profile: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 },
      { x: 1000, y: 0, z: 1000 }, { x: 0, y: 0, z: 1000 },
    ];
    const s = extrudePolygon3(profile, { x: 0, y: 100, z: 0 })!;
    expectManifold(s);
    expect(volume(s)).toBeCloseTo(1000 * 1000 * 100, 3);
  });

  it('refuses to sweep inside the profile plane', () => {
    const profile: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 100, y: 100, z: 0 }, { x: 0, y: 100, z: 0 },
    ];
    expect(extrudePolygon3(profile, { x: 10, y: 0, z: 0 })).toBeNull();
  });
});

describe('boxSolid / sweepBox / cylinderSolid', () => {
  it('box is centred on its centre point', () => {
    const s = boxSolid({ x: 100, y: 200, z: 300 }, 20, 40, 60)!;
    expectManifold(s);
    expect(volume(s)).toBeCloseTo(20 * 40 * 60, 6);
    const c = centroid(s)!;
    expect([c.x, c.y, c.z]).toEqual([100, 200, 300]);
  });

  it('swept member keeps its section along an oblique axis', () => {
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 3000, y: 4000, z: 0 }; // length 5000
    const s = sweepBox(a, b, 200, 300)!;
    expectManifold(s);
    expect(volume(s)).toBeCloseTo(5000 * 200 * 300, 3);
    const c = centroid(s)!;
    expect(c.x).toBeCloseTo(1500, 6);
    expect(c.y).toBeCloseTo(2000, 6);
  });

  it('vertical member falls back to a well-defined section frame', () => {
    const s = sweepBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 }, 250, 250)!;
    expectManifold(s);
    expect(volume(s)).toBeCloseTo(3000 * 250 * 250, 3);
  });

  it('cylinder approximates a circle to within the n-gon error', () => {
    const sides = 64;
    const s = cylinderSolid({ x: 0, y: 0 }, 0, 500, 1000, sides)!;
    expectManifold(s);
    // Regular n-gon area = (n/2)·r²·sin(2π/n) — exact for the tessellation we built.
    const exact = (sides / 2) * 500 * 500 * Math.sin((2 * Math.PI) / sides) * 1000;
    expect(volume(s)).toBeCloseTo(exact, 3);
    expect(volume(s)).toBeLessThan(Math.PI * 500 * 500 * 1000); // inscribed
  });
});

// ─── Topology & validation ────────────────────────────────────────────────────

describe('validateSolid', () => {
  it('flags an open shell', () => {
    const cube = extrudeFootprint(square(1000), 0, 1000)!;
    const open: Solid = { ...cube, faces: cube.faces.slice(0, 5) };
    expect(validateSolid(open).some((d) => d.code === 'not_closed')).toBe(true);
    expect(isManifold(open)).toBe(false);
  });

  it('flags inward-facing normals', () => {
    const inverted = flipSolid(extrudeFootprint(square(1000), 0, 1000)!);
    expect(signedVolume(inverted)).toBeLessThan(0);
    expect(validateSolid(inverted).some((d) => d.code === 'inverted')).toBe(true);
  });

  it('flags a non-planar face', () => {
    // Hand-built (bypassing makeSolid's normal derivation) so one quad is warped.
    const v: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 100, y: 100, z: 50 }, { x: 0, y: 100, z: 0 },
    ];
    const s: Solid = {
      vertices: v,
      faces: [{ outer: [0, 1, 2, 3], normal: { x: 0, y: 0, z: 1 } }],
    };
    expect(validateSolid(s).some((d) => d.code === 'non_planar_face')).toBe(true);
  });

  it('flags an empty solid', () => {
    expect(validateSolid({ vertices: [], faces: [] })[0].code).toBe('empty');
  });

  it('accepts a well-formed prism', () => {
    expect(validateSolid(extrudeFootprint(square(1000), 0, 1000)!)).toEqual([]);
  });
});

describe('makeSolid', () => {
  it('welds coincident vertices from separate faces', () => {
    // The same cube, but every face supplies its own copies of the corners.
    const cube = extrudeFootprint(square(1000), 0, 1000)!;
    const loose: Vec3[] = [];
    const faces = cube.faces.map((f) => {
      const outer = f.outer.map((id) => { loose.push({ ...cube.vertices[id] }); return loose.length - 1; });
      return { outer, normal: f.normal };
    });
    const rebuilt = makeSolid(loose, faces);
    expect(loose.length).toBe(24);
    expect(rebuilt.vertices.length).toBe(8); // welded back down
    expectManifold(rebuilt);
    expect(volume(rebuilt)).toBeCloseTo(1e9, 3);
  });

  it('drops degenerate faces instead of producing broken topology', () => {
    const s = makeSolid(
      [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }],
      [{ outer: [0, 1, 0] }],
    );
    expect(s.faces).toEqual([]);
  });

  it('honours a supplied normal by reversing the winding', () => {
    const pts: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 100, y: 100, z: 0 }, { x: 0, y: 100, z: 0 },
    ];
    const up = makeSolid(pts, [{ outer: [0, 1, 2, 3], normal: { x: 0, y: 0, z: 1 } }]);
    const down = makeSolid(pts, [{ outer: [0, 1, 2, 3], normal: { x: 0, y: 0, z: -1 } }]);
    expect(up.faces[0].normal.z).toBeCloseTo(1, 9);
    expect(down.faces[0].normal.z).toBeCloseTo(-1, 9);
    // Compare the traversed POINTS, not the ids — makeSolid compacts the vertex
    // pool, so ids are only meaningful within the solid that owns them.
    const walk = (s: typeof up) => s.faces[0].outer.map((i) => s.vertices[i]);
    expect(walk(down)).toEqual([...walk(up)].reverse());
  });
});

describe('buildTopology', () => {
  it('produces one half-edge per loop step, fully twinned on a closed solid', () => {
    const s = extrudeFootprint(square(1000), 0, 1000)!;
    const topo = buildTopology(s);
    // 6 faces: 2 quads (caps) + 4 quads (sides) = 24 half-edges, 12 edges.
    expect(topo.halfEdges.length).toBe(24);
    expect(topo.byEdge.size).toBe(12);
    for (const he of topo.halfEdges) {
      const twin = topo.halfEdges[he.twin];
      expect(twin.from).toBe(he.to);
      expect(twin.to).toBe(he.from);
      expect(twin.face).not.toBe(he.face);
    }
  });

  it('next pointers cycle back to the start of their loop', () => {
    const s = extrudeFootprint(square(1000), 0, 1000)!;
    const topo = buildTopology(s);
    for (let i = 0; i < topo.halfEdges.length; i++) {
      let cur = i, steps = 0;
      do { cur = topo.halfEdges[cur].next; steps++; } while (cur !== i && steps < 100);
      expect(cur).toBe(i);
      expect(steps).toBe(4); // every loop here is a quad
    }
  });
});

// ─── Triangulation ────────────────────────────────────────────────────────────

describe('triangulateFace', () => {
  it('triangulates a convex loop into n−2 triangles', () => {
    const pts: Vec3[] = square(1000).map((p) => ({ ...p, z: 0 }));
    const tris = triangulateFace(pts, [0, 1, 2, 3], undefined, { x: 0, y: 0, z: 1 });
    expect(tris.length).toBe(2);
  });

  it('handles a concave loop without emitting outside triangles', () => {
    // Arrow-head: one strongly reflex vertex.
    const pts: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 },
      { x: 500, y: 400, z: 0 }, { x: 1000, y: 1000, z: 0 }, { x: 0, y: 1000, z: 0 },
    ];
    const tris = triangulateFace(pts, [0, 1, 2, 3, 4], undefined, { x: 0, y: 0, z: 1 });
    expect(tris.length).toBe(3);
    // Total triangle area must equal the polygon's shoelace area.
    const shoelace = Math.abs(
      pts.reduce((a, p, i) => {
        const q = pts[(i + 1) % pts.length];
        return a + (p.x * q.y - q.x * p.y);
      }, 0) / 2,
    );
    const sum = tris.reduce((a, [i, j, k]) => {
      const [p, q, r] = [pts[i], pts[j], pts[k]];
      return a + Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2;
    }, 0);
    expect(sum).toBeCloseTo(shoelace, 6);
  });

  it('bridges TWO holes — the case a wall with two windows produces', () => {
    // 3000 × 1000 face with two 500 × 400 holes, as two windows in one wall.
    const outer: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 3000, y: 0, z: 0 },
      { x: 3000, y: 1000, z: 0 }, { x: 0, y: 1000, z: 0 },
    ];
    const holeAt = (x0: number): Vec3[] => [
      { x: x0, y: 300, z: 0 }, { x: x0, y: 700, z: 0 },
      { x: x0 + 500, y: 700, z: 0 }, { x: x0 + 500, y: 300, z: 0 },
    ];
    const pts = [...outer, ...holeAt(400), ...holeAt(2000)];
    const tris = triangulateFace(pts, [0, 1, 2, 3], [[4, 5, 6, 7], [8, 9, 10, 11]], { x: 0, y: 0, z: 1 });

    const area = tris.reduce((a, [i, j, k]) => {
      const [p, q, r] = [pts[i], pts[j], pts[k]];
      return a + ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2;
    }, 0);
    expect(area).toBeCloseTo(3000 * 1000 - 2 * (500 * 400), 6);
  });

  it('bridges three holes without any of them being filled in', () => {
    const outer: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 6000, y: 0, z: 0 },
      { x: 6000, y: 3000, z: 0 }, { x: 0, y: 3000, z: 0 },
    ];
    const holeAt = (x0: number): Vec3[] => [
      { x: x0, y: 900, z: 0 }, { x: x0, y: 2100, z: 0 },
      { x: x0 + 1000, y: 2100, z: 0 }, { x: x0 + 1000, y: 900, z: 0 },
    ];
    const pts = [...outer, ...holeAt(500), ...holeAt(2500), ...holeAt(4500)];
    const tris = triangulateFace(
      pts, [0, 1, 2, 3], [[4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]], { x: 0, y: 0, z: 1 },
    );
    const area = tris.reduce((a, [i, j, k]) => {
      const [p, q, r] = [pts[i], pts[j], pts[k]];
      return a + ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2;
    }, 0);
    expect(area).toBeCloseTo(6000 * 3000 - 3 * (1000 * 1200), 6);
  });

  it('bridges a hole so the triangulated area excludes it', () => {
    const outer = square(1000).map((p) => ({ ...p, z: 0 }));
    const hole: Vec3[] = [
      { x: 250, y: 250, z: 0 }, { x: 250, y: 750, z: 0 },
      { x: 750, y: 750, z: 0 }, { x: 750, y: 250, z: 0 }, // wound opposite to outer
    ];
    const pts = [...outer, ...hole];
    const tris = triangulateFace(pts, [0, 1, 2, 3], [[4, 5, 6, 7]], { x: 0, y: 0, z: 1 });
    const area = tris.reduce((a, [i, j, k]) => {
      const [p, q, r] = [pts[i], pts[j], pts[k]];
      return a + ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2;
    }, 0);
    expect(area).toBeCloseTo(1000 * 1000 - 500 * 500, 6); // 750 000 mm²
  });
});

describe('faceArea', () => {
  it('subtracts holes from the outer loop', () => {
    const pts: Vec3[] = [
      ...square(1000).map((p) => ({ ...p, z: 0 })),
      { x: 250, y: 250, z: 0 }, { x: 250, y: 750, z: 0 },
      { x: 750, y: 750, z: 0 }, { x: 750, y: 250, z: 0 },
    ];
    const s: Solid = {
      vertices: pts,
      faces: [{ outer: [0, 1, 2, 3], holes: [[4, 5, 6, 7]], normal: { x: 0, y: 0, z: 1 } }],
    };
    expect(faceArea(s, 0)).toBeCloseTo(750000, 6);
  });
});

// ─── Transforms ───────────────────────────────────────────────────────────────

describe('transforms', () => {
  it('translation preserves volume and shifts the centroid', () => {
    const s = extrudeFootprint(square(1000), 0, 1000)!;
    const moved = translateSolid(s, { x: 500, y: -200, z: 30 });
    expect(volume(moved)).toBeCloseTo(volume(s), 3);
    const a = centroid(s)!, b = centroid(moved)!;
    expect(b.x - a.x).toBeCloseTo(500, 6);
    expect(b.y - a.y).toBeCloseTo(-200, 6);
    expect(b.z - a.z).toBeCloseTo(30, 6);
  });

  it('flip reverses orientation but not the enclosed volume', () => {
    const s = extrudeFootprint(square(1000), 0, 1000)!;
    const f = flipSolid(s);
    expect(signedVolume(f)).toBeCloseTo(-signedVolume(s), 3);
    expect(volume(f)).toBeCloseTo(volume(s), 3);
  });
});

// ─── Tessellation ─────────────────────────────────────────────────────────────

describe('tessellate', () => {
  it('emits flat-shaded triangles with per-face normals', () => {
    const s = extrudeFootprint(square(1000), 0, 1000)!;
    const soup = tessellate(s, { space: 'bim' });
    expect(soup.indices.length).toBe(6 * 2 * 3);       // 6 quads → 12 triangles
    expect(soup.positions.length / 3).toBe(6 * 4);     // per-face vertices, not shared
    expect(soup.triangleFaces.length).toBe(12);
    expect(soup.normals.length).toBe(soup.positions.length);
  });

  it('converts BIM mm (Z up) to scene metres (Y up, −Z north)', () => {
    const s = boxSolid({ x: 2000, y: 3000, z: 1000 }, 100, 100, 100)!;
    const soup = tessellate(s, { space: 'three' });
    let minX = Infinity, minY = Infinity, maxZ = -Infinity;
    for (let i = 0; i < soup.positions.length; i += 3) {
      minX = Math.min(minX, soup.positions[i]);
      minY = Math.min(minY, soup.positions[i + 1]);
      maxZ = Math.max(maxZ, soup.positions[i + 2]);
    }
    expect(minX).toBeCloseTo(1.95, 6);   // BIM X 1950 mm → 1.95 m
    expect(minY).toBeCloseTo(0.95, 6);   // BIM Z 950 mm  → scene Y
    expect(maxZ).toBeCloseTo(-2.95, 6);  // BIM Y 2950 mm → scene −Z
  });

  it('scene-space triangles stay wound the same way (proper rotation)', () => {
    const s = extrudeFootprint(square(1000), 0, 1000)!;
    const bim = tessellate(s, { space: 'bim' });
    const three = tessellate(s, { space: 'three' });
    expect(Array.from(three.indices)).toEqual(Array.from(bim.indices));
  });
});
