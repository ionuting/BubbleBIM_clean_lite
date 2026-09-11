/**
 * takeoffContext.ts — the project-level inputs the takeoff needs that are not
 * on the nodes themselves.
 *
 * The structural system is a PROJECT decision with per-element overrides
 * (`lib/systems/structuralSystem.ts`). The engine's pure functions take it as
 * an explicit option; the UI panels, which all read the same project, get it
 * from here instead of threading one more prop through six components. The
 * panel that owns the project state writes it on every change.
 *
 * Same idea as `getMappingOverrides()` feeding `getActiveCatalog()`: one
 * module-level snapshot, read at call time, never cached across calls.
 */
import type { StructuralSystem } from '@/lib/systems/structuralSystem';
import type { SpecSelection } from '@/lib/norms/specs';

export interface TakeoffContext {
  /** Project default; elements override through `properties.structural_system`. */
  structuralSystem: StructuralSystem;
  /**
   * Project-level material and finish choices (`grup → opțiune`); elements
   * override through `properties.spec_<grup>`. Empty = every group on its
   * declared default, i.e. exactly the decomposition that existed before
   * specifications were introduced.
   */
  specs: SpecSelection;
}

let current: TakeoffContext = { structuralSystem: 'unset', specs: {} };

export function getTakeoffContext(): TakeoffContext {
  return current;
}

export function setTakeoffContext(next: Partial<TakeoffContext>): void {
  current = { ...current, ...next };
}

/** Options every takeoff entry point accepts; anything omitted falls back to the context. */
export interface TakeoffOptions {
  structuralSystem?: StructuralSystem;
  /** Project-level specification choices; per-node properties still win. */
  specs?: SpecSelection;
  /** Per-node measurement memo — see `createMeasureMemo` in geometryMeasures. */
  memo?: import('./geometryMeasures').MeasureMemo;
}

export const resolveTakeoffSystem = (opts?: TakeoffOptions): StructuralSystem =>
  opts?.structuralSystem ?? current.structuralSystem;

export const resolveTakeoffSpecs = (opts?: TakeoffOptions): SpecSelection =>
  opts?.specs ?? current.specs;
