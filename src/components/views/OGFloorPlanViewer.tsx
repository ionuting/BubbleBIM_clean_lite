/**
 * OGOrthoViewer — OpenGeometry orthographic 2D viewer.
 *
 * viewType:
 *   'floorplan'  — horizontal cut view (top-down, per storey)
 *   'section'    — vertical cut view (looking through building)
 *   'elevation'  — external facade view (4 directions via viewDirection)
 *
 * viewDirection (N|S|E|W) = where the camera is positioned:
 *   'N' — camera at North (low OG Z), looking South (+Z) — shows North facade / north section
 *   'S' — camera at South (high OG Z), looking North (−Z) — shows South facade / south section
 *   'E' — camera at East  (high OG X), looking West  (−X) — shows East facade  / east section
 *   'W' — camera at West  (low OG X), looking East  (+X) — shows West facade  / west section
 *
 * BIM mm → OG Three.js meters:  X→+X  Y→−Z  Z→+Y
 *
 * Colors: uses color_2d / opacity_2d from the material config panel (not color_3d).
 * Per-storey filtering: for floor plans, nodes are filtered to the given storeyId.
 * Cut settings are persisted to the tab via updateViewTabParams.
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { cn, parseAxes } from '@/lib/utils';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { useBubbleGraphStore } from '@/store';
import { ensureOpenGeoReady } from '@/lib/openGeoInit';
import { buildOGScene } from '@/lib/ogBimMapper';
import { useMaterialConfig } from '@/lib/useMaterialConfig';
import { resolveVisuals } from '@/lib/materialConfig';
import { expandArrayNodes } from '@/lib/formulaUtils';
import { getAxRealPos, calcRoomPolygon, calcRoomParametricGrid, type RoomParametricGrid, parseContourOffsets, insetPolygon } from '@/lib/bimGeometry';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OG2DViewType = 'floorplan' | 'section' | 'elevation';
export type OGViewDir    = 'N' | 'S' | 'E' | 'W';

interface OGOrthoViewerProps {
  nodes:   BubbleGraphNode[];
  edges:   BubbleGraphEdge[];
  viewType:      OG2DViewType;
  viewDirection?: OGViewDir;    // N/S/E/W for section & elevation; default 'N'
  storeyId?:     string;        // for floor plan storey filtering
  tabId?:        string;        // for persisting cut settings to tab params
  initialCutPos?:   number;     // OG meters — from tab params
  initialCutDepth?: number;     // OG meters — from tab params
  className?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MM = 0.001;   // BIM mm → OG meters

function dwUid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Human label per view */
function viewLabel(viewType: OG2DViewType, dir: OGViewDir): string {
  if (viewType === 'floorplan') return 'OG Floor Plan';
  const dirName = { N: 'North', S: 'South', E: 'East', W: 'West' }[dir];
  if (viewType === 'section')   return `OG Section — ${dirName}`;
  return `${dirName} Elevation`;
}

/**
 * Screen-right and screen-up vectors for pan drag, per camera direction.
 * Computed as: right = forward × up (Three.js convention).
 *   N look+Z: right = (0,0,1)×(0,1,0) = (−1,0,0)
 *   S look−Z: right = (0,0,−1)×(0,1,0) = (1,0,0)
 *   E look−X: right = (−1,0,0)×(0,1,0) = (0,0,−1)
 *   W look+X: right = (1,0,0)×(0,1,0)  = (0,0,1)
 *   FP look−Y: right = (1,0,0), up = (0,0,−1)
 */
const PAN: Record<'floorplan' | OGViewDir, { right: THREE.Vector3; up: THREE.Vector3 }> = {
  floorplan: { right: new THREE.Vector3(1, 0,  0), up: new THREE.Vector3(0, 0, -1) },
  N:         { right: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1,  0) },
  S:         { right: new THREE.Vector3(1, 0,  0), up: new THREE.Vector3(0, 1,  0) },
  E:         { right: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1,  0) },
  W:         { right: new THREE.Vector3(0, 0,  1), up: new THREE.Vector3(0, 1,  0) },
};

function getCameraPos(
  viewType: OG2DViewType,
  dir: OGViewDir,
  center: THREE.Vector3,
  dist: number,
): { position: THREE.Vector3; up: THREE.Vector3 } {
  const { x, y, z } = center;
  if (viewType === 'floorplan')
    return { position: new THREE.Vector3(x, y + dist, z), up: new THREE.Vector3(0, 0, -1) };
  switch (dir) {
    case 'N': return { position: new THREE.Vector3(x, y, z - dist), up: new THREE.Vector3(0, 1, 0) };
    case 'S': return { position: new THREE.Vector3(x, y, z + dist), up: new THREE.Vector3(0, 1, 0) };
    case 'E': return { position: new THREE.Vector3(x + dist, y, z), up: new THREE.Vector3(0, 1, 0) };
    case 'W': return { position: new THREE.Vector3(x - dist, y, z), up: new THREE.Vector3(0, 1, 0) };
  }
}

