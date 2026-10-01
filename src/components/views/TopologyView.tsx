/**
 * TopologyView — the rooms as the backend's topology kernel sees them.
 *
 * The analysis (topologicpy on PythonOCC, backend/topology_engine.py) turns
 * every room into a cell of one CellComplex; this view shows what that says:
 *
 *   • the cells in 3D, as the kernel built them — shared walls and slabs,
 *     the envelope, and the adjacency graph threaded through the rooms —
 *     with orbit, pan and zoom (TopologyScene3D);
 *   • the same graph drawn axonometrically over the room footprints, flat;
 *   • the whole-model indicators, and per room, the table;
 *   • whatever the backend could not build, and why.
 *
 * Nothing is computed here but the drawing: every number is the backend's.
 * The run is on demand — a CellComplex of a large building takes seconds —
 * and the view says when the graph has changed since the last run.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import { analyzeTopology, getTopologyStatus, measureSolids } from '@/lib/api';
import { useBubbleGraphStore } from '@/store';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { exportGeoreference } from '@/lib/geo';
import { downloadText, safeFilename } from '@/lib/download';
import { topologyExtras } from '@/lib/topology/extras';
import { compareSolids, type SolidsComparison } from '@/lib/topology/solidsCompare';
import { calcRoomPolygon } from '@/lib/bimGeometry';
import { cn } from '@/lib/utils';
import { TopologyScene3D, type TopologyLayers } from './TopologyScene3D';
import type {
  AdjacencyKind, TopologyEnvelope, TopologyResult, TopologyRoom, TopologyStatus,
} from '@/lib/topology/types';

interface TopologyViewProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  /** For the exported file's name and IfcProject. */
  projectName?: string;
  className?: string;
}

type PanelTab = 'rooms' | 'egress' | 'envelope' | 'solids';
const DEFAULT_EGRESS_M = 30;

