/**
 * spaceBoundaries.ts — the CellComplex's faces as IFC space boundaries.
 *
 * Energy and facility-management tools read a building through its space
 * boundaries: for each room, every surface that bounds it, the element that
 * surface belongs to, and whether the other side is another room, outside
 * air or the ground. The topology backend computes exactly that (one face per
 * wall or slab between two cells, split where rooms meet), so this writes it
 * into the IFC the app already exports:
 *
 *   IFC4 / IFC4X3  IfcRelSpaceBoundary2ndLevel, a shared face written once
 *                  per side with the two sides pointing at each other
 *                  (CorrespondingBoundary) — the "2a" boundaries of the
 *                  2nd-level convention;
 *   IFC2X3         IfcRelSpaceBoundary named '2ndLevel', the same data
 *                  without the pairing, which the schema cannot express.
 *
 * Geometry is an IfcConnectionSurfaceGeometry holding an IfcFaceSurface in
 * the space's own coordinates, its normal pointing out of the space.
 *
 * The element is the wall the face lies on (from the backend's `elements`),
 * or for a horizontal face the slab the app exports with the room below it
 * (its ceiling slab, Tag = that room's id). A face no element makes — a
 * ground floor with no slab, a room edge with no wall — gets an
 * IfcVirtualElement and is marked VIRTUAL, as the schema intends, rather
 * than being dropped. Doors and windows are not written as inner boundaries
 * yet; the wall boundary around them is whole.
 */
import { findEntities, ifcGuid, readEntity, refsIn } from './stepGeometry';
import {
  appendEntities, detectIfcSchema, findEntityId, flt, inner, maxEntityId, stepReal, tokeniseArgs, unquote,
} from './stepText';
import type { TopologyFace, TopologyResult } from '@/lib/topology/types';

const MM = 0.001;
type V3 = [number, number, number];

export interface SpaceBoundaryReport {
  text: string;
  boundaries: number;
  /** Boundaries with no building element behind them. */
  virtual: number;
  /** Faces left out, and why (a room with no IfcSpace, a degenerate face). */
  skipped: string[];
}

// ── Placement: world → an element's local frame ──────────────────────────────

interface Frame { o: V3; x: V3; y: V3; z: V3 }
const IDENTITY: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function readVec(text: string, arg: string | undefined): V3 | null {
  const id = refsIn(arg)[0];
  if (id === undefined) return null;
  const e = readEntity(text, id);
  if (!e) return null;
  const v = tokeniseArgs(inner(e.args[0])).map(flt);
  return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
}

/** The absolute frame of an IfcLocalPlacement, following PlacementRelTo. */
function placementFrame(text: string, id: number | undefined, depth = 0): Frame {
  if (id === undefined || depth > 32) return IDENTITY;
  const lp = readEntity(text, id);
  if (!lp || lp.type !== 'IFCLOCALPLACEMENT') return IDENTITY;
  const parent = placementFrame(text, refsIn(lp.args[0])[0], depth + 1);
  const ax = readEntity(text, refsIn(lp.args[1])[0] ?? -1);
  if (!ax || ax.type !== 'IFCAXIS2PLACEMENT3D') return parent;
  const loc = readVec(text, ax.args[0]) ?? [0, 0, 0];
  const z = norm(readVec(text, ax.args[1]) ?? [0, 0, 1]);
  const xRef = readVec(text, ax.args[2]) ?? [1, 0, 0];
  const x = norm(sub(xRef, z.map((c) => c * dot(xRef, z)) as V3));
  const y = cross(z, x);
  // Local frame expressed in the parent's, then in the world's.
  const toWorld = (v: V3): V3 => [
    parent.x[0] * v[0] + parent.y[0] * v[1] + parent.z[0] * v[2],
    parent.x[1] * v[0] + parent.y[1] * v[1] + parent.z[1] * v[2],
    parent.x[2] * v[0] + parent.y[2] * v[1] + parent.z[2] * v[2],
  ];
  const o = toWorld(loc);
  return {
    o: [parent.o[0] + o[0], parent.o[1] + o[1], parent.o[2] + o[2]],
    x: toWorld(x), y: toWorld(y), z: toWorld(z),
  };
}

