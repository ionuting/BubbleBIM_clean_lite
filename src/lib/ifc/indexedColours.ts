/**
 * indexedColours.ts — the colours an IFC4 file gives its tessellated geometry
 * through IfcIndexedColourMap, which web-ifc does not read.
 *
 * IFC has two ways to colour geometry. The classic one is an IfcStyledItem
 * pointing at a surface style; web-ifc reads it and fragments carries it as
 * the sample's material. The IFC4 one is an IfcIndexedColourMap attached to
 * an IfcTriangulatedFaceSet / IfcPolygonalFaceSet, giving each face an index
 * into an IfcColourRgbList. Revit writes its IFC4 exports this way, and
 * web-ifc 0.0.77 ignores it: every such body arrives in the default grey,
 * in the TOC viewer and in everything built from the fragments model.
 *
 * This reads the colour maps off the file's text and says, for each product,
 * which colour each of its bodies should have — in the order web-ifc emits
 * them, so the caller can pair them with the fragments samples one to one:
 * the product's Body representations in order, their items in order, an
 * IfcMappedItem expanded in place to the items of the representation it maps.
 *
 * A map can give different faces different colours; a sample has one
 * material, so the colour covering the most faces wins. Opacity comes from
 * the map's own Opacity attribute.
 *
 * Pure text processing, like the rest of the STEP layer — no wasm.
 */

import { inner, ref, tokeniseArgs, unquote } from './stepText';

/** A body's colour: 0–1 sRGB channels, 0–1 opacity. */
export interface BodyColour {
  rgb: [number, number, number];
  opacity: number;
}

/** One body of a product, in web-ifc's order; `colour` is null when no map colours it. */
export interface ProductBody {
  /** The representation item (face set, extrusion, …) the body comes from. */
  item: number;
  colour: BodyColour | null;
}

/** Representation identifiers that are not the 3D body; web-ifc skips them. */
const NOT_BODY = new Set(['AXIS', 'BOX', 'FOOTPRINT', 'ANNOTATION', 'PROFILE', 'CLEARANCE', 'SURFACE', 'LIGHTSOURCE', 'REFERENCE']);

/**
 * Every entity as id → [TYPE, argument text], cut on top-level `;` so an
 * entity written over several lines reads the same as one on a single line.
 */
function scanEntities(text: string): Map<number, [string, string]> {
  const out = new Map<number, [string, string]>();
  const data = text.indexOf('DATA;');
  let i = data < 0 ? 0 : data + 5;
  const n = text.length;
  while (i < n) {
    const hash = text.indexOf('#', i);
    if (hash < 0) break;
    // Find the end of this entity: the first `;` outside a string.
    let j = hash;
    let inStr = false;
    for (; j < n; j++) {
      const c = text.charCodeAt(j);
      if (c === 39) inStr = !inStr;          // '
      else if (c === 59 && !inStr) break;    // ;
    }
    const stmt = text.slice(hash, j);
    i = j + 1;
    const eq = stmt.indexOf('=');
    const paren = stmt.indexOf('(', eq);
    if (eq < 0 || paren < 0) continue;
    const id = parseInt(stmt.slice(1, eq), 10);
    if (Number.isNaN(id)) continue;
    const type = stmt.slice(eq + 1, paren).trim().toUpperCase();
    const close = stmt.lastIndexOf(')');
    out.set(id, [type, stmt.slice(paren + 1, close < 0 ? stmt.length : close)]);
  }
  return out;
}

/** `(#1,#2,#3)` → [1, 2, 3]. */
function refList(s: string | undefined): number[] {
  if (!s) return [];
  return tokeniseArgs(inner(s)).map(ref).filter((v): v is number => v !== null);
}

/** `((0.1,0.2,0.3),(…))` → [[0.1,0.2,0.3], …]. */
function colourList(s: string | undefined): [number, number, number][] {
  if (!s) return [];
  return tokeniseArgs(inner(s)).map((t) => {
    const [r, g, b] = tokeniseArgs(inner(t)).map((v) => parseFloat(v));
    return [r, g, b].map((v) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0)) as [number, number, number];
  });
}

/**
 * Per product express id, its bodies in web-ifc's order. Products whose
 * bodies no colour map touches are left out, so an empty map means there
 * is nothing to correct.
 */
