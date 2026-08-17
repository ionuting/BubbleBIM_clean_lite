/**
 * WorkflowHelpPanel — lightweight overlay explaining the BubbleBIM workflow.
 * Opened via the ? button in the BubbleGraphPanel header.
 */

import React from 'react';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

const STEPS: { icon: string; title: string; detail: string }[] = [
  {
    icon: '⊞',
    title: 'Define the structural grid',
    detail: 'Click ⊞ Axes in the toolbar. Enter X distances (e.g. 6000, 6000) and Y distances in mm. This creates the column-grid layout used by all storeys.',
  },
  {
    icon: '+',
    title: 'Add storeys',
    detail: 'Click "+ Storey". Set a name, bottom elevation and top elevation (mm). A grid of ax-node intersections is generated automatically for each storey.',
  },
  {
    icon: '⬡',
    title: 'Place structural elements',
    detail: 'Select an ax node and enable "has_column" in the Properties panel to place a column. Draw wall or beam edges between two ax nodes using the Edge tool (keyboard E). Set types like W25, C30x30, B30x60 in the property fields.',
  },
  {
    icon: '🪟',
    title: 'Add openings',
    detail: 'Connect a window or door node to a wall edge. Width, height, and sill-height are configurable in the Properties panel. Use ◈ Symbols to design custom window/door profiles.',
  },
  {
    icon: '▣',
    title: 'Add slabs & rooms',
    detail: 'Connect a slab or room node to four or more ax nodes that form the polygon boundary. Slab thickness is set via the "slab_type" property (e.g. SLAB20 = 20 cm).',
  },
  {
    icon: '📐',
    title: 'View in 2D / 3D',
    detail: 'Right-click a storey → "Open Floor Plan" for the 2D orthographic view. Click "+ 3D" in the View tab bar to open the 3D model. Sections and elevations are available from the View menu on the canvas toolbar.',
  },
  {
    icon: '💾',
    title: 'Save & share',
    detail: 'Click Save to download a .bbim file. Open a .bbim file with the Open button. The project auto-saves to browser localStorage between sessions.',
  },
];

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'S', action: 'Switch to Select mode' },
  { keys: 'E', action: 'Switch to Edge (connect) mode' },
  { keys: 'Delete / Backspace', action: 'Delete selected node or edge' },
  { keys: 'Ctrl + Z', action: 'Undo' },
  { keys: 'Ctrl + Shift + Z', action: 'Redo' },
  { keys: 'Scroll', action: 'Zoom in / out on canvas' },
  { keys: 'Space + Drag', action: 'Pan canvas' },
  { keys: 'Ctrl + A', action: 'Select all nodes' },
];

const NODE_TYPES: { type: string; desc: string }[] = [
  { type: 'storey', desc: 'Floor level container — holds ax grid and all elements' },
  { type: 'ax', desc: 'Column-grid intersection — the spatial anchor for all geometry' },
  { type: 'wall', desc: 'Vertical panel — connects two ax nodes, thickness from type (W20, W25…)' },
  { type: 'beam', desc: 'Horizontal span — connects two ax nodes, size from type (B30x60…)' },
  { type: 'column', desc: 'Enabled on an ax node via has_column property (C25x25, CR30…)' },
  { type: 'slab', desc: 'Horizontal plate — connects to ax boundary nodes (SLAB15, SLAB20…)' },
  { type: 'window', desc: 'Opening — connects to a wall edge' },
  { type: 'door', desc: 'Opening — connects to a wall edge' },
  { type: 'room', desc: 'Space — connects to ax nodes forming the room polygon' },
  { type: 'foundation', desc: 'Footing below ground — same geometry as slab' },
  { type: 'section / view', desc: 'Cutting plane — opens a parametric section or elevation tab' },
];

export function WorkflowHelpPanel({ onClose }: Props) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto', padding: '32px 16px 40px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'hsl(var(--background))',
          border: '1px solid hsl(var(--border))',
          borderRadius: 14,
          maxWidth: 660, width: '100%',
          padding: '28px 28px 32px',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          <span style={{ fontSize: 20, color: 'hsl(var(--primary))' }}>⬡</span>
          <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: '-0.02em' }}>BubbleBIM — Workflow Guide</span>
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
              color: 'hsl(var(--muted-foreground))', padding: 4, borderRadius: 6,
              display: 'flex', alignItems: 'center',
            }}
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Steps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 28 }}>
          {STEPS.map(({ icon, title, detail }, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div style={{
                minWidth: 32, height: 32, borderRadius: 8,
                background: 'hsl(var(--primary) / 0.12)',
                color: 'hsl(var(--primary))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 15, fontWeight: 700, flexShrink: 0,
              }}>
                {icon}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: 'hsl(var(--primary))',
                    background: 'hsl(var(--primary) / 0.1)',
                    borderRadius: 4, padding: '1px 6px', marginRight: 7,
                  }}>{i + 1}</span>
                  {title}
                </div>
                <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: 12, lineHeight: 1.6 }}>
                  {detail}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Node types */}
        <div style={{
          borderTop: '1px solid hsl(var(--border))', paddingTop: 20, marginBottom: 24,
        }}>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 12, color: 'hsl(var(--foreground))' }}>
            Node types
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
            {NODE_TYPES.map(({ type, desc }) => (
              <div key={type} style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                <code style={{
                  background: 'hsl(var(--muted))', borderRadius: 4,
                  padding: '1px 5px', fontSize: 11, color: 'hsl(var(--primary))',
                  marginRight: 5,
                }}>{type}</code>
                <span style={{ color: 'hsl(var(--muted-foreground))' }}>{desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Shortcuts */}
        <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 12 }}>Keyboard shortcuts</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 16px' }}>
            {SHORTCUTS.map(({ keys, action }) => (
              <div key={keys} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5 }}>
                <kbd style={{
                  background: 'hsl(var(--muted))', border: '1px solid hsl(var(--border))',
                  borderRadius: 4, padding: '1px 6px', fontSize: 10.5,
                  color: 'hsl(var(--foreground))', whiteSpace: 'nowrap', flexShrink: 0,
                }}>{keys}</kbd>
                <span style={{ color: 'hsl(var(--muted-foreground))' }}>{action}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
