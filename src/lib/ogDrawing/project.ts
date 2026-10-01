/**
 * project.ts — the kernel's linework, for any view frame.
 *
 * `ogProjection.projectOgLines` does this for a vertical cut. Everything in it
 * that mattered turned out to be frame arithmetic — the camera, the depths,
 * the occluders — and only the frame itself was vertical. So the body moved
 * here, generalised to a `ViewFrame`, and the old entry point now builds a
 * section frame and calls this. There is one projection in the codebase, and
 * the floor plan is not a second copy of it.
 *
 * ## What the kernel does and does not do
 *
 * It gives each solid its true silhouette through an orthographic camera,
 * openings included, with that solid's OWN back faces removed. It does not
 * remove what another element hides — measured, on 2.0.13 and again on
 * 2.0.14: a box standing entirely behind a panel comes back with all four
 * edges visible. So `hlr.ts` does that part, from the same faces.
 *
 * And it does not section. `section_plane` is in the API and is discarded
 * (also measured, also both versions). The cut is `slice.ts`'s work; an
 * element the plane passes through is left out of the projection here
 * entirely, because the kernel would draw the whole of it — in a plan, the
 * full height of a wall stacked on its own footprint.
 *
 * ## Coordinates
 *
 * The kernel works in the 3D viewers' metres: x east, y up, z south, so a BIM
 * point (x, y, z) in mm is (x, z, −y) × 0.001. A camera is built from the
 * frame by rotating its three axes the same way, and the kernel returns image
 * coordinates relative to the target, x to the camera's right and y up — which
 * is `u` and `v` by construction. For the vertical frames this reproduces the
 * old module's mapping term for term; for the plan it is pinned by a test,
 * because an image axis that comes back mirrored still looks like a drawing.
 */
import type { MaterialConfig } from '@/lib/materialConfig';
import { applyNodeColorOverrides, resolveVisuals } from '@/lib/materialConfig';
import type { BubbleGraphNode } from '@/store';
import { expandArrayNodes } from '@/lib/formulaUtils';
import type { DrawingShape } from '@/lib/drawingEngine';
import { facePlaneFrom, hideOccluded, type FacePlane, type HlrLine } from '@/lib/hlr';
import { meshEdges } from '@/lib/meshOutline';
import { boxDepth, projectPt, roleOf, type UVD, type Vec3, type ViewFrame } from './frame';

const MM = 0.001;

/** How far behind the plane the camera stands, metres — past anything a model reaches. */
const CAMERA_BACK_M = 1000;

/**
 * A mesh with more triangles than this still hides what is behind it, but its
 * own edges are not drawn: a terrain grid's ten thousand creases are a net,
 * not a drawing.
 */
export const MAX_OUTLINE_TRIANGLES = 4000;

/** The shape of an `OgEntity`, restated so this module owns no import cycle. */
export interface EntityLike {
  key: string;
  nodeId: string;
  nodeType: string;
  storeyId?: string;
  /** See-through — a room's air, a pane of glass. Draws nothing, hides nothing. */
  seeThrough?: boolean;
  source: 'brep' | 'mesh';
  brep: string;
  bbox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  faces: { ring: Vec3[]; holes: Vec3[][] }[];
  verts: Vec3[];
}

/** The scene manager this module needs — the kernel's, injected by the caller. */
export interface SceneManagerLike {
  createScene(name: string): string;
  removeScene(id: string): boolean;
  addBrepEntityToScene(sceneId: string, entityId: string, kind: string, brep: string): void;
  projectTo2DCamera(sceneId: string, cameraJson: string, hlrJson?: string | null): string;
  free(): void;
}

export interface ProjectViewOptions {
  /** Keep each solid's own back-face edges as dashed hidden lines. Off by default. */
  showBackFaces?: boolean;
  /** Cut every line where something nearer covers it. On by default. */
  occlude?: boolean;
  /**
   * Darken a stroke that has no contrast against the sheet (see `penColor`).
   *
   * OFF by default, and deliberately so. The engine-backed section and
   * elevation draw these lines OVER their own filled faces, where a pale
   * stroke is a subtle edge and darkening it would restyle drawings that
   * already read correctly. A view with no fills — the OG elevation — has
   * nothing but these lines, and there it is the difference between a
   * drawing and a blank sheet.
   */
  rescuePens?: boolean;
}

