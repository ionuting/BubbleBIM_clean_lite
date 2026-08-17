/**
 * Boolean engine adapter — manifold-3d.
 *
 * The ONLY file in the project allowed to import `manifold-3d`. Everything else
 * goes through the `BooleanEngine` interface, so replacing this backend is a
 * one-file change.
 *
 * ## Why this engine
 * Evaluated against reusing `opengeometry`'s kernel:
 *   - Takes and returns plain indexed triangle meshes — exactly the shape
 *     `toIndexedMesh` / `solidFromMesh` already speak. The OG path would require
 *     serialising into its undocumented internal BRep JSON.
 *   - Handles through-cuts whose faces are EXACTLY coplanar with the host, with
 *     zero overshoot. OG's own docs require a `max(hostThickness·0.05, 0.01)`
 *     model-unit overshoot and warn it may still fail on coincident faces —
 *     which is what all the defensive retry code in `ogBimMapper.ts` works around.
 *   - Runs under plain Node, so booleans are unit-testable rather than only
 *     observable in a browser.
 *   - Its result is data, not a `THREE.Mesh` subclass, so nothing about the
 *     geometry pipeline is coupled to a renderer.
 *
 * ## Precision
 * manifold-3d carries vertex positions as float32. At building scale in
 * millimetres that leaves roughly 0.01 mm of resolution — an order of magnitude
 * finer than `TOL_DIST` and two below anything a user can author, but it is why
 * `solidFromMesh` re-welds rather than trusting the returned coordinates.
 *
 * ## Memory
 * `Manifold` instances are WASM-allocated and are NOT garbage collected. Every
 * one created here is disposed in a `finally`, including on the error path.
 */

import type { BooleanEngine, BooleanOp } from '../boolean';
import type { IndexedMesh } from '../mesh';

// The package ships its types on subpaths; these are the shapes we actually use.
interface ManifoldInstance {
  getMesh(): { vertProperties: Float32Array; triVerts: Uint32Array };
  status(): string;
  isEmpty(): boolean;
  delete(): void;
}

interface ManifoldStatic {
  new (mesh: unknown): ManifoldInstance;
  union(manifolds: readonly ManifoldInstance[]): ManifoldInstance;
  difference(manifolds: readonly ManifoldInstance[]): ManifoldInstance;
  intersection(manifolds: readonly ManifoldInstance[]): ManifoldInstance;
}

interface ManifoldModule {
  setup(): void;
  Manifold: ManifoldStatic;
  Mesh: new (opts: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }) => unknown;
}

let _wasm: ManifoldModule | null = null;
let _loading: Promise<void> | null = null;

function toManifold(wasm: ManifoldModule, mesh: IndexedMesh): ManifoldInstance {
  const m = new wasm.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(mesh.positions),
    triVerts: mesh.triangles,
  });
  const solid = new wasm.Manifold(m);
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new Error(`manifold rejected an operand: ${status}`);
  }
  return solid;
}

function fromManifold(solid: ManifoldInstance): IndexedMesh {
  const mesh = solid.getMesh();
  return {
    positions: Float64Array.from(mesh.vertProperties),
    triangles: Uint32Array.from(mesh.triVerts),
  };
}

export const manifoldEngine: BooleanEngine = {
  name: 'manifold-3d',

  ready(): Promise<void> {
    if (_loading) return _loading;
    _loading = (async () => {
      const Module = (await import('manifold-3d')).default as unknown as () => Promise<ManifoldModule>;
      const wasm = await Module();
      wasm.setup();
      _wasm = wasm;
    })();
    return _loading;
  },

  isReady(): boolean {
    return _wasm !== null;
  },

  run(op: BooleanOp, lhs: IndexedMesh, rhs: IndexedMesh[]): IndexedMesh {
    const wasm = _wasm;
    if (!wasm) throw new Error('manifold-3d is not initialised — await ready() first.');

    const allocated: ManifoldInstance[] = [];
    try {
      const operands = [lhs, ...rhs].map((m) => {
        const inst = toManifold(wasm, m);
        allocated.push(inst);
        return inst;
      });

      // The batch statics resolve all operands against each other in one pass,
      // rather than re-meshing the host once per cutter.
      const result =
        op === 'union' ? wasm.Manifold.union(operands)
        : op === 'subtract' ? wasm.Manifold.difference(operands)
        : wasm.Manifold.intersection(operands);
      allocated.push(result);

      const status = result.status();
      if (status !== 'NoError') throw new Error(`manifold ${op} failed: ${status}`);
      if (result.isEmpty()) return { positions: new Float64Array(0), triangles: new Uint32Array(0) };

      return fromManifold(result);
    } finally {
      for (const inst of allocated) {
        try { inst.delete(); } catch { /* already disposed */ }
      }
    }
  },
};