/**
 * Clipping planes defining the visible band.
 *
 * cutPos (OG meters): position of the cut plane along the view-axis.
 *   floorplan : OG Y (elevation). Init → floor + 1.2 m
 *   N/S       : OG Z of the face. N init → box.min.z ; S init → box.max.z
 *   E/W       : OG X of the face. E init → box.max.x ; W init → box.min.x
 *
 * cutDepth (OG meters): how far into the building to show from the cut plane.
 *
 * Band directions:
 *   floorplan : Y ∈ [cutPos − depth, cutPos]   (below cut, above floor)
 *   N         : Z ∈ [cutPos, cutPos + depth]    (from N face southward)
 *   S         : Z ∈ [cutPos − depth, cutPos]    (from S face northward)
 *   E         : X ∈ [cutPos − depth, cutPos]    (from E face westward)
 *   W         : X ∈ [cutPos, cutPos + depth]    (from W face eastward)
 */
function makePlanes(
  viewType: OG2DViewType,
  dir: OGViewDir,
  cutPos: number,
  cutDepth: number,
): THREE.Plane[] {
  const p = cutPos;
  const d = cutDepth;
  if (viewType === 'floorplan') {
    // Y ≤ p  AND  Y ≥ p−d
    return [
      new THREE.Plane(new THREE.Vector3(0, -1, 0),  p),       // y ≤ p
      new THREE.Plane(new THREE.Vector3(0,  1, 0), -(p - d)), // y ≥ p−d
    ];
  }
  switch (dir) {
    case 'N': // Z ∈ [p, p+d]   camera at low-Z looking +Z
      return [
        new THREE.Plane(new THREE.Vector3(0, 0,  1), -p),      // z ≥ p
        new THREE.Plane(new THREE.Vector3(0, 0, -1),  p + d),  // z ≤ p+d
      ];
    case 'S': // Z ∈ [p−d, p]   camera at high-Z looking −Z
      return [
        new THREE.Plane(new THREE.Vector3(0, 0, -1),  p),      // z ≤ p
        new THREE.Plane(new THREE.Vector3(0, 0,  1), -(p - d)),// z ≥ p−d
      ];
    case 'E': // X ∈ [p−d, p]   camera at high-X looking −X
      return [
        new THREE.Plane(new THREE.Vector3(-1, 0, 0),  p),      // x ≤ p
        new THREE.Plane(new THREE.Vector3( 1, 0, 0), -(p - d)),// x ≥ p−d
      ];
    case 'W': // X ∈ [p, p+d]   camera at low-X looking +X
      return [
        new THREE.Plane(new THREE.Vector3( 1, 0, 0), -p),      // x ≥ p
        new THREE.Plane(new THREE.Vector3(-1, 0, 0),  p + d),  // x ≤ p+d
      ];
  }
}

/** Apply color_2d / opacity_2d from matConfig to all scene meshes. */
function apply2DColors(
  scene: THREE.Scene,
  nodeMap: Map<string, BubbleGraphNode>,
  matConfig: ReturnType<typeof useMaterialConfig>['config'],
): void {
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const nodeType = obj.userData.nodeType as string | undefined;
    if (!nodeType) return;
    const nodeId = obj.userData.nodeId as string | undefined;
    const node   = nodeId ? nodeMap.get(nodeId) : undefined;
    const matId  = String(node?.properties?.material ?? '');
    const vis    = resolveVisuals(nodeType, matId, matConfig ?? null);
    const apply  = (m: THREE.Material) => {
      if (m instanceof THREE.MeshStandardMaterial) {
        m.color.set(vis.color_2d);
        m.opacity     = vis.opacity_2d;
        m.transparent = vis.opacity_2d < 1;
        m.roughness   = 0.9;
        m.metalness   = 0.0;
        m.needsUpdate = true;
      }
    };
    const mat = obj.material;
    Array.isArray(mat) ? mat.forEach(apply) : apply(mat);
  });
}