export interface ViewOutlines {
  shapes: DrawingShape[];
  /** Node ids the kernel drew — whose own bounding-rectangle strokes these replace. */
  covered: Set<string>;
}

export interface KernelCamera {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  near: number;
  projection_mode: 'Orthographic';
}

const toKernelPt = (p: Vec3) => ({ x: p.x * MM, y: p.z * MM, z: -p.y * MM });
const toKernelDir = (d: Vec3) => ({ x: d.x, y: d.z, z: -d.y });

/**
 * Above this relative luminance a colour cannot be a pen on a light sheet.
 *
 * It is a test, not a target. It sits above the slates the element defaults
 * use as ink — `#64748B` is about 0.17 and `#94A3B8` about 0.63 — and below
 * the tints they use as FILL, which were never meant to be drawn with: a
 * slab's `#CBD5E1` is 0.83 and a covering's `#FDA4AF` is 0.72.
 */
const MAX_PEN_LUMINANCE = 0.68;

/** What a rescued colour is darkened TO: contrast about 3:1 on a cream sheet. */
const RESCUED_PEN_LUMINANCE = 0.28;

/**
 * The colour as ink.
 *
 * A seen line is a LINE, and a line the colour of the paper is not a drawing.
 * This happens for real rather than in theory: `resolveVisuals` lets a named
 * material replace the whole visual set, so a library entry for concrete
 * brings concrete's near-white with it — perfectly good as a fill, and
 * invisible as a pen. It went unnoticed while the only kernel lines were
 * drawn over the engine's own filled faces; an elevation, which has no cut
 * and so no fills at all, is nothing BUT these lines.
 *
 * The material's hue is kept and the colour darkened until it reads, so the
 * element still looks like itself. A colour that already has contrast is
 * returned untouched — this rescues, it does not restyle.
 */
export function penColor(hex: string): string {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return hex;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum <= MAX_PEN_LUMINANCE) return hex;
  // Scale toward black, which keeps the hue. A pure white has no hue to keep
  // and lands on one dark grey every time, which is right for it.
  const k = RESCUED_PEN_LUMINANCE / Math.max(lum, 1e-6);
  const two = (v: number) => Math.round(Math.max(0, Math.min(1, v * k)) * 255).toString(16).padStart(2, '0');
  return `#${two(r)}${two(g)}${two(b)}`;
}

/**
 * The camera that sees the frame the way the drawing does: standing far back
 * on the viewer's side, looking along the frame's depth direction, with its
 * target on the frame origin.
 */
export function cameraForView(frame: ViewFrame): KernelCamera {
  const target = toKernelPt(frame.o);
  const fwd = toKernelDir(frame.rd);
  return {
    position: {
      x: target.x - fwd.x * CAMERA_BACK_M,
      y: target.y - fwd.y * CAMERA_BACK_M,
      z: target.z - fwd.z * CAMERA_BACK_M,
    },
    target,
    up: toKernelDir(frame.rv),
    near: 0.01,
    projection_mode: 'Orthographic',
  };
}

/** Keep the part of a ring at or beyond the plane (Sutherland–Hodgman on depth). */
function clipToPlane(ring: UVD[], minDepth: number): UVD[] {
  const out: UVD[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const prev = ring[j], cur = ring[i];
    const prevIn = prev.depth >= minDepth, curIn = cur.depth >= minDepth;
    if (curIn !== prevIn) {
      const t = (minDepth - prev.depth) / (cur.depth - prev.depth);
      out.push({ u: prev.u + (cur.u - prev.u) * t, v: prev.v + (cur.v - prev.v) * t, depth: minDepth });
    }
    if (curIn) out.push(cur);
  }
  return out;
}

/**
 * Every face of every entity, projected and trimmed to the viewed side.
 *
 * A solid the plane passes through occludes with the half of it that is still
 * standing, not with the half that was sawn off — so the trim is at depth
 * zero, not at the solid's own extent.
 */
