/**
 * ogProjection.ts — exact projected outlines for sections and elevations,
 * from the OpenGeometry kernel.
 *
 * The drawing engine draws a seen prism as its bounding RECTANGLE: a wall
 * with three windows is one blank box, a wall trimmed by its neighbours is
 * drawn axis to axis. Every OG-backed element the 3D viewer builds already
 * has a B-rep, and the kernel projects one through an orthographic camera
 * into its true silhouette — openings included, back faces removed. That is
 * what this module fetches.
 *
 * ## Two things the kernel does NOT do — both measured, neither documented
 *
 * **Section planes.** `section_plane` is accepted by the API and then thrown
 * away: 2.0.13's `scenegraph.rs` reads `let _ = &view.section_plane;` with
 * the comment "wired up here in Phase 3+", and no `SectionCut` edge is ever
 * emitted. So the cut stays the engine's; this module projects only what
 * lies WHOLLY beyond the plane.
 *
 * **Occlusion between elements.** `hide_hidden_edges` removes each solid's
 * own back faces and nothing else. A 2 × 2 box standing entirely behind a
 * 10 × 8 panel comes back with all four of its edges as `VisibleOutline`;
 * a box straddling the panel's edge is not trimmed at it. So the kernel's
 * linework alone is an x-ray, and we do that part ourselves: the same B-reps
 * give the projected faces, and `hlr.ts` cuts every line where something
 * nearer covers it. Each line also keeps its own element's depth, so what
 * survives still sorts with the fills the way it always did.
 *
 * ## Coordinates
 *
 * The kernel works in the 3D viewers' metres: x east, y up, z south (BIM
 * y → −z). A view is a `CutFrame` — the very one the engine uses — turned
 * into a camera standing far back on the viewer's side, looking along the
 * frame's look direction, with its target on the frame origin at elevation
 * zero. The kernel returns image coordinates relative to that target with
 * x to the camera's right and y up; the frame's `u` runs along the marker
 * with the viewer's right hand positive, so `u = x·1000`, `v = y·1000`, and
 * there is nothing else to get wrong.
 *
 * ## Which elements
 *
 * Whatever `buildOGScene` makes as a kernel solid — walls with their
 * openings cut, columns, beams, slabs, shells, sloping roof faces — comes
 * out with its B-rep, and the kernel draws its edges. Whatever it makes as a
 * plain mesh — a gable end, a stair, a sweep, a dome, the terrain — comes out
 * as its triangles instead, and `meshOutline.ts` draws its edges. Both kinds
 * give their faces to `hlr.ts`, so a stair hides the wall behind it exactly
 * as a wall hides a stair. Glass is left out: a pane that hid what stands
 * behind it would be wrong on every drawing there is.
 */
import * as THREE from 'three';
import { OGSceneManager } from 'opengeometry';
import type { BubbleGraphEdge, BubbleGraphNode } from '@/store';
import type { MaterialConfig } from '@/lib/materialConfig';
import { buildOGScene } from '@/lib/ogBimMapper';
import {
  buildFrame, localOf,
  type CutFrame, type KernelOutlines, type SectionCut,
} from '@/lib/drawingEngine';
import { frameFromCut } from '@/lib/ogDrawing/frame';
import { projectViewLines } from '@/lib/ogDrawing/project';

const MM = 0.001;

/** How far behind the plane the camera stands, metres — past anything a model reaches. */
const CAMERA_BACK_M = 1000;

/** An element this close to the plane is cut, not seen — the engine's business. */
const PLANE_TOL_MM = 0.5;

/**
 * A mesh with more triangles than this still hides what is behind it, but
 * its own edges are not drawn: a terrain grid's ten thousand creases are a
 * net, not a drawing.
 */
export const MAX_OUTLINE_TRIANGLES = 4000;

/**
 * Element types the engine draws as SYMBOLS rather than as bodies, and that
 * are therefore left out of the projection entirely. Planting is a
 * silhouette in a drawing, not the low-poly sphere the viewer shows, and a
 * dome is its front half of panels and ribs, culled on the surface normal —
 * the tube mesh's edges would only draw over that as a cage, and the glass,
 * being transparent, never drew at all. Neither hides anything here either:
 * the engine's fills already cover what stands behind them.
 */
export const ENGINE_DRAWN_TYPES: ReadonlySet<string> = new Set(['dome', 'scatter']);

// ─── The kernel's B-rep, as much of it as this module touches ────────────────

interface BrepVertex { position: { x: number; y: number; z: number } }
interface BrepFace { normal?: { x: number; y: number; z: number } | null; outer_loop: number; inner_loops?: number[] }
interface BrepHalfedge { id: number; from: number; next: number }
interface BrepLoop { id: number; halfedge: number }
interface BrepJson {
  id: string;
  vertices: BrepVertex[];
  faces: BrepFace[];
  halfedges?: BrepHalfedge[];
  loops?: BrepLoop[];
}

