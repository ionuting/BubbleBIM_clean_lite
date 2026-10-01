/**
 * planDefaults.ts — the architectural symbol a door gets when nobody has drawn
 * one for it.
 *
 * `DOOR_PLAN_TEMPLATES` already holds proper parametric plan symbols — mask,
 * wall breaks, header, leaf and swing arc, all written as expressions in the
 * opening's width `W` and the wall's thickness `T`. Until now only Symbol
 * Studio read them: the floor plan drew its own hard-coded version instead, so
 * the editor and the drawing were two separate descriptions of the same door
 * and could disagree. This makes the template the plan's default too, which
 * leaves one description.
 *
 * The simple controls keep working. Every part the templates build carries a
 * label — `Mask`, `Break`, `Frame`, `Panel`, `Arc` — so the same
 * `DoorPlan2DConfig` that drove the old rendering is applied to the template
 * by label: a part switched off is dropped, and colours and weights are
 * written onto the parts they belong to.
 */

import type { SvgSymbolDef, SvgSymNode } from '@/lib/svgSymbolStore';
import type { DoorPlan2DConfig } from '@/lib/doorSymbolLibrary';
import type { WindowPlan2DConfig } from '@/lib/windowSymbolLibrary';
import { pickDoorTemplate } from './doorPlanTemplates';
import { pickWindowTemplate } from './windowPlanTemplates';

/** One base template per family; the config is applied to a copy. */
const _base = new Map<string, SvgSymbolDef>();

function baseDoorDef(family: string): SvgSymbolDef {
  const cached = _base.get(family);
  if (cached) return cached;
  const tpl = pickDoorTemplate(family);
  const def = tpl.build(`swing:${family}`, tpl.name);
  _base.set(family, def);
  return def;
}

/** Which config flag, if any, governs a labelled part. */
function shownBy(label: string, cfg: DoorPlan2DConfig): boolean {
  switch (label) {
    case 'Mask':  return cfg.showWhiteMask;
    case 'Break': return cfg.showWallBreaks;
    case 'Panel': return cfg.showDoorPanel;
    case 'Arc':   return cfg.showSwingArc;
    default:      return true;
  }
}

/** The stroke a labelled part takes from the config, if the config names one. */
function strokeFor(label: string, cfg: DoorPlan2DConfig): { stroke: string; weight: number } | null {
  switch (label) {
    // The header line reads as part of the leaf's linework, as it did before.
    case 'Frame': return { stroke: cfg.panelColor, weight: cfg.panelLineWeight * 1.2 };
    case 'Panel': return { stroke: cfg.panelColor, weight: cfg.panelLineWeight };
    case 'Arc':   return { stroke: cfg.arcColor, weight: cfg.arcLineWeight };
    case 'Break': return { stroke: cfg.breakLineColor, weight: cfg.breakLineWeight };
    default:      return null;
  }
}

/**
 * The plan symbol for a door of this swing family, with the simple controls
 * applied.
 *
 * Dropping a part takes its edges with it: an edge pointing at a node that is
 * no longer there would render as nothing at best, and as a stray line from
 * the origin at worst.
 */
export function defaultDoorPlanDef(family: string, cfg: DoorPlan2DConfig): SvgSymbolDef {
  const base = baseDoorDef(family);

  const dropped = new Set<string>();
  const nodes: SvgSymNode[] = [];
  for (const n of base.nodes) {
    if (!shownBy(n.label, cfg)) { dropped.add(n.id); continue; }
    const s = strokeFor(n.label, cfg);
    nodes.push(s ? { ...n, props: { ...n.props, stroke: s.stroke, weight: s.weight } } : n);
  }
  return {
    ...base,
    nodes,
    // A no-op when nothing was dropped, which is the common case.
    edges: dropped.size === 0
      ? base.edges
      : base.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to)),
  };
}

// ─── Windows ─────────────────────────────────────────────────────────────────

const _baseWin = new Map<string, SvgSymbolDef>();

function baseWindowDef(family: string): SvgSymbolDef {
  const cached = _baseWin.get(family);
  if (cached) return cached;
  const tpl = pickWindowTemplate(family);
  const def = tpl.build(`opening:${family}`, tpl.name);
  _baseWin.set(family, def);
  return def;
}

/** Window parts the config can switch off. `SqL`/`SqR` are the frame corners. */
function winShownBy(label: string, cfg: WindowPlan2DConfig): boolean {
  switch (label) {
    case 'Mask':  return true;
    case 'SqL':
    case 'SqR':   return cfg.showFrameSquares;
    case 'Glass': return cfg.showGlassPanel;
    case 'Sill':  return cfg.showSillZone;
    default:      return true;
  }
}

function winStrokeFor(label: string, cfg: WindowPlan2DConfig): { stroke: string; weight: number } | null {
  switch (label) {
    case 'SqL':
    case 'SqR':
    case 'Frame': return { stroke: cfg.frameColor, weight: cfg.cutLineWeight };
    case 'Glass': return { stroke: cfg.glassColor, weight: cfg.seenLineWeight };
    case 'Sill':  return { stroke: cfg.sillLineColor, weight: cfg.seenLineWeight };
    default:      return null;
  }
}

/** The plan symbol for a window of this opening family, config applied. */
export function defaultWindowPlanDef(family: string, cfg: WindowPlan2DConfig): SvgSymbolDef {
  const base = baseWindowDef(family);

  const dropped = new Set<string>();
  const nodes: SvgSymNode[] = [];
  for (const n of base.nodes) {
    if (!winShownBy(n.label, cfg)) { dropped.add(n.id); continue; }
    const s = winStrokeFor(n.label, cfg);
    nodes.push(s ? { ...n, props: { ...n.props, stroke: s.stroke, weight: s.weight } } : n);
  }

  return {
    ...base,
    nodes,
    edges: dropped.size === 0
      ? base.edges
      : base.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to)),
  };
}
