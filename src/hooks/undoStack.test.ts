import { describe, it, expect } from 'vitest';
import { UndoStack } from './undoStack';

/** A fake, fully-controlled clock so coalescing tests never depend on real timing. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('UndoStack', () => {
  it('starts with nothing to undo/redo', () => {
    const s = new UndoStack<number>();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    expect(s.undo(0)).toBeUndefined();
    expect(s.redo(0)).toBeUndefined();
  });

  it('record() pushes a step when called outside the coalescing window', () => {
    const clock = fakeClock();
    const s = new UndoStack<number>({ coalesceMs: 500, now: clock.now });

    expect(s.record(0)).toBe(true); // first record always pushes
    expect(s.canUndo).toBe(true);
    expect(s.pastLength).toBe(1);

    clock.advance(1000); // well past the coalescing window
    expect(s.record(1)).toBe(true);
    expect(s.pastLength).toBe(2);
  });

  it('record() calls within the coalescing window fold into the same step', () => {
    const clock = fakeClock();
    const s = new UndoStack<number>({ coalesceMs: 500, now: clock.now });

    expect(s.record(0)).toBe(true);
    clock.advance(100);
    expect(s.record(1)).toBe(false); // within window — coalesced, no new step
    clock.advance(100);
    expect(s.record(2)).toBe(false);
    expect(s.pastLength).toBe(1); // still just the one step from the first record()

    // undo() restores the FIRST recorded snapshot (0), not the coalesced ones —
    // that's the whole point: the drag/typing session undoes as one unit.
    expect(s.undo(3)).toBe(0);
  });

  it('undo() then redo() round-trips to the same current value', () => {
    const s = new UndoStack<string>({ coalesceMs: 0 });
    s.record('a');
    // current value after the edit that followed recording 'a' is 'b'
    const undone = s.undo('b');
    expect(undone).toBe('a');
    expect(s.canRedo).toBe(true);

    const redone = s.redo('a'); // 'a' is now current after the undo above
    expect(redone).toBe('b');
    expect(s.canRedo).toBe(false);
  });

  it('a fresh record() after undo() clears the redo stack', () => {
    const s = new UndoStack<string>({ coalesceMs: 0 });
    s.record('a');
    s.undo('b');
    expect(s.canRedo).toBe(true);

    s.record('a'); // user made a NEW edit instead of redoing
    expect(s.canRedo).toBe(false);
    expect(s.redo('c')).toBeUndefined();
  });

  it('breakCoalescing() forces the next record() to push even inside the window', () => {
    const clock = fakeClock();
    const s = new UndoStack<number>({ coalesceMs: 500, now: clock.now });
    s.record(0);
    clock.advance(10); // well within the window
    s.breakCoalescing();
    expect(s.record(1)).toBe(true);
    expect(s.pastLength).toBe(2);
  });

  it('drops the oldest entry once maxHistory is exceeded', () => {
    const s = new UndoStack<number>({ coalesceMs: 0, maxHistory: 3 });
    for (let i = 0; i < 5; i++) s.record(i);
    expect(s.pastLength).toBe(3);
    // Oldest 2 (0, 1) were dropped — undoing 3 times pops 4, 3, 2, then nothing.
    expect(s.undo(5)).toBe(4);
    expect(s.undo(5)).toBe(3);
    expect(s.undo(5)).toBe(2);
    expect(s.undo(5)).toBeUndefined();
  });

  it('bounds the redo stack the same way', () => {
    const s = new UndoStack<number>({ coalesceMs: 0, maxHistory: 2 });
    s.record(0); s.record(1); s.record(2); s.record(3);
    // past = [1, 2, 3] after the cap; undo everything to fill up `future`.
    let cur = 4;
    for (let i = 0; i < 5; i++) {
      const u = s.undo(cur);
      if (u === undefined) break;
      cur = u;
    }
    expect(s.futureLength).toBeLessThanOrEqual(2);
  });
});
