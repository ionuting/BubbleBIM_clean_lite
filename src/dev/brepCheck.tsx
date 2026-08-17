/**
 * Standalone visual check for the internal B-rep kernel.
 *
 * Served at /brep-check.html. Mounts `BrepViewer` on a fixed synthetic model so
 * the kernel can be inspected — and screenshotted headlessly — without loading a
 * project or navigating the app's tab state.
 *
 * The model deliberately exercises what the kernel claims to do:
 *   - an L-shaped plan, so wall junctions must be resolved
 *   - walls of two thicknesses meeting, so priority decides who runs through
 *   - a T-junction where a partition meets a bearing wall
 *   - a window (hole in the face) and a door (notch in the outline)
 *   - a column at a corner ax, a room floor slab
 *
 * Development artefact — not part of the shipped app.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { BrepViewer } from '@/components/views/BrepViewer';
import '../index.css';

const STOREY: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const ax = (id: string, x: number, y: number, props: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
  properties: { bimX: x, bimY: y, ...props },
});

const wall = (id: string, props: Record<string, unknown> = {}): BubbleGraphNode => ({
  id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
  properties: { wall_type: 'W25', ...props },
});

let n = 0;
const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `e${n++}`, from, to });

//        c3 ────────── c2
//        │              │
//        │   (room)     │ ← wE has a window
//        │              │
//        c0 ──── m ──── c1
//                │
//                p  ← thin partition, T-junction into the south wall
//        wS has a door
const nodes: BubbleGraphNode[] = [
  STOREY,
  ax('c0', 0, 0, { has_column: 'true', column_type: 'C30x30' }),
  ax('m', 4000, 0),
  ax('c1', 8000, 0, { has_column: 'true', column_type: 'CR30' }),
  ax('c2', 8000, 6000),
  ax('c3', 0, 6000, { has_column: 'true', column_type: 'C30x30' }),
  ax('p', 4000, 3000),

  wall('wS1', { has_beam: 'True', beam_section: 'B25x30' }),
  wall('wS2', { has_beam: 'True', beam_section: 'B25x30' }),
  wall('wE'),
  wall('wN'),
  wall('wW'),
  wall('part', { wall_type: 'W10' }),

  {
    id: 'door', type: 'door', name: 'Ușă', x: 0, y: 0, z: 0, parentId: 'wS1',
    properties: { width: 900, height: 2100, sill_height: 0 },
  },
  {
    id: 'win1', type: 'window', name: 'Fereastră E', x: 0, y: 0, z: 0, parentId: 'wE',
    properties: { width: 1500, height: 1500, sill_height: 900 },
  },
  {
    id: 'win2', type: 'window', name: 'Fereastră N1', x: 0, y: 0, z: 0, parentId: 'wN',
    properties: { width: 1200, height: 1400, sill_height: 900, offset: 1200 },
  },
  {
    id: 'win3', type: 'window', name: 'Fereastră N2', x: 0, y: 0, z: 0, parentId: 'wN',
    properties: { width: 1200, height: 1400, sill_height: 900, offset: 5000 },
  },
  {
    id: 'room', type: 'room', name: 'Living', x: 4000, y: 3000, z: 0, parentId: 'st',
    properties: { contour_offset: 0, slab_type: 'SLAB15' },
  },
];

const edges: BubbleGraphEdge[] = [
  wire('wS1', 'c0'), wire('wS1', 'm'),
  wire('wS2', 'm'), wire('wS2', 'c1'),
  wire('wE', 'c1'), wire('wE', 'c2'),
  wire('wN', 'c2'), wire('wN', 'c3'),
  wire('wW', 'c3'), wire('wW', 'c0'),
  wire('part', 'm'), wire('part', 'p'),

  wire('wS1', 'door'),
  wire('wE', 'win1'),
  wire('wN', 'win2'), wire('wN', 'win3'),

  wire('room', 'c0'), wire('room', 'c1'), wire('room', 'c2'), wire('room', 'c3'),
];

function App() {
  const [sel, setSel] = React.useState<string | null>(null);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#15171c' }}>
      <BrepViewer nodes={nodes} edges={edges} onSelectNode={setSel} selectedNodeId={sel} />
      <div style={{
        position: 'absolute', bottom: 8, left: 8, zIndex: 30,
        font: '11px ui-monospace, monospace', color: 'rgba(255,255,255,.6)',
      }}>
        brep-check — synthetic model {sel ? `· selected: ${sel}` : ''}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