export function occludersForView(entities: EntityLike[], frame: ViewFrame): FacePlane[] {
  const out: FacePlane[] = [];
  for (const e of entities) {
    for (const face of e.faces) {
      const outer = clipToPlane(face.ring.map((p) => projectPt(frame, p)), 0);
      if (outer.length < 3) continue;
      const rings: UVD[][] = [outer];
      for (const hole of face.holes) {
        const h = clipToPlane(hole.map((p) => projectPt(frame, p)), 0);
        if (h.length >= 3) rings.push(h);
      }
      const plane = facePlaneFrom(rings);
      if (plane) out.push(plane);
    }
  }
  return out;
}

/** How deep each of an entity's vertices sits, keyed by where it lands on paper. */
function vertexDepths(e: EntityLike, frame: ViewFrame): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of e.verts) {
    const q = projectPt(frame, p);
    const k = `${Math.round(q.u * 10)},${Math.round(q.v * 10)}`;
    const cur = m.get(k);
    if (cur === undefined || q.depth < cur) m.set(k, q.depth);
  }
  return m;
}

interface KernelSegment {
  geometry?: { Line?: { start: { x: number; y: number }; end: { x: number; y: number } } };
  class?: string;
  source_entity_id?: string;
}

/**
 * Project everything BEYOND the frame's plane into outline linework.
 *
 * `newSceneManager` is passed in rather than imported so the kernel stays one
 * import away from the pure geometry — the tests that only exercise the frame
 * arithmetic do not load a wasm module to do it.
 *
 * Never throws for a kernel refusal: an entity the kernel will not take is
 * skipped and simply does not get its outline, so the drawing is complete
 * either way.
 */
