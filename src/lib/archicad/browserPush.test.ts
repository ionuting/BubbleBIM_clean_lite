/**
 * The button's guard rail. Everything else in browserPush is glue, but the
 * confirmation is the only thing standing between a stray click and a deleted
 * ArchiCAD model, so it gets pinned: it must be asked BEFORE the push runs, and
 * declining must leave ArchiCAD untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const projectInfo = vi.fn();
const push = vi.fn();

vi.mock('./tapirClient', () => ({
  TapirClient: class {
    productInfo() { return Promise.resolve({ version: 29, buildNumber: 3000, languageCode: 'INT' }); }
    addOnVersion() { return Promise.resolve('1.5.8'); }
    projectInfo() { return projectInfo(); }
  },
}));
vi.mock('./pushToArchicad', () => ({ pushToArchicad: (...a: unknown[]) => push(...a) }));
vi.mock('./buildArchicadModel', () => ({
  buildArchicadModel: () => ({
    stories: [{}], walls: [{}, {}], columns: [], beams: [], slabs: [], roofs: [], stairs: [],
    windows: [], doors: [], skipped: [],
  }),
}));

const { isCancelled, pushGraphToArchicad } = await import('./browserPush');

const EMPTY = { deleted: 0, created: {}, rejected: {}, hints: [], skipped: [] };

describe('pushGraphToArchicad', () => {
  beforeEach(() => {
    projectInfo.mockReset();
    push.mockReset().mockResolvedValue(EMPTY);
  });

  it('aborts without touching ArchiCAD when a saved project is declined', async () => {
    projectInfo.mockResolvedValue({ isUntitled: false, isTeamwork: false, projectPath: '/a/Villa.pln' });
    const confirm = vi.fn().mockReturnValue(false);

    const result = await pushGraphToArchicad([], [], { confirmSavedProject: confirm });

    expect(isCancelled(result)).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith('/a/Villa.pln');
  });

  it('proceeds when a saved project is confirmed', async () => {
    projectInfo.mockResolvedValue({ isUntitled: false, isTeamwork: false });
    const result = await pushGraphToArchicad([], [], { confirmSavedProject: () => true });

    expect(isCancelled(result)).toBe(false);
    expect(push).toHaveBeenCalledOnce();
  });

  it('does not ask about an untitled project', async () => {
    projectInfo.mockResolvedValue({ isUntitled: true, isTeamwork: false });
    const confirm = vi.fn();

    const result = await pushGraphToArchicad([], [], { confirmSavedProject: confirm });

    expect(confirm).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledOnce();
    expect(isCancelled(result)).toBe(false);
  });

  it('reports which ArchiCAD and Tapir answered', async () => {
    projectInfo.mockResolvedValue({ isUntitled: true, isTeamwork: false });
    const result = await pushGraphToArchicad([], []);

    expect(isCancelled(result)).toBe(false);
    if (!isCancelled(result)) expect(result.archicad).toBe('ArchiCAD 29, Tapir 1.5.8');
  });

  it('reports what the mapping planned, so an empty push can be told from a refused one', async () => {
    projectInfo.mockResolvedValue({ isUntitled: true, isTeamwork: false });
    const result = await pushGraphToArchicad([], []);

    expect(isCancelled(result)).toBe(false);
    // Only non-empty kinds appear — nothing to read past in the message.
    if (!isCancelled(result)) expect(result.planned).toEqual({ stories: 1, walls: 2 });
  });
});