const EDGE_COLOUR: Record<AdjacencyKind, string> = {
  wall: '#2563eb',
  slab: '#d97706',
  mixed: '#7c3aed',
};
const STOREY_COLOURS = ['#0ea5e9', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#64748b'];

// Isometric projection of BIM mm (x east, y north, z up) onto the screen.
const COS30 = Math.cos(Math.PI / 6);
const project = (x: number, y: number, z: number) => ({
  x: (x - y) * COS30,
  y: -(x + y) * 0.5 - z,
});

const fmt = (v: number | null | undefined, digits = 1) =>
  v == null ? '—' : v.toLocaleString('ro-RO', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function TopologyView({ nodes, edges, selectedNodeId, onSelectNode, projectName, className }: TopologyViewProps) {
  const [status, setStatus] = useState<TopologyStatus | null>(null);
  const [storeyFilter, setStoreyFilter] = useState<string>('');
  const [result, setResult] = useState<TopologyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [mode, setMode] = useState<'3d' | 'graph'>('3d');
  const [layers, setLayers] = useState<TopologyLayers>({ envelope: true, shared: true, graph: true, egress: true });
  const [tab, setTab] = useState<PanelTab>('rooms');
  // The egress limit. Sent with the next run, and applied at once to the
  // distances already computed — no reason to wait for the kernel to compare.
  const [maxEgressM, setMaxEgressM] = useState(DEFAULT_EGRESS_M);
  const [solids, setSolids] = useState<{ busy: boolean; result: SolidsComparison | null; error: string | null; tookMs?: number; truncated?: boolean }>({ busy: false, result: null, error: null });
  const [ifcNote, setIfcNote] = useState<string | null>(null);
  const { config: matConfig } = useMaterialConfig();
  // What the shown result was computed from, to say when it is out of date.
  const [analysedFrom, setAnalysedFrom] = useState<{ nodes: unknown; edges: unknown; storey: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const storeys = useMemo(
    () => nodes
      .filter((n) => n.type === 'storey')
      .sort((a, b) => Number(a.properties.bottomElevation ?? 0) - Number(b.properties.bottomElevation ?? 0)),
    [nodes],
  );
  const storeyIndex = useMemo(() => new Map(storeys.map((s, i) => [s.id, i])), [storeys]);
  const storeyName = useCallback((id: string | null) => storeys.find((s) => s.id === id)?.name ?? '—', [storeys]);

  useEffect(() => {
    let alive = true;
    void getTopologyStatus().then((s) => { if (alive) setStatus(s); });
    return () => { alive = false; abortRef.current?.abort(); };
  }, []);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setError(null);
    try {
      const r = await analyzeTopology(
        {
          nodes, edges, ...(storeyFilter ? { storeyIds: [storeyFilter] } : {}),
          extras: topologyExtras(nodes, edges, maxEgressM),
        },
        ctrl.signal,
      );
      setResult(r);
      setAnalysedFrom({ nodes, edges, storey: storeyFilter });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === ctrl) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, storeyFilter]);

  /** The project's IFC, as the main export writes it — the one the checks below read. */
  const buildIfc = useCallback(async () => {
    const { buildIfcModel } = await import('@/lib/ifc/buildIfcModel');
    return buildIfcModel(nodes, edges, projectName || 'Model', {
      georeference: exportGeoreference(useBubbleGraphStore.getState().worldLocation),
      materialConfig: matConfig,
    });
  }, [nodes, edges, projectName, matConfig]);

  /** IFC with the CellComplex written in as 2nd-level space boundaries. */
  const exportWithBoundaries = useCallback(async () => {
    if (!result?.faces) return;
    setIfcNote('Se construiește IFC-ul…');
    try {
      const built = await buildIfc();
      const { addSpaceBoundaries } = await import('@/lib/ifc/spaceBoundaries');
      const out = addSpaceBoundaries(built.content, result, built.spaceIds);
      downloadText(safeFilename(`${projectName || 'model'}-space-boundaries`, 'ifc', 'model'), out.text, 'application/x-step');
      setIfcNote(`${out.boundaries} limite de spațiu scrise`
        + (out.virtual ? `, ${out.virtual} virtuale (fără element în model)` : '')
        + (out.skipped.length ? ` · ${out.skipped.length} fețe lăsate deoparte` : '') + '.');
    } catch (err) {
      setIfcNote(`Exportul a eșuat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [result, buildIfc, projectName]);

  /** Every element as an exact solid, held against the takeoff. */
  const runSolids = useCallback(async () => {
    setSolids({ busy: true, result: null, error: null });
    try {
      const built = await buildIfc();
      const r = await measureSolids(built.content);
      setSolids({ busy: false, result: compareSolids(r, nodes, edges), error: null, tookMs: r.stats.tookMs, truncated: r.stats.truncated });
    } catch (err) {
      setSolids({ busy: false, result: null, error: err instanceof Error ? err.message : String(err) });
    }
  }, [buildIfc, nodes, edges]);

  // One run on opening, once the kernel is known to be there.
  const ranOnce = useRef(false);
  useEffect(() => {
    if (status?.available && !ranOnce.current) {
      ranOnce.current = true;
      void run();
    }
  }, [status, run]);

  const stale = !!result && !!analysedFrom
    && (analysedFrom.nodes !== nodes || analysedFrom.edges !== edges || analysedFrom.storey !== storeyFilter);

  // ── Drawing ────────────────────────────────────────────────────────────────
  const drawing = useMemo(() => {
    if (!result || result.graph.nodes.length === 0) return null;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const roomsById = new Map(result.rooms.map((r) => [r.id, r]));

    const footprints = result.graph.nodes.flatMap((gn) => {
      const room = nodeMap.get(gn.id);
      const info = roomsById.get(gn.id);
      if (!room || !info) return [];
      const poly = calcRoomPolygon(room, nodeMap, edges);
      if (!poly || poly.length < 3) return [];
      return [{ id: gn.id, storeyId: gn.storeyId, pts: poly.map((p) => project(p.x, p.y, info.bottomMm)) }];
    });
    const centres = new Map(result.graph.nodes.map((gn) => {
      const [x, y, z] = gn.positionMm;
      return [gn.id, project(x, y, z)];
    }));

    const all = [...footprints.flatMap((f) => f.pts), ...centres.values()];
    const minX = Math.min(...all.map((p) => p.x)), maxX = Math.max(...all.map((p) => p.x));
    const minY = Math.min(...all.map((p) => p.y)), maxY = Math.max(...all.map((p) => p.y));
    const extent = Math.max(maxX - minX, maxY - minY, 1000);
    const pad = extent * 0.08;

    const maxArea = Math.max(...result.rooms.map((r) => r.floorAreaM2), 1);
    const maxShared = Math.max(...result.graph.edges.map((e) => e.sharedAreaM2), 1);
    const radius = (id: string) => {
      const a = roomsById.get(id)?.floorAreaM2 ?? 0;
      return extent * (0.008 + 0.014 * Math.sqrt(a / maxArea));
    };
    return {
      viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`,
      footprints, centres, radius, extent,
      edgeWidth: (area: number) => extent * (0.002 + 0.006 * (area / maxShared)),
    };
  }, [result, nodes, edges]);

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of result?.graph.edges ?? []) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    }
    return m;
  }, [result]);

  const focus = hovered ?? selectedNodeId;
  const dimmed = (id: string) => !!focus && id !== focus && !neighbours.get(focus)?.has(id) && neighbours.has(focus);
  const roomName = (id: string) => result?.rooms.find((r) => r.id === id)?.name ?? id;

  // ── Render ─────────────────────────────────────────────────────────────────
  const st = result?.stats;
  return (
    <div className={cn('flex flex-col h-full overflow-hidden bg-background text-foreground text-xs', className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
        <span className="font-semibold text-sm">Topologie spații</span>
        <span className="text-muted-foreground">
          {status == null ? 'se verifică kernelul…'
            : status.available ? `topologicpy ${status.topologicpy} · PythonOCC ${status.pythonocc}`
            : 'kernel indisponibil'}
        </span>
        {result && (
          <div className="flex items-center gap-2 ml-3">
            <div className="flex rounded border border-border overflow-hidden">
              {([['3d', 'Celule 3D'], ['graph', 'Graf 2D']] as const).map(([m, label]) => (
                <button key={m}
                  className={cn('px-2 py-1', mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
                  disabled={m === '3d' && !result.faces}
                  title={m === '3d' && !result.faces ? 'Backendul nu a trimis geometria celulelor — repornește-l.' : undefined}
                  onClick={() => setMode(m)}>{label}</button>
              ))}
            </div>
            {mode === '3d' && result.faces && ([
              ['envelope', 'Anvelopă'], ['shared', 'Fețe comune'], ['graph', 'Graf'],
              ...(result.circulation ? [['egress', 'Evacuare']] : []),
            ] as [keyof TopologyLayers, string][]).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1 cursor-pointer select-none">
                <input type="checkbox" checked={layers[k]}
                  onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            className="border border-border rounded px-1.5 py-1 bg-background"
            value={storeyFilter}
            onChange={(e) => setStoreyFilter(e.target.value)}
          >
            <option value="">Toate etajele</option>
            {storeys.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.id}</option>)}
          </select>
          <button
            className="px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
            disabled={busy || !status?.available}
            onClick={() => void run()}
          >
            {busy ? 'Se analizează…' : 'Analizează'}
          </button>
        </div>
      </div>

      {status && !status.available && (
        <div className="m-3 p-3 rounded border border-amber-400/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Analiza topologică rulează în backend, pe topologicpy cu PythonOCC, iar acesta nu este disponibil
          {status.error ? <>: <span className="font-mono">{status.error}</span></> : '.'}
          {' '}Rulează <span className="font-mono">backend/scripts/setup_topology_env.sh</span> și repornește backend-ul.
        </div>
      )}
      {error && (
        <div className="mx-3 mt-3 p-2 rounded border border-red-400/60 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}
      {stale && (
        <div className="mx-3 mt-3 p-2 rounded border border-border bg-muted text-muted-foreground">
          Modelul s-a schimbat de la ultima analiză — apasă „Analizează” pentru un rezultat la zi.
        </div>
      )}

      {result && st && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Graph */}
          <div className="flex-1 min-w-0 relative">
            {mode === '3d' && result.faces ? (
              <TopologyScene3D
                result={result}
                storeyColour={(id) => STOREY_COLOURS[(storeyIndex.get(id ?? '') ?? 0) % STOREY_COLOURS.length]}
                focus={focus}
                selectedId={selectedNodeId}
                neighbours={neighbours}
                layers={layers}
                maxEgressM={maxEgressM}
                onPick={onSelectNode}
                onHover={setHovered}
              />
            ) : drawing ? (
              <svg viewBox={drawing.viewBox} className="w-full h-full" preserveAspectRatio="xMidYMid meet"
                onClick={() => onSelectNode(null)}>
                {drawing.footprints.map((f) => {
                  const colour = STOREY_COLOURS[(storeyIndex.get(f.storeyId ?? '') ?? 0) % STOREY_COLOURS.length];
                  return (
                    <polygon key={`fp-${f.id}`} points={f.pts.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill={colour} fillOpacity={dimmed(f.id) ? 0.03 : 0.1}
                      stroke={colour} strokeOpacity={0.5} strokeWidth={drawing.extent * 0.0012} />
                  );
                })}
                {result.graph.edges.map((e) => {
                  const a = drawing.centres.get(e.source), b = drawing.centres.get(e.target);
                  if (!a || !b) return null;
                  const faded = !!focus && neighbours.has(focus) && e.source !== focus && e.target !== focus;
                  return (
                    <line key={`e-${e.source}-${e.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={EDGE_COLOUR[e.kind]} strokeOpacity={faded ? 0.15 : 0.9}
                      strokeWidth={drawing.edgeWidth(e.sharedAreaM2)} strokeLinecap="round"
                      strokeDasharray={e.kind === 'slab' ? `${drawing.extent * 0.012} ${drawing.extent * 0.008}` : undefined}>
                      <title>{`${roomName(e.source)} — ${roomName(e.target)}: ${fmt(e.sharedAreaM2, 2)} m² (${e.kind === 'wall' ? 'perete' : e.kind === 'slab' ? 'placă' : 'perete + placă'})`}</title>
                    </line>
                  );
                })}
                {result.graph.nodes.map((gn) => {
                  const c = drawing.centres.get(gn.id);
                  if (!c) return null;
                  const colour = STOREY_COLOURS[(storeyIndex.get(gn.storeyId ?? '') ?? 0) % STOREY_COLOURS.length];
                  const r = drawing.radius(gn.id);
                  const sel = gn.id === selectedNodeId;
                  return (
                    <g key={`n-${gn.id}`} style={{ cursor: 'pointer' }} opacity={dimmed(gn.id) ? 0.3 : 1}
                      onMouseEnter={() => setHovered(gn.id)} onMouseLeave={() => setHovered(null)}
                      onClick={(ev) => { ev.stopPropagation(); onSelectNode(gn.id); }}>
                      <circle cx={c.x} cy={c.y} r={r} fill={colour}
                        stroke={sel ? '#f97316' : '#fff'} strokeWidth={r * (sel ? 0.35 : 0.15)} />
                      <text x={c.x} y={c.y - r * 1.5} textAnchor="middle" fontSize={drawing.extent * 0.018}
                        fill="currentColor" pointerEvents="none">{gn.name}</text>
                      <title>{`${gn.name} · ${storeyName(gn.storeyId)} · ${gn.degree} vecini`}</title>
                    </g>
                  );
                })}
              </svg>
            ) : (
              <div className="p-6 text-muted-foreground">Nicio cameră de analizat.</div>
            )}
            <div className={cn('absolute left-3 bottom-3 flex gap-3 bg-background/80 rounded px-2 py-1 border border-border',
              mode === '3d' && result.faces && !layers.graph && 'hidden')}>
              {(['wall', 'slab', 'mixed'] as AdjacencyKind[]).map((k) => (
                <span key={k} className="flex items-center gap-1">
                  <span className="inline-block w-5 h-0.5" style={{ background: EDGE_COLOUR[k] }} />
                  {k === 'wall' ? 'perete comun' : k === 'slab' ? 'placă comună' : 'ambele'}
                </span>
              ))}
            </div>
          </div>

          {/* Indicators + table */}
          <div className="w-[520px] max-w-[55%] border-l border-border flex flex-col min-h-0">
            <div className="grid grid-cols-3 gap-2 p-3 border-b border-border">
              {[
                ['Camere', `${st.rooms}`],
                ['Vecinătăți', `${st.adjacencies} (${st.wallAdjacencies} pereți · ${st.slabAdjacencies} plăci)`],
                ['Grupuri legate', `${st.components}`],
                ['Arie utilă', `${fmt(st.totalFloorAreaM2)} m²`],
                ['Volum', `${fmt(st.totalVolumeM3)} m³`],
                ['Anvelopă', `${fmt(st.envelopeAreaM2)} m²`],
                ['Arie comună', `${fmt(st.sharedAreaM2)} m²`],
                ['Compactitate', st.compactnessPerM == null ? '—' : `${fmt(st.compactnessPerM, 3)} m⁻¹`],
                ['Grad mediu', fmt(st.meanDegree, 2)],
              ].map(([label, value]) => (
                <div key={label} className="rounded border border-border px-2 py-1.5">
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</div>
                  <div className="font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </div>

            {(st.isolatedRooms.length > 0 || result.warnings.length > 0 || result.skippedRooms.length > 0) && (
              <div className="px-3 py-2 border-b border-border space-y-1 max-h-40 overflow-y-auto">
                {st.isolatedRooms.length > 0 && (
                  <div className="text-amber-700 dark:text-amber-300">
                    Camere fără vecini: {st.isolatedRooms.map(roomName).join(', ')}
                  </div>
                )}
                {result.skippedRooms.map((s) => (
                  <div key={s.id} className="text-red-700 dark:text-red-300">
                    Lăsată deoparte: <button className="underline" onClick={() => onSelectNode(s.id)}>{s.name}</button> — {s.reason}
                  </div>
                ))}
                {result.warnings.map((w, i) => (
                  <div key={i} className="text-amber-700 dark:text-amber-300">{w}</div>
                ))}
              </div>
            )}

            <div className="flex border-b border-border">
              {([
                ['rooms', 'Camere'],
                ['egress', 'Evacuare'],
                ['envelope', 'Anvelopă'],
                ['solids', 'Solide exacte'],
              ] as [PanelTab, string][]).map(([k, label]) => (
                <button key={k}
                  className={cn('px-3 py-1.5 border-b-2 -mb-px', tab === k ? 'border-primary text-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground')}
                  onClick={() => setTab(k)}>
                  {label}
                  {k === 'egress' && result.circulation && (() => {
                    const bad = result.circulation.rooms.filter((r) => r.egressM == null || r.egressM > maxEgressM).length;
                    return bad ? <span className="ml-1 px-1 rounded bg-red-500/15 text-red-600 dark:text-red-300">{bad}</span> : null;
                  })()}
                </button>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-auto">
              {tab === 'rooms' && (
                <RoomTable rooms={result.rooms} storeyName={storeyName}
                  selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} onHover={setHovered} />
              )}
              {tab === 'egress' && (
                result.circulation ? (
                  <EgressPanel result={result} maxEgressM={maxEgressM} onMaxEgress={setMaxEgressM}
                    storeyName={storeyName} selectedNodeId={selectedNodeId}
                    onSelectNode={onSelectNode} onHover={setHovered} />
                ) : <div className="p-3 text-muted-foreground">Reanalizează pentru ușile și scările modelului.</div>
              )}
              {tab === 'envelope' && (
                result.envelope ? (
                  <EnvelopePanel env={result.envelope} rooms={result.rooms}
                    onExportIfc={() => void exportWithBoundaries()} ifcNote={ifcNote} canExport={!!result.faces}
                    selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
                ) : <div className="p-3 text-muted-foreground">Reanalizează pentru ferestrele modelului.</div>
              )}
              {tab === 'solids' && (
                <SolidsPanel state={solids} available={status?.ifcopenshell != null}
                  onRun={() => void runSolids()} onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} />
              )}
            </div>
            <div className="px-3 py-1.5 border-t border-border text-muted-foreground">
              {st.cells} celule · {result.sharedFaces.length} fețe comune
              {st.tookMs != null && <> · {fmt(st.tookMs / 1000, 2)} s</>}
            </div>
          </div>
        </div>
      )}

      {!result && !busy && status?.available && !error && (
        <div className="p-6 text-muted-foreground">Apasă „Analizează” pentru a construi topologia camerelor.</div>
      )}
    </div>
  );
}

function RoomTable({
  rooms, storeyName, selectedNodeId, onSelectNode, onHover,
}: {
  rooms: TopologyRoom[];
  storeyName: (id: string | null) => string;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onHover: (id: string | null) => void;
}) {
  const cols: Array<[string, (r: TopologyRoom) => string]> = [
    ['Cameră', (r) => r.name],
    ['Etaj', (r) => storeyName(r.storeyId)],
    ['Arie m²', (r) => fmt(r.floorAreaM2, 2)],
    ['Volum m³', (r) => fmt(r.volumeM3, 2)],
    ['Vecini', (r) => `${r.neighbours}`],
    ['Pereți comuni m²', (r) => fmt(r.sharedWallAreaM2, 2)],
    ['Plăci comune m²', (r) => fmt(r.sharedSlabAreaM2, 2)],
    ['Perete ext. m²', (r) => fmt(r.exteriorWallAreaM2, 2)],
    ['Sus expus m²', (r) => fmt(r.exposedTopAreaM2, 2)],
    ['Jos expus m²', (r) => fmt(r.exposedBottomAreaM2, 2)],
  ];
  return (
    <table className="w-full border-collapse">
      <thead className="sticky top-0 bg-muted">
        <tr>
          {cols.map(([h]) => (
            <th key={h} className="text-left font-semibold px-2 py-1.5 whitespace-nowrap border-b border-border">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rooms.map((r) => (
          <tr key={r.id}
            className={cn('cursor-pointer hover:bg-accent', r.id === selectedNodeId && 'bg-orange-100 dark:bg-orange-950/40')}
            onClick={() => onSelectNode(r.id)}
            onMouseEnter={() => onHover(r.id)} onMouseLeave={() => onHover(null)}>
            {cols.map(([h, get], i) => (
              <td key={h} className={cn('px-2 py-1 border-b border-border whitespace-nowrap', i >= 2 && 'text-right tabular-nums')}>
                {get(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Egress ────────────────────────────────────────────────────────────────────

function EgressPanel({
  result, maxEgressM, onMaxEgress, storeyName, selectedNodeId, onSelectNode, onHover,
}: {
  result: TopologyResult;
  maxEgressM: number;
  onMaxEgress: (v: number) => void;
  storeyName: (id: string | null) => string;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onHover: (id: string | null) => void;
}) {
  const c = result.circulation!;
  const name = (id: string) => result.rooms.find((r) => r.id === id)?.name ?? id;
  const doorName = (id: string) => c.doors.find((d) => d.id === id)?.name ?? id;
  const rows = [...c.rooms].sort((a, b) => (b.egressM ?? Infinity) - (a.egressM ?? Infinity));
  const status = (r: typeof rows[number]) =>
    !r.accessible ? { t: 'fără ușă', cls: 'text-red-600 dark:text-red-300' }
      : r.egressM == null ? { t: 'fără ieșire', cls: 'text-red-600 dark:text-red-300' }
      : r.egressM > maxEgressM ? { t: 'peste limită', cls: 'text-amber-600 dark:text-amber-300' }
      : { t: 'în limită', cls: 'text-emerald-600 dark:text-emerald-400' };
  return (
    <div>
      <div className="px-3 py-2 border-b border-border space-y-1">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Distanță maximă până la ieșire</span>
          <input type="number" min={1} step={1} value={maxEgressM}
            className="w-16 border border-border rounded px-1 py-0.5 bg-background text-right"
            onChange={(e) => onMaxEgress(Math.max(1, Number(e.target.value) || 1))} />
          <span>m</span>
        </label>
        <div className="text-[10px] text-muted-foreground leading-snug">
          Drumul e măsurat din colțul cel mai îndepărtat al camerei, de la ușă la ușă, în linie dreaptă, iar pe scară pe linia de mers.
          Mobilierul și pereții din interiorul camerei nu sunt ocoliți. E o verificare preliminară; limita o alegi tu după normativul aplicabil (de ex. P118).
        </div>
        <div className="text-muted-foreground">
          {c.exits.length} {c.exits.length === 1 ? 'ieșire' : 'ieșiri'}: {c.exits.map(doorName).join(', ') || '—'}
          {' · '}{c.doors.length} uși · {c.stairs.length} scări
          {c.unplacedDoors.length > 0 && <span className="text-amber-600 dark:text-amber-300"> · {c.unplacedDoors.length} uși nelegate</span>}
        </div>
      </div>
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {['Cameră', 'Etaj', 'Drum m', 'Uși', 'Prin', 'Stare'].map((h) => (
              <th key={h} className="text-left font-semibold px-2 py-1.5 whitespace-nowrap border-b border-border">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const st = status(r);
            return (
              <tr key={r.id}
                className={cn('cursor-pointer hover:bg-accent', r.id === selectedNodeId && 'bg-orange-100 dark:bg-orange-950/40')}
                onClick={() => onSelectNode(r.id)} onMouseEnter={() => onHover(r.id)} onMouseLeave={() => onHover(null)}>
                <td className="px-2 py-1 border-b border-border whitespace-nowrap">{r.name}</td>
                <td className="px-2 py-1 border-b border-border whitespace-nowrap">{storeyName(r.storeyId)}</td>
                <td className="px-2 py-1 border-b border-border text-right tabular-nums">{fmt(r.egressM, 1)}</td>
                <td className="px-2 py-1 border-b border-border text-right tabular-nums">{r.doors}</td>
                <td className="px-2 py-1 border-b border-border text-muted-foreground truncate max-w-[180px]"
                  title={r.roomsOnPath.map(name).join(' → ')}>
                  {r.roomsOnPath.length > 1 ? r.roomsOnPath.slice(1).map(name).join(' → ') : r.exitId ? 'direct' : '—'}
                </td>
                <td className={cn('px-2 py-1 border-b border-border whitespace-nowrap', st.cls)}>{st.t}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Envelope ──────────────────────────────────────────────────────────────────

function EnvelopePanel({
  env, rooms, onExportIfc, ifcNote, canExport, selectedNodeId, onSelectNode,
}: {
  env: TopologyEnvelope;
  rooms: TopologyRoom[];
  onExportIfc: () => void;
  ifcNote: string | null;
  canExport: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const pct = (v: number | null) => (v == null ? '—' : `${fmt(v * 100, 1)} %`);
  const byId = new Map(env.rooms.map((r) => [r.id, r]));
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 p-3 border-b border-border">
        {[
          ['Pereți exteriori', `${fmt(env.wallM2)} m²`],
          ['Ferestre', `${fmt(env.windowM2)} m²`],
          ['Ferestre / pereți', pct(env.wwr)],
          ['Acoperiș expus', `${fmt(env.roofM2)} m²`],
          ['Pe sol', `${fmt(env.groundM2)} m²`],
          ['Uși exterioare', `${fmt(env.doorM2)} m²`],
        ].map(([l, v]) => (
          <div key={l} className="rounded border border-border px-2 py-1.5">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wide">{l}</div>
            <div className="font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-muted">
          <tr>{['Orientare', 'Perete m²', 'Ferestre m²', 'Ferestre / perete'].map((h) => (
            <th key={h} className="text-left font-semibold px-2 py-1.5 border-b border-border">{h}</th>))}</tr>
        </thead>
        <tbody>
          {env.orientations.map((o) => (
            <tr key={o.dir}>
              <td className="px-2 py-1 border-b border-border font-semibold">{o.dir}</td>
              <td className="px-2 py-1 border-b border-border text-right tabular-nums">{fmt(o.wallM2, 2)}</td>
              <td className="px-2 py-1 border-b border-border text-right tabular-nums">{fmt(o.windowM2, 2)}</td>
              <td className="px-2 py-1 border-b border-border text-right tabular-nums">{pct(o.wwr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full border-collapse mt-2">
        <thead className="bg-muted">
          <tr>{['Cameră', 'Perete ext. m²', 'Ferestre m²', 'Ferestre / pardoseală'].map((h) => (
            <th key={h} className="text-left font-semibold px-2 py-1.5 border-b border-border">{h}</th>))}</tr>
        </thead>
        <tbody>
          {rooms.map((r) => {
            const e = byId.get(r.id);
            return (
              <tr key={r.id} className={cn('cursor-pointer hover:bg-accent', r.id === selectedNodeId && 'bg-orange-100 dark:bg-orange-950/40')}
                onClick={() => onSelectNode(r.id)}>
                <td className="px-2 py-1 border-b border-border">{r.name}</td>
                <td className="px-2 py-1 border-b border-border text-right tabular-nums">{fmt(e?.exteriorWallM2, 2)}</td>
                <td className="px-2 py-1 border-b border-border text-right tabular-nums">{fmt(e?.windowM2, 2)}</td>
                <td className="px-2 py-1 border-b border-border text-right tabular-nums">{pct(e?.windowToFloor ?? null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="p-3 border-t border-border mt-2 space-y-1">
        <button className="px-3 py-1 rounded border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40"
          disabled={!canExport} onClick={onExportIfc}
          title="IFC-ul proiectului, cu fețele camerelor scrise ca IfcRelSpaceBoundary2ndLevel — citit de programele de energie și de facility management.">
          ⬇ IFC cu limite de spațiu
        </button>
        {ifcNote && <div className="text-muted-foreground">{ifcNote}</div>}
      </div>
    </div>
  );
}

// ── Exact solids ──────────────────────────────────────────────────────────────

function SolidsPanel({
  state, available, onRun, onSelectNode, selectedNodeId,
}: {
  state: { busy: boolean; result: SolidsComparison | null; error: string | null; tookMs?: number; truncated?: boolean };
  available: boolean;
  onRun: () => void;
  onSelectNode: (id: string | null) => void;
  selectedNodeId: string | null;
}) {
  const c = state.result;
  const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${fmt(v * 100, 1)} %`);
  return (
    <div>
      <div className="p-3 border-b border-border space-y-1">
        <button className="px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
          disabled={state.busy || !available} onClick={onRun}>
          {state.busy ? 'Se calculează solidele…' : 'Verifică cantitățile pe solide exacte'}
        </button>
        <div className="text-[10px] text-muted-foreground leading-snug">
          Modelul e exportat în IFC, iar fiecare element devine un solid exact (OpenCASCADE), cu golurile tăiate.
          Volumul lui e comparat cu devizul, iar volumul pe care două elemente îl ocupă în comun (joncțiuni, stâlpi în pereți) e numărat de două ori în deviz.
          {!available && ' · Indisponibil: workerul nu are ifcopenshell — rulează din nou scripts/setup_topology_env.sh.'}
        </div>
        {state.error && <div className="text-red-600 dark:text-red-300">{state.error}</div>}
      </div>
      {c && (
        <>
          <div className="grid grid-cols-3 gap-2 p-3 border-b border-border">
            {[
              ['Volum solide', `${fmt(c.totals.solidM3, 3)} m³`],
              ['Numărat de 2 ori', `${fmt(c.totals.overlapM3, 3)} m³`],
              ['Volum real', `${fmt(c.totals.netSolidM3, 3)} m³`],
              ['Deviz (comparabil)', `${fmt(c.totals.comparedTakeoffM3, 3)} m³`],
              ['Solide (aceleași)', `${fmt(c.totals.comparedSolidM3, 3)} m³`],
              ['Abateri > 2 %', `${c.totals.flagged}`],
            ].map(([l, v]) => (
              <div key={l} className="rounded border border-border px-2 py-1.5">
                <div className="text-muted-foreground text-[10px] uppercase tracking-wide">{l}</div>
                <div className="font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-muted">
              <tr>{['Element', 'Deviz m³', 'Solid m³', 'Abatere', 'Suprapus m³'].map((h) => (
                <th key={h} className="text-left font-semibold px-2 py-1.5 whitespace-nowrap border-b border-border">{h}</th>))}</tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.key}
                  className={cn('hover:bg-accent', r.nodeId && 'cursor-pointer', r.nodeId === selectedNodeId && 'bg-orange-100 dark:bg-orange-950/40')}
                  onClick={() => r.nodeId && onSelectNode(r.nodeId)}>
                  <td className="px-2 py-1 border-b border-border whitespace-nowrap" title={r.ifcTypes.join(', ')}>
                    {r.name}{r.elements > 1 && <span className="text-muted-foreground"> ×{r.elements}</span>}
                  </td>
                  <td className="px-2 py-1 border-b border-border text-right tabular-nums">{fmt(r.takeoffM3, 3)}</td>
                  <td className="px-2 py-1 border-b border-border text-right tabular-nums">{fmt(r.solidM3, 3)}</td>
                  <td className={cn('px-2 py-1 border-b border-border text-right tabular-nums', r.flagged && 'text-amber-600 dark:text-amber-300 font-semibold')}>
                    {pct(r.diffPct)}
                  </td>
                  <td className="px-2 py-1 border-b border-border text-right tabular-nums">{r.overlapM3 > 0 ? fmt(r.overlapM3, 3) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.overlaps.length > 0 && (
            <div className="p-3 space-y-0.5">
              <div className="font-semibold">Cele mai mari suprapuneri</div>
              {c.overlaps.slice(0, 12).map((o, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span className="truncate">{o.a} ∩ {o.b}</span>
                  <span className="tabular-nums">{fmt(o.volumeM3, 3)} m³</span>
                </div>
              ))}
            </div>
          )}
          <div className="px-3 py-1.5 text-muted-foreground">
            {state.tookMs != null && <>{fmt(state.tookMs / 1000, 1)} s</>}
            {state.truncated && ' · verificarea perechilor a fost oprită la limita de timp — suprapunerile pot fi incomplete'}
          </div>
        </>
      )}
    </div>
  );
}