/** A point in BIM millimetres. */
export interface Pt3 { x: number; y: number; z: number }

/** One planar face of a solid, in BIM mm: its boundary and its holes. */
export interface OgFace {
  ring: Pt3[];
  holes: Pt3[][];
}

/** Extent in BIM mm. */
export interface BimBox {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface OgEntity {
  /** The B-rep's root id, which the kernel reports edges under. A fresh UUID per entity. */
  key: string;
  nodeId: string;
  nodeType: string;
  storeyId?: string;
  /**
   * You can see through it — a room's volume, a pane of glass. It is still
   * here, because a plan shades its rooms, but it draws no lines and hides
   * nothing.
   */
  seeThrough: boolean;
  /** Where the geometry came from: a kernel solid, or a mesh's triangles. */
  source: 'brep' | 'mesh';
  /** World-placed B-rep JSON, kernel metres — what the kernel projects. Empty for a mesh. */
  brep: string;
  bbox: BimBox;
  /**
   * The solid's faces in BIM mm — what hides things behind it. Extracted once
   * here, because the topology walk does not depend on the view.
   */
  faces: OgFace[];
  /** Every vertex in BIM mm, so a projected edge end can be given its depth. */
  verts: Pt3[];
}

export interface ProjectOptions {
  /**
   * Keep each solid's own back-face edges as dashed hidden lines. Off by
   * default: they are one solid's far side, not "what is behind the wall",
   * and reading them as the latter would be worse than not drawing them.
   */
  showBackFaces?: boolean;
  /**
   * Cut every line where something nearer covers it. On by default — it is
   * the whole reason the faces are collected. Off gives the raw kernel
   * linework, which is what the tests about the kernel itself want.
   */
  occlude?: boolean;
}

type BrepSource = { getBrepSerialized?: () => string; getBrepData?: () => unknown };

/**
 * The kernel wants a UUID for the root id, and the WebCrypto one is not
 * there in every runtime the tests and workers run in.
 */
function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** A fresh copy of the object's B-rep, or null when it has none / it is broken. */
function brepOf(obj: THREE.Object3D): BrepJson | null {
  const src = obj as unknown as BrepSource;
  try {
    if (typeof src.getBrepSerialized === 'function') return JSON.parse(src.getBrepSerialized()) as BrepJson;
    if (typeof src.getBrepData === 'function') {
      const d = src.getBrepData();
      // A copy: the wrapper keeps this object, and it must not see our edits.
      return (typeof d === 'string' ? JSON.parse(d) : JSON.parse(JSON.stringify(d))) as BrepJson;
    }
  } catch {
    return null;
  }
  return null;
}

const isIdentity = (m: THREE.Matrix4): boolean => {
  const e = m.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > 1e-9) return false;
  return true;
};

/**
 * The kernel places its own solids inside the B-rep (`setTranslation` moves
 * the vertices, not the mesh — checked), so the mesh's world matrix carries
 * only what was added on top: a node's `obj_translate_*` / `obj_rotate_*`.
 * Bake that in, or the lines would sit where the element was before it was
 * moved. Only positions and face normals are geometry; the rest is topology.
 */
function bake(b: BrepJson, m: THREE.Matrix4): void {
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3();
  for (const vert of b.vertices) {
    v.set(vert.position.x, vert.position.y, vert.position.z).applyMatrix4(m);
    vert.position = { x: v.x, y: v.y, z: v.z };
  }
  for (const f of b.faces) {
    if (!f.normal) continue;
    v.set(f.normal.x, f.normal.y, f.normal.z).applyMatrix3(nm).normalize();
    f.normal = { x: v.x, y: v.y, z: v.z };
  }
}

/** kernel (x, y up, z) → BIM (x east, y north, z up), millimetres. */
const toBim = (p: { x: number; y: number; z: number }): Pt3 =>
  ({ x: p.x * 1000, y: -p.z * 1000, z: p.y * 1000 });

/** Ten thousand times round a loop is a broken B-rep, not a big one. */
const LOOP_GUARD = 10000;

/**
 * The faces of a solid, as rings of BIM points.
 *
 * Walks the topology: a face names its outer loop and its holes, a loop names
 * one half-edge, and the half-edges chain through `next` back to where they
 * started. A loop that does not come back — a B-rep the kernel built wrong,
 * or one this code has misread — is dropped rather than spun on forever.
 */
