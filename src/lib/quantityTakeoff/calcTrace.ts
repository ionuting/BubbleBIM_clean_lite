/**
 * calcTrace.ts — „urma de calcul" (provenance) pentru fiecare cantitate.
 *
 * Motorul de takeoff dă doar rezultatul (`quantity`, `source`). Pentru memoriul
 * de calcul (CalcPad) și pentru graful de calcul vizual avem nevoie de PAȘII prin
 * care s-a obținut cifra: formula simbolică → valorile substituite → rezultat.
 *
 * IMPORTANT: acest modul EXPLICĂ ce a calculat motorul, nu recalculează
 * independent. Valoarea numerică se obține exact ca în `takeoffEngine.evalFormula`
 * (același `new Function`), astfel încât cifrele să nu poată diverge de F3.
 */
import type {
  NodeMeasures,
  NormMappingOutput,
  NormUnit,
} from '@/lib/norms';

/** O mărime de intrare folosită într-un calcul. */
export interface CalcInput {
  /** Cheia din NodeMeasures, ex. "net_area_m2". */
  key: keyof NodeMeasures;
  /** Simbol afișat în formulă, ex. "A_net". */
  symbol: string;
  /** Etichetă lizibilă, ex. "Arie netă (fără goluri)". */
  label: string;
  value: number;
  /** Unitate de afișare, ex. "m²". */
  unit: string;
}

/** Urma completă a unui calcul (per nod × articol de normă). */
export interface CalcTrace {
  symbolic: string;    // "Q = A_net × t"
  substituted: string; // "Q = 12.50 × 0.20"
  result: number;
  unit: NormUnit;
  inputs: CalcInput[];
  /** Descriere a sursei geometrice (ex. „arie perete minus goluri"). */
  sourceLabel: string;
  /**
   * Expresie EDITABILĂ a formulei, în termeni de simbolurile intrărilor
   * (ex. "A_brut - A_gol", "A * t", "V"). Folosită de graful de calcul editabil.
   */
  editableFormula: string;
}

// ── Metadate mărimi (simbol + etichetă + unitate de afișare) ────────────────
interface MeasureMeta {
  symbol: string;
  label: string;
  unit: string;
}

const MEASURE_META: Record<keyof NodeMeasures, MeasureMeta> = {
  length_m: { symbol: 'L', label: 'Length', unit: 'm' },
  height_m: { symbol: 'H', label: 'Height', unit: 'm' },
  thickness_m: { symbol: 't', label: 'Thickness', unit: 'm' },
  width_m: { symbol: 'b', label: 'Width', unit: 'm' },
  depth_m: { symbol: 'd', label: 'Depth', unit: 'm' },
  gross_area_m2: { symbol: 'A_brut', label: 'Gross area', unit: 'm²' },
  net_area_m2: { symbol: 'A_net', label: 'Net area (excl. openings)', unit: 'm²' },
  area_m2: { symbol: 'A', label: 'Area', unit: 'm²' },
  perimeter_m: { symbol: 'P', label: 'Perimeter', unit: 'm' },
  section_m2: { symbol: 'A_s', label: 'Section area', unit: 'm²' },
  volume_m3: { symbol: 'V', label: 'Volume', unit: 'm³' },
  count: { symbol: 'n', label: 'Count', unit: 'pcs' },
  opening_area_m2: { symbol: 'A_gol', label: 'Opening area', unit: 'm²' },
};

/** Display unit for a norm unit. */
export function unitLabel(unit: NormUnit): string {
  switch (unit) {
    case 'mp': return 'm²';
    case 'mc': return 'm³';
    case 'ml': return 'm';
    case 'kg': return 'kg';
    case 'buc': return 'pcs';
    default: return unit;
  }
}

const NUM = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

function meta(key: keyof NodeMeasures): MeasureMeta {
  return MEASURE_META[key];
}

function input(key: keyof NodeMeasures, m: NodeMeasures): CalcInput {
  const md = meta(key);
  return { key, symbol: md.symbol, label: md.label, value: m[key], unit: md.unit };
}

/**
 * Identificatorii din NodeMeasures care apar într-o formulă (în ordinea apariției,
 * fără duplicate).
 */
function varsInFormula(formula: string): (keyof NodeMeasures)[] {
  const keys = Object.keys(MEASURE_META) as (keyof NodeMeasures)[];
  const found: (keyof NodeMeasures)[] = [];
  for (const key of keys) {
    // \b nu funcționează pe „_"; folosim lookaround pe caractere de identificator.
    const re = new RegExp(`(?<![\\w])${key}(?![\\w])`);
    if (re.test(formula) && !found.includes(key)) found.push(key);
  }
  return found;
}

/**
 * Evaluează o formulă cu URMĂ. Valoarea se calculează IDENTIC cu
 * `takeoffEngine.evalFormula` (același `new Function`), deci nu poate diverge.
 */