export function projectViewLines(
  entities: EntityLike[],
  frame: ViewFrame,
  nodes: BubbleGraphNode[],
  matConfig: MaterialConfig | null,
  newSceneManager: () => SceneManagerLike,
  opts: ProjectViewOptions = {},
): ViewOutlines {
  const shapes: DrawingShape[] = [];
  const covered = new Set<string>();

  const sm = newSceneManager();
  const sid = sm.createScene('drawing');
  try {
    const byKey = new Map<string, EntityLike>();
    const depthOfKey = new Map<string, number>();
    const meshes: EntityLike[] = [];

    for (const e of entities) {
      if (e.seeThrough) continue;              // a room's air has no outline
      const role = roleOf(frame, e.bbox);
      if (role === 'out') continue;
      if (role === 'cut') continue;            // the slicer's, not the kernel's
      depthOfKey.set(e.key, Math.max(0, boxDepth(frame, e.bbox).near));
      covered.add(e.nodeId);
      if (e.source === 'mesh') { meshes.push(e); continue; }
      try {
        sm.addBrepEntityToScene(sid, e.key, e.nodeType || 'generic', e.brep);
        byKey.set(e.key, e);
      } catch (err) {
        console.warn(`[ogDrawing] kernel refused ${e.nodeType} ${e.nodeId}:`, err);
        covered.delete(e.nodeId);
      }
    }
    if (byKey.size === 0 && meshes.length === 0) return { shapes, covered };

    const parsed: { segments?: KernelSegment[] } = byKey.size === 0 ? {} : JSON.parse(
      sm.projectTo2DCamera(
        sid,
        JSON.stringify(cameraForView(frame)),
        JSON.stringify({ hide_hidden_edges: !opts.showBackFaces }),
      ),
    );

    const nodeMap = new Map(expandArrayNodes(nodes).map((n) => [n.id, n]));
    const strokeOf = new Map<string, string>();
    const stroke = (e: EntityLike): string => {
      const hit = strokeOf.get(e.nodeId);
      if (hit) return hit;
      const node = nodeMap.get(e.nodeId);
      let vis = resolveVisuals(e.nodeType, String(node?.properties?.material ?? ''), matConfig);
      if (node) vis = applyNodeColorOverrides(vis, node.properties);
      const raw = vis.view_line_color ?? vis.color_2d;
      const c = opts.rescuePens ? penColor(raw) : raw;
      strokeOf.set(e.nodeId, c);
      return c;
    };

    const depthMaps = new Map<string, Map<string, number>>();
    const endDepth = (e: EntityLike, u: number, v: number): number => {
      let m = depthMaps.get(e.key);
      if (!m) { m = vertexDepths(e, frame); depthMaps.set(e.key, m); }
      return m.get(`${Math.round(u * 10)},${Math.round(v * 10)}`) ?? depthOfKey.get(e.key) ?? 0;
    };

    type Drawn = HlrLine & { e: EntityLike; hidden: boolean };
    const drawn: Drawn[] = [];
    // The kernel reports one edge under two classes when it is both an outline
    // and a crease — the same segment twice, which would draw twice.
    const seen = new Set<string>();
    const segKey = (id: string, a: { u: number; v: number }, b: { u: number; v: number }): string => {
      const ka = `${Math.round(a.u * 10)},${Math.round(a.v * 10)}`;
      const kb = `${Math.round(b.u * 10)},${Math.round(b.v * 10)}`;
      return `${id}|${ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`}`;
    };
    for (const s of parsed.segments ?? []) {
      const line = s.geometry?.Line;
      if (!line || !s.source_entity_id) continue;
      const e = byKey.get(s.source_entity_id);
      if (!e) continue;
      const hidden = s.class === 'Hidden';
      if (hidden && !opts.showBackFaces) continue;
      const a = { u: line.start.x * 1000, v: line.start.y * 1000 };
      const b = { u: line.end.x * 1000, v: line.end.y * 1000 };
      if (Math.hypot(b.u - a.u, b.v - a.v) < 0.05) continue;
      const k = segKey(e.key, a, b);
      if (seen.has(k)) continue;
      seen.add(k);
      drawn.push({ a, b, depthA: endDepth(e, a.u, a.v), depthB: endDepth(e, b.u, b.v), e, hidden });
    }

    // A mesh's edges are read off its triangles, in 3D, so each end has its
    // depth exactly. The viewer looks along the frame's depth direction.
    for (const e of meshes) {
      if (e.faces.length > MAX_OUTLINE_TRIANGLES) continue;
      for (const edge of meshEdges(e.faces.map((f) => f.ring), frame.rd)) {
        const a = projectPt(frame, edge.a), b = projectPt(frame, edge.b);
        // An edge in front of the plane is not in the picture; one across it
        // is trimmed where it crosses.
        if (a.depth < 0 && b.depth < 0) continue;
        let pa = a, pb = b;
        if (a.depth < 0 || b.depth < 0) {
          const t = a.depth / (a.depth - b.depth);
          const cut = { u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t, depth: 0 };
          if (a.depth < 0) pa = cut; else pb = cut;
        }
        // An edge along the line of sight is a point on paper.
        if (Math.hypot(pb.u - pa.u, pb.v - pa.v) < 0.05) continue;
        drawn.push({
          a: { u: pa.u, v: pa.v }, b: { u: pb.u, v: pb.v },
          depthA: pa.depth, depthB: pb.depth, e, hidden: false,
        });
      }
    }

    // Every OPAQUE entity occludes, whatever role it plays — a wall the plane
    // cuts hides what stands behind its remaining half, and so does one
    // outside the drawing's own vertical range. A face in front of the plane
    // needs no filtering: `occludersForView` clips it away to nothing.
    const pieces = opts.occlude === false
      ? drawn.map((line) => ({ line, a: line.a, b: line.b }))
      : hideOccluded(drawn, occludersForView(entities.filter((e) => !e.seeThrough), frame));

    for (const { line, a, b } of pieces) {
      shapes.push({
        pts: [a, b],
        closed: false,
        hatch: 'none',
        fillColor: 'none',
        strokeColor: stroke(line.e),
        lineWeight: line.hidden ? 'hidden' : 'projected',
        depthMm: depthOfKey.get(line.e.key) ?? 0,
        nodeId: line.e.nodeId,
        nodeType: line.e.nodeType,
      });
    }
  } finally {
    sm.removeScene(sid);
    sm.free();
  }
  return { shapes, covered };
}