export function readIndexedColours(text: string): Map<number, ProductBody[]> {
  const result = new Map<number, ProductBody[]>();
  // Most files carry no colour maps at all; do not scan them.
  if (!/IFCINDEXEDCOLOURMAP\s*\(/i.test(text)) return result;

  const ents = scanEntities(text);

  // ── Face set → colour ──────────────────────────────────────────────────────
  // IfcIndexedColourMap(MappedTo, Opacity, Colours, ColourIndex)
  const colourOf = new Map<number, BodyColour>();
  for (const [, [type, args]] of ents) {
    if (type !== 'IFCINDEXEDCOLOURMAP') continue;
    const a = tokeniseArgs(args);
    const faceSet = ref(a[0] ?? '');
    const list = ents.get(ref(a[2] ?? '') ?? -1);
    if (faceSet === null || !list || list[0] !== 'IFCCOLOURRGBLIST') continue;
    const colours = colourList(tokeniseArgs(list[1])[0]);
    if (colours.length === 0) continue;
    // The colour on the most faces; a sample has one material.
    const counts = new Array(colours.length).fill(0);
    for (const t of tokeniseArgs(inner(a[3] ?? ''))) {
      const k = parseInt(t, 10) - 1;
      if (k >= 0 && k < counts.length) counts[k]++;
    }
    let best = 0;
    for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
    const op = parseFloat(a[1] ?? '');
    colourOf.set(faceSet, { rgb: colours[best], opacity: Number.isFinite(op) ? Math.min(Math.max(op, 0), 1) : 1 });
  }
  if (colourOf.size === 0) return result;

  // ── Representation → items, mapped items expanded ──────────────────────────
  const itemsOfRep = (repId: number, depth: number): number[] => {
    const rep = ents.get(repId);
    if (!rep || depth > 8) return [];
    // IfcShapeRepresentation(ContextOfItems, RepresentationIdentifier, RepresentationType, Items)
    const a = tokeniseArgs(rep[1]);
    const out: number[] = [];
    for (const it of refList(a[3])) {
      const e = ents.get(it);
      if (e?.[0] === 'IFCMAPPEDITEM') {
        // IfcMappedItem(MappingSource, MappingTarget) → IfcRepresentationMap(MappingOrigin, MappedRepresentation)
        const map = ents.get(ref(tokeniseArgs(e[1])[0] ?? '') ?? -1);
        const mapped = map ? ref(tokeniseArgs(map[1])[1] ?? '') : null;
        if (mapped !== null) out.push(...itemsOfRep(mapped, depth + 1));
      } else {
        out.push(it);
      }
    }
    return out;
  };

  // ── Product → bodies ───────────────────────────────────────────────────────
  // Every IfcProduct has Representation as its 7th attribute; find the ones
  // pointing at an IfcProductDefinitionShape rather than naming each class.
  for (const [id, [type, args]] of ents) {
    if (!type.startsWith('IFC') || type === 'IFCPRODUCTDEFINITIONSHAPE') continue;
    const a = tokeniseArgs(args);
    if (a.length < 7) continue;
    const pdsId = ref(a[6] ?? '');
    const pds = pdsId === null ? undefined : ents.get(pdsId);
    if (!pds || pds[0] !== 'IFCPRODUCTDEFINITIONSHAPE') continue;

    const bodies: ProductBody[] = [];
    for (const repId of refList(tokeniseArgs(pds[1])[2])) {
      const rep = ents.get(repId);
      if (!rep || rep[0] !== 'IFCSHAPEREPRESENTATION') continue;
      const ident = unquote(tokeniseArgs(rep[1])[1] ?? '').toUpperCase();
      if (NOT_BODY.has(ident)) continue;
      for (const item of itemsOfRep(repId, 0)) bodies.push({ item, colour: colourOf.get(item) ?? null });
    }
    if (bodies.some((b) => b.colour)) result.set(id, bodies);
  }
  return result;
}

/**
 * Products grouped by the colour most of their mapped bodies have — for a
 * viewer that can colour whole elements only (fragments' `setColor`), not
 * single bodies. Bodies no map colours do not vote.
 */
export function productsByColour(bodies: Map<number, ProductBody[]>): { colour: BodyColour; ids: number[] }[] {
  const groups = new Map<string, { colour: BodyColour; ids: number[] }>();
  for (const [id, list] of bodies) {
    const votes = new Map<string, { colour: BodyColour; n: number }>();
    for (const b of list) {
      if (!b.colour) continue;
      const key = `${b.colour.rgb.join(',')}|${b.colour.opacity}`;
      const v = votes.get(key);
      if (v) v.n++; else votes.set(key, { colour: b.colour, n: 1 });
    }
    let best: { key: string; colour: BodyColour; n: number } | null = null;
    for (const [key, v] of votes) if (!best || v.n > best.n) best = { key, ...v };
    if (!best) continue;
    const g = groups.get(best.key);
    if (g) g.ids.push(id); else groups.set(best.key, { colour: best.colour, ids: [id] });
  }
  return [...groups.values()];
}
