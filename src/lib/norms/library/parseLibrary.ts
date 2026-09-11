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
  type LibrarySpecGroup,
  type LibrarySpecOption,
  type PriceComponents,
  VALID_UNITS,
  VALID_MEASURES,
  VALID_SYSTEMS,
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
      const srcRaw = cell(artTable.header, row.cells, 'sursă');
      const dateRaw = cell(artTable.header, row.cells, 'data');
      if (dateRaw && !/^\d{4}-\d{2}(-\d{2})?$/.test(dateRaw)) {
        issues.push({ file, line: row.line, message: `data invalidă "${dateRaw}" pentru ${normId} — se scrie AAAA-LL sau AAAA-LL-ZZ` });
      }
      articles.push({
        normId, symbol: symbol || normId, denumire, unit: unitRaw as NormUnit, price,
        ...(srcRaw || dateRaw ? { priceSource: { source: srcRaw, date: dateRaw } } : {}),
      });
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
      const systemRaw = cell(mapTable.header, row.cells, 'sistem').toLowerCase();
      const specRaw = cell(mapTable.header, row.cells, 'spec');
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
      if (systemRaw && !VALID_SYSTEMS.includes(systemRaw)) {
        issues.push({ file, line: row.line, message: `sistem invalid "${systemRaw}" (permise: ${VALID_SYSTEMS.join(', ')})` });
        continue;
      }
      if (specRaw && !/^[a-z0-9_]+:[a-z0-9_]+$/.test(specRaw)) {
        issues.push({ file, line: row.line, message: `spec invalid "${specRaw}" — se scrie \`grup:opțiune\` cu litere mici, cifre și _` });
        continue;
      }
      mappings.push({
        normId,
        nodeType,
        elementType,
        materialKey: materialKeyRaw || undefined,
        system: systemRaw || undefined,
        spec: specRaw || undefined,
        measure: measureRaw as MeasureKey,
        formula: formula || undefined,
        netOfOpenings: netRaw === 'da' || netRaw === 'true' || netRaw === 'x' ? true : undefined,
      });
    }
  }

  return { categorie, capitol, articles, mappings, sourceFile: file };
}

/**
 * Parsează `_specificatii.md`: grupurile de specificații și opțiunile lor.
 *
 * Două tabele. `## Grupuri` declară decizia (eticheta, pe ce noduri se poate
 * suprascrie, opțiunea implicită și articolele pe care le produce implicitul);
 * `## Opțiuni` declară alternativele. Ce produce fiecare alternativă vine din
 * coloana `spec` a mapărilor, nu de aici — grupul e doar vocabularul.
 */
export function parseSpecsMd(text: string, file = '_specificatii.md'): LibrarySpecGroup[] {
  const issues: ParseIssue[] = [];
  const groups = parseSpecsMdCollecting(text, file, issues);
  if (issues.length > 0) throw new LibraryParseError(issues);
  return groups;
}

