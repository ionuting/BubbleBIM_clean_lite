/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * priceCsv.ts — the price list out to a spreadsheet and back.
 *
 * WHY THIS IS THE IMPORTANT PART
 * ------------------------------
 * Nobody types a real price list into a web form article by article. Real
 * prices arrive as a quote, a supplier list, or an export from the deviz
 * software the office already uses — a table. So the honest way to make the
 * catalogue "real" is not to guess better numbers, it is to make the round
 * trip trivial: export what the project uses, edit it where prices actually
 * live, import it back.
 *
 * The schema is deliberately the SAME shape the norm library declares, so a
 * file exported here can be pasted into a category's `## Articole` table and a
 * file exported from the library imports here unchanged:
 *
 *   normId, simbol, denumire, UM, material, manoperă, utilaj, transport,
 *   total, sursă, data
 *
 * Matching is on `normId` only. `total` wins when it is present and the four
 * components are not, which is what a supplier list usually looks like; when
 * the components are given, their sum is used and the file's own `total` is
 * ignored, so a spreadsheet with a stale formula cannot quietly disagree with
 * itself.
 *
 * Pure: parsing and building strings. The store write is the caller's.
 */

export interface PriceCsvRow {
  normId: string;
  symbol: string;
  denumire: string;
  unit: string;
  material: number | null;
  manopera: number | null;
  utilaj: number | null;
  transport: number | null;
  total: number;
  source: string;
  date: string;
}

export interface PriceImportResult {
  /** normId → unit price, ready for `mergePrices`. */
  prices: Record<string, number>;
  /** Rows whose `normId` is not in the catalogue — reported, never guessed at. */
  unknown: string[];
  /** Rows that carried no usable number. */
  invalid: string[];
  /** Rows accepted. */
  accepted: number;
}

export const PRICE_CSV_HEADER = [
  'normId', 'simbol', 'denumire', 'UM', 'material', 'manopera', 'utilaj', 'transport', 'total', 'sursa', 'data',
] as const;

const esc = (v: string | number): string => {
  const s = String(v ?? '');
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const num = (n: number | null): string => (n === null ? '' : String(n));

/** The price list as CSV, semicolon-separated so Excel in a ro locale opens it whole. */
export function buildPriceCsv(rows: PriceCsvRow[]): string {
  const out: string[] = [PRICE_CSV_HEADER.join(';')];
  for (const r of rows) {
    out.push([
      esc(r.normId), esc(r.symbol), esc(r.denumire), esc(r.unit),
      num(r.material), num(r.manopera), num(r.utilaj), num(r.transport),
      String(r.total), esc(r.source), esc(r.date),
    ].join(';'));
  }
  return out.join('\n');
}

/** Split one CSV line on `;` or `,`, honouring quotes. */
export function splitCsvLine(line: string): string[] {
  const sep = line.includes(';') ? ';' : ',';
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** A number written the Romanian way (`1.234,56`) or the plain way. */
export function parseNumber(raw: string): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // `1.234,56` → `1234.56`; `1234,56` → `1234.56`; `1234.56` stays.
  const normalised = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const v = Number(normalised);
  return Number.isFinite(v) ? v : null;
}

/**
 * Read a price CSV against the catalogue's article ids.
 *
 * Unknown ids are collected rather than silently dropped: a supplier list that
 * matched nothing must look like a failure, not like a successful import of
 * zero prices.
 */
export function parsePriceCsv(text: string, knownIds: Set<string>): PriceImportResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const prices: Record<string, number> = {};
  const unknown: string[] = [];
  const invalid: string[] = [];
  if (lines.length === 0) return { prices, unknown, invalid, accepted: 0 };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[ăâ]/g, 'a').replace(/ș/g, 's').replace(/ț/g, 't'));
  const col = (name: string) => header.indexOf(name);
  const hasHeader = col('normid') !== -1;
  const iId = hasHeader ? col('normid') : 0;
  const iTot = hasHeader ? col('total') : 1;
  const iMat = hasHeader ? col('material') : -1;
  const iMan = hasHeader ? col('manopera') : -1;
  const iUti = hasHeader ? col('utilaj') : -1;
  const iTra = hasHeader ? col('transport') : -1;

  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const c = splitCsvLine(line);
    const id = (c[iId] ?? '').trim();
    if (!id) continue;
    if (!knownIds.has(id)) { unknown.push(id); continue; }

    const parts = [iMat, iMan, iUti, iTra].map((i) => (i >= 0 ? parseNumber(c[i] ?? '') : null));
    const fromParts = parts.every((p) => p !== null)
      ? parts.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)
      : null;
    const value = fromParts ?? (iTot >= 0 ? parseNumber(c[iTot] ?? '') : null);

    if (value === null || !(value >= 0)) { invalid.push(id); continue; }
    prices[id] = Math.round(value * 100) / 100;
  }

  return { prices, unknown, invalid, accepted: Object.keys(prices).length };
}

/** Trigger a browser download of the price CSV (UTF-8 BOM so Excel reads the diacritics). */
export function downloadPriceCsv(rows: PriceCsvRow[], projectName: string): void {
  const blob = new Blob(['﻿' + buildPriceCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${projectName || 'project'}_preturi.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
