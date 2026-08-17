/**
 * Internal B-rep kernel — tessellation to renderer-ready buffers.
 *
 * This is the single place where the kernel's BIM space (X east, Y north, Z up,
 * millimetres) is converted to the renderers' scene space (Y up, metres). Keeping
 * that conversion in one function — instead of sprinkled through every builder as
 * it is today — is what lets the rest of the kernel read node coordinates
 * verbatim.
 *
 * Faces are planar and flat-shaded, so vertices are emitted per face rather than
 * shared: two faces meeting at an edge need different normals there.
 */

import type { Solid } from './types';
import { triangulateFace } from './triangulate';

/** BIM millimetres → scene metres. Mirrors `MM` in `bimGeometry.ts`. */
export const MM = 0.001;

export type TessellateSpace =
  /** Kernel space, unconverted: X east, Y north, Z up, millimetres. */
  | 'bim'
  /**
   * Renderer space as used by every viewer in this project:
   *   x = bimX · MM,  y = bimZ · MM,  z = −bimY · MM
   * A proper rotation (determinant +1), so winding and normals carry over unchanged.
   */
  | 'three';

export interface TriangleSoup {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Face index each triangle came from — lets callers map a raycast hit back to a face tag. */
  triangleFaces: Uint32Array;
}

export interface TessellateOptions {
  space?: TessellateSpace;
  /** Extra uniform scale applied after the space conversion. Default 1. */
  scale?: number;
}

/**
 * Line segments tracing every face boundary — outer loops and holes.
 *
 * The point of having topology: these are the model's REAL edges. Deriving them
 * from the triangle soup instead (e.g. THREE's `EdgesGeometry`) cannot work
 * here, because `tessellate` duplicates vertices per face for flat shading, so
 * nothing downstream can tell which triangles are adjacent — every triangulation
 * edge would be drawn, scribbling diagonals across flat surfaces.
 *
 * Returns flat xyz pairs, one pair per segment.
 */
export function loopSegments(solid: Solid, opts: TessellateOptions = {}): Float32Array {
  const space = opts.space ?? 'three';
  const s = (opts.scale ?? 1) * (space === 'three' ? MM : 1);
  const out: number[] = [];

  const push = (id: number) => {
    const p = solid.vertices[id];
    if (space === 'three') out.push(p.x * s, p.z * s, -p.y * s);
    else out.push(p.x * s, p.y * s, p.z * s);
  };

  for (const f of solid.faces) {
    for (const loop of [f.outer, ...(f.holes ?? [])]) {
      for (let i = 0; i < loop.length; i++) {
        push(loop[i]);
        push(loop[(i + 1) % loop.length]);
      }
    }
  }
  return new Float32Array(out);
}

export function tessellate(solid: Solid, opts: TessellateOptions = {}): TriangleSoup {
  const space = opts.space ?? 'three';
  const s = (opts.scale ?? 1) * (space === 'three' ? MM : 1);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const triangleFaces: number[] = [];

  solid.faces.forEach((f, fi) => {
    const tris = triangulateFace(solid.vertices, f.outer, f.holes, f.normal);
    if (tris.length === 0) return;

    // Local vertex pool for this face — flat shading forbids sharing across faces.
    const local = new Map<number, number>();
    const emit = (id: number): number => {
      let n = local.get(id);
      if (n !== undefined) return n;
      const p = solid.vertices[id];
      n = positions.length / 3;
      if (space === 'three') {
        positions.push(p.x * s, p.z * s, -p.y * s);
        normals.push(f.normal.x, f.normal.z, -f.normal.y);
      } else {
        positions.push(p.x * s, p.y * s, p.z * s);
        normals.push(f.normal.x, f.normal.y, f.normal.z);
      }
      local.set(id, n);
      return n;
    };

    for (const [a, b, c] of tris) {
      indices.push(emit(a), emit(b), emit(c));
      triangleFaces.push(fi);
    }
  });

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    triangleFaces: new Uint32Array(triangleFaces),
  };
}
