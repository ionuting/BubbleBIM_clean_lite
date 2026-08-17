/**
 * Standalone visual check for the FEM spike (buildFemModel + @awatif/components).
 *
 * Served at /fem-check.html. Mounts `FemViewer` on a fixed synthetic model so
 * the column/beam/wall/slab conversion + solver can be inspected — and
 * screenshotted headlessly — without loading a project.
 *
 * The model: a 5m × 4m single-storey box, 4 corner columns (C30x30), 4 walls
 * (W20) between them, one beam across the middle (B25x30), a slab (room)
 * covering the whole footprint, and a standalone `slab` node cantilevered
 * off the east wall (a balcony, not tied to a `room`) — enough to exercise
 * all four element kinds and both slab sources, with both shared-DOF corners
 * (on c1/c2) and fresh pinned corners (on the two unsupported balcony
 * corners) in one scene.
 */

import { createRoot } from 'react-dom/client';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { FemViewer } from '@/components/views/FemViewer';
import '../index.css';

const STOREY: BubbleGraphNode = {
  id: 'st', type: 'storey', name: 'Parter', x: 0, y: 0, z: 0,
  properties: { bottomElevation: 0, topElevation: 3000 },
};

const ax = (id: string, x: number, y: number, hasColumn = true): BubbleGraphNode => ({
  id, type: 'ax', name: id, x, y, z: 0, parentId: 'st',
  properties: { bimX: x, bimY: y, has_column: hasColumn ? 'True' : 'False', column_type: 'C30x30' },
});

const wall = (id: string): BubbleGraphNode => ({
  id, type: 'wall', name: id, x: 0, y: 0, z: 0, parentId: 'st',
  properties: { wall_type: 'W20' },
});

let n = 0;
const wire = (from: string, to: string): BubbleGraphEdge => ({ id: `e${n++}`, from, to });

//   c3 ─────w2───── c2
//   │                │
//  w3    m0══beam══m1  ← 2 interior columns + a beam spanning between them
//   │                │
//   c0 ─────w0───── c1
const c0 = ax('c0', 0, 0);
const c1 = ax('c1', 5000, 0);
const c2 = ax('c2', 5000, 4000);
const c3 = ax('c3', 0, 4000);
const m0 = ax('m0', 1000, 2000);
const m1 = ax('m1', 4000, 2000);
// Balcony outer corners — no column, so addSlabShell falls back to a pinned support.
const b0 = ax('b0', 6500, 0, false);
const b1 = ax('b1', 6500, 4000, false);

const w0 = wall('w0'), w1 = wall('w1'), w2 = wall('w2'), w3 = wall('w3');
const beam: BubbleGraphNode = {
  id: 'beam1', type: 'beam', name: 'B1', x: 2500, y: 2000, z: 0, parentId: 'st',
  properties: { beam_section: 'B25x30' },
};
const room: BubbleGraphNode = {
  id: 'room', type: 'room', name: 'R', x: 2500, y: 2000, z: 0, parentId: 'st',
  properties: { slab_type: 'SLAB15' },
};
const balcony: BubbleGraphNode = {
  id: 'balcony', type: 'slab', name: 'Balcony', x: 5750, y: 2000, z: 0, parentId: 'st',
  properties: { slab_type: 'SLAB12' },
};

const nodes: BubbleGraphNode[] = [STOREY, c0, c1, c2, c3, m0, m1, b0, b1, w0, w1, w2, w3, beam, room, balcony];
const edges: BubbleGraphEdge[] = [
  wire('w0', 'c0'), wire('w0', 'c1'),
  wire('w1', 'c1'), wire('w1', 'c2'),
  wire('w2', 'c2'), wire('w2', 'c3'),
  wire('w3', 'c3'), wire('w3', 'c0'),
  wire('beam1', 'm0'), wire('beam1', 'm1'),
  wire('room', 'c0'), wire('room', 'c1'), wire('room', 'c2'), wire('room', 'c3'),
  wire('balcony', 'c1'), wire('balcony', 'b0'), wire('balcony', 'b1'), wire('balcony', 'c2'),
];

function App() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#15171c' }}>
      <FemViewer nodes={nodes} edges={edges} storeyId="st" options={{ divisions: 4 }} />
      <div style={{
        position: 'absolute', bottom: 8, left: 8, zIndex: 30,
        font: '11px ui-monospace, monospace', color: 'rgba(255,255,255,.6)',
      }}>
        fem-check — 6 columns (4 corner + 2 interior) · 4 walls · 1 interior beam · 1 room slab · 1 standalone balcony slab
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
