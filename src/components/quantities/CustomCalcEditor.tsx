/**
 * CustomCalcEditor — editorul VIZUAL editabil al grafurilor de calcul (Faza 3B).
 * Inginerul extrage parametri geometrici (direcți din NodeMeasures sau custom prin
 * formule), îi combină și obține o cantitate — cu preview live pe un element ales.
 */
import { useCallback, useMemo } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position,
  type Node, type Edge, type Connection, type NodeChange, type EdgeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import {
  MEASURE_OPTIONS,
  measuresForNode,
  evaluateCustomCalc,
  type CustomCalcNode,
  type CustomOp,
} from '@/lib/quantityTakeoff';
import { useCustomCalc } from '@/store/customCalcStore';

const NUM = (n: number) => (Math.round(n * 1000) / 1000).toString();
const box: React.CSSProperties = {
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  background: 'hsl(var(--card, var(--background)))',
  fontSize: 11,
  minWidth: 130,
  color: 'hsl(var(--foreground))',
};
const head: React.CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'hsl(var(--muted-foreground))',
  padding: '3px 8px',
  borderBottom: '1px solid hsl(var(--border))',
};
const body: React.CSSProperties = { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 };
const valBadge: React.CSSProperties = { fontFamily: 'monospace', fontWeight: 700, color: 'hsl(var(--primary))' };

