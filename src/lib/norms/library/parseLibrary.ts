/**
 * parseLibrary.ts — parser pentru fișierele `.md` ale librăriei.
 *
 * Format: frontmatter YAML simplu (`cheie: valoare`) + tabele markdown sub titluri
 * de secțiune. Fără dependențe externe, ca să ruleze identic în Node și în browser.
 *
 * Parserul e STRICT: orice rând invalid produce o eroare cu fișier + linie, în loc
 * să fie ignorat tăcut. Un rând de mapare pierdut = cantități lipsă din deviz, exact
 * genul de eșec invizibil pe care librăria trebuie să-l elimine.
 */
import type { NormUnit, MeasureKey } from '../types';
import {
  type LibraryArticle,
  type LibraryCategory,
  type LibraryMapping,
  type LibraryCatalogMeta,
  type PriceComponents,
  VALID_UNITS,
  VALID_MEASURES,
} from './types';

export interface ParseIssue {
  file: string;
  line: number;
  message: string;
}

export class LibraryParseError extends Error {
  constructor(public issues: ParseIssue[]) {
    super(
      `Librărie invalidă (${issues.length} ${issues.length === 1 ? 'problemă' : 'probleme'}):\n` +
        issues.map((i) => `  ${i.file}:${i.line} — ${i.message}`).join('\n'),
    );
    this.name = 'LibraryParseError';
  }
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

interface Frontmatter {
  data: Record<string, string>;
  /** Linia (1-based) la care începe corpul, după frontmatter. */
  bodyStartLine: number;
  body: string[];
}

function parseFrontmatter(lines: string[], file: string, issues: ParseIssue[]): Frontmatter {
  if (lines[0]?.trim() !== '---') {
    issues.push({ file, line: 1, message: 'lipsește frontmatter-ul (prima linie trebuie să fie `---`)' });
    return { data: {}, bodyStartLine: 1, body: lines };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) {
    issues.push({ file, line: 1, message: 'frontmatter neînchis (lipsește `---` de final)' });
    return { data: {}, bodyStartLine: 1, body: lines };
  }
  const data: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const idx = raw.indexOf(':');
    if (idx === -1) {
      issues.push({ file, line: i + 1, message: `linie de frontmatter invalidă: "${raw.trim()}"` });
      continue;
    }
    data[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  return { data, bodyStartLine: end + 2, body: lines.slice(end + 1) };
}

// ── Tabele markdown ─────────────────────────────────────────────────────────

interface TableRow {
  cells: string[];
  /** Linia absolută (1-based) în fișier. */
  line: number;
}

/** Rândurile de date ale tabelului aflat sub titlul `## <section>`. */
function findTable(
  body: string[],
  bodyStartLine: number,
  section: string,
): { header: string[]; rows: TableRow[] } | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const headIdx = body.findIndex((l) => l.trim().startsWith('##') && norm(l.replace(/^#+/, '')) === norm(section));
  if (headIdx === -1) return null;

  const rows: TableRow[] = [];
  let header: string[] | null = null;
  for (let i = headIdx + 1; i < body.length; i++) {
    const line = body[i];
    const t = line.trim();
    if (t.startsWith('##')) break;              // secțiunea următoare
    if (!t.startsWith('|')) continue;           // text între tabel și titlu
    const cells = splitRow(t);
    if (!header) { header = cells; continue; }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // separator
    rows.push({ cells, line: bodyStartLine + i });
  }
  return header ? { header, rows } : null;
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}

/** Valoarea unei coloane după nume (case-insensitive), sau '' dacă lipsește. */
function cell(header: string[], cells: string[], name: string): string {
  const i = header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  return i === -1 ? '' : (cells[i] ?? '').trim();
}

function num(raw: string): number | null {
  if (!raw) return null;
  const v = Number(raw.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

// ── Parsare categorie ───────────────────────────────────────────────────────

/** Parsează un fișier de categorie. Aruncă `LibraryParseError` dacă are probleme. */
export function parseCategoryMd(text: string, file: string): LibraryCategory {
  const issues: ParseIssue[] = [];
  const cat = parseCategoryMdCollecting(text, file, issues);
  if (issues.length > 0) throw new LibraryParseError(issues);
  return cat;
}

/** Ca `parseCategoryMd`, dar acumulează problemele în loc să arunce. */
export function parseCategoryMdCollecting(
  text: string,
  file: string,
  issues: ParseIssue[],
): LibraryCategory {
  const lines = text.split(/\r?\n/);
  const fm = parseFrontmatter(lines, file, issues);

  const categorie = fm.data.categorie ?? '';
  const capitol = fm.data.capitol ?? '';
  if (!categorie) issues.push({ file, line: 1, message: 'frontmatter: lipsește `categorie`' });
  if (!capitol) issues.push({ file, line: 1, message: 'frontmatter: lipsește `capitol`' });

  const articles: LibraryArticle[] = [];
  const mappings: LibraryMapping[] = [];

  // ── Articole ──
  const artTable = findTable(fm.body, fm.bodyStartLine, 'Articole');
  if (!artTable) {
    issues.push({ file, line: 1, message: 'lipsește secțiunea `## Articole`' });
  } else {
    for (const row of artTable.rows) {
      const normId = cell(artTable.header, row.cells, 'normId');
      const symbol = cell(artTable.header, row.cells, 'simbol');
      const denumire = cell(artTable.header, row.cells, 'denumire');
      const unitRaw = cell(artTable.header, row.cells, 'UM');
      if (!normId) { issues.push({ file, line: row.line, message: 'articol fără `normId`' }); continue; }
      if (!VALID_UNITS.includes(unitRaw as NormUnit)) {
        issues.push({ file, line: row.line, message: `UM invalidă "${unitRaw}" (permise: ${VALID_UNITS.join(', ')})` });
        continue;
      }
      const parts = ['material', 'manoperă', 'utilaj', 'transport'].map((k) => num(cell(artTable.header, row.cells, k)));
      const price: PriceComponents | undefined = parts.every((p) => p !== null)
        ? { material: parts[0]!, manopera: parts[1]!, utilaj: parts[2]!, transport: parts[3]! }
        : undefined;
      if (parts.some((p) => p !== null) && price === undefined) {
        issues.push({ file, line: row.line, message: `preț incomplet pentru ${normId} — completează material/manoperă/utilaj/transport sau lasă-le goale` });
      }
      articles.push({ normId, symbol: symbol || normId, denumire, unit: unitRaw as NormUnit, price });
    }
  }

  // ── Mapări BIM ──
  const mapTable = findTable(fm.body, fm.bodyStartLine, 'Mapări BIM');
  if (mapTable) {
    for (const row of mapTable.rows) {
      const normId = cell(mapTable.header, row.cells, 'normId');
      const nodeType = cell(mapTable.header, row.cells, 'nodeType');
      const elementType = cell(mapTable.header, row.cells, 'elementType') || '*';
      const materialKeyRaw = cell(mapTable.header, row.cells, 'materialKey');
      const measureRaw = cell(mapTable.header, row.cells, 'măsură');
      const formula = cell(mapTable.header, row.cells, 'formulă');
      const netRaw = cell(mapTable.header, row.cells, 'netOfOpenings').toLowerCase();

      if (!normId) { issues.push({ file, line: row.line, message: 'mapare fără `normId`' }); continue; }
      if (!nodeType) { issues.push({ file, line: row.line, message: `mapare fără \`nodeType\` (${normId})` }); continue; }
      if (!VALID_MEASURES.includes(measureRaw as MeasureKey)) {
        issues.push({ file, line: row.line, message: `măsură invalidă "${measureRaw}" (permise: ${VALID_MEASURES.join(', ')})` });
        continue;
      }
      if (measureRaw === 'formula' && !formula) {
        issues.push({ file, line: row.line, message: `măsura este \`formula\` dar coloana \`formulă\` e goală (${normId})` });
        continue;
      }
      mappings.push({
        normId,
        nodeType,
        elementType,
        materialKey: materialKeyRaw || undefined,
        measure: measureRaw as MeasureKey,
        formula: formula || undefined,
        netOfOpenings: netRaw === 'da' || netRaw === 'true' || netRaw === 'x' ? true : undefined,
      });
    }
  }

  return { categorie, capitol, articles, mappings, sourceFile: file };
}

/** Parsează `_catalog.md` (metadatele catalogului). */
export function parseCatalogMd(text: string, file = '_catalog.md'): LibraryCatalogMeta {
  const issues: ParseIssue[] = [];
  const fm = parseFrontmatter(text.split(/\r?\n/), file, issues);
  const meta: LibraryCatalogMeta = {
    id: fm.data.id ?? '',
    version: fm.data.version ?? '',
    currency: fm.data.currency ?? 'lei',
  };
  if (!meta.id) issues.push({ file, line: 1, message: 'frontmatter: lipsește `id`' });
  if (!meta.version) issues.push({ file, line: 1, message: 'frontmatter: lipsește `version`' });
  if (issues.length > 0) throw new LibraryParseError(issues);
  return meta;
}
