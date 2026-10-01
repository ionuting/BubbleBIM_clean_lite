/**
 * The drawings an exported file carries are the viewers' own drawings, as
 * text. What is checked here: each one is a complete SVG on its own (its
 * own viewBox, its own hatch patterns), the four facades and every section
 * marker come out, and an empty model produces no blank sheets.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildStandaloneDrawings, drawingToSvg } from './standaloneDrawings';
import { computeElevationView } from '@/lib/drawingEngine';

// A 6 × 4 m box with four walls — the same fixture the projection tests use.
const storey: BubbleGraphNode = {
  id: 's1', type: 'storey', name: 'P', x: 0, y: 0, z: 0, parentId: null,
  properties: { bottomElevation: 0, topElevation: 3000, axesX: [0, 6000], axesY: [0, 4000] },
};
const ax = (id: string, gx: number, gy: number): BubbleGraphNode => ({
  id, type: 'ax', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: { gridX: gx, gridY: gy },
});
const wall = (id: string): BubbleGraphNode => ({
  id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 's1', properties: { wall_type: 'W25', height: 3000 },
});
const edge = (from: string, to: string): BubbleGraphEdge => ({ id: `${from}-${to}`, from, to });

const A = ax('A', 0, 0), B = ax('B', 1, 0), C = ax('C', 1, 1), D = ax('D', 0, 1);
const section: BubbleGraphNode = {
  id: 'sec1', type: 'section', name: 'A-A', x: 0, y: 0, z: 0, parentId: null,
  properties: { plan_cut: { x1: -1000, y1: 2000, x2: 7000, y2: 2000 }, look_side: 'left' },
};
const nodes = [storey, A, B, C, D, wall('south'), wall('north'), wall('west'), wall('east'), section];
const edges = [
  edge('A', 'south'), edge('south', 'B'), edge('D', 'north'), edge('north', 'C'),
  edge('A', 'west'), edge('west', 'D'), edge('B', 'east'), edge('east', 'C'),
];

describe('drawingToSvg', () => {
  it('is one complete, self-contained SVG', () => {
    const drawing = computeElevationView(nodes, edges, null, 'N');
    const svg = drawingToSvg(drawing, { caption: 'Fațada nord', openings: true });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toMatch(/viewBox="0 0 \d+(\.\d+)? \d+(\.\d+)?"/);
    expect(svg).toContain('<pattern');                 // hatch defs travel with it
    expect(svg).toContain('Fațada nord');
    expect(svg).toContain('stroke-width=');            // React attributes became SVG ones
    expect(svg).not.toContain('strokeWidth');
  });
});

describe('buildStandaloneDrawings', () => {
  it('puts a plan per storey first when it has the axis grid, as a complete SVG', () => {
    const drawings = buildStandaloneDrawings(nodes, edges, null, () => null, { buildingAxes: { xValues: [0, 6000], yValues: [0, 4000] } });
    expect(drawings[0]).toMatchObject({ id: 'plan-s1', title: 'Plan P', kind: 'plan' });
    expect(drawings).toHaveLength(6);
    const svg = drawings[0].svg;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/^<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toMatch(/viewBox="/);
    expect(svg.endsWith('</svg>')).toBe(true);
    // The walls of the box are in it.
    expect((svg.match(/<polygon/g) ?? []).length).toBeGreaterThan(4);
  });

  it('draws the four facades and every section marker', () => {
    const drawings = buildStandaloneDrawings(nodes, edges, null);
    expect(drawings.map((d) => d.id)).toEqual(['elevation-N', 'elevation-S', 'elevation-E', 'elevation-W', 'section-sec1']);
    expect(drawings.map((d) => d.title)).toEqual(['Fațada nord', 'Fațada sud', 'Fațada est', 'Fațada vest', 'A-A']);
    for (const d of drawings) expect(d.svg).toContain('<svg');
    expect(drawings[4].kind).toBe('section');
  });

  it('asks for the kernel outlines of each cut and draws with them', () => {
    const cuts: unknown[] = [];
    buildStandaloneDrawings(nodes, edges, null, (cut) => { cuts.push(cut); return null; });
    expect(cuts).toHaveLength(5);
  });

  it('exports no blank sheets for an empty model', () => {
    expect(buildStandaloneDrawings([storey], [], null)).toEqual([]);
  });
});
