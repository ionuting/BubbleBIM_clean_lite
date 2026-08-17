"""Patch TechnicalDrawingsViewer.tsx: insert SVG annotation layer + toolbar."""
import pathlib, re

SRC = pathlib.Path(__file__).parent.parent.parent / "src/components/views/TechnicalDrawingsViewer.tsx"
content = SRC.read_text(encoding="utf-8")

# ── 1. Replace SVG closing tag to insert annotation layer ──────────────────
OLD_SVG_END = """          </g>
          );
        })}
      </svg>"""

NEW_SVG_END = """          </g>
          );
        })}

        {/* SVG Annotation layer */}
        <g className="annotations" style={{ pointerEvents: annTool ? 'none' : 'all' }}>
          {annTool === 'linear' && annPendingRef.current && (
            <circle
              cx={annPendingRef.current.x} cy={annPendingRef.current.y}
              r={viewBox.w * 0.008}
              fill="none" stroke="#1565c0" strokeWidth={viewBox.w * 0.001}
              strokeDasharray="4 2" vectorEffect="non-scaling-stroke"
            />
          )}
          {svgAnnotations.map((ann) => {
            if (ann.kind === 'linear') {
              const { p1, p2 } = ann;
              const dx = p2.x - p1.x, dy = p2.y - p1.y;
              const len = Math.sqrt(dx * dx + dy * dy);
              if (len < 1e-6) return null;
              const ux = dx / len, uy = dy / len;
              const nx = -uy, ny = ux;
              const offset = Math.max(len * 0.1, viewBox.w * 0.04);
              const GAP  = viewBox.w * 0.004;
              const OVER = viewBox.w * 0.007;
              const TICK = viewBox.w * 0.009;
              const SW   = viewBox.w * 0.0008;
              const d1 = { x: p1.x + nx * offset, y: p1.y + ny * offset };
              const d2 = { x: p2.x + nx * offset, y: p2.y + ny * offset };
              const e1a = { x: p1.x + nx * GAP,            y: p1.y + ny * GAP };
              const e1b = { x: p1.x + nx * (offset + OVER), y: p1.y + ny * (offset + OVER) };
              const e2a = { x: p2.x + nx * GAP,            y: p2.y + ny * GAP };
              const e2b = { x: p2.x + nx * (offset + OVER), y: p2.y + ny * (offset + OVER) };
              const t1a = { x: d1.x + (ux + nx) * TICK * 0.5, y: d1.y + (uy + ny) * TICK * 0.5 };
              const t1b = { x: d1.x - (ux + nx) * TICK * 0.5, y: d1.y - (uy + ny) * TICK * 0.5 };
              const t2a = { x: d2.x + (ux + nx) * TICK * 0.5, y: d2.y + (uy + ny) * TICK * 0.5 };
              const t2b = { x: d2.x - (ux + nx) * TICK * 0.5, y: d2.y - (uy + ny) * TICK * 0.5 };
              const mid = { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 };
              let dispAngle = Math.atan2(uy, ux) * 180 / Math.PI;
              if (dispAngle >  90) dispAngle -= 180;
              if (dispAngle < -90) dispAngle += 180;
              const dist_mm = Math.round(len * 1000);
              const label = dist_mm >= 1000 ? `${(dist_mm / 1000).toFixed(2)} m` : `${dist_mm}`;
              const COLOR = '#1565c0';
              return (
                <g key={ann.id}
                  onClick={() => setSvgAnnotations((prev) => prev.filter((a) => a.id !== ann.id))}
                  style={{ cursor: 'pointer' }}
                  title="Click to remove">
                  <line x1={e1a.x} y1={e1a.y} x2={e1b.x} y2={e1b.y} stroke={COLOR} strokeWidth={SW} vectorEffect="non-scaling-stroke" />
                  <line x1={e2a.x} y1={e2a.y} x2={e2b.x} y2={e2b.y} stroke={COLOR} strokeWidth={SW} vectorEffect="non-scaling-stroke" />
                  <line x1={d1.x} y1={d1.y} x2={d2.x} y2={d2.y} stroke={COLOR} strokeWidth={SW} vectorEffect="non-scaling-stroke" />
                  <line x1={t1a.x} y1={t1a.y} x2={t1b.x} y2={t1b.y} stroke={COLOR} strokeWidth={SW * 1.6} vectorEffect="non-scaling-stroke" />
                  <line x1={t2a.x} y1={t2a.y} x2={t2b.x} y2={t2b.y} stroke={COLOR} strokeWidth={SW * 1.6} vectorEffect="non-scaling-stroke" />
                  <g transform={`translate(${mid.x},${mid.y}) rotate(${dispAngle})`}>
                    <rect x={-viewBox.w * 0.03} y={-viewBox.w * 0.012} width={viewBox.w * 0.06} height={viewBox.w * 0.024}
                      fill="white" fillOpacity={0.9} rx={viewBox.w * 0.004} />
                    <text x={0} y={0} textAnchor="middle" dominantBaseline="central"
                      fill={COLOR} style={{ fontSize: `${viewBox.w * 0.014}px`, fontWeight: 600 }}>
                      {label}
                    </text>
                  </g>
                </g>
              );
            } else if (ann.kind === 'callout') {
              const COLOR = '#1565c0';
              const LW = viewBox.w * 0.0008;
              const r  = viewBox.w * 0.008;
              const labelOff = viewBox.w * 0.04;
              return (
                <g key={ann.id}
                  onClick={() => setSvgAnnotations((prev) => prev.filter((a) => a.id !== ann.id))}
                  style={{ cursor: 'pointer' }}
                  title="Click to remove">
                  <circle cx={ann.px} cy={ann.py} r={r} fill={COLOR} fillOpacity={0.7} />
                  <line x1={ann.px} y1={ann.py}
                    x2={ann.px + labelOff * 0.6} y2={ann.py - labelOff * 0.8}
                    stroke={COLOR} strokeWidth={LW} vectorEffect="non-scaling-stroke" />
                  <line x1={ann.px + labelOff * 0.6} y1={ann.py - labelOff * 0.8}
                    x2={ann.px + labelOff * 0.6 + Math.min(ann.text.length, 20) * viewBox.w * 0.008}
                    y2={ann.py - labelOff * 0.8}
                    stroke={COLOR} strokeWidth={LW} vectorEffect="non-scaling-stroke" />
                  <text
                    x={ann.px + labelOff * 0.6 + viewBox.w * 0.005}
                    y={ann.py - labelOff * 0.8 - viewBox.w * 0.005}
                    fill={COLOR} style={{ fontSize: `${viewBox.w * 0.015}px`, fontWeight: 500 }}>
                    {ann.text}
                  </text>
                </g>
              );
            }
            return null;
          })}
        </g>
      </svg>"""

