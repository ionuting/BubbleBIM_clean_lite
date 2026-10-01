import { describe, it, expect } from 'vitest';
import { safeEval } from './formulaUtils';

describe('safeEval — identifiers are checked by name', () => {
  // The old guard was a character class spelled from the math function names.
  // It let through any word those letters happen to spell and rejected every
  // name outside them, which silently included the `W` and `T` that every
  // symbol template is written in.
  it('resolves a context variable whatever its case', () => {
    expect(safeEval('W', { W: 900 } as never)).toBe(900);
    expect(safeEval('T / 2', { T: 250 } as never)).toBe(125);
    expect(safeEval('T / 2 - W', { W: 40, T: 250 } as never)).toBe(85);
  });

  it('still does arithmetic and maths', () => {
    expect(safeEval('3000+500')).toBe(3500);
    expect(safeEval('sqrt(16)')).toBe(4);
    expect(safeEval('max(2, 7)')).toBe(7);
    expect(safeEval('120')).toBe(120);
  });

  it('refuses a name it is not about to bind', () => {
    // `constructor` is spelled entirely from the old class's letters, so it
    // used to pass the check and only failed later, by accident.
    expect(safeEval('constructor', { W: 1 } as never)).toBeNaN();
    expect(safeEval('globalThis', { W: 1 } as never)).toBeNaN();
    expect(safeEval('foo + 1', { W: 1 } as never)).toBeNaN();
    expect(safeEval('W', {} as never)).toBeNaN();
  });

  it('refuses characters that are not part of an expression', () => {
    expect(safeEval('1;2')).toBeNaN();
    expect(safeEval('a["b"]', { a: 1 } as never)).toBeNaN();
    expect(safeEval('`x`')).toBeNaN();
  });
});