/** Display cutPos in human-readable BIM units. */
function fmtCut(viewType: OG2DViewType, dir: OGViewDir, cutPos: number): string {
  if (viewType === 'floorplan')         return `${Math.round(cutPos * 1000)} mm Z`;
  if (dir === 'N' || dir === 'S')       return `${Math.round(-cutPos * 1000)} mm Y`;
  return `${Math.round(cutPos * 1000)} mm X`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OGOrthoViewer({
  nodes,
  edges,
  viewType,
  viewDirection = 'N',
  storeyId,
  tabId,
  initialCutPos,
  initialCutDepth,
  className,
}: OGOrthoViewerProps) {
  const dir = (viewType === 'floorplan' ? 'N' : (viewDirection ?? 'N')) as OGViewDir;

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef     = useRef<THREE.Scene | null>(null);
  const cameraRef    = useRef<THREE.OrthographicCamera | null>(null);
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);

  const targetRef = useRef(new THREE.Vector3(0, 0, 0));
  const halfRef   = useRef(10); // half-height of ortho frustum in OG meters

  const mouseRef  = useRef({ isDown: false, x: 0, y: 0 });
  const hasFitRef = useRef(false);

  const [isReady,   setIsReady]   = useState(false);
  const [isBuilding, setBuilding] = useState(false);
  const [ogError,   setOgError]   = useState<string | null>(null);
  const { config: matConfig } = useMaterialConfig();
  const updateViewTabParams = useBubbleGraphStore((s) => s.updateViewTabParams);

  // ── Expanded nodes (used for storey meta + geometry rebuild) ──────────────
  const allNodes = useMemo(() => expandArrayNodes(nodes), [nodes]);

  // ── Cut plane state (OG meters) ──────────────────────────────────────────
  const [cutPos,   setCutPos]   = useState(initialCutPos   ?? 1.2);
  const [cutDepth, setCutDepth] = useState(initialCutDepth ?? 50);
  const [cutRange, setCutRange] = useState({ min: -50, max: 50, maxDepth: 100 });

  // Persist cut params to tab whenever they change (after init)
  const cutInitRef = useRef(false);
  useEffect(() => {
    if (!tabId || !cutInitRef.current) return;
    const t = setTimeout(() => {
      updateViewTabParams(tabId, { cutPos, cutDepth });
    }, 400);
    return () => clearTimeout(t);
  }, [tabId, cutPos, cutDepth, updateViewTabParams]);

  // ── Selection ──────────────────────────────────────────────────────────────
  const setSelectedNodeId = useBubbleGraphStore((s) => s.setSelectedNodeId);
  const selectedNodeId    = useBubbleGraphStore((s) => s.selectedNodeId);

  // ── Draw Wall state (only for floorplan viewType) ─────────────────────────
  const setBubbleGraph   = useBubbleGraphStore((s) => s.setBubbleGraph);
  const rawStoreNodes    = useBubbleGraphStore((s) => s.bubbleGraphNodes);
  const rawStoreEdges    = useBubbleGraphStore((s) => s.bubbleGraphEdges);

  const [drawWallMode, setDrawWallMode] = useState(false);
  const [wallStart, setWallStart]       = useState<{ x: number; y: number } | null>(null);
  const [hoverSnap, setHoverSnap]       = useState<{ x: number; y: number } | null>(null);
  const [hoverRaw, setHoverRaw]         = useState<{ x: number; y: number } | null>(null);

  // Refs so effect-registered mouse handlers can read latest draw-wall state
  const drawWallRef = useRef(false);
  const wallStartRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { drawWallRef.current = drawWallMode; }, [drawWallMode]);
  useEffect(() => { wallStartRef.current = wallStart; }, [wallStart]);

  // Storey axis data for snap points
  const storeyMeta = useMemo(
    () => allNodes.find((n) => n.id === storeyId),
    [allNodes, storeyId],
  );
  const axisXVals = useMemo(
    () => parseAxes(storeyMeta?.properties?.axesX).slice().sort((a, b) => a - b),
    [storeyMeta],
  );
  const axisYVals = useMemo(
    () => parseAxes(storeyMeta?.properties?.axesY).slice().sort((a, b) => a - b),
    [storeyMeta],
  );

  // All snap points (BIM mm): axis intersections + axis midpoints + cross-midpoints
  const snapPoints = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    for (const x of axisXVals) for (const y of axisYVals) pts.push({ x, y });
    for (let i = 0; i < axisXVals.length - 1; i++) {
      const mx = (axisXVals[i] + axisXVals[i + 1]) / 2;
      for (const y of axisYVals) pts.push({ x: mx, y });
    }
    for (let j = 0; j < axisYVals.length - 1; j++) {
      const my = (axisYVals[j] + axisYVals[j + 1]) / 2;
      for (const x of axisXVals) pts.push({ x, y: my });
    }
    for (let i = 0; i < axisXVals.length - 1; i++) {
      const mx = (axisXVals[i] + axisXVals[i + 1]) / 2;
      for (let j = 0; j < axisYVals.length - 1; j++) {
        const my = (axisYVals[j] + axisYVals[j + 1]) / 2;
        pts.push({ x: mx, y: my });
      }
    }
    return pts;
  }, [axisXVals, axisYVals]);
  const snapPointsRef = useRef(snapPoints);
  useEffect(() => { snapPointsRef.current = snapPoints; }, [snapPoints]);

  // Room parametric control grids (inside real room contour)
  const roomParametricGrids = useMemo((): RoomParametricGrid[] => {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const roomNodes = nodes.filter((n) => n.type === 'room' && n.parentId === storeyId);
    const grids: RoomParametricGrid[] = [];
    for (const rn of roomNodes) {
      let poly = calcRoomPolygon(rn, nodeMap, edges);
      if (!poly || poly.length < 3) continue;
      const rawOff = parseContourOffsets(rn.properties.contour_offset);
      const inward = rawOff.map((o) => -o);
      if (inward.some((o) => o !== 0)) poly = insetPolygon(poly, inward);
      grids.push(calcRoomParametricGrid(poly, rn.id));
    }
    return grids;
  }, [nodes, edges, storeyId]);

  // Augmented snap points ref including room parametric (updated when drawWallMode changes)
  const allSnapPointsRef = useRef<{ x: number; y: number }[]>(snapPoints);
  useEffect(() => {
    if (drawWallMode) {
      const extra = roomParametricGrids.flatMap((g) => g.points);
      allSnapPointsRef.current = [...snapPoints, ...extra];
    } else {
      allSnapPointsRef.current = snapPoints;
    }
  }, [snapPoints, roomParametricGrids, drawWallMode]);

  const SNAP_THRESHOLD_MM = 500;

  /** Convert screen pixel (relative to container) → BIM mm, for floorplan ortho camera. */
  const screenToBim = useCallback((sx: number, sy: number): { x: number; y: number } | null => {
    const camera = cameraRef.current;
    const container = containerRef.current;
    if (!camera || !container) return null;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const ndcX = (sx / w) * 2 - 1;
    const ndcY = -(sy / h) * 2 + 1;
    const v = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);
    // Floorplan: OG X → BIM X, OG -Z → BIM Y
    return { x: v.x / MM, y: -v.z / MM };
  }, []);

  /** Find the nearest snap point within threshold (BIM mm). */
  const findSnap = useCallback((pt: { x: number; y: number }): { x: number; y: number } => {
    let best: { x: number; y: number } | null = null;
    let bestD = SNAP_THRESHOLD_MM;
    for (const p of allSnapPointsRef.current) {
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ?? pt;
  }, []);

  /**
   * Convert a BIM mm position to graph canvas pixel position.
   * Uses the same formula the graph editor uses when auto-placing ax nodes:
   *   canvas = storeyNode.xy + (bim_mm - maxAxis/2)
   * Scale is 1:1 (1 canvas pixel = 1 BIM mm), centered on storey canvas pos.
   */
  const bimToCanvasPos = useCallback((bimPt: { x: number; y: number }): { x: number; y: number } => {
    const sn = rawStoreNodes.find((n) => n.id === storeyId);
    if (!sn) return { x: 300, y: 300 };
    const axesX = parseAxes(sn.properties?.axesX).sort((a, b) => a - b);
    const axesY = parseAxes(sn.properties?.axesY).sort((a, b) => a - b);
    const maxX = axesX.length > 0 ? axesX[axesX.length - 1] : 0;
    const maxY = axesY.length > 0 ? axesY[axesY.length - 1] : 0;
    return {
      x: sn.x + (bimPt.x - maxX / 2),
      y: sn.y + (bimPt.y - maxY / 2),
    };
  }, [rawStoreNodes, storeyId]);

  /** Commit a wall between two BIM mm points into the store. */
  const commitWall = useCallback((ptA: { x: number; y: number }, ptB: { x: number; y: number }) => {
    if (!storeyId) return;
    const REUSE_DIST = 100; // mm
    const nodeMap = new Map(rawStoreNodes.map((n) => [n.id, n]));
    const stAxNodes = rawStoreNodes.filter(
      (n) => n.type === 'ax' && n.parentId === storeyId,
    );
    const findExisting = (pt: { x: number; y: number }) =>
      stAxNodes.find((n) => {
        const pos = getAxRealPos(n, nodeMap);
        return Math.hypot(pos.x - pt.x, pos.y - pt.y) < REUSE_DIST;
      });

    const existingA = findExisting(ptA);
    const existingB = findExisting(ptB);
    const startId = existingA ? existingA.id : `ax_${dwUid()}`;
    const endId   = existingB ? existingB.id : `ax_${dwUid()}`;
    const wallId  = `wall_${dwUid()}`;

    const axCount   = rawStoreNodes.filter((n) => n.type === 'ax').length;
    const wallCount = rawStoreNodes.filter((n) => n.type === 'wall').length;
    const canvasA   = bimToCanvasPos(ptA);
    const canvasB   = bimToCanvasPos(ptB);
    const canvasMid = { x: (canvasA.x + canvasB.x) / 2, y: (canvasA.y + canvasB.y) / 2 };
    const newNodes: BubbleGraphNode[] = [];
    if (!existingA) {
      newNodes.push({
        id: startId, type: 'ax', name: `Ax${axCount + 1}`,
        x: canvasA.x, y: canvasA.y, z: 0, parentId: storeyId,
        properties: { has_column: 'False', column_type: 'C25x25', bimX: ptA.x, bimY: ptA.y },
      });
    }
    if (!existingB) {
      newNodes.push({
        id: endId, type: 'ax', name: `Ax${axCount + newNodes.length + 1}`,
        x: canvasB.x, y: canvasB.y, z: 0, parentId: storeyId,
        properties: { has_column: 'False', column_type: 'C25x25', bimX: ptB.x, bimY: ptB.y },
      });
    }
    // Determine if wall belongs to a room (both endpoints are room parametric points)
    const ROOM_SNAP_EPS = 10; // mm tolerance
    let ownerRoomId: string | null = null;
    for (const grid of roomParametricGrids) {
      const inA = grid.points.some((p) => Math.hypot(p.x - ptA.x, p.y - ptA.y) < ROOM_SNAP_EPS);
      const inB = grid.points.some((p) => Math.hypot(p.x - ptB.x, p.y - ptB.y) < ROOM_SNAP_EPS);
      if (inA && inB) { ownerRoomId = grid.roomId; break; }
    }
    const wallParentId = ownerRoomId ?? storeyId;

    newNodes.push({
      id: wallId, type: 'wall', name: `Wall${wallCount + 1}`,
      x: canvasMid.x, y: canvasMid.y, z: 0, parentId: wallParentId,
      properties: {
        wall_type: 'W20', height: 3000,
        offset_start: 0, offset_end: 0,
        has_beam: 'True', beam_section: 'B20x30',
        material: 'Beton C30/37',
        has_windows: 'False', windows: '[]',
        has_doors: 'False', doors: '[]',
        ...(ownerRoomId ? { roomId: ownerRoomId } : {}),
      },
    });
    const newEdges: BubbleGraphEdge[] = [
      { id: `edge_${dwUid()}`, from: startId, to: wallId },
      { id: `edge_${dwUid()}`, from: wallId, to: endId },
    ];
    setBubbleGraph([...rawStoreNodes, ...newNodes], [...rawStoreEdges, ...newEdges]);
  }, [storeyId, rawStoreNodes, rawStoreEdges, setBubbleGraph, bimToCanvasPos, roomParametricGrids]);

  /** Delete the currently selected wall (and its orphaned draw-wall ax endpoints). */
  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    const node = rawStoreNodes.find((n) => n.id === selectedNodeId);
    if (!node) return;
    const toRemove = new Set<string>([selectedNodeId]);
    if (node.type === 'wall') {
      const connectedAxIds = rawStoreEdges
        .filter((e) => e.from === selectedNodeId || e.to === selectedNodeId)
        .map((e) => (e.from === selectedNodeId ? e.to : e.from));
      for (const axId of connectedAxIds) {
        const axNode = rawStoreNodes.find((n) => n.id === axId);
        if (!axNode || axNode.properties?.bimX == null) continue;
        const hasOtherConn = rawStoreEdges.some(
          (e) => (e.from === axId || e.to === axId) && e.from !== selectedNodeId && e.to !== selectedNodeId,
        );
        if (!hasOtherConn) toRemove.add(axId);
      }
    }
    setBubbleGraph(
      rawStoreNodes.filter((n) => !toRemove.has(n.id)),
      rawStoreEdges.filter((e) => !toRemove.has(e.from) && !toRemove.has(e.to)),
    );
    setSelectedNodeId(null);
  }, [selectedNodeId, rawStoreNodes, rawStoreEdges, setBubbleGraph, setSelectedNodeId]);

  // ESC → cancel draw wall; Delete/Backspace → delete selected node
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drawWallRef.current) {
        setWallStart(null); setHoverSnap(null); setHoverRaw(null); setDrawWallMode(false);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !drawWallRef.current) {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && !(e.target as HTMLElement)?.isContentEditable) {
          deleteSelectedNode();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelectedNode]);

  // ── Click-to-select: raycast through the scene when NOT in draw-wall mode ──
  const ogRaycasterRef = useRef(new THREE.Raycaster());
  /** Node types that should never be selected via raycast click */
  const OG_SELECTION_SKIP_TYPES = new Set(['room', 'storey']);

  const handleOGSceneClick = useCallback((e: MouseEvent) => {
    if (drawWallRef.current) return;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const container = containerRef.current;
    if (!scene || !camera || !container) return;
    const rect = container.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ogRaycasterRef.current.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hits = ogRaycasterRef.current.intersectObjects(scene.children, true);
    let nodeId: string | null = null;
    let fallbackRoomId: string | null = null;
    for (const hit of hits) {
      if (hit.object.userData?.isPlanFill) continue;
      // Room/storey meshes have lowest selection priority — use as fallback
      const hitType = hit.object.userData?.nodeType as string | undefined;
      if (hitType && OG_SELECTION_SKIP_TYPES.has(hitType)) {
        if (!fallbackRoomId) {
          const fid = hit.object.userData?.nodeId as string | undefined;
          if (fid) fallbackRoomId = fid;
        }
        continue;
      }
      let obj: THREE.Object3D | null = hit.object;
      let invisible = false;
      let found: string | null = null;
      let foundType: string | null = null;
      while (obj) {
        if (!obj.visible) { invisible = true; break; }
        if (!found && obj.userData?.nodeId) {
          found = obj.userData.nodeId as string;
          foundType = (obj.userData.nodeType as string) ?? null;
        }
        obj = obj.parent;
      }
      if (!invisible && found && (!foundType || !OG_SELECTION_SKIP_TYPES.has(foundType))) {
        nodeId = found;
        break;
      }
    }
    setSelectedNodeId(nodeId ?? fallbackRoomId);
  }, [setSelectedNodeId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('click', handleOGSceneClick);
    return () => container.removeEventListener('click', handleOGSceneClick);
  }, [handleOGSceneClick]);

  // ── Scene + renderer init ─────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const W = container.clientWidth  || 800;
    const H = container.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8f8f6);
    sceneRef.current = scene;

    const half   = halfRef.current;
    const aspect = W / H;
    const camera = new THREE.OrthographicCamera(
      -half * aspect, half * aspect, half, -half, 0.01, 10000,
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.localClippingEnabled = true;  // required for clipping planes
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Flat ambient lighting — no shadows/shading for technical 2D look
    scene.add(new THREE.AmbientLight(0xffffff, 2.0));

    const updateCam = () => {
      const t   = targetRef.current;
      const h   = halfRef.current;
      const asp = container.clientWidth / (container.clientHeight || 1);
      const dist = Math.max(h * 8, 30);
      const { position, up } = getCameraPos(viewType, dir, t, dist);
      camera.position.copy(position);
      camera.up.copy(up);
      camera.lookAt(t);
      camera.left   = -h * asp;
      camera.right  =  h * asp;
      camera.top    =  h;
      camera.bottom = -h;
      camera.updateProjectionMatrix();
    };

    const panKey = viewType === 'floorplan' ? 'floorplan' : dir;
    const { right: panRight, up: panUp } = PAN[panKey];

    const onDown  = (e: MouseEvent) => { mouseRef.current = { isDown: true, x: e.clientX, y: e.clientY }; };
    const onUp    = () => { mouseRef.current.isDown = false; };
    const onMove  = (e: MouseEvent) => {
      if (!mouseRef.current.isDown) return;
      const dx = e.clientX - mouseRef.current.x;
      const dy = e.clientY - mouseRef.current.y;
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      const speed = (halfRef.current * 2) / (container.clientHeight || 1);
      targetRef.current = targetRef.current.clone()
        .addScaledVector(panRight, -dx * speed)
        .addScaledVector(panUp,    -dy * speed);
      updateCam();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      halfRef.current = Math.max(0.2, Math.min(500, halfRef.current * (e.deltaY > 0 ? 1.12 : 0.89)));
      updateCam();
    };
    const onResize = () => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      updateCam();
    };

    renderer.domElement.addEventListener('mousedown', onDown);
    renderer.domElement.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('mouseup',   onUp);
    renderer.domElement.addEventListener('wheel',     onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    updateCam();

    let animId: number;
    const animate = () => { animId = requestAnimationFrame(animate); renderer.render(scene, camera); };
    animate();
    setIsReady(true);

    return () => {
      cancelAnimationFrame(animId);
      renderer.domElement.removeEventListener('mousedown', onDown);
      renderer.domElement.removeEventListener('mousemove', onMove);
      renderer.domElement.removeEventListener('mouseup',   onUp);
      renderer.domElement.removeEventListener('wheel',     onWheel);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewType, dir]);

  // ── Geometry rebuild ──────────────────────────────────────────────────────

  useEffect(() => {
    const scene    = sceneRef.current;
    const camera   = cameraRef.current;
    const renderer = rendererRef.current;
    if (!scene || !camera || !renderer || !isReady) return;

    setBuilding(true);
    setOgError(null);

    (async () => {
      try {
        await ensureOpenGeoReady();
        scene.children = scene.children.filter((c) => c instanceof THREE.Light);

        // Filter to storey for floor plans
        const buildNodes = (viewType === 'floorplan' && storeyId)
          ? nodes.filter((n) => n.id === storeyId || n.parentId === storeyId)
          : nodes;
        const nodeIds    = new Set(buildNodes.map((n) => n.id));
        const buildEdges = (viewType === 'floorplan' && storeyId)
          ? edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
          : edges;

        buildOGScene(scene, buildNodes, buildEdges, matConfig);

        // Override to 2D colors from material config
        const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
        apply2DColors(scene, nodeMap, matConfig);

        // Auto-fit + cut init on first build (or if no initial params provided)
        if (!hasFitRef.current) {
          const box = new THREE.Box3();
          scene.traverse((c) => { if (c instanceof THREE.Mesh) box.expandByObject(c); });
          if (!box.isEmpty()) {
            hasFitRef.current = true;

            const center = new THREE.Vector3();
            const size   = new THREE.Vector3();
            box.getCenter(center);
            box.getSize(size);
            targetRef.current = center.clone();

            // Choose visible span for half-size
            const [spanA, spanB] =
              viewType === 'floorplan' ? [size.x, size.z] :
              (dir === 'N' || dir === 'S') ? [size.x, size.y] : [size.z, size.y];
            halfRef.current = (Math.max(spanA, spanB) / 2) * 1.25;

            const asp  = renderer.domElement.width / (renderer.domElement.height || 1);
            const dist = halfRef.current * 8;
            const { position, up } = getCameraPos(viewType, dir, center, dist);
            camera.position.copy(position);
            camera.up.copy(up);
            camera.lookAt(center);
            camera.left   = -halfRef.current * asp;
            camera.right  =  halfRef.current * asp;
            camera.top    =  halfRef.current;
            camera.bottom = -halfRef.current;
            camera.updateProjectionMatrix();

            // Initialise cut params (unless tab already has saved params)
            if (initialCutPos === undefined) {
              let pos = 0;
              let depth = 0;
              let rMin = 0, rMax = 0, rMaxDepth = 0;

              if (viewType === 'floorplan') {
                pos        = box.min.y + 1.2;    // 1200 mm above floor
                depth      = box.max.y - box.min.y;
                rMin       = box.min.y; rMax = box.max.y;
                rMaxDepth  = box.max.y - box.min.y;
              } else if (dir === 'N') {
                pos        = box.min.z;           // OG Z of N face
                depth      = Math.max(0.3, (box.max.z - box.min.z) * 0.2);
                rMin       = box.min.z; rMax = box.max.z;
                rMaxDepth  = box.max.z - box.min.z;
              } else if (dir === 'S') {
                pos        = box.max.z;           // OG Z of S face
                depth      = Math.max(0.3, (box.max.z - box.min.z) * 0.2);
                rMin       = box.min.z; rMax = box.max.z;
                rMaxDepth  = box.max.z - box.min.z;
              } else if (dir === 'E') {
                pos        = box.max.x;           // OG X of E face
                depth      = Math.max(0.3, (box.max.x - box.min.x) * 0.2);
                rMin       = box.min.x; rMax = box.max.x;
                rMaxDepth  = box.max.x - box.min.x;
              } else {
                pos        = box.min.x;           // OG X of W face
                depth      = Math.max(0.3, (box.max.x - box.min.x) * 0.2);
                rMin       = box.min.x; rMax = box.max.x;
                rMaxDepth  = box.max.x - box.min.x;
              }
              setCutPos(pos);
              setCutDepth(depth);
              setCutRange({ min: rMin, max: rMax, maxDepth: rMaxDepth });
              cutInitRef.current = true;
            } else {
              // Range from bounding box, but use provided pos/depth
              let rMin = 0, rMax = 0, rMaxDepth = 0;
              if (viewType === 'floorplan') {
                rMin = box.min.y; rMax = box.max.y; rMaxDepth = box.max.y - box.min.y;
              } else if (dir === 'N' || dir === 'S') {
                rMin = box.min.z; rMax = box.max.z; rMaxDepth = box.max.z - box.min.z;
              } else {
                rMin = box.min.x; rMax = box.max.x; rMaxDepth = box.max.x - box.min.x;
              }
              setCutRange({ min: rMin, max: rMax, maxDepth: rMaxDepth });
              cutInitRef.current = true;
            }
          }
        }
      } catch (err) {
        console.error('[OGOrthoViewer] Build failed:', err);
        setOgError(err instanceof Error ? err.message : 'OpenGeometry build failed');
      } finally {
        setBuilding(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, storeyId, isReady, matConfig]);

  // ── Clipping planes update ────────────────────────────────────────────────
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.clippingPlanes = makePlanes(viewType, dir, cutPos, cutDepth);
  }, [viewType, dir, cutPos, cutDepth]);

  // ── Slider label ──────────────────────────────────────────────────────────
  const cutLabel = viewType === 'floorplan' ? 'Cut Elev'
    : dir === 'N' || dir === 'S' ? 'Cut Y'
    : 'Cut X';

  // ── Draw-wall overlay handlers (React events, only when mode active) ──────
  const handleOverlayMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawWallMode) return;
    // Only left-click; shift+click = pass to pan (let event bubble)
    if (e.button !== 0 || e.shiftKey) return;
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const bim = screenToBim(e.clientX - rect.left, e.clientY - rect.top);
    if (!bim) return;
    const snapped = findSnap(bim);
    if (!wallStart) {
      setWallStart(snapped);
    } else {
      commitWall(wallStart, snapped);
      setWallStart(null);
    }
  }, [drawWallMode, wallStart, screenToBim, findSnap, commitWall]);

  const handleOverlayMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawWallMode) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const bim = screenToBim(e.clientX - rect.left, e.clientY - rect.top);
    if (bim) {
      setHoverRaw(bim);
      setHoverSnap(findSnap(bim));
    }
  }, [drawWallMode, screenToBim, findSnap]);

  /** Convert BIM mm → screen px (relative to container), for overlay SVG. */
  const bimToScreen = useCallback((bx: number, by: number): { sx: number; sy: number } | null => {
    const camera = cameraRef.current;
    const container = containerRef.current;
    if (!camera || !container) return null;
    const w = container.clientWidth;
    const h = container.clientHeight;
    // BIM mm → OG meters: X→+X, Y→-Z (floorplan)
    const ogX = bx * MM;
    const ogZ = -by * MM;
    const v = new THREE.Vector3(ogX, 0, ogZ).project(camera);
    return { sx: (v.x + 1) / 2 * w, sy: (-v.y + 1) / 2 * h };
  }, []);

  return (
    <div className={cn('relative w-full h-full overflow-hidden', className)}>
      {/* Three.js canvas */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Draw-wall interaction overlay — above canvas, below UI controls */}
      {drawWallMode && viewType === 'floorplan' && (
        <div
          className="absolute inset-0 z-[5]"
          style={{ cursor: 'crosshair' }}
          onMouseDown={handleOverlayMouseDown}
          onMouseMove={handleOverlayMouseMove}
        >
          {/* SVG overlay for snap indicators */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
            {/* Room parametric grid lines */}
            {roomParametricGrids.map((grid) =>
              grid.gridLines.map((line, li) => {
                const s1 = bimToScreen(line[0].x, line[0].y);
                const s2 = bimToScreen(line[1].x, line[1].y);
                if (!s1 || !s2) return null;
                return <line key={`rg_${grid.roomId}_${li}`} x1={s1.sx} y1={s1.sy} x2={s2.sx} y2={s2.sy} stroke="#14b8a6" strokeWidth={0.5} strokeOpacity={0.4} strokeDasharray="4 3" />;
              })
            )}
            {/* Room parametric control points (teal squares) */}
            {roomParametricGrids.flatMap((grid) =>
              grid.points.map((p, i) => {
                const s = bimToScreen(p.x, p.y);
                if (!s) return null;
                return <rect key={`rp_${grid.roomId}_${i}`} x={s.sx - 3} y={s.sy - 3} width={6} height={6} fill="#14b8a6" fillOpacity={0.5} />;
              })
            )}
            {/* Axis snap points as tiny dots */}
            {snapPoints.map((p, i) => {
              const s = bimToScreen(p.x, p.y);
              if (!s) return null;
              return <circle key={i} cx={s.sx} cy={s.sy} r={3} fill="#3b82f6" fillOpacity={0.25} />;
            })}
            {/* Hover snap crosshair */}
            {hoverRaw && (() => {
              const s = bimToScreen(hoverRaw.x, hoverRaw.y);
              if (!s) return null;
              const snapDist = hoverSnap
                ? Math.hypot(hoverSnap.x - hoverRaw.x, hoverSnap.y - hoverRaw.y)
                : 0;
              const showSnap = hoverSnap && snapDist > 1;
              const snapScr = showSnap ? bimToScreen(hoverSnap.x, hoverSnap.y) : null;
              return (
                <g>
                  <line x1={s.sx - 14} y1={s.sy} x2={s.sx + 14} y2={s.sy} stroke="#3b82f6" strokeWidth={1.5} />
                  <line x1={s.sx} y1={s.sy - 14} x2={s.sx} y2={s.sy + 14} stroke="#3b82f6" strokeWidth={1.5} />
                  <circle cx={s.sx} cy={s.sy} r={6} fill="#3b82f6" fillOpacity={0.3} stroke="#3b82f6" strokeWidth={1} />
                  {showSnap && snapScr && (
                    <circle cx={snapScr.sx} cy={snapScr.sy} r={8} fill="none" stroke="#22c55e" strokeWidth={1.2} strokeDasharray="3 2" />
                  )}
                </g>
              );
            })()}
            {/* Wall start point */}
            {wallStart && (() => {
              const s = bimToScreen(wallStart.x, wallStart.y);
              if (!s) return null;
              return <circle cx={s.sx} cy={s.sy} r={6} fill="#22c55e" fillOpacity={0.7} stroke="#22c55e" strokeWidth={1.5} />;
            })()}
            {/* Rubber-band line from start to hover */}
            {wallStart && hoverRaw && (() => {
              const ss = bimToScreen(wallStart.x, wallStart.y);
              const he = hoverSnap && Math.hypot(hoverSnap.x - hoverRaw.x, hoverSnap.y - hoverRaw.y) > 1
                ? bimToScreen(hoverSnap.x, hoverSnap.y)
                : bimToScreen(hoverRaw.x, hoverRaw.y);
              if (!ss || !he) return null;
              return <line x1={ss.sx} y1={ss.sy} x2={he.sx} y2={he.sy} stroke="#3b82f6" strokeWidth={2} strokeDasharray="8 4" />;
            })()}
          </svg>
        </div>
      )}

      {/* Badge */}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-black/60 text-emerald-400 select-none">
          {viewLabel(viewType, dir)}
        </span>
        {/* Draw Wall button — only for floorplan */}
        {viewType === 'floorplan' && (
          <button
            title={drawWallMode ? 'Draw Wall active — click two points (ESC to cancel)' : 'Draw Wall — place walls by clicking snap points'}
            onClick={() => { setDrawWallMode(!drawWallMode); setWallStart(null); setHoverSnap(null); setHoverRaw(null); }}
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-mono select-none transition-colors',
              drawWallMode
                ? 'bg-orange-500 text-white'
                : 'bg-black/60 text-gray-300 hover:bg-black/80 hover:text-white',
            )}
          >▭ Wall</button>
        )}
        {selectedNodeId && !drawWallMode && viewType === 'floorplan' && (
          <button
            title="Delete selected element (Del)"
            onClick={deleteSelectedNode}
            className="px-2 py-0.5 rounded text-[10px] font-mono select-none transition-colors bg-red-800/70 text-red-200 hover:bg-red-700"
          >🗑 Delete</button>
        )}
      </div>

      {/* Building indicator */}
      {isBuilding && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-20 pointer-events-none">
          <span className="text-white text-sm font-medium">Building geometry…</span>
        </div>
      )}

      {/* Error */}
      {ogError && (
        <div className="absolute top-2 right-2 z-20 max-w-sm px-3 py-2 rounded bg-red-900/80 text-red-200 text-xs font-mono">
          {ogError}
        </div>
      )}

      {/* Cut controls */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-3 py-1.5 bg-black/75 text-[10px] font-mono text-white select-none flex flex-col gap-1">
        {drawWallMode && viewType === 'floorplan' && (
          <div className="text-orange-400 font-semibold">
            {wallStart ? '▭ Click 2nd snap point to place wall' : '▭ Click 1st snap point for wall start'} — ESC to cancel
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-emerald-300">{cutLabel}</span>
          <input
            type="range" className="flex-1 h-1 accent-emerald-400 cursor-pointer"
            min={cutRange.min} max={cutRange.max} step={0.05}
            value={cutPos}
            onChange={(e) => setCutPos(Number(e.target.value))}
          />
          <span className="w-24 text-right text-emerald-200">{fmtCut(viewType, dir, cutPos)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-emerald-300">Depth</span>
          <input
            type="range" className="flex-1 h-1 accent-emerald-400 cursor-pointer"
            min={0.05} max={Math.max(cutRange.maxDepth, 0.5)} step={0.05}
            value={cutDepth}
            onChange={(e) => setCutDepth(Number(e.target.value))}
          />
          <span className="w-24 text-right text-emerald-200">{Math.round(cutDepth * 1000)} mm</span>
        </div>
      </div>
    </div>
  );
}

// ─── Named aliases ────────────────────────────────────────────────────────────

interface OGAlias {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  storeyId?: string;
  tabId?: string;
  initialCutPos?: number;
  initialCutDepth?: number;
  viewDirection?: OGViewDir;
  className?: string;
}

export function OGFloorPlanViewer(props: OGAlias) {
  return <OGOrthoViewer {...props} viewType="floorplan" />;
}

export function OGSectionViewer({ viewDirection = 'N', ...props }: OGAlias) {
  return <OGOrthoViewer {...props} viewType="section" viewDirection={viewDirection} />;
}

export function OGElevationViewer({ viewDirection = 'N', ...props }: OGAlias) {
  return <OGOrthoViewer {...props} viewType="elevation" viewDirection={viewDirection} />;
}
