/**
 * The push sequence against a fake ArchiCAD.
 *
 * The behaviour worth pinning is the floor-plan switch around openings: it cost
 * a long diagnosis to find (ArchiCAD reports it only as a numeric
 * APIERR_BADDATABASE on the opening itself), and nothing in the payloads hints
 * that the current window matters.
 */
import { describe, expect, it } from 'vitest';
import type { ArchicadPlan } from './buildArchicadModel';
import { pushToArchicad } from './pushToArchicad';
import { BAD_DATABASE, type CreateOutcome, type ElementId, type TapirClient } from './tapirClient';

interface FakeOpts {
  /** Window type the fake reports before the push. */
  window?: string;
  /** Commands whose every item fails, with this code. */
  failing?: Record<string, number>;
  /** Vertical extent ArchiCAD reports back for every element, in metres. */
  builtThickness?: number;
}

/** Records the call order so ordering assertions read as a single sequence. */
function fakeClient(opts: FakeOpts = {}) {
  const calls: string[] = [];
  let current = opts.window ?? '3DModel';
  let n = 0;
  const client = {
    async setStories() { calls.push('setStories'); },
    async elementsByType(type: string): Promise<ElementId[]> {
      calls.push(`elementsByType:${type}`);
      return [];
    },
    async deleteElements(els: ElementId[]) { calls.push(`deleteElements:${els.length}`); },
    async currentWindowType() { calls.push('currentWindowType'); return current; },
    async boundingBoxes(els: ElementId[]) {
      calls.push(`boundingBoxes:${els.length}`);
      const t = opts.builtThickness;
      return els.map(() => (t == null ? null : { zMin: 0, zMax: t }));
    },
    async changeWindow(w: string) { calls.push(`changeWindow:${w}`); current = w; },
    async create(command: string, _key: string, items: unknown[]): Promise<CreateOutcome[]> {
      calls.push(`${command}:${items.length}@${current}`);
      const code = opts.failing?.[command];
      return items.map(() => (code
        ? { guid: null, code, message: 'Failed to create.' }
        : { guid: `guid-${++n}` }));
    },
  } as unknown as TapirClient;
  return { client, calls };
}

function plan(over: Partial<ArchicadPlan> = {}): ArchicadPlan {
  return {
    stories: [{ name: 'Parter', level: 0 }],
    walls: [{}, {}],
    columns: [],
    beams: [],
    slabs: [],
    roofs: [],
    stairs: [],
    windows: [],
    doors: [],
    skipped: [],
    ...over,
  } as unknown as ArchicadPlan;
}

const opening = (wallIndex: number) =>
  ({ wallIndex, centerOffset: 1, sillHeight: 0.9, width: 1, height: 1.2 }) as never;

describe('pushToArchicad', () => {
  it('switches to the floor plan for openings and restores the previous window', async () => {
    const { client, calls } = fakeClient({ window: '3DModel' });
    await pushToArchicad(client, plan({ windows: [opening(0)], doors: [opening(1)] }));

    expect(calls).toContain('changeWindow:FloorPlan');
    expect(calls).toContain('CreateWindows:1@FloorPlan');
    expect(calls).toContain('CreateDoors:1@FloorPlan');
    // Restored, and only after both opening commands ran.
    expect(calls.indexOf('changeWindow:3DModel')).toBeGreaterThan(calls.indexOf('CreateDoors:1@FloorPlan'));
  });

  it('leaves the window alone when the floor plan is already current', async () => {
    const { client, calls } = fakeClient({ window: 'FloorPlan' });
    await pushToArchicad(client, plan({ windows: [opening(0)] }));

    expect(calls.filter((c) => c.startsWith('changeWindow'))).toEqual([]);
    expect(calls).toContain('CreateWindows:1@FloorPlan');
  });

  it('does not touch the window when there are no openings', async () => {
    const { client, calls } = fakeClient({ window: '3DModel' });
    await pushToArchicad(client, plan());

    expect(calls.filter((c) => c.startsWith('changeWindow'))).toEqual([]);
    expect(calls).not.toContain('currentWindowType');
  });

  it('restores the window even when opening creation throws', async () => {
    const { client, calls } = fakeClient({ window: '3DModel' });
    (client as { create: unknown }).create = async (command: string, _key: string, items: unknown[]) => {
      calls.push(command);
      if (command === 'CreateWindows') throw new Error('boom');
      return items.map((_, i) => ({ guid: `guid-${i}` }));
    };
    await expect(pushToArchicad(client, plan({ windows: [opening(0)] }))).rejects.toThrow('boom');
    expect(calls).toContain('changeWindow:3DModel');
  });

  it('drops an opening whose host wall failed rather than sending a dangling GUID', async () => {
    const { client, calls } = fakeClient({ failing: { CreateWalls: -1 } });
    const result = await pushToArchicad(client, plan({ windows: [opening(0)] }));

    expect(calls).not.toContain('currentWindowType');
    expect(result.created.windows).toBeUndefined();
    expect(result.rejected.walls.count).toBe(2);
  });

  it('explains APIERR_BADDATABASE when the switch did not take', async () => {
    const { client } = fakeClient({ failing: { CreateWindows: BAD_DATABASE } });
    const result = await pushToArchicad(client, plan({ windows: [opening(0)] }));

    expect(result.rejected.windows.count).toBe(1);
    expect(result.hints.join(' ')).toMatch(/floor plan/i);
  });

  it('creates walls before the openings that reference them', async () => {
    const { client, calls } = fakeClient();
    await pushToArchicad(client, plan({ windows: [opening(0)] }));

    expect(calls.findIndex((c) => c.startsWith('CreateWalls')))
      .toBeLessThan(calls.findIndex((c) => c.startsWith('CreateWindows')));
  });
});

describe('slab thickness verification', () => {
  const slab = (thickness: number) =>
    ({ polygonCoordinates: [{ x: 0, y: 0 }], level: 0, thickness, floorIndex: 0 }) as never;

  it('warns when ArchiCAD substitutes its composite for the requested thickness', async () => {
    // What ArchiCAD 29 actually does: any requested thickness becomes 300 mm.
    const { client } = fakeClient({ builtThickness: 0.30 });
    const result = await pushToArchicad(client, plan({ slabs: [slab(0.15)] }));

    expect(result.hints.join(' ')).toMatch(/300 mm thick instead of the 150 mm/);
    expect(result.hints.join(' ')).toMatch(/Basic/);
  });

  it('stays quiet when the slab came out as asked', async () => {
    const { client } = fakeClient({ builtThickness: 0.15 });
    const result = await pushToArchicad(client, plan({ slabs: [slab(0.15)] }));
    expect(result.hints).toEqual([]);
  });

  it('does not measure anything when there are no slabs', async () => {
    const { client, calls } = fakeClient({ builtThickness: 0.30 });
    await pushToArchicad(client, plan());
    expect(calls.some((c) => c.startsWith('boundingBoxes'))).toBe(false);
  });

  it('never lets a failed measurement break the push', async () => {
    const { client } = fakeClient({ builtThickness: 0.30 });
    (client as { boundingBoxes: unknown }).boundingBoxes = async () => { throw new Error('nope'); };
    const result = await pushToArchicad(client, plan({ slabs: [slab(0.15)] }));
    expect(result.created.slabs).toBe(1);
    expect(result.hints).toEqual([]);
  });
});
