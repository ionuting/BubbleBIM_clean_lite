/**
 * stepGeometry.ts — geometry `@ifc-lite/create` cannot write, added to the
 * file it wrote.
 *
 * Two things the library has no public API for, both visible the moment the
 * export is opened next to the 3D view:
 *
 *   • an OPENING in an element that is not a parametric wall — the envelope
 *     ring, a covering band — so a window is not plastered over from outside;
 *   • a window or door that is more than a box: stiles, rails, a mullion
 *     when it is double, and a glass pane or a door leaf inside.
 *
 * The library keeps openings private and tied to `addIfcWall`, and its fills
 * are single solids. Rather than reach into its internals, this works on the
 * STEP text after `toIfc()`, the way the georeference already does: entities
 * are appended with ids that continue where the file stopped, and the one
 * edit made to existing lines is pointing a representation at new solids.
 * Everything here is text in, text out, and tested as such.
 *
 * Frames: an opening is written RELATIVE TO ITS HOST's placement; a fill's
 * new solids are written in the fill's own placement, which the library put
 * at the opening on the wall centre-line with X along the wall, Y up and Z
 * through the wall. Metres throughout.
 */

import { appendEntities, findEntityId, maxEntityId, stepReal, tokeniseArgs } from './stepText';

const STEP_LINE = /^#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\((.*)\)\s*;$/;

export interface Entity { id: number; type: string; args: string[] }

/** One entity by id, tokenised. Null when absent. */
export function readEntity(text: string, id: number): Entity | null {
  for (const line of text.split('\n')) {
    const m = STEP_LINE.exec(line.trim());
    if (!m || parseInt(m[1], 10) !== id) continue;
    return { id, type: m[2].toUpperCase(), args: tokeniseArgs(m[3]) };
  }
  return null;
}

/** Every entity for which `pred` holds. */
export function findEntities(text: string, pred: (e: Entity) => boolean): Entity[] {
  const out: Entity[] = [];
  for (const line of text.split('\n')) {
    const m = STEP_LINE.exec(line.trim());
    if (!m) continue;
    const e = { id: parseInt(m[1], 10), type: m[2].toUpperCase(), args: tokeniseArgs(m[3]) };
    if (pred(e)) out.push(e);
  }
  return out;
}

/** `#12` → 12; a list `(#12,#13)` → every id in it. */
export function refsIn(arg: string | undefined): number[] {
  return [...(arg ?? '').matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10));
}

/** Drop the lines defining these ids. */
export function removeEntities(text: string, ids: Set<number>): string {
  if (ids.size === 0) return text;
  return text.split('\n').filter((line) => {
    const m = STEP_LINE.exec(line.trim());
    return !(m && ids.has(parseInt(m[1], 10)));
  }).join('\n');
}

/** Is `#id` referenced by any entity other than its own definition? */
export function isReferenced(text: string, id: number): boolean {
  const re = new RegExp(`#${id}(?!\\d)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // A definition is `#id=`; anything else is a reference.
    if (text[m.index + m[0].length] !== '=') return true;
  }
  return false;
}

/**
 * Remove whichever of `candidates` nothing refers to any more, repeating
 * until the set is stable — deleting a solid orphans its profile, which
 * orphans its placement. Shared entities stay because something still
 * points at them, which is exactly the test.
 */
export function removeUnreferenced(text: string, candidates: Iterable<number>): string {
  const pending = new Set(candidates);
  let out = text;
  let changed = true;
  while (changed && pending.size > 0) {
    changed = false;
    for (const id of [...pending]) {
      if (isReferenced(out, id)) continue;
      out = removeEntities(out, new Set([id]));
      pending.delete(id);
      changed = true;
    }
  }
  return out;
}

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/**
 * A fresh IFC GlobalId: 128 random bits in the 22-character base-64 that
 * IFC uses (the "compressed GUID"). Same encoding as every IFC toolkit, so
 * a file that carries these round-trips through them unchanged.
 */
