/**
 * Internal B-rep kernel — boolean operations.
 *
 * The deliberate seam in the hybrid design: the topology, the builders and the
 * face reconstruction are ours, but the numeric boolean — plane intersection,
 * coincident-face handling, degenerate-case robustness — is delegated to a
 * mature engine behind this interface. That is the one part of a CAD kernel
 * where reimplementing from scratch buys years of precision bugs and no
 * differentiation.
 *
 * Nothing outside `engines/` may import an engine package directly. Swapping
 * engines must stay a one-file change.
 *
 * Usage mirrors `ensureOpenGeoReady()`: await once at startup, then call the
 * operations synchronously from the scene builder.
 *
 *   await ensureBooleanEngine();
 *   const { solid } = subtractSolids(wall, openings);
 */

import { TOL_DIST, type Solid } from './types';
import { solidFromMesh, toIndexedMesh, type IndexedMesh, type RebuildOptions } from './mesh';
import { signedVolume } from './measure';

export type BooleanOp = 'union' | 'subtract' | 'intersect';

/**
 * Enclosed volume (mm³) at or below which a result counts as empty. A shell
 * thinner than the weld tolerance in every direction is not distinguishable
 * from coincident surfaces, and real geometry lands orders of magnitude above it.
 */
const ZERO_VOLUME = TOL_DIST ** 3;

/**
 * A numeric boolean backend.
 *
 * Implementations live in `./engines/` and speak only `IndexedMesh` — welded,
 * CCW-from-outside triangles in BIM millimetres. They never see a `Solid`, a
 * BubbleGraph node or a renderer.
 */
export interface BooleanEngine {
  readonly name: string;
  /** Load whatever the backend needs (typically WASM). Must be idempotent. */
  ready(): Promise<void>;
  /** True once `ready()` has resolved. */
  isReady(): boolean;
  /**
   * Run `op` with `lhs` against every mesh in `rhs`, in one batch.
   *
   * Batching is not a micro-optimisation: cutting N openings in a single call
   * lets the engine resolve them against one another, where N sequential calls
   * re-mesh the host N times and accumulate error at every step.
   */
  run(op: BooleanOp, lhs: IndexedMesh, rhs: IndexedMesh[]): IndexedMesh;
}

/**
 * Result of a boolean. Failure is a value, not an exception: a single bad
 * opening must not abort a whole scene build, and callers routinely want to
 * fall back to the uncut host (as the current renderers already do).
 */
export interface BooleanOutcome {
  solid: Solid | null;
  error?: string;
}

export interface BooleanOptions extends RebuildOptions {}

// ─── Engine registry ──────────────────────────────────────────────────────────

let _engine: BooleanEngine | null = null;
let _readyPromise: Promise<void> | null = null;

/** Install a specific engine. Call before `ensureBooleanEngine()`; mainly for tests. */
export function setBooleanEngine(engine: BooleanEngine): void {
  _engine = engine;
  _readyPromise = null;
}

export function getBooleanEngine(): BooleanEngine | null {
  return _engine;
}

/**
 * Load the boolean engine, defaulting to the manifold-3d adapter.
 *
 * Idempotent and safe to call concurrently — all callers share one promise. The
 * default engine is imported dynamically so that consumers which never run a
 * boolean (2D views, quantity takeoff, tests of pure geometry) do not pay for
 * its WASM payload.
 */
export function ensureBooleanEngine(engine?: BooleanEngine): Promise<void> {
  if (engine) setBooleanEngine(engine);
  if (_readyPromise) return _readyPromise;

  _readyPromise = (async () => {
    if (!_engine) {
      const { manifoldEngine } = await import('./engines/manifold');
      _engine = manifoldEngine;
    }
    await _engine.ready();
  })();
  return _readyPromise;
}

/** Drop the installed engine. Test helper — resets the module-level registry. */
export function resetBooleanEngine(): void {
  _engine = null;
  _readyPromise = null;
}

// ─── Operations ───────────────────────────────────────────────────────────────

function runOp(op: BooleanOp, lhs: Solid, rhs: Solid[], opts: BooleanOptions): BooleanOutcome {
  if (!_engine) return { solid: null, error: 'No boolean engine installed — await ensureBooleanEngine() first.' };
  if (!_engine.isReady()) return { solid: null, error: `Boolean engine "${_engine.name}" is not ready yet.` };
  if (lhs.faces.length === 0) return { solid: null, error: 'Left operand has no faces.' };

  const operands = rhs.filter((s) => s.faces.length > 0);
  if (operands.length === 0) {
    // Nothing to cut/join with: subtraction and union are no-ops, but an
    // intersection against nothing is empty rather than unchanged.
    return op === 'intersect'
      ? { solid: null, error: 'Intersection with no operands is empty.' }
      : { solid: lhs };
  }

  try {
    const out = _engine.run(op, toIndexedMesh(lhs), operands.map(toIndexedMesh));
    if (out.triangles.length === 0) return { solid: null, error: `${op} produced an empty solid.` };

    const solid = solidFromMesh(out, { tag: lhs.tag, ...opts });
    // Two bodies that merely touch intersect in a flat contact patch: a shell
    // with real faces but zero enclosed volume. That is an empty result, not a
    // solid, and reporting it as one would make "do these overlap?" answer yes
    // for every pair of adjacent walls. A closed polyhedron also needs at least
    // four faces, which is the cheaper of the two checks.
    if (solid.faces.length < 4 || Math.abs(signedVolume(solid)) <= ZERO_VOLUME) {
      return { solid: null, error: `${op} produced an empty result (no enclosed volume).` };
    }
    return { solid };
  } catch (err) {
    return { solid: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cut `cutters` out of `host` — window and door openings, skylight and dormer
 * notches, service penetrations.
 */
export function subtractSolids(host: Solid, cutters: Solid[], opts: BooleanOptions = {}): BooleanOutcome {
  return runOp('subtract', host, cutters, opts);
}

/**
 * Fuse solids into one — the wall-junction case that the current pipeline cannot
 * express at all, leaving overlapping bodies that z-fight and double-count in
 * quantity takeoff.
 */
export function unionSolids(solids: Solid[], opts: BooleanOptions = {}): BooleanOutcome {
  if (solids.length === 0) return { solid: null, error: 'Union of nothing.' };
  if (solids.length === 1) return { solid: solids[0] };
  return runOp('union', solids[0], solids.slice(1), opts);
}

/** Common volume of `a` and `b` — clash detection, and trimming an element to a zone. */
export function intersectSolids(a: Solid, b: Solid[], opts: BooleanOptions = {}): BooleanOutcome {
  return runOp('intersect', a, b, opts);
}
