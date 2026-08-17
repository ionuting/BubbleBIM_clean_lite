/**
 * QuestPanel — a quiet, "pro" guidance HUD for the graph editor.
 *
 * Renders the live "First Building" questline (see lib/quests/questline.ts) as a
 * small card docked on the canvas. It holds no modeling state: every step ticks
 * itself off as the graph changes. Deliberately understated — muted palette, a
 * single progress ring, one contextual hint at a time — so it reads as premium
 * onboarding rather than a game overlay. Collapsible; remembers its state.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Check } from 'lucide-react';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';
import { evaluateQuestline } from '@/lib/quests/questline';

interface QuestPanelProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
}

const COLLAPSE_KEY = 'bb.quest.collapsed';
const DISMISS_KEY = 'bb.quest.dismissed';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Small SVG progress ring with the percent (or a check when complete) inside. */
function ProgressRing({ pct, done, pulse }: { pct: number; done: boolean; pulse: boolean }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct / 100);
  return (
    <svg
      width={30} height={30} viewBox="0 0 30 30"
      style={{
        flexShrink: 0,
        transform: pulse ? 'scale(1.14)' : 'scale(1)',
        transition: 'transform 0.28s cubic-bezier(0.34,1.56,0.64,1)',
      }}
    >
      <circle cx={15} cy={15} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={2.5} />
      <circle
        cx={15} cy={15} r={r} fill="none"
        stroke={done ? 'hsl(var(--primary))' : 'hsl(var(--primary))'}
        strokeWidth={2.5} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 15 15)"
        style={{ transition: 'stroke-dashoffset 0.45s ease' }}
      />
      {done ? (
        <g transform="translate(15 15)">
          <path d="M-3.4 0.2 L-1 2.6 L3.6 -2.6" fill="none" stroke="hsl(var(--primary))"
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ) : (
        <text x={15} y={15} textAnchor="middle" dominantBaseline="central"
          fontSize={9} fontWeight={600} fill="hsl(var(--foreground))">
          {pct}
        </text>
      )}
    </svg>
  );
}

export function QuestPanel({ nodes, edges, buildingAxes }: QuestPanelProps) {
  const progress = useMemo(
    () => evaluateQuestline(nodes, edges, buildingAxes),
    [nodes, edges, buildingAxes],
  );

  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(COLLAPSE_KEY) === '1',
  );
  const [dismissed, setDismissed] = useState<boolean>(
    () => localStorage.getItem(DISMISS_KEY) === '1',
  );
  useEffect(() => { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); }, [collapsed]);
  useEffect(() => { localStorage.setItem(DISMISS_KEY, dismissed ? '1' : '0'); }, [dismissed]);

  // Pulse the ring for a beat whenever a step is newly completed.
  const prevCompleted = useRef(progress.completed);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const advanced = progress.completed > prevCompleted.current;
    prevCompleted.current = progress.completed;
    if (!advanced || prefersReducedMotion()) return undefined;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 320);
    return () => clearTimeout(t);
  }, [progress.completed]);

  // Auto-collapse once complete (but stay discoverable as a "done" pill).
  const wasAllDone = useRef(progress.allDone);
  useEffect(() => {
    if (progress.allDone && !wasAllDone.current) setCollapsed(true);
    wasAllDone.current = progress.allDone;
  }, [progress.allDone]);

  if (dismissed) {
    // A tiny re-open affordance so the feature is never fully lost.
    return (
      <button
        type="button"
        onClick={() => setDismissed(false)}
        title="Show build guide"
        style={{
          position: 'absolute', left: 8, bottom: 8, zIndex: 20,
          width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center',
          background: 'hsl(var(--background) / 0.85)', border: '1px solid hsl(var(--border))',
          backdropFilter: 'blur(6px)', cursor: 'pointer',
        }}
      >
        <ProgressRing pct={progress.pct} done={progress.allDone} pulse={false} />
      </button>
    );
  }

  const { steps, nextStep, completed, total, pct, allDone } = progress;

  return (
    <div
      style={{
        position: 'absolute', left: 8, bottom: 8, zIndex: 20,
        width: collapsed ? 'auto' : 232, maxWidth: 'calc(100% - 16px)',
        borderRadius: 12, overflow: 'hidden',
        background: 'hsl(var(--background) / 0.92)',
        border: '1px solid hsl(var(--border))',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 4px 16px -6px rgb(0 0 0 / 0.28)',
        fontSize: 11,
        color: 'hsl(var(--foreground))',
      }}
    >
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setCollapsed((c) => !c); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 9px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <ProgressRing pct={pct} done={allDone} pulse={pulse} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 11.5, letterSpacing: 0.1 }}>
              {allDone ? 'Building complete' : 'First building'}
            </span>
            <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: 10 }}>
              {completed}/{total}
            </span>
          </div>
          {collapsed && !allDone && nextStep && (
            <div style={{
              color: 'hsl(var(--muted-foreground))', fontSize: 10, marginTop: 1,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              Next: {nextStep.title}
            </div>
          )}
        </div>
        {collapsed ? <ChevronUp size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
          : <ChevronDown size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />}
      </div>

      {/* Steps */}
      {!collapsed && (
        <div style={{ padding: '2px 6px 8px' }}>
          {steps.map((s) => {
            const active = !allDone && nextStep?.id === s.id;
            return (
              <div
                key={s.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '5px 7px', borderRadius: 8,
                  background: active ? 'hsl(var(--accent) / 0.6)' : 'transparent',
                  borderLeft: active ? '2px solid hsl(var(--primary))' : '2px solid transparent',
                  transition: 'background 0.15s',
                }}
              >
                <span style={{
                  width: 16, height: 16, marginTop: 1, flexShrink: 0,
                  display: 'grid', placeItems: 'center',
                  borderRadius: 5,
                  background: s.done ? 'hsl(var(--primary))' : 'transparent',
                  border: s.done ? 'none' : '1px solid hsl(var(--border))',
                  color: s.done ? '#fff' : 'hsl(var(--muted-foreground))',
                  fontSize: 9,
                }}>
                  {s.done ? <Check size={11} strokeWidth={3} /> : s.icon}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                  }}>
                    <span style={{
                      fontSize: 11,
                      color: s.done ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
                      textDecoration: s.done ? 'line-through' : 'none',
                      opacity: s.done ? 0.7 : 1,
                    }}>
                      {s.title}
                    </span>
                    {!s.done && s.target > 1 && (
                      <span style={{ fontSize: 9.5, color: 'hsl(var(--muted-foreground))', flexShrink: 0 }}>
                        {s.current}/{s.target}
                      </span>
                    )}
                  </div>
                  {active && (
                    <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 2, lineHeight: 1.35 }}>
                      {s.hint}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
              style={{
                fontSize: 10, color: 'hsl(var(--muted-foreground))',
                background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px',
              }}
            >
              {allDone ? 'Dismiss' : 'Hide guide'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