// ── Noduri custom ───────────────────────────────────────────────────────────
function ParamNode({ id, data }: NodeProps) {
  const node = (data as any).node as CustomCalcNode;
  const value = (data as any).value as number;
  const updateNode = useCustomCalc((s) => s.updateNode);
  const opt = MEASURE_OPTIONS.find((o) => o.key === node.measureKey);
  return (
    <div style={{ ...box, borderColor: 'hsl(var(--primary) / 0.45)' }}>
      <div style={head}>Parametru geometric</div>
      <div style={body}>
        <select value={node.measureKey} onChange={(e) => updateNode(id, { measureKey: e.target.value as any })} style={{ fontSize: 11 }}>
          {MEASURE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label} ({o.unit})</option>)}
        </select>
        <span style={valBadge}>{NUM(value)} {opt?.unit}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ConstNode({ id, data }: NodeProps) {
  const node = (data as any).node as CustomCalcNode;
  const updateNode = useCustomCalc((s) => s.updateNode);
  return (
    <div style={{ ...box, borderColor: 'hsl(var(--border))' }}>
      <div style={head}>Constant</div>
      <div style={body}>
        <input type="number" value={node.value ?? 0} onChange={(e) => updateNode(id, { value: Number(e.target.value) })} style={{ fontSize: 11, width: 90 }} />
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const OP_LABEL: Record<CustomOp, string> = { add: '+ add', sub: '− subtract', mul: '× multiply', div: '÷ divide', formula: 'ƒ formula' };
const IN_HANDLES = ['in-0', 'in-1', 'in-2'];

function OpNode({ id, data }: NodeProps) {
  const node = (data as any).node as CustomCalcNode;
  const value = (data as any).value as number;
  const updateNode = useCustomCalc((s) => s.updateNode);
  return (
    <div style={{ ...box, borderColor: '#f59e0b' }}>
      <div style={head}>Operation (computed parameter)</div>
      <div style={{ ...body, paddingLeft: 14 }}>
        <select value={node.op} onChange={(e) => updateNode(id, { op: e.target.value as CustomOp })} style={{ fontSize: 11 }}>
          {(Object.keys(OP_LABEL) as CustomOp[]).map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
        </select>
        {node.op === 'formula' && (
          <input value={node.formula ?? ''} placeholder="ex: a * b * 0.2" onChange={(e) => updateNode(id, { formula: e.target.value })} style={{ fontSize: 11, fontFamily: 'monospace' }} />
        )}
        <span style={valBadge}>= {NUM(value)}</span>
      </div>
      {IN_HANDLES.map((h, i) => (
        <Handle key={h} id={h} type="target" position={Position.Left} style={{ top: 26 + i * 16 }} />
      ))}
      {node.op === 'formula' && (
        <div style={{ position: 'absolute', left: -10, top: 20, fontSize: 8, color: '#94a3b8', lineHeight: '16px' }}>a<br />b<br />c</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ResultNode({ id, data }: NodeProps) {
  const node = (data as any).node as CustomCalcNode;
  const value = (data as any).value as number;
  const updateNode = useCustomCalc((s) => s.updateNode);
  return (
    <div style={{ ...box, borderColor: '#818cf8', background: '#eef2ff' }}>
      <div style={head}>Result</div>
      <div style={body}>
        <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 15 }}>{NUM(value)} <input value={node.unit ?? ''} onChange={(e) => updateNode(id, { unit: e.target.value })} style={{ width: 40, fontSize: 11 }} /></div>
      </div>
      <Handle type="target" position={Position.Left} />
    </div>
  );
}

const nodeTypes = { param: ParamNode, const: ConstNode, op: OpNode, result: ResultNode };

// ── Editor ──────────────────────────────────────────────────────────────────
interface CustomCalcEditorProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  height?: number;
}

export function CustomCalcEditor({ nodes: bimNodes, edges: bimEdges, height = 420 }: CustomCalcEditorProps) {
  const graphs = useCustomCalc((s) => s.graphs);
  const currentId = useCustomCalc((s) => s.currentId);
  const previewNodeId = useCustomCalc((s) => s.previewNodeId);
  const createGraph = useCustomCalc((s) => s.createGraph);
  const setCurrent = useCustomCalc((s) => s.setCurrent);
  const setPreviewNode = useCustomCalc((s) => s.setPreviewNode);
  const addNode = useCustomCalc((s) => s.addNode);
  const moveNode = useCustomCalc((s) => s.moveNode);
  const removeNode = useCustomCalc((s) => s.removeNode);
  const addEdge = useCustomCalc((s) => s.addEdge);
  const removeEdge = useCustomCalc((s) => s.removeEdge);

  const graph = currentId ? graphs[currentId] ?? null : null;

  // Elemente BIM măsurabile (pentru preview).
  const measurableNodes = useMemo(
    () => bimNodes.filter((n) => !['storey', 'ax', 'section', 'view'].includes(n.type)),
    [bimNodes],
  );
  const measures = useMemo(
    () => (previewNodeId ? measuresForNode(bimNodes, bimEdges, previewNodeId) : null),
    [bimNodes, bimEdges, previewNodeId],
  );
  const evalResult = useMemo(
    () => (graph ? evaluateCustomCalc(graph, measures) : null),
    [graph, measures],
  );

  const rfNodes: Node[] = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: n.position,
      data: { node: n, value: evalResult?.byNode[n.id] ?? 0 },
    }));
  }, [graph, evalResult]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, targetHandle: e.targetHandle ?? undefined, animated: true }));
  }, [graph]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === 'position' && c.position) moveNode(c.id, c.position);
      else if (c.type === 'remove') removeNode(c.id);
    }
  }, [moveNode, removeNode]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === 'remove') removeEdge(c.id);
  }, [removeEdge]);

  const onConnect = useCallback((conn: Connection) => {
    if (conn.source && conn.target) addEdge(conn.source, conn.target, conn.targetHandle);
  }, [addEdge]);

  return (
    <div style={{ border: '1px solid hsl(var(--border))', borderRadius: 8, overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: 8, borderBottom: '1px solid hsl(var(--border))', flexWrap: 'wrap', background: 'hsl(var(--background))' }}>
        <select value={currentId ?? ''} onChange={(e) => setCurrent(e.target.value || null)} style={{ fontSize: 11 }}>
          <option value="">— select calculation —</option>
          {Object.values(graphs).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button className="bb-row" style={btn} onClick={() => createGraph()}>+ New calculation</button>
        {graph && (
          <>
            <span style={{ width: 1, height: 18, background: 'hsl(var(--border))' }} />
            <button className="bb-row" style={btn} onClick={() => addNode('param', { x: 40, y: 40 })}>+ Parameter</button>
            <button className="bb-row" style={btn} onClick={() => addNode('const', { x: 40, y: 140 })}>+ Constant</button>
            <button className="bb-row" style={btn} onClick={() => addNode('op', { x: 280, y: 90 })}>+ Operation</button>
            <button className="bb-row" style={btn} onClick={() => addNode('result', { x: 520, y: 90 })}>+ Result</button>
            <span style={{ width: 1, height: 18, background: 'hsl(var(--border))' }} />
            <label style={{ fontSize: 10.5, color: 'hsl(var(--muted-foreground))' }}>Preview:</label>
            <select value={previewNodeId ?? ''} onChange={(e) => setPreviewNode(e.target.value || null)} style={{ fontSize: 11, maxWidth: 160 }}>
              <option value="">— element —</option>
              {measurableNodes.map((n) => <option key={n.id} value={n.id}>{n.name ?? n.id} ({n.type})</option>)}
            </select>
            {evalResult && (
              <span style={{ marginLeft: 'auto', fontFamily: 'monospace', fontWeight: 700, color: 'hsl(var(--primary))' }}>
                = {NUM(evalResult.value)} {graph.nodes.find((n) => n.kind === 'result')?.unit ?? ''}
              </span>
            )}
          </>
        )}
      </div>

      {/* Canvas */}
      <div style={{ height }}>
        {graph ? (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
            maxZoom={2}
          >
            <Background gap={16} color="#e2e8f0" />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
            Create a new calculation to get started.
          </div>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = { fontSize: 10.5, padding: '3px 8px', color: 'hsl(var(--primary))' };
