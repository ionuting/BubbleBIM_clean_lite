/**
 * Calc2DInset — inserție de geometrie 2D (plan) pentru nodurile dintr-un calcul,
 * cu overlay al grafului relațional. „Filtrul" = `nodeIds` din urma de calcul.
 *
 * Randează, ca un mini-plan SVG (asemeni planurilor 2D), doar elementele implicate
 * în calcul: pereți / stâlpi / grinzi, plus muchiile de graf dintre ele. Static și
 * ușor (fără pan/zoom) → potrivit pentru raport și pentru snapshot.
 *
 * Convenții: poziții în mm (`getNodeBimPos`), Y în sus → SVG cu Y flip. Dimensiunile
 * din parserii de tip (`parseWallThickness` etc.) sunt în metri → ×1000.
 */
import { useMemo } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildCalc2DModel } from '@/lib/quantityTakeoff';

interface Calc2DInsetProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  /** Nodurile din calcul (focus, evidențiate roșu). */
  nodeIds: string[];
  /** true = arată tot planul (albastru) cu focus-ul roșu; false = doar focus + vecini. */
  fullContext?: boolean;
  height?: number;
}

// Context = albastru, focus = roșu.
const FOCUS = '#dc2626';       // roșu
const FOCUS_DARK = '#991b1b';
const CTX = '#60a5fa';         // albastru
const CTX_LIGHT = '#bfdbfe';

export function Calc2DInset({ nodes, edges, nodeIds, fullContext = false, height = 220 }: Calc2DInsetProps) {
  const model = useMemo(() => buildCalc2DModel(nodes, edges, nodeIds, { fullContext }), [nodes, edges, nodeIds, fullContext]);

  if (!model) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}>
        No geometry to display
      </div>
    );
  }

  const { minX, maxY, w, h, span } = model;
  // mm → coord SVG local (Y flip).
  const X = (x: number) => x - minX;
  const Y = (y: number) => maxY - y;
  const graphStroke = span * 0.004;
  const nodeR = span * 0.014;

  return (
    <div style={{ height, border: '1px solid hsl(var(--border))', borderRadius: 8, overflow: 'hidden', background: '#f8fafc' }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
        {/* Context (albastru) desenat întâi, focus (roșu) deasupra. */}
        {/* Pereți / grinzi */}
        {[...model.walls].sort((a, b) => Number(a.focus) - Number(b.focus)).map((wl, i) => (
          <line
            key={`w${i}`}
            x1={X(wl.a.x)} y1={Y(wl.a.y)} x2={X(wl.b.x)} y2={Y(wl.b.y)}
            stroke={wl.focus ? FOCUS : CTX}
            strokeWidth={Math.max(wl.thick, span * 0.008)}
            strokeLinecap="round"
            opacity={wl.focus ? 1 : 0.55}
          />
        ))}
        {/* Stâlpi */}
        {[...model.cols].sort((a, b) => Number(a.focus) - Number(b.focus)).map((c, i) => (
          <rect
            key={`c${i}`}
            x={X(c.c.x) - c.w / 2} y={Y(c.c.y) - c.d / 2} width={c.w} height={c.d}
            fill={c.focus ? FOCUS : CTX} stroke={c.focus ? FOCUS_DARK : CTX} strokeWidth={span * 0.003}
            opacity={c.focus ? 1 : 0.55}
          />
        ))}
        {/* Overlay graf: muchii */}
        {model.graphEdges.map((e, i) => (
          <line key={`ge${i}`} x1={X(e.a.x)} y1={Y(e.a.y)} x2={X(e.b.x)} y2={Y(e.b.y)} stroke="#6366f1" strokeWidth={graphStroke} strokeDasharray={`${graphStroke * 2} ${graphStroke * 2}`} opacity={0.4} />
        ))}
        {/* Overlay graf: noduri */}
        {[...model.graphNodes].sort((a, b) => Number(a.focus) - Number(b.focus)).map((g, i) => (
          <circle key={`gn${i}`} cx={X(g.p.x)} cy={Y(g.p.y)} r={g.focus ? nodeR * 1.15 : nodeR} fill={g.focus ? FOCUS : CTX_LIGHT} stroke="#fff" strokeWidth={nodeR * 0.25} />
        ))}
        {/* Markeri (ferestre/uși/altele) */}
        {[...model.markers].sort((a, b) => Number(a.focus) - Number(b.focus)).map((m, i) => (
          <circle key={`m${i}`} cx={X(m.p.x)} cy={Y(m.p.y)} r={nodeR * 0.9} fill={m.focus ? FOCUS : CTX_LIGHT} stroke="#fff" strokeWidth={nodeR * 0.2} />
        ))}
      </svg>
    </div>
  );
}
