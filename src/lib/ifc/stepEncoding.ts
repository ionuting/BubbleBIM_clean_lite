/**
 * stepEncoding.ts — two fixes to the STEP text `@ifc-lite/create` writes.
 *
 * 1. Strings. ISO 10303-21 files are 7-bit: a character outside ASCII has to
 *    be written as a `\X2\…\X0\` escape (UTF-16, four hex digits per unit).
 *    The library writes UTF-8 bytes as they are, so "Stâlp prispă" reaches
 *    IfcOpenShell as "Stlp prisp" — every Romanian name, material and room
 *    label loses its diacritics, or worse, in any tool that reads by the
 *    standard. web-ifc decodes both, which is why the viewers never showed it.
 *
 * 2. Quantities. IFC4 gave `IfcPhysicalSimpleQuantity` a fifth attribute,
 *    `Formula`. The library writes the four-attribute IFC2X3 form in every
 *    schema, so each quantity of an IFC4 file fails schema validation.
 *
 * Both are text passes over the finished file, like the other post-passes in
 * `buildIfcModel`: nothing is re-numbered, only the lines concerned change.
 */

/** Non-ASCII runs → `\X2\hhhh…\X0\` (and `\X4\` for characters beyond the BMP). */
export function encodeStepUnicode(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x00-\x7F]+/g, (run) => {
    let out = '';
    let bmp = '';
    let astral = '';
    const flush = () => {
      if (bmp) { out += `\\X2\\${bmp}\\X0\\`; bmp = ''; }
      if (astral) { out += `\\X4\\${astral}\\X0\\`; astral = ''; }
    };
    for (const ch of run) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0xffff) {
        if (bmp) flush();
        astral += cp.toString(16).toUpperCase().padStart(8, '0');
      } else {
        if (astral) flush();
        bmp += cp.toString(16).toUpperCase().padStart(4, '0');
      }
    }
    flush();
    return out;
  });
}

/** Top-level argument count of `A,B,(C,D),'E,F'` — commas in quotes and lists don't count. */
function countArgs(args: string): number {
  let depth = 0, n = 1, inStr = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (inStr) {
      if (c === "'") {
        if (args[i + 1] === "'") i++;
        else inStr = false;
      }
    } else if (c === "'") inStr = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

const QUANTITY_LINE = /^(#\d+\s*=\s*IFCQUANTITY(?:LENGTH|AREA|VOLUME|WEIGHT|COUNT|TIME|NUMBER)\()(.*)(\);\s*)$/gm;

/** Give every four-attribute quantity its IFC4 `Formula` (unset). IFC2X3 is left alone. */
export function addQuantityFormula(text: string, schema: string): string {
  if (!/^IFC4/i.test(schema)) return text;
  return text.replace(QUANTITY_LINE, (line, head: string, args: string, tail: string) =>
    (countArgs(args) === 4 ? `${head}${args},$${tail}` : line));
}
