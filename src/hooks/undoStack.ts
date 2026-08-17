/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * undoStack.ts — a plain (no React) bounded undo/redo stack with coalescing.
 * Framework-independent on purpose: `useUndoableGraphState.ts` is a thin
 * React wrapper around this; keeping the actual stack logic here makes it
 * unit-testable without React Testing Library (not a project dependency).
 *
 * Coalescing: two `record()` calls within `coalesceMs` of each other are
 * treated as ONE undo step (the second call is a no-op besides refreshing
 * the timer) — this is what stops a drag or fast typing from producing one
 * undo step per mousemove/keystroke. `now` is injectable so tests don't
 * depend on real wall-clock timing.
 */

export interface UndoStackOptions {
  maxHistory?: number;
  coalesceMs?: number;
  now?: () => number;
}

export class UndoStack<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastPushAt = -Infinity;
  private readonly maxHistory: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;

  constructor(options: UndoStackOptions = {}) {
    this.maxHistory = options.maxHistory ?? 100;
    this.coalesceMs = options.coalesceMs ?? 500;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record `prev` as the pre-change snapshot, unless this call arrives
   * within the coalescing window of the previous `record()` (then it's
   * folded into the step already on top of the stack). Any `record()` also
   * clears the redo stack — a fresh edit invalidates old redo history, same
   * as every other undo/redo system. Returns true iff a new step was pushed.
   */
  record(prev: T): boolean {
    const t = this.now();
    // `>=`, not `>`: with coalesceMs = 0 (or several record() calls landing in
    // the same millisecond under a real clock), equal timestamps must still
    // count as "outside the window" — otherwise coalesceMs: 0 (meant as "never
    // coalesce") would wrongly fold same-millisecond calls into one step.
    const pushed = t - this.lastPushAt >= this.coalesceMs;
    if (pushed) {
      this.past.push(prev);
      if (this.past.length > this.maxHistory) this.past.shift();
      this.future = [];
    }
    this.lastPushAt = t;
    return pushed;
  }

  /** Pop the last past snapshot, push `current` onto future, return the popped snapshot (undefined if nothing to undo). */
  undo(current: T): T | undefined {
    const snap = this.past.pop();
    if (snap === undefined) return undefined;
    this.future.push(current);
    if (this.future.length > this.maxHistory) this.future.shift();
    this.lastPushAt = -Infinity; // whatever happens next always starts a fresh step
    return snap;
  }

  /** Pop the last future snapshot, push `current` onto past, return the popped snapshot (undefined if nothing to redo). */
  redo(current: T): T | undefined {
    const snap = this.future.pop();
    if (snap === undefined) return undefined;
    this.past.push(current);
    if (this.past.length > this.maxHistory) this.past.shift();
    this.lastPushAt = -Infinity;
    return snap;
  }

  /** Force the next `record()` to push a new step regardless of timing (e.g. before a bulk/programmatic edit). */
  breakCoalescing(): void { this.lastPushAt = -Infinity; }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get pastLength(): number { return this.past.length; }
  get futureLength(): number { return this.future.length; }
}
