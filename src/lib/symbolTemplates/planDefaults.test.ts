import { describe, it, expect } from 'vitest';
import { defaultDoorPlanDef } from './planDefaults';
import { DEFAULT_DOOR_PLAN_CONFIG, type DoorPlan2DConfig } from '@/lib/doorSymbolLibrary';
import { buildDoorSymRenderParams, renderSymbolInlineElements } from '@/lib/svgSymbolStore';

const cfg = (over: Partial<DoorPlan2DConfig> = {}): DoorPlan2DConfig =>
  ({ ...DEFAULT_DOOR_PLAN_CONFIG, ...over });

const labels = (family: string, c = cfg()) =>
  defaultDoorPlanDef(family, c).nodes.map((n) => n.label);

describe('defaultDoorPlanDef', () => {
  it('gives a left-hung door its leaf and its arc', () => {
    const got = labels('left');
    expect(got).toContain('Panel');
    expect(got).toContain('Arc');
    // And the parts that make it read as a hole in a wall.
    expect(got).toContain('Mask');
    expect(got).toContain('Break');
    expect(got).toContain('Frame');
  });

  it('picks the family the swing asks for', () => {
    // Two leaves for a double door, one for a single.
    const dbl = labels('double').filter((l) => l === 'Panel');
    const one = labels('left').filter((l) => l === 'Panel');
    expect(dbl.length).toBe(2);
    expect(one.length).toBe(1);
    // A slider has no swing to draw.
    expect(labels('sliding')).not.toContain('Arc');
  });

  it('drops a part the config switches off, and its edges with it', () => {
    const on = defaultDoorPlanDef('left', cfg());
    const off = defaultDoorPlanDef('left', cfg({ showSwingArc: false, showDoorPanel: false }));
    expect(off.nodes.map((n) => n.label)).not.toContain('Arc');
    expect(off.nodes.map((n) => n.label)).not.toContain('Panel');
    // An edge pointing at a node that is gone would draw a stray line from
    // the symbol's origin, so the edges have to go too.
    const ids = new Set(off.nodes.map((n) => n.id));
    for (const e of off.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    expect(off.edges.length).toBeLessThan(on.edges.length);
  });

  it('writes the config\'s colours onto the parts they belong to', () => {
    const def = defaultDoorPlanDef('left', cfg({
      panelColor: '#ff0000', panelLineWeight: 3,
      arcColor: '#00ff00', arcLineWeight: 0.5,
      breakLineColor: '#0000ff', breakLineWeight: 4,
    }));
    const byLabel = (l: string) => def.nodes.filter((n) => n.label === l);
    expect(byLabel('Panel')[0].props.stroke).toBe('#ff0000');
    expect(byLabel('Panel')[0].props.weight).toBe(3);
    expect(byLabel('Arc')[0].props.stroke).toBe('#00ff00');
    expect(byLabel('Arc')[0].props.weight).toBe(0.5);
    expect(byLabel('Break')[0].props.stroke).toBe('#0000ff');
    expect(byLabel('Break')[0].props.weight).toBe(4);
  });

  it('does not mutate the template it builds from', () => {
    // The base is cached per family; recolouring one door must not recolour
    // every other door in the drawing.
    defaultDoorPlanDef('left', cfg({ panelColor: '#ff0000' }));
    const plain = defaultDoorPlanDef('left', cfg());
    const panel = plain.nodes.find((n) => n.label === 'Panel')!;
    expect(panel.props.stroke).toBe(DEFAULT_DOOR_PLAN_CONFIG.panelColor);
  });

  it('still answers for a swing nobody has a template for', () => {
    // `pickDoorTemplate` falls back rather than returning nothing, so a plan
    // never loses a door to an unknown swing value.
    expect(defaultDoorPlanDef('folding', cfg()).nodes.length).toBeGreaterThan(0);
    expect(defaultDoorPlanDef('', cfg()).nodes.length).toBeGreaterThan(0);
  });
});

describe('and it renders to an actual arc', () => {
  // Nodes with the right labels prove the symbol is assembled; this proves it
  // reaches the drawing as geometry, through the same renderer the plan uses
  // for a hand-drawn symbol.
  it('emits a swing arc and a leaf for a 900 mm door in a 250 wall', () => {
    const def = defaultDoorPlanDef('left', cfg());
    const svg = renderSymbolInlineElements(def, buildDoorSymRenderParams({}, 900, 250))
      .join('\n');
    // Not just "an arc exists" — the geometry has to carry the sizes. Every
    // template coordinate is an expression in W and T, and an expression that
    // fails to evaluate comes back as 0, which draws the whole symbol on top
    // of its own origin while still emitting every element.
    expect(svg).toContain('<polygon points="0.00,0.00 900.00,0.00 900.00,250.00 0.00,250.00"');
    // Wall breaks at both jambs, across the wall.
    expect(svg).toContain('x1="900.00" y1="0.00" x2="900.00" y2="250.00"');
    // An arc with a radius, not a degenerate one.
    const arc = /<path d="M [\d.-]+ [\d.-]+ A ([\d.]+) ([\d.]+)/.exec(svg);
    expect(arc).toBeTruthy();
    expect(Number(arc![1])).toBeCloseTo(900, 3);
  });

  it('loses the arc when the config says no swing', () => {
    const def = defaultDoorPlanDef('left', cfg({ showSwingArc: false }));
    const svg = renderSymbolInlineElements(def, buildDoorSymRenderParams({}, 900, 250))
      .join('\n');
    expect(svg).not.toMatch(/<path[^>]*\bA\b/);
  });
});