const toLocal = (f: Frame, p: V3): V3 => {
  const d = sub(p, f.o);
  return [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
};
const dirToLocal = (f: Frame, d: V3): V3 => [dot(d, f.x), dot(d, f.y), dot(d, f.z)];

// ── The writer ───────────────────────────────────────────────────────────────

export function addSpaceBoundaries(
  text: string,
  topo: Pick<TopologyResult, 'faces' | 'rooms' | 'graph'>,
  spaceIds: Record<string, number>,
): SpaceBoundaryReport {
  const schema = detectIfcSchema(text);
  const owner = findEntityId(text, 'IFCOWNERHISTORY');
  const skipped: string[] = [];
  if (owner === null) return { text, boundaries: 0, virtual: 0, skipped: ['Fișierul nu are IfcOwnerHistory.'] };

  // Elements by the node id the app writes into Tag (index 7 of an IfcElement).
  const byTag = new Map<string, number>();
  for (const e of findEntities(text, (x) => /^IFC(WALL|WALLSTANDARDCASE|SLAB)$/.test(x.type))) {
    const tag = e.args[7] && e.args[7] !== '$' ? unquote(e.args[7]) : '';
    if (tag && !byTag.has(tag)) byTag.set(tag, e.id);
  }
  const slabTag = (tag: string) => {
    const id = byTag.get(tag);
    return id !== undefined && readEntity(text, id)?.type === 'IFCSLAB' ? id : undefined;
  };

  const rooms = new Map(topo.rooms.map((r) => [r.id, r]));
  const centre = new Map(topo.graph.nodes.map((n) => [n.id, n.positionMm as V3]));
  const frames = new Map<number, Frame>();
  const frameOf = (spaceId: number) => {
    let f = frames.get(spaceId);
    if (!f) {
      const sp = readEntity(text, spaceId);
      f = placementFrame(text, refsIn(sp?.args[5])[0]);
      frames.set(spaceId, f);
    }
    return f;
  };

  let next = maxEntityId(text) + 1;
  const lines: string[] = [];
  const lineOf = new Map<number, number>();
  const add = (type: string, args: string[]) => {
    const id = next++;
    lineOf.set(id, lines.length);
    lines.push(`#${id}=${type}(${args.join(',')});`);
    return id;
  };
  const pt = (p: V3) => add('IFCCARTESIANPOINT', [`(${p.map(stepReal).join(',')})`]);
  const dir = (d: V3) => add('IFCDIRECTION', [`(${d.map(stepReal).join(',')})`]);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

  /** An IfcFaceSurface for `loop` (world mm) in `frame`, normal `n` (world). */
  const surface = (frame: Frame, loop: V3[], n: V3): number => {
    const local = loop.map((p) => toLocal(frame, [p[0] * MM, p[1] * MM, p[2] * MM]));
    // Wind the loop so its right-hand normal is `n`.
    const ln = dirToLocal(frame, n);
    let nw: V3 = [0, 0, 0];
    for (let i = 0; i < local.length; i++) {
      const a = local[i], b = local[(i + 1) % local.length];
      nw = [nw[0] + (a[1] - b[1]) * (a[2] + b[2]), nw[1] + (a[2] - b[2]) * (a[0] + b[0]), nw[2] + (a[0] - b[0]) * (a[1] + b[1])];
    }
    const ordered = dot(nw, ln) < 0 ? local.slice().reverse() : local;
    const poly = add('IFCPOLYLOOP', [`(${ordered.map((p) => `#${pt(p)}`).join(',')})`]);
    const bound = add('IFCFACEOUTERBOUND', [`#${poly}`, '.T.']);
    const edge0 = sub(ordered[1], ordered[0]);
    const refDir = norm(edge0);
    const plane = add('IFCPLANE', [`#${add('IFCAXIS2PLACEMENT3D', [`#${pt(ordered[0])}`, `#${dir(norm(ln))}`, `#${dir(refDir)}`])}`]);
    return add('IFCFACESURFACE', [`(#${bound})`, `#${plane}`, '.T.']);
  };

  const virtualElement = (label: string): number =>
    add('IFCVIRTUALELEMENT', [q(ifcGuid()), `#${owner}`, q(label), '$', '$', '$', '$', '$']);

  let boundaries = 0, virtual = 0;
  const isIfc4 = schema !== 'IFC2X3';
  const relType = isIfc4 ? 'IFCRELSPACEBOUNDARY2NDLEVEL' : 'IFCRELSPACEBOUNDARY';

  for (const face of (topo.faces ?? []) as TopologyFace[]) {
    if (face.kind === 'internal' || face.kind === 'orphan') continue;
    const sides = face.rooms.filter((r) => spaceIds[r] !== undefined);
    if (sides.length === 0) {
      skipped.push(`Fața ${face.kind} a ${face.rooms.join('/')} — camera nu are IfcSpace.`);
      continue;
    }
    if (face.outerMm.length < 3) { skipped.push('O față degenerată.'); continue; }
    const loop = face.outerMm as V3[];
    const n = norm(face.normal as V3);
    const fc: V3 = loop.reduce<V3>((a, p) => [a[0] + p[0] / loop.length, a[1] + p[1] / loop.length, a[2] + p[2] / loop.length], [0, 0, 0]);

    // The element behind the face.
    let element: number | undefined;
    if (face.kind === 'wall' || face.kind === 'exterior') {
      element = face.elements?.[0] ? byTag.get(face.elements[0]) : undefined;
    } else if (face.kind === 'slab') {
      // The lower room's ceiling slab.
      const lower = face.rooms.find((r) => Math.abs((rooms.get(r)?.topMm ?? NaN) - fc[2]) < 1);
      element = lower ? slabTag(lower) : undefined;
    } else if (face.kind === 'roof') {
      element = slabTag(face.rooms[0]);
    }
    const physical = element !== undefined;
    if (!physical) element = virtualElement(`${face.kind} ${face.rooms.join('/')}`);

    const where = face.kind === 'wall' || face.kind === 'slab' ? '.INTERNAL.'
      : face.kind === 'ground' ? (isIfc4 ? '.EXTERNAL_EARTH.' : '.EXTERNAL.') : '.EXTERNAL.';

    // One boundary per side; for a shared face, the two point at each other.
    const made: number[] = [];
    for (const roomId of sides) {
      const spaceId = spaceIds[roomId];
      const frame = frameOf(spaceId);
      const c = centre.get(roomId);
      // Normal out of this space.
      const out: V3 = c && dot(sub(fc, c), n) < 0 ? [-n[0], -n[1], -n[2]] : n;
      const conn = add('IFCCONNECTIONSURFACEGEOMETRY', [`#${surface(frame, loop, out)}`, '$']);
      const common = [
        q(ifcGuid()), `#${owner}`, q('2ndLevel'), q(isIfc4 ? '2a' : '2ndLevel'),
        `#${spaceId}`, `#${element}`, `#${conn}`,
        physical ? '.PHYSICAL.' : '.VIRTUAL.', where,
      ];
      // The corresponding boundary of a pair is written after this one, so
      // its id is known once both are placed: patched below.
      const id = add(relType, isIfc4 ? [...common, '$', '__CORR__'] : common);
      made.push(id);
      boundaries++;
      if (!physical) virtual++;
    }
    if (isIfc4) {
      for (const [k, id] of made.entries()) {
        const other = made.length === 2 ? `#${made[1 - k]}` : '$';
        const i = lineOf.get(id)!;
        lines[i] = lines[i].replace('__CORR__', other);
      }
    }
  }

  return { text: appendEntities(text, lines), boundaries, virtual, skipped };
}