export function ifcGuid(random: (bytes: Uint8Array) => void = fillRandom): string {
  const b = new Uint8Array(16);
  random(b);
  const enc = (v: number, n: number) => {
    let s = '';
    for (let i = 0; i < n; i++) { s = GUID_CHARS[v % 64] + s; v = Math.floor(v / 64); }
    return s;
  };
  let out = enc(b[0], 2);
  for (let i = 1; i < 16; i += 3) out += enc((b[i] << 16) + (b[i + 1] << 8) + b[i + 2], 4);
  return out;
}

function fillRandom(bytes: Uint8Array): void {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) { c.getRandomValues(bytes); return; }
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
}

const esc = (s: string) => s.replace(/'/g, "''");

/** The two ids every appended product needs. */
export interface FileRefs { ownerHistory: number; bodyContext: number }

export function fileRefs(text: string): FileRefs {
  const ownerHistory = findEntityId(text, 'IFCOWNERHISTORY');
  const body = findEntities(text, (e) =>
    e.type === 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT' && e.args[1] === "'Body'")[0];
  const bodyContext = body?.id ?? findEntityId(text, 'IFCGEOMETRICREPRESENTATIONCONTEXT');
  if (ownerHistory == null || bodyContext == null) {
    throw new Error('stepGeometry: file has no owner history or model context');
  }
  return { ownerHistory, bodyContext };
}

export type Vec3 = [number, number, number];

/** A box in some local frame: profile centred on (cx, cy), extruded +Z from z0. */
export interface LocalBox { cx: number; cy: number; z0: number; w: number; h: number; depth: number }

export interface Rgb { r: number; g: number; b: number }

/**
 * Appends entities with ids continuing after the file's last one. Nothing is
 * written into `text` until `apply()`, so a writer that throws half-way
 * leaves the file as it was.
 */
export class StepWriter {
  private next: number;
  private readonly lines: string[] = [];
  private readonly styles = new Map<string, number>();
  private dirZ: number | null = null;

  constructor(private readonly text: string) {
    this.next = maxEntityId(text) + 1;
  }

  add(type: string, args: string[]): number {
    const id = this.next++;
    this.lines.push(`#${id}=${type}(${args.join(',')});`);
    return id;
  }

  apply(): string { return appendEntities(this.text, this.lines); }

  point3(p: Vec3): number {
    return this.add('IFCCARTESIANPOINT', [`(${p.map(stepReal).join(',')})`]);
  }
  point2(x: number, y: number): number {
    return this.add('IFCCARTESIANPOINT', [`(${stepReal(x)},${stepReal(y)})`]);
  }
  direction(d: Vec3): number {
    return this.add('IFCDIRECTION', [`(${d.map(stepReal).join(',')})`]);
  }
  axis2(p: Vec3, axis?: Vec3, ref?: Vec3): number {
    return this.add('IFCAXIS2PLACEMENT3D', [
      `#${this.point3(p)}`,
      axis ? `#${this.direction(axis)}` : '$',
      ref ? `#${this.direction(ref)}` : '$',
    ]);
  }
  private get zDir(): number {
    if (this.dirZ === null) this.dirZ = this.direction([0, 0, 1]);
    return this.dirZ;
  }

  /** A rectangle profile centred on the origin of its own plane. */
  rectangle(w: number, h: number): number {
    const placement = this.add('IFCAXIS2PLACEMENT2D', [`#${this.point2(0, 0)}`, '$']);
    return this.add('IFCRECTANGLEPROFILEDEF', ['.AREA.', '$', `#${placement}`, stepReal(w), stepReal(h)]);
  }

  box(b: LocalBox): number {
    return this.add('IFCEXTRUDEDAREASOLID', [
      `#${this.rectangle(b.w, b.h)}`,
      `#${this.axis2([b.cx, b.cy, b.z0])}`,
      `#${this.zDir}`,
      stepReal(b.depth),
    ]);
  }

  /** One IfcSurfaceStyle per distinct (name, colour, opacity); reused after. */
  style(name: string, rgb: Rgb, opacity = 1): number {
    const key = `${name}|${rgb.r},${rgb.g},${rgb.b}|${opacity}`;
    const cached = this.styles.get(key);
    if (cached !== undefined) return cached;
    const colour = this.add('IFCCOLOURRGB', ['$', stepReal(rgb.r), stepReal(rgb.g), stepReal(rgb.b)]);
    const transparency = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 1000) / 1000;
    const rendering = this.add('IFCSURFACESTYLERENDERING', [
      `#${colour}`, stepReal(transparency), '$', '$', '$', '$',
      'IFCNORMALISEDRATIOMEASURE(0.5)', 'IFCSPECULAREXPONENT(64.)', '.NOTDEFINED.',
    ]);
    const id = this.add('IFCSURFACESTYLE', [`'${esc(name)}'`, '.BOTH.', `(#${rendering})`]);
    this.styles.set(key, id);
    return id;
  }

  styled(solid: number, style: number): number {
    return this.add('IFCSTYLEDITEM', [`#${solid}`, `(#${style})`, '$']);
  }
}

// ── Openings in any element ──────────────────────────────────────────────────

export interface VoidSpec {
  /** The element to cut, by expressId. */
  hostId: number;
  name: string;
  /** Frame of the cut, relative to the HOST's placement: origin at the
   *  bottom-centre of the opening, `axis` the direction it cuts through,
   *  `refDirection` along the opening's width. */
  location: Vec3;
  axis: Vec3;
  refDirection: Vec3;
  /** Metres: across `refDirection`, up, and along `axis`. */
  width: number;
  height: number;
  depth: number;
}

/**
 * Cut `voids` into their hosts: an IfcOpeningElement each, related through
 * IfcRelVoidsElement — the same pair the library writes for a wall opening.
 * The opening is placed relative to the host, so a host that moves takes its
 * holes with it. A host that cannot be found is skipped, not guessed at.
 */
export function voidElements(text: string, voids: VoidSpec[]): string {
  if (voids.length === 0) return text;
  const refs = fileRefs(text);
  const w = new StepWriter(text);
  for (const v of voids) {
    const host = readEntity(text, v.hostId);
    const hostPlacement = host ? refsIn(host.args[5])[0] : undefined;
    if (!host || hostPlacement === undefined) continue;

    const placement = w.add('IFCLOCALPLACEMENT', [
      `#${hostPlacement}`, `#${w.axis2(v.location, v.axis, v.refDirection)}`,
    ]);
    // The rectangle stands on the origin: centred across, rising from it.
    const solid = w.box({ cx: 0, cy: v.height / 2, z0: 0, w: v.width, h: v.height, depth: v.depth });
    const rep = w.add('IFCSHAPEREPRESENTATION', [`#${refs.bodyContext}`, "'Body'", "'SweptSolid'", `(#${solid})`]);
    const shape = w.add('IFCPRODUCTDEFINITIONSHAPE', ['$', '$', `(#${rep})`]);
    const opening = w.add('IFCOPENINGELEMENT', [
      `'${ifcGuid()}'`, `#${refs.ownerHistory}`, `'${esc(v.name)}'`, '$', '$',
      `#${placement}`, `#${shape}`, '$', '.OPENING.',
    ]);
    w.add('IFCRELVOIDSELEMENT', [
      `'${ifcGuid()}'`, `#${refs.ownerHistory}`, '$', '$', `#${v.hostId}`, `#${opening}`,
    ]);
  }
  return w.apply();
}

// ── Holes through an extruded profile ────────────────────────────────────────

export interface ProfileVoidSpec {
  /** The element whose extruded body gets the holes, by expressId. */
  elementId: number;
  /**
   * The holes, each a ring in the SAME profile plane and units as the
   * element's outer curve (metres, relative to the profile origin). Not
   * closed — the closing point is written here.
   */
  holes: [number, number][][];
}

/**
 * Turn the element's IfcArbitraryClosedProfileDef into an
 * IfcArbitraryProfileDefWithVoids carrying `holes` as inner curves.
 *
 * `@ifc-lite/create` writes outer curves only, so a face with holes goes out
 * as its outline and gets its voids here, on the text: the profile keeps its
 * id and its outer curve, so every reference to it stays valid, and one new
 * closed IfcPolyline per hole is appended. The entity exists in IFC2X3 and
 * IFC4 alike. Every extruded solid of the element's Body is treated — a swept
 * run exported segment by segment shares the one profile shape.
 */
export function profileVoids(text: string, specs: ProfileVoidSpec[]): string {
  const withHoles = specs.filter((s) => s.holes.some((h) => h.length >= 3));
  if (withHoles.length === 0) return text;
  const w = new StepWriter(text);
  const rewrite = new Map<number, string>();

  for (const spec of withHoles) {
    const element = readEntity(text, spec.elementId);
    const shape = element ? readEntity(text, refsIn(element.args[6])[0]) : null;
    if (!shape) continue;
    for (const repId of refsIn(shape.args[2])) {
      const rep = readEntity(text, repId);
      if (!rep || rep.type !== 'IFCSHAPEREPRESENTATION') continue;
      for (const solidId of refsIn(rep.args[3])) {
        const solid = readEntity(text, solidId);
        if (!solid || solid.type !== 'IFCEXTRUDEDAREASOLID') continue;
        const profileId = refsIn(solid.args[0])[0];
        const profile = profileId === undefined ? null : readEntity(text, profileId);
        if (!profile || profile.type !== 'IFCARBITRARYCLOSEDPROFILEDEF' || rewrite.has(profile.id)) continue;
        const inner = spec.holes.filter((h) => h.length >= 3).map((h) => {
          const pts = h.map(([x, y]) => w.point2(x, y));
          return w.add('IFCPOLYLINE', [`(${[...pts, pts[0]].map((id) => `#${id}`).join(',')})`]);
        });
        // ProfileType, ProfileName, OuterCurve — then the inner curves.
        rewrite.set(profile.id,
          `#${profile.id}=IFCARBITRARYPROFILEDEFWITHVOIDS(${profile.args[0]},${profile.args[1]},${profile.args[2]},(${inner.map((id) => `#${id}`).join(',')}));`);
      }
    }
  }
  if (rewrite.size === 0) return text;
  return w.apply().split('\n').map((line) => {
    const m = STEP_LINE.exec(line.trim());
    return m ? rewrite.get(parseInt(m[1], 10)) ?? line : line;
  }).join('\n');
}

// ── Clipping an element's body with a plane ──────────────────────────────────

export interface ClipSpec {
  /** The element whose Body representation is cut, by expressId. */
  hostId: number;
  /**
   * A point on the cutting plane, in the HOST's own local frame. Metres.
   *
   * For a wall from `addIfcWall` that frame is: origin at `Start`, X along the
   * axis toward `End`, Y = Z × X (left of the run), Z up from the storey.
   */
  location: Vec3;
  /** The plane's normal, host-local. The half-space it points INTO is removed. */
  normal: Vec3;
}

/**
 * `AgreementFlag` on IfcHalfSpaceSolid.
 *
 * TRUE selects the half-space on the side the base surface's normal points
 * AWAY from — so with the plane's Z set to `ClipSpec.normal`, TRUE would keep
 * the material we mean to drop. FALSE is therefore what makes `normal` read
 * as "this side goes". Verified by tessellating the result rather than from
 * the specification's wording, which is easy to read either way round.
 */
const CLIP_AGREEMENT = '.F.';

/**
 * Cut each host's Body solid with its planes.
 *
 * The library writes a wall as a rectangle swept up — the one shape that can
 * host `IfcOpeningElement`s, and the reason a mitred corner cannot simply be
 * exported as its true quadrilateral footprint. IFC's own answer is to keep
 * the swept solid and subtract a half-space from it, which is what this does:
 * `IfcBooleanClippingResult(.DIFFERENCE., body, IfcHalfSpaceSolid)`, chained
 * once per plane, with the representation retyped from 'SweptSolid' to 'CSG'.
 *
 * The host's placement, openings, material and styling are untouched — only
 * the Body representation's items change, so everything hung off the wall
 * still hangs off it.
 */
export function clipElements(text: string, clips: ClipSpec[]): string {
  if (clips.length === 0) return text;

  const byHost = new Map<number, ClipSpec[]>();
  for (const c of clips) {
    const arr = byHost.get(c.hostId);
    if (arr) arr.push(c); else byHost.set(c.hostId, [c]);
  }

  const w = new StepWriter(text);
  /** repId → the items that representation should point at afterwards. */
  const newItems = new Map<number, number[]>();

  for (const [hostId, planes] of byHost) {
    const element = readEntity(text, hostId);
    const shape = element ? readEntity(text, refsIn(element.args[6])[0]) : null;
    if (!element || !shape || shape.type !== 'IFCPRODUCTDEFINITIONSHAPE') continue;

    // A product may carry an 'Axis' representation as well as the solid; only
    // the body is geometry, and clipping the axis line would be meaningless.
    const rep = refsIn(shape.args[2])
      .map((id) => readEntity(text, id))
      .find((r) => r !== null && r.type === 'IFCSHAPEREPRESENTATION' && r.args[1] === "'Body'");
    if (!rep) continue;

    const items = refsIn(rep.args[3]);
    if (items.length === 0) continue;

    newItems.set(rep.id, items.map((item) => {
      let cur = item;
      for (const p of planes) {
        const plane = w.add('IFCPLANE', [`#${w.axis2(p.location, p.normal)}`]);
        const half = w.add('IFCHALFSPACESOLID', [`#${plane}`, CLIP_AGREEMENT]);
        cur = w.add('IFCBOOLEANCLIPPINGRESULT', ['.DIFFERENCE.', `#${cur}`, `#${half}`]);
      }
      return cur;
    }));
  }

  if (newItems.size === 0) return text;

  return w.apply().split('\n').map((line) => {
    const m = STEP_LINE.exec(line.trim());
    if (!m) return line;
    const items = newItems.get(parseInt(m[1], 10));
    if (!items) return line;
    const args = tokeniseArgs(m[3]);
    // A boolean result is no longer a swept solid, and a viewer that trusts
    // RepresentationType would stop reading the body if this stayed as it was.
    args[2] = "'CSG'";
    args[3] = `(${items.map((id) => `#${id}`).join(',')})`;
    return `#${m[1]}=${m[2].toUpperCase()}(${args.join(',')});`;
  }).join('\n');
}

// ── Windows and doors with a frame ───────────────────────────────────────────

export interface FillSpec {
  /** The IfcWindow / IfcDoor the library wrote, by expressId. */
  elementId: number;
  kind: 'window' | 'door';
  /** Opening size and how deep the frame runs into the wall, metres. */
  width: number;
  height: number;
  depth: number;
  /** Stile and rail width, metres. */
  profile: number;
  double: boolean;
  frame: Rgb;
  /** Glass for a window, leaf for a door. */
  panel: Rgb;
  panelOpacity: number;
}

/** The mullion between two leaves or two panes, metres. As drawn in 3D. */
export const MULLION_M = 0.10;
export const GLASS_M = 0.008;
export const LEAF_M = 0.04;

/**
 * The parts of a fill in its own frame (x along the wall, y up from the
 * sill, z into the wall): the same boxes `buildOpeningMeshes3` draws, so the
 * file and the 3D view agree part for part. A fill too small to hold a
 * frame is one panel filling the opening rather than nothing.
 */
export function fillParts(f: FillSpec): Array<{ box: LocalBox; part: 'frame' | 'panel' }> {
  const { width: W, height: H, depth: d, profile: P } = f;
  const isDoor = f.kind === 'door';
  const t = isDoor ? LEAF_M : GLASS_M;
  const rails = isDoor ? 1 : 2;              // a door has no bottom rail
  const innerW = W - 2 * P;
  const innerH = H - rails * P;
  if (!(innerW > 0.01) || !(innerH > 0.01)) {
    return [{ box: { cx: 0, cy: H / 2, z0: 0, w: W, h: H, depth: d }, part: 'panel' }];
  }
  const parts: Array<{ box: LocalBox; part: 'frame' | 'panel' }> = [
    { box: { cx: -W / 2 + P / 2, cy: H / 2, z0: 0, w: P, h: H, depth: d }, part: 'frame' },
    { box: { cx: W / 2 - P / 2, cy: H / 2, z0: 0, w: P, h: H, depth: d }, part: 'frame' },
    { box: { cx: 0, cy: H - P / 2, z0: 0, w: innerW, h: P, depth: d }, part: 'frame' },
  ];
  if (!isDoor) parts.push({ box: { cx: 0, cy: P / 2, z0: 0, w: innerW, h: P, depth: d }, part: 'frame' });
  const base = isDoor ? 0 : P;
  if (f.double) {
    parts.push({ box: { cx: 0, cy: base + innerH / 2, z0: 0, w: MULLION_M, h: innerH, depth: d }, part: 'frame' });
    const leafW = (innerW - MULLION_M) / 2 - 0.005;
    for (const side of [-1, 1]) {
      parts.push({
        box: { cx: side * (leafW / 2 + MULLION_M / 2 + 0.002), cy: base + innerH / 2, z0: d / 2 - t / 2, w: leafW, h: innerH, depth: t },
        part: 'panel',
      });
    }
  } else {
    parts.push({ box: { cx: 0, cy: base + innerH / 2, z0: d / 2 - t / 2, w: innerW, h: innerH, depth: t }, part: 'panel' });
  }
  return parts;
}

/**
 * Swap each fill's single box for the parts above. The element's own
 * representation is pointed at the new solids; the old solid, its profile
 * and placements are removed once nothing references them, as is the styled
 * item the library attached to it. Anything else about the element — its
 * placement, its opening, its material — is untouched.
 */
export function replaceFillGeometry(text: string, fills: FillSpec[]): string {
  if (fills.length === 0) return text;
  const refs = fileRefs(text);
  const w = new StepWriter(text);
  const repItems = new Map<number, number[]>();
  const orphaned = new Set<number>();
  const dropStyled = new Set<number>();

  for (const f of fills) {
    const element = readEntity(text, f.elementId);
    const shape = element ? readEntity(text, refsIn(element.args[6])[0]) : null;
    const rep = shape ? readEntity(text, refsIn(shape.args[2])[0]) : null;
    if (!element || !shape || !rep || rep.type !== 'IFCSHAPEREPRESENTATION') continue;

    for (const solid of refsIn(rep.args[3])) {
      const s = readEntity(text, solid);
      if (!s) continue;
      orphaned.add(solid);
      // Its profile, the profile's placement and point; its own placement and point.
      const profile = readEntity(text, refsIn(s.args[0])[0]);
      if (profile) {
        orphaned.add(profile.id);
        const p2 = readEntity(text, refsIn(profile.args[2])[0]);
        if (p2) { orphaned.add(p2.id); refsIn(p2.args[0]).forEach((id) => orphaned.add(id)); }
      }
      const position = readEntity(text, refsIn(s.args[1])[0]);
      if (position) { orphaned.add(position.id); refsIn(position.args[0]).forEach((id) => orphaned.add(id)); }
      findEntities(text, (e) => e.type === 'IFCSTYLEDITEM' && refsIn(e.args[0])[0] === solid)
        .forEach((e) => dropStyled.add(e.id));
    }

    const frameStyle = w.style(f.kind === 'door' ? 'Door frame' : 'Window frame', f.frame);
    const panelName = f.kind === 'door' ? 'Door leaf' : 'Glass';
    const panelStyle = w.style(
      f.panelOpacity < 1 ? `${panelName} ${Math.round(f.panelOpacity * 100)}%` : panelName,
      f.panel, f.panelOpacity,
    );
    const solids = fillParts(f).map(({ box, part }) => {
      const id = w.box(box);
      w.styled(id, part === 'frame' ? frameStyle : panelStyle);
      return id;
    });
    repItems.set(rep.id, solids);
    void refs;
  }

  let out = w.apply();
  // Point each representation at its new solids.
  out = out.split('\n').map((line) => {
    const m = STEP_LINE.exec(line.trim());
    if (!m) return line;
    const items = repItems.get(parseInt(m[1], 10));
    if (!items) return line;
    const args = tokeniseArgs(m[3]);
    args[3] = `(${items.map((id) => `#${id}`).join(',')})`;
    return `#${m[1]}=${m[2].toUpperCase()}(${args.join(',')});`;
  }).join('\n');
  out = removeEntities(out, dropStyled);
  return removeUnreferenced(out, orphaned);
}

// ── Tessellated bodies ───────────────────────────────────────────────────────

/**
 * An element whose body is one or more closed triangle solids — a shape no
 * extrusion can make, like the eyebrow dormer's hood. Points are in metres,
 * in the element's own placement frame.
 */
export interface MeshSpec {
  elementId: number;
  parts: Array<Array<[Vec3, Vec3, Vec3]>>;
  /**
   * A look per part (parallel to `parts`) — a library window's glass and its
   * frame are different materials. Absent, every part takes the style the
   * exporter gave the element.
   */
  looks?: Array<{ name: string; rgb: Rgb; opacity: number } | null>;
}

/**
 * Replace the placeholder body `@ifc-lite/create` wrote for each element with
 * faceted B-reps, one per closed part (IfcFacetedBrep exists in IFC2X3 and
 * IFC4 alike). The style the exporter gave the placeholder carries over to
 * every part, so colour and transparency stay what `paint` decided.
 */
export function replaceWithMeshes(text: string, specs: MeshSpec[]): string {
  if (specs.length === 0) return text;
  const w = new StepWriter(text);
  const repItems = new Map<number, number[]>();
  const orphaned = new Set<number>();
  const dropStyled = new Set<number>();

  for (const spec of specs) {
    const element = readEntity(text, spec.elementId);
    const shape = element ? readEntity(text, refsIn(element.args[6])[0]) : null;
    const rep = shape ? readEntity(text, refsIn(shape.args[2])[0]) : null;
    if (!element || !shape || !rep || rep.type !== 'IFCSHAPEREPRESENTATION') continue;

    let styles: string | null = null;
    for (const solid of refsIn(rep.args[3])) {
      const s = readEntity(text, solid);
      if (!s) continue;
      orphaned.add(solid);
      const profile = readEntity(text, refsIn(s.args[0])[0]);
      if (profile) {
        orphaned.add(profile.id);
        // The placeholder's outline: its polyline and the polyline's points.
        for (const id of refsIn(profile.args[2])) {
          orphaned.add(id);
          const curve = readEntity(text, id);
          if (curve) refsIn(curve.args[0]).forEach((pt) => orphaned.add(pt));
        }
      }
      const position = readEntity(text, refsIn(s.args[1])[0]);
      if (position) { orphaned.add(position.id); refsIn(position.args[0]).forEach((id) => orphaned.add(id)); }
      for (const e of findEntities(text, (x) => x.type === 'IFCSTYLEDITEM' && refsIn(x.args[0])[0] === solid)) {
        styles = styles ?? e.args[1];
        dropStyled.add(e.id);
      }
    }

    const breps = spec.parts.map((tris, partIdx) => ({ tris, look: spec.looks?.[partIdx] ?? null }))
      .filter(({ tris }) => tris.length >= 4).map(({ tris, look }) => {
      const pointIds = new Map<string, number>();
      const pid = (p: Vec3) => {
        const key = p.map((c) => c.toFixed(6)).join(',');
        let id = pointIds.get(key);
        if (id === undefined) { id = w.point3(p); pointIds.set(key, id); }
        return id;
      };
      const faces = tris.map((t) => {
        const loop = w.add('IFCPOLYLOOP', [`(${t.map((p) => `#${pid(p)}`).join(',')})`]);
        const bound = w.add('IFCFACEOUTERBOUND', [`#${loop}`, '.T.']);
        return w.add('IFCFACE', [`(#${bound})`]);
      });
      const shell = w.add('IFCCLOSEDSHELL', [`(${faces.map((f) => `#${f}`).join(',')})`]);
      const brep = w.add('IFCFACETEDBREP', [`#${shell}`]);
      if (look) w.styled(brep, w.style(look.name, look.rgb, look.opacity));
      else if (styles) w.add('IFCSTYLEDITEM', [`#${brep}`, styles, '$']);
      return brep;
    });
    if (breps.length) repItems.set(rep.id, breps);
  }

  let out = w.apply();
  out = out.split('\n').map((line) => {
    const m = STEP_LINE.exec(line.trim());
    if (!m) return line;
    const items = repItems.get(parseInt(m[1], 10));
    if (!items) return line;
    const args = tokeniseArgs(m[3]);
    args[2] = "'Brep'";
    args[3] = `(${items.map((id) => `#${id}`).join(',')})`;
    return `#${m[1]}=${m[2].toUpperCase()}(${args.join(',')});`;
  }).join('\n');
  out = removeEntities(out, dropStyled);
  return removeUnreferenced(out, orphaned);
}
