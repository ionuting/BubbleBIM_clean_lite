/**
 * WelcomeScreen — shown on first visit (localStorage empty).
 * Lets the user either open the bundled example project or start from scratch.
 */

import React from 'react';

interface WelcomeScreenProps {
  onLoadExample: () => void;
  onNewProject: () => void;
  loading?: boolean;
}

const STEPS = [
  {
    n: '1',
    title: 'Define Axes',
    desc: 'Click ⊞ Axes to set the structural grid — enter X and Y distances in mm.',
  },
  {
    n: '2',
    title: 'Add Storeys',
    desc: 'Use "+ Storey" to create each floor level with bottom/top elevations.',
  },
  {
    n: '3',
    title: 'Model Elements',
    desc: 'Add columns, walls, slabs and openings from the node library on the left.',
  },
];

export function WelcomeScreen({ onLoadExample, onNewProject, loading = false }: WelcomeScreenProps) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'hsl(var(--background))',
        padding: '24px 16px',
        overflowY: 'auto',
      }}
    >
      {/* ── Logo ── */}
      <div style={{ fontSize: 44, lineHeight: 1, color: 'hsl(var(--primary))' }}>⬡</div>
      <h1 style={{
        fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em',
        margin: '8px 0 4px', color: 'hsl(var(--foreground))',
      }}>
        BubbleBIM
      </h1>
      <p style={{ color: 'hsl(var(--muted-foreground))', fontSize: 13, margin: '0 0 36px' }}>
        Open-source parametric BIM editor — browser-based, no install required
      </p>

      {/* ── Action cards ── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 44 }}>

        {/* Example project */}
        <div style={{
          border: '1.5px solid hsl(var(--primary) / 0.35)',
          borderRadius: 14, padding: '24px 26px',
          width: 248, background: 'hsl(var(--primary) / 0.04)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>🏢</div>
          <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 6 }}>My Building</div>
          <div style={{
            color: 'hsl(var(--muted-foreground))', fontSize: 12.5,
            flex: 1, marginBottom: 20, lineHeight: 1.5,
          }}>
            A complete multi-storey example with a structural grid, columns, walls, slabs and windows.
          </div>
          <button
            className="bb-btn primary"
            style={{ width: '100%', justifyContent: 'center', opacity: loading ? 0.6 : 1 }}
            disabled={loading}
            onClick={onLoadExample}
          >
            {loading ? 'Loading…' : 'Open Example'}
          </button>
        </div>

        {/* New project */}
        <div style={{
          border: '1.5px solid hsl(var(--border))',
          borderRadius: 14, padding: '24px 26px',
          width: 248, background: 'hsl(var(--card))',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>✦</div>
          <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 6 }}>New Project</div>
          <div style={{
            color: 'hsl(var(--muted-foreground))', fontSize: 12.5,
            flex: 1, marginBottom: 20, lineHeight: 1.5,
          }}>
            Start from a blank canvas. Define your building axes and begin modeling from scratch.
          </div>
          <button
            className="bb-btn"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={onNewProject}
          >
            Start from Scratch
          </button>
        </div>

      </div>

      {/* ── 3-step quick guide ── */}
      <div style={{
        display: 'flex', gap: 0, flexWrap: 'wrap', justifyContent: 'center',
        maxWidth: 580, borderTop: '1px solid hsl(var(--border))', paddingTop: 28,
        width: '100%',
      }}>
        {STEPS.map(({ n, title, desc }, i) => (
          <div key={n} style={{
            display: 'flex', gap: 12, alignItems: 'flex-start',
            flex: '1 1 160px', padding: '0 16px 0',
            borderRight: i < STEPS.length - 1 ? '1px solid hsl(var(--border))' : 'none',
            marginBottom: 8,
          }}>
            <div style={{
              minWidth: 26, height: 26, borderRadius: '50%',
              background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, marginTop: 2,
            }}>
              {n}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 4 }}>{title}</div>
              <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: 11.5, lineHeight: 1.55 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Existing project hint ── */}
      <p style={{ marginTop: 24, color: 'hsl(var(--muted-foreground))', fontSize: 11.5 }}>
        Already have a <code>.bbim</code> file? Use <strong>Open</strong> in the toolbar after entering the editor.
      </p>
    </div>
  );
}
