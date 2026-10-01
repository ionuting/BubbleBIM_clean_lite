/**
 * pushToArchicad.ts — drives one regeneration of the ArchiCAD model.
 *
 * Delete-everything-then-recreate, by design: with no reverse sync there is
 * nothing to preserve on the ArchiCAD side, and dropping identity mapping
 * removes diffing, GUID ledgers and conflict policy entirely. The cost is that
 * anything an architect anchored to a generated element (a manual dimension,
 * say) is lost on the next push — so the CLI refuses to run against a saved
 * project unless explicitly told to.
 *
 * Order matters in one place only: walls must exist before their windows and
 * doors, which reference them by GUID. Openings additionally need the floor
 * plan to be the current window — see BAD_DATABASE in tapirClient.ts.
 */
import type { ArchicadPlan, OpeningPayload } from './buildArchicadModel';
import { BAD_DATABASE, type CreateOutcome, type ElementId, type TapirClient } from './tapirClient';

/** Element types this bridge owns and therefore clears before regenerating. */
export const MANAGED_TYPES = ['Window', 'Door', 'Wall', 'Column', 'Beam', 'Slab', 'Roof', 'Stair'] as const;

export interface PushResult {
  deleted: number;
  created: Record<string, number>;
  /** Elements ArchiCAD itself refused, with its reason, per command. */
  rejected: Record<string, { count: number; reason: string }>;
  /** Actionable advice when the failures have a known cause. */
  hints: string[];
  skipped: ArchicadPlan['skipped'];
}

/**
 * Resolve wall-index references into real GUIDs now that the walls exist.
 * An opening whose host wall failed to create is dropped rather than sent with
 * a dangling reference.
 */
function withOwners(openings: OpeningPayload[], walls: CreateOutcome[]) {
  return openings
    .filter((o) => walls[o.wallIndex]?.guid != null)
    .map((o) => ({
      ownerWallId: { guid: walls[o.wallIndex].guid as string },
      centerOffset: o.centerOffset,
      sillHeight: o.sillHeight,
      width: o.width,
      height: o.height,
    }));
}

/**
 * Slabs are the one element whose thickness ArchiCAD can silently override.
 *
 * `CreateSlabs` has no `structureType` field (unlike walls and roofs), so when
 * the Slab tool defaults to a composite, ArchiCAD builds THAT composite and
 * ignores the thickness in the payload entirely — measured on ArchiCAD 29,
 * every requested thickness from 100 to 500 mm came out as the template's
 * 300 mm. There is no API-side fix, so the least we can do is refuse to let it
 * pass unnoticed: measure what was built and say so.
 */
async function checkSlabThickness(
  client: TapirClient,
  plan: ArchicadPlan,
  created: CreateOutcome[],
  hints: Set<string>,
): Promise<void> {
  const built = created
    .map((o, i) => ({ guid: o.guid, want: plan.slabs[i]?.thickness }))
    .filter((s): s is { guid: string; want: number } => s.guid != null && s.want != null);
  if (!built.length) return;

  let boxes: ({ zMin: number; zMax: number } | null)[];
  try {
    boxes = await client.boundingBoxes(built.map((s) => ({ elementId: { guid: s.guid } })));
  } catch {
    return; // a diagnostic must never break the push
  }

  for (let i = 0; i < built.length; i++) {
    const box = boxes[i];
    if (!box) continue;
    const got = box.zMax - box.zMin;
    if (Math.abs(got - built[i].want) <= 0.001) continue;
    hints.add(
      `ArchiCAD built the slabs ${(got * 1000).toFixed(0)} mm thick instead of the `
      + `${(built[i].want * 1000).toFixed(0)} mm requested. Its Slab tool is set to a composite, `
      + `which overrides the thickness and cannot be changed through the API. Set the Slab tool's `
      + `structure to Basic in ArchiCAD (Slab Settings → Structure), then push again.`,
    );
    return; // one slab is enough to diagnose the tool default
  }
}

export async function pushToArchicad(client: TapirClient, plan: ArchicadPlan): Promise<PushResult> {
  // Stories first: every element carries a floorIndex into this structure.
  await client.setStories(plan.stories);

  const existing: ElementId[] = [];
  for (const type of MANAGED_TYPES) existing.push(...await client.elementsByType(type));
  await client.deleteElements(existing);

  const created: Record<string, number> = {};
  const rejected: PushResult['rejected'] = {};
  const hints = new Set<string>();

  const record = (key: string, outcomes: CreateOutcome[]) => {
    const failures = outcomes.filter((o) => o.guid == null);
    const ok = outcomes.length - failures.length;
    if (ok) created[key] = ok;
    if (failures.length) {
      rejected[key] = { count: failures.length, reason: failures[0].message ?? 'unknown' };
      if (failures.some((f) => f.code === BAD_DATABASE)) {
        hints.add(
          'ArchiCAD refused every opening with APIERR_BADDATABASE. Openings carry a floor-plan '
          + 'marker and can only be created while the floor plan is the current window. The push '
          + 'switches to it automatically, so this means the switch itself failed — bring the '
          + 'floor plan to the front in ArchiCAD and push again.',
        );
      }
    }
    return outcomes;
  };

  record('columns', await client.create('CreateColumns', 'columnsData', plan.columns));
  record('beams', await client.create('CreateBeams', 'beamsData', plan.beams));

  const slabs = record('slabs', await client.create('CreateSlabs', 'slabsData', plan.slabs));
  await checkSlabThickness(client, plan, slabs, hints);

  record('roofs', await client.create('CreateRoofs', 'roofsData', plan.roofs));
  record('stairs', await client.create('CreateStairs', 'stairsData', plan.stairs));

  // GUIDs come back in input order, so a wall's index into plan.walls is also
  // its index here — that is what lets openings find their host.
  const walls = record('walls', await client.create('CreateWalls', 'wallsData', plan.walls));

  // Openings only: they carry a floor-plan marker, so ArchiCAD rejects them
  // outright unless the floor plan is the current database (see BAD_DATABASE).
  // Whatever the user was looking at goes back afterwards, even on failure.
  const windows = withOwners(plan.windows, walls);
  const doors = withOwners(plan.doors, walls);
  if (windows.length || doors.length) {
    const previous = await client.currentWindowType();
    if (previous !== 'FloorPlan') await client.changeWindow('FloorPlan');
    try {
      record('windows', await client.create('CreateWindows', 'windowsData', windows));
      record('doors', await client.create('CreateDoors', 'doorsData', doors));
    } finally {
      if (previous !== 'FloorPlan') await client.changeWindow(previous);
    }
  }

  return { deleted: existing.length, created, rejected, hints: [...hints], skipped: plan.skipped };
}