export function evalFormulaTraced(
  formula: string,
  m: NodeMeasures,
): { value: number; substituted: string; inputs: CalcInput[] } {
  const env: Record<string, number> = {
    length_m: m.length_m,
    height_m: m.height_m,
    thickness_m: m.thickness_m,
    width_m: m.width_m,
    depth_m: m.depth_m,
    gross_area_m2: m.gross_area_m2,
    net_area_m2: m.net_area_m2,
    area_m2: m.area_m2,
    perimeter_m: m.perimeter_m,
    section_m2: m.section_m2,
    volume_m3: m.volume_m3,
    count: m.count,
    opening_area_m2: m.opening_area_m2,
  };
  let value = 0;
  try {
    const keys = Object.keys(env);
    const vals = Object.values(env);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...keys, `'use strict'; return (${formula});`) as (...a: number[]) => number;
    const r = fn(...vals);
    value = typeof r === 'number' && isFinite(r) ? r : 0;
  } catch {
    value = 0;
  }

  const used = varsInFormula(formula);
  const inputs = used.map((k) => input(k, m));
  // Substituie fiecare identificator cu valoarea lui, păstrând operatorii.
  let substituted = formula;
  for (const k of used) {
    const re = new RegExp(`(?<![\\w])${k}(?![\\w])`, 'g');
    substituted = substituted.replace(re, NUM(m[k]));
  }
  return { value, substituted, inputs };
}

/**
 * Evaluează o expresie editabilă în termeni de simbolurile intrărilor
 * (ex. "A_brut - A_gol" cu A_brut, A_gol din `inputs`). Întoarce NaN la eroare.
 */
export function evalWithSymbols(formula: string, inputs: CalcInput[]): number {
  const names = inputs.map((i) => i.symbol);
  const vals = inputs.map((i) => i.value);
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...names, `'use strict'; return (${formula});`) as (...a: number[]) => number;
    const r = fn(...vals);
    return typeof r === 'number' && isFinite(r) ? r : NaN;
  } catch {
    return NaN;
  }
}

/** Simbolurile de formulă înlocuiesc cheile brute pentru afișare simbolică. */
function symbolicFromFormula(formula: string): string {
  let s = formula;
  for (const [key, md] of Object.entries(MEASURE_META)) {
    const re = new RegExp(`(?<![\\w])${key}(?![\\w])`, 'g');
    s = s.replace(re, md.symbol);
  }
  return s;
}

/**
 * Construiește urma de calcul a unui output de normă, oglindind exact logica din
 * `takeoffEngine.applyOutput`. Întoarce și `quantity` (identică cu motorul).
 */
export function traceForOutput(
  output: NormMappingOutput,
  m: NodeMeasures,
  unit: NormUnit,
): { quantity: number; source: string; trace: CalcTrace } {
  const u = unitLabel(unit);

  const simplu = (key: keyof NodeMeasures, sourceLabel: string): ReturnType<typeof traceForOutput> => {
    const inp = input(key, m);
    return {
      quantity: inp.value,
      source: sourceLabel,
      trace: {
        symbolic: `Q = ${inp.symbol}`,
        substituted: `Q = ${NUM(inp.value)}`,
        result: inp.value,
        unit,
        inputs: [inp],
        sourceLabel,
        editableFormula: inp.symbol,
      },
    };
  };

  switch (output.measure) {
    case 'length':
      return simplu('length_m', 'Developed length');
    case 'area': {
      if (output.netOfOpenings) {
        const a = input('net_area_m2', m);
        const g = input('opening_area_m2', m);
        return {
          quantity: a.value,
          source: 'net_area_m2 (excl. openings)',
          trace: {
            symbolic: `Q = ${a.symbol} = ${meta('gross_area_m2').symbol} − ${g.symbol}`,
            substituted: `Q = ${NUM(m.gross_area_m2)} − ${NUM(g.value)} = ${NUM(a.value)}`,
            result: a.value,
            unit,
            inputs: [input('gross_area_m2', m), g],
            sourceLabel: 'Wall area minus openings',
            editableFormula: `${meta('gross_area_m2').symbol} - ${g.symbol}`,
          },
        };
      }
      return simplu('area_m2', 'area_m2');
    }
    case 'volume':
      return simplu('volume_m3', 'Volume');
    case 'count':
      return simplu('count', 'Piece count');
    case 'opening_area':
      return simplu('opening_area_m2', 'Opening area');
    case 'formula': {
      const formula = output.formula ?? '0';
      const { value, substituted, inputs } = evalFormulaTraced(formula, m);
      return {
        quantity: value,
        source: formula,
        trace: {
          symbolic: `Q = ${symbolicFromFormula(formula)}`,
          substituted: `Q = ${substituted} = ${NUM(value)} ${u}`,
          result: value,
          unit,
          inputs,
          sourceLabel: 'Norm formula',
          editableFormula: symbolicFromFormula(formula),
        },
      };
    }
    default:
      return {
        quantity: 0,
        source: 'unknown',
        trace: {
          symbolic: 'Q = ?', substituted: 'Q = 0', result: 0, unit, inputs: [], sourceLabel: 'unknown',
          editableFormula: '0',
        },
      };
  }
}