# ── 2. Replace toolbar ──────────────────────────────────────────────────────
OLD_TOOLBAR = """      <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 bg-background/80 border border-border/50 rounded px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm">
        <span className="font-semibold text-foreground">{viewLabel[viewType]}</span>
        <span className="opacity-40">|</span>
        <span>SVG Drawing</span>
      </div>"""

NEW_TOOLBAR = """      <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
        <div className="flex items-center gap-1.5 bg-background/80 border border-border/50 rounded px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm">
          <span className="font-semibold text-foreground">{viewLabel[viewType]}</span>
          <span className="opacity-40">|</span>
          <span>SVG Drawing</span>
        </div>
        <AnnotationsToolbar
          activeTool={annTool === 'linear' ? 'linear' : annTool === 'callout' ? 'callout' : null}
          onToolChange={(tool) => {
            annPendingRef.current = null;
            if (tool === 'linear' || tool === 'callout') setAnnTool(tool as 'linear' | 'callout');
            else setAnnTool(null);
          }}
          onClearAll={() => { setSvgAnnotations([]); annPendingRef.current = null; setAnnTool(null); }}
          availableTools={['linear', 'callout']}
        />
      </div>"""

patches = [(OLD_SVG_END, NEW_SVG_END), (OLD_TOOLBAR, NEW_TOOLBAR)]
for old, new in patches:
    if old in content:
        content = content.replace(old, new, 1)
        print(f"OK: patched {repr(old[:40])}")
    else:
        print(f"NOT FOUND: {repr(old[:60])}")

SRC.write_text(content, encoding="utf-8")
print("Done.")