export function facesOf(b: BrepJson): OgFace[] {
  if (!b.halfedges || !b.loops) return [];
  const heById = new Map(b.halfedges.map((h) => [h.id, h]));
  const loopById = new Map(b.loops.map((l) => [l.id, l]));

  const walk = (loopId: number): Pt3[] => {
    const loop = loopById.get(loopId);
    if (!loop) return [];
    const startId = loop.halfedge;
    const out: Pt3[] = [];
    let h = heById.get(startId);
    for (let i = 0; h && i < LOOP_GUARD; i++) {
      const v = b.vertices[h.from];
      if (!v) return [];
      out.push(toBim(v.position));
      h = heById.get(h.next);
      if (!h || h.id === startId) return out;
    }
    return [];
  };

  const faces: OgFace[] = [];
  for (const f of b.faces) {
    const ring = walk(f.outer_loop);
    if (ring.length < 3) continue;
    const holes: Pt3[][] = [];
    for (const id of f.inner_loops ?? []) {
      const h = walk(id);
      if (h.length >= 3) holes.push(h);
    }
    faces.push({ ring, holes });
  }
  return faces;
}

function bboxOf(b: BrepJson): BimBox {
  const box: BimBox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const { position: p } of b.vertices) {
    // kernel (x, y up, z) → BIM (x, y north = −z, z up = y), mm
    const x = p.x * 1000, y = -p.z * 1000, z = p.y * 1000;
    if (x < box.minX) box.minX = x; if (x > box.maxX) box.maxX = x;
    if (y < box.minY) box.minY = y; if (y > box.maxY) box.maxY = y;
    if (z < box.minZ) box.minZ = z; if (z > box.maxZ) box.maxZ = z;
  }
  return box;
}

/**
 * Can you see through this object?
 *
 * It decides whether the element takes part in the linework at all, and the
 * answer has to be the same for a kernel solid and for a plain mesh. It was
 * not: the test used to live inside `meshTriangles`, so a transparent MESH —
 * a glass pane — was dropped, while a transparent SOLID went through as if it
 * were masonry. A room is exactly that: `ogBimMapper` extrudes its polygon to
 * full height and hands it an opacity of 0.15, so it was hiding every element
 * standing in it and poché-ing the air besides.
 *
 * See-through elements are still collected — a plan shades its rooms, and
 * that is a drawing's business — but they are flagged, and the projection
 * leaves them out of both the drawing and the occlusion.
 */
function isSeeThrough(obj: THREE.Object3D): boolean {
  const mesh = obj as THREE.Mesh;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.some((m) => {
    const mat = m as THREE.Material | undefined;
    return !!mat && mat.transparent && (mat.opacity ?? 1) <= SEE_THROUGH_MAX_OPACITY;
  });
}

/**
 * Below this a material is something you look THROUGH; above it, something
 * merely drawn a little soft.
 *
 * The line cannot be "less than fully opaque": a roof is 0.95 and a dormer's
 * cheek 1.0, but a roof at 0.95 is a roof — drop it and the elevation loses
 * its roofline. The defaults leave a wide gap to put the threshold in: the
 * most opaque see-through thing is a window at 0.55, the least opaque real
 * material is that roof at 0.95. Rooms sit at 0.15, glazing and panels at
 * 0.45.
 */
const SEE_THROUGH_MAX_OPACITY = 0.75;

/**
 * The triangles of a plain mesh, in world space and BIM mm — or null when
 * the object is not a mesh worth reading: no geometry or no positions.
 */
function meshTriangles(obj: THREE.Object3D): Pt3[][] | null {
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh || !mesh.geometry) return null;
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 3) return null;
  const index = mesh.geometry.getIndex();
  const n = index ? index.count : pos.count;
  const v = new THREE.Vector3();
  const at = (i: number): Pt3 => {
    const k = index ? index.getX(i) : i;
    v.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(mesh.matrixWorld);
    return toBim(v);
  };
  const out: Pt3[][] = [];
  for (let i = 0; i + 2 < n; i += 3) out.push([at(i), at(i + 1), at(i + 2)]);
  return out.length ? out : null;
}

function boxOfPoints(pts: Pt3[]): BimBox {
  const box: BimBox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const p of pts) {
    if (p.x < box.minX) box.minX = p.x; if (p.x > box.maxX) box.maxX = p.x;
    if (p.y < box.minY) box.minY = p.y; if (p.y > box.maxY) box.maxY = p.y;
    if (p.z < box.minZ) box.minZ = p.z; if (p.z > box.maxZ) box.maxZ = p.z;
  }
  return box;
}

function disposeScene(scene: THREE.Scene): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose?.();
  });
}

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * Every kernel solid the 3D viewer would build for this graph, with its
 * B-rep. Builds the viewer's scene into a throwaway `THREE.Scene` — the one
 * place the element loops live — and reads the solids back off it, so the
 * lines can never disagree with what the viewer shows.
 *
 * Needs the kernel initialised (`ensureOpenGeoReady`).
 */
export function collectOgEntities(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  matConfig: MaterialConfig | null,
): OgEntity[] {
  const scene = new THREE.Scene();
  try {
    buildOGScene(scene, nodes, edges, matConfig);
    return entitiesFromScene(scene);
  } finally {
    disposeScene(scene);
  }
}

