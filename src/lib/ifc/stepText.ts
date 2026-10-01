/**
 * stepText.ts — the STEP (ISO 10303-21) text layer shared by everything that
 * reads or edits an IFC file as text.
 *
 * Lifted out of `ifcStepParser.ts` so the georeferencing writer works on the
 * same tokens the reader does. A second tokeniser would be a second set of
 * quirks — and the quirks are the whole job here: commas inside strings,
 * commas inside nested lists, and `\X2\…\X0\` escapes all look like argument
 * separators until you handle them.
 */

/** `#12=IFCWALL(...);` → id, type, argument text. */
export const STEP_LINE_RE = /^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\((.*)\)\s*;?\s*$/i;

/**
 * Split an entity's argument text on top-level commas only — not on commas
 * inside quoted strings or inside nested `(...)` lists.
 */
export function tokeniseArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inStr) { inStr = true; }
    else if (c === "'" && inStr) { inStr = false; }
    else if (!inStr) {
      if      (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        args.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const last = s.slice(start).trim();
  if (last) args.push(last);
  return args;
}

/** Strip the quotes and flatten `\X2\…\X0\` unicode escapes to '?'. */
export function unquote(s: string): string {
  s = s.trim();
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  return s.replace(/\\X2\\[0-9A-Fa-f]+\\X0\\/g, '?');
}

/** `#42` → 42; anything else → null. */
export function ref(s: string): number | null {
  const t = s.trim();
  if (!t.startsWith('#')) return null;
  const n = parseInt(t.slice(1), 10);
  return Number.isNaN(n) ? null : n;
}

/** A STEP real/integer → number, with 0 for `$`, `*` and junk. */
export function flt(s: string): number {
  const n = parseFloat(s.trim());
  return Number.isNaN(n) ? 0 : n;
}

/** Drop one layer of `( … )`, leaving the list's contents. */
export function inner(s: string): string {
  const t = s.trim();
  return t.startsWith('(') && t.endsWith(')') ? t.slice(1, -1) : t;
}

/**
 * Format a number the way a STEP file wants it: a real always carries a
 * decimal point, so `85` must be written `85.` or strict readers take it as an
 * integer and reject it where a REAL is required.
 */
export function stepReal(v: number): string {
  if (!Number.isFinite(v)) return '0.';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return `${v}.`;
  // Avoid exponent forms like 1e-7, which some readers choke on; 9 decimals is
  // a nanometre in metres and a micro-arcsecond in degrees.
  const s = v.toFixed(9).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
}

/** Highest `#id` in the file — where to continue numbering when appending. */
export function maxEntityId(text: string): number {
  let max = 0;
  const re = /^#(\d+)\s*=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = parseInt(m[1], 10);
    if (id > max) max = id;
  }
  return max;
}

/**
 * Rewrite one entity's arguments in place.
 *
 * `edit` receives the tokenised arguments and mutates or returns them. Only
 * the FIRST instance of `type` is touched — every caller here works on
 * singletons (IfcSite, the model context), and quietly rewriting a second one
 * would be worse than not finding it.
 *
 * Returns the text unchanged when the entity is absent.
 */
export function editEntityArgs(
  text: string,
  type: string,
  edit: (args: string[]) => string[] | void,
): string {
  const upper = type.toUpperCase();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = STEP_LINE_RE.exec(lines[i].trim());
    if (!m || m[2].toUpperCase() !== upper) continue;
    const args = tokeniseArgs(m[3]);
    const next = edit(args) ?? args;
    lines[i] = `#${m[1]}=${m[2].toUpperCase()}(${next.join(',')});`;
    return lines.join('\n');
  }
  return text;
}

/**
 * Rewrite the arguments of the entity with exactly this `#id`.
 *
 * The by-type variant above only ever touches the first instance; this one
 * is for following a reference — an IfcMapConversion names WHICH
 * IfcProjectedCRS it targets, and a file may carry more than one.
 */
export function editEntityById(
  text: string,
  id: number,
  edit: (type: string, args: string[]) => string[] | void,
): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = STEP_LINE_RE.exec(lines[i].trim());
    if (!m || parseInt(m[1], 10) !== id) continue;
    const args = tokeniseArgs(m[3]);
    const next = edit(m[2].toUpperCase(), args) ?? args;
    lines[i] = `#${m[1]}=${m[2].toUpperCase()}(${next.join(',')});`;
    return lines.join('\n');
  }
  return text;
}

/**
 * The schema family a file declares in its header — `FILE_SCHEMA(('IFC4X3_ADD2'))`
 * → 'IFC4X3'. Defaults to IFC4 when the header is missing or odd, which is the
 * safer guess: writing IfcMapConversion into a file that cannot hold it costs
 * nothing, omitting it from one that can loses the georeference.
 */
export function detectIfcSchema(text: string): 'IFC2X3' | 'IFC4' | 'IFC4X3' {
  const m = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(text.slice(0, 4000));
  const s = (m?.[1] ?? '').toUpperCase();
  if (s.startsWith('IFC2X3')) return 'IFC2X3';
  if (s.startsWith('IFC4X3')) return 'IFC4X3';
  return 'IFC4';
}

/** The `#id` of the first entity of `type`, or null. */
export function findEntityId(text: string, type: string): number | null {
  const upper = type.toUpperCase();
  for (const line of text.split('\n')) {
    const m = STEP_LINE_RE.exec(line.trim());
    if (m && m[2].toUpperCase() === upper) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Insert entity lines just before `ENDSEC;` that closes DATA.
 *
 * Appending at the end of the DATA section is always legal: STEP is a graph
 * addressed by id, not an ordered document, so a forward reference from an
 * earlier line to a later one is fine.
 */
export function appendEntities(text: string, lines: string[]): string {
  if (!lines.length) return text;
  const block = lines.join('\n');
  const idx = text.lastIndexOf('ENDSEC;');
  if (idx < 0) return `${text}\n${block}\n`;
  return `${text.slice(0, idx)}${block}\n${text.slice(idx)}`;
}