/** Ca `parseSpecsMd`, dar acumulează problemele în loc să arunce. */
export function parseSpecsMdCollecting(
  text: string,
  file: string,
  issues: ParseIssue[],
): LibrarySpecGroup[] {
  const lines = text.split(/\r?\n/);
  const fm = parseFrontmatter(lines, file, issues);
  const list: (LibrarySpecGroup & { options: LibrarySpecOption[] })[] = [];
  const byId = new Map<string, LibrarySpecGroup>();

  const grpTable = findTable(fm.body, fm.bodyStartLine, 'Grupuri');
  if (!grpTable) {
    issues.push({ file, line: 1, message: 'lipsește secțiunea `## Grupuri`' });
    return [];
  }
  for (const row of grpTable.rows) {
    const id = cell(grpTable.header, row.cells, 'grup');
    const label = cell(grpTable.header, row.cells, 'etichetă');
    const applies = cell(grpTable.header, row.cells, 'aplicabil');
    const def = cell(grpTable.header, row.cells, 'implicit');
    const arts = cell(grpTable.header, row.cells, 'articole implicite');
    const description = cell(grpTable.header, row.cells, 'descriere');
    if (!id) { issues.push({ file, line: row.line, message: 'grup fără `grup`' }); continue; }
    if (!/^[a-z0-9_]+$/.test(id)) {
      issues.push({ file, line: row.line, message: `id de grup invalid "${id}" — litere mici, cifre și _` });
      continue;
    }
    if (byId.has(id)) { issues.push({ file, line: row.line, message: `grup duplicat "${id}"` }); continue; }
    if (!def) { issues.push({ file, line: row.line, message: `grupul "${id}" nu declară opțiunea \`implicit\`` }); continue; }
    const g: LibrarySpecGroup & { options: LibrarySpecOption[] } = {
      id,
      label: label || id,
      appliesTo: applies.split(',').map((t) => t.trim()).filter(Boolean),
      defaultOption: def,
      defaultArticles: arts.split(',').map((t) => t.trim()).filter(Boolean),
      ...(description ? { description } : {}),
      options: [],
    };
    if (g.appliesTo.length === 0) {
      issues.push({ file, line: row.line, message: `grupul "${id}" nu declară \`aplicabil\` (tipurile de nod)` });
      continue;
    }
    list.push(g);
    byId.set(id, g);
  }

  const optTable = findTable(fm.body, fm.bodyStartLine, 'Opțiuni');
  if (!optTable) {
    issues.push({ file, line: 1, message: 'lipsește secțiunea `## Opțiuni`' });
    return list;
  }
  for (const row of optTable.rows) {
    const group = cell(optTable.header, row.cells, 'grup');
    const id = cell(optTable.header, row.cells, 'opțiune');
    const label = cell(optTable.header, row.cells, 'etichetă');
    const description = cell(optTable.header, row.cells, 'descriere');
    const material = cell(optTable.header, row.cells, 'material');
    const lambdaRaw = cell(optTable.header, row.cells, 'lambda');
    const grosimeRaw = cell(optTable.header, row.cells, 'grosime');
    const lambda = lambdaRaw ? Number(lambdaRaw.replace(',', '.')) : NaN;
    const grosime = grosimeRaw ? Number(grosimeRaw.replace(',', '.')) : NaN;
    if (!group || !id) { issues.push({ file, line: row.line, message: 'opțiune fără `grup` sau `opțiune`' }); continue; }
    const g = byId.get(group);
    if (!g) { issues.push({ file, line: row.line, message: `opțiunea "${id}" trimite la grupul inexistent "${group}"` }); continue; }
    if (!/^[a-z0-9_]+$/.test(id)) {
      issues.push({ file, line: row.line, message: `id de opțiune invalid "${id}" — litere mici, cifre și _` });
      continue;
    }
    if (g.options.some((o) => o.id === id)) {
      issues.push({ file, line: row.line, message: `opțiune duplicată "${group}:${id}"` });
      continue;
    }
    if (lambdaRaw && !(lambda > 0)) {
      issues.push({ file, line: row.line, message: `opțiunea "${group}:${id}": lambda invalid "${lambdaRaw}" — W/mK, pozitiv` });
      continue;
    }
    if (grosimeRaw && !(grosime > 0)) {
      issues.push({ file, line: row.line, message: `opțiunea "${group}:${id}": grosime invalidă "${grosimeRaw}" — mm, pozitiv` });
      continue;
    }
    g.options.push({
      group, id, label: label || id,
      ...(description ? { description } : {}),
      ...(material ? { material } : {}),
      ...(lambda > 0 ? { lambda } : {}),
      ...(grosime > 0 ? { grosime } : {}),
    });
  }

  for (const g of list) {
    if (!g.options.some((o) => o.id === g.defaultOption)) {
      issues.push({ file, line: 1, message: `grupul "${g.id}": opțiunea implicită "${g.defaultOption}" nu e declarată în \`## Opțiuni\`` });
    }
  }
  return list;
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