/**
 * The entities of a scene `buildOGScene` has already filled — for a caller
 * that built the scene for something else too (the HTML export bakes it to
 * a GLB) and does not want it built twice. The scene is left as it is.
 */
export function entitiesFromScene(scene: THREE.Object3D): OgEntity[] {
  const out: OgEntity[] = [];
  {
    scene.updateMatrixWorld(true);
    scene.traverse((obj) => {
      const nodeId = obj.userData?.nodeId;
      if (typeof nodeId !== 'string' || !nodeId) return;
      const nodeType = String(obj.userData.nodeType ?? '');
      if (ENGINE_DRAWN_TYPES.has(nodeType)) return;
      const storeyId = typeof obj.userData.storeyId === 'string' ? obj.userData.storeyId : undefined;
      const seeThrough = isSeeThrough(obj);
      const key = uuid();

      const b = brepOf(obj);
      if (b && Array.isArray(b.vertices) && b.vertices.length > 0 && Array.isArray(b.faces)) {
        if (!isIdentity(obj.matrixWorld)) bake(b, obj.matrixWorld);
        b.id = key;
        out.push({
          key, nodeId, nodeType, storeyId, seeThrough, source: 'brep',
          brep: JSON.stringify(b),
          bbox: bboxOf(b),
          faces: facesOf(b),
          verts: b.vertices.map((v) => toBim(v.position)),
        });
        return;
      }

      // No B-rep: a mesh is its triangles, and those are faces enough.
      const tris = meshTriangles(obj);
      if (!tris) return;
      const verts = tris.flat();
      out.push({
        key, nodeId, nodeType, storeyId, seeThrough, source: 'mesh',
        brep: '',
        bbox: boxOfPoints(verts),
        faces: tris.map((ring) => ({ ring, holes: [] })),
        verts,
      });
    });
  }
  return out;
}

/**
 * How far beyond the plane this element starts, or null when it is not in
 * the picture at all: cut by the plane (the engine's business), behind the
 * viewer, past the view's depth, or outside its elevation band.
 *
 * The distance is the engine's own `depthMm` for a seen prism — the nearest
 * point of the footprint — so a kernel line sorts exactly where the
 * rectangle it replaces did.
 */
export function depthBeyondPlane(
  bbox: BimBox, frame: CutFrame, elevMin: number, elevMax: number,
): number | null {
  const corners = [
    { x: bbox.minX, y: bbox.minY }, { x: bbox.maxX, y: bbox.minY },
    { x: bbox.maxX, y: bbox.maxY }, { x: bbox.minX, y: bbox.maxY },
  ];
  // Frame y is minus the depth into the viewed side.
  let yMax = -Infinity;
  for (const c of corners) {
    const { y } = localOf(frame, c);
    if (y > yMax) yMax = y;
  }
  const dMin = -yMax;
  if (dMin <= PLANE_TOL_MM) return null;
  if (dMin > frame.depth + 1) return null;
  if (bbox.maxZ < elevMin || bbox.minZ > elevMax) return null;
  return dMin;
}

/**
 * The camera that sees the frame the way the engine does: on the viewer's
 * side, looking along the frame's look direction, target on the frame origin
 * at elevation zero. Exported for the tests, which pin the mapping.
 */
export function cameraFor(frame: CutFrame): {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  near: number;
  projection_mode: 'Orthographic';
} {
  const target = { x: frame.ax * MM, y: 0, z: -frame.ay * MM };
  // The viewed side is +n in BIM; BIM y is kernel −z.
  const fwd = { x: frame.nx, z: -frame.ny };
  return {
    position: { x: target.x - fwd.x * CAMERA_BACK_M, y: 0, z: target.z - fwd.z * CAMERA_BACK_M },
    target,
    up: { x: 0, y: 1, z: 0 },
    near: 0.01,
    projection_mode: 'Orthographic',
  };
}

/**
 * Project the entities beyond the cut into outline linework in the frame's
 * drawing coordinates. Every element that goes through the kernel is listed
 * in `covered`; the engine drops its bounding rectangle's stroke for those.
 *
 * Never throws for a kernel refusal: an entity the kernel will not take is
 * skipped and stays the engine's, so the drawing is complete either way.
 */
export function projectOgLines(
  entities: OgEntity[],
  cut: SectionCut,
  nodes: BubbleGraphNode[],
  matConfig: MaterialConfig | null,
  opts: ProjectOptions = {},
): KernelOutlines {
  const frame = frameFromCut(
    buildFrame(cut), 'section',
    cut.elevMin ?? -Infinity, cut.elevMax ?? Infinity,
  );
  return projectViewLines(entities, frame, nodes, matConfig, () => new OGSceneManager(), opts);
}
