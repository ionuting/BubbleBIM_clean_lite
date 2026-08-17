/**
 * f3Export.ts — Export quantity schedule (F3) to CSV (UTF-8 BOM for Excel).
 */

import type { F3Row, TakeoffLine } from '@/lib/norms';
import { getActiveCatalog } from '@/lib/norms';

function escapeCsv(value: string | number): string {
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface F3ExportMeta {
  projectName: string;
  exportedAt: string;
  catalogVersion: string;
}

/** Build CSV content for F3 schedule. */
export function buildF3Csv(rows: F3Row[], meta: F3ExportMeta): string {
  const header = [
    'Bill of quantities (F3)',
    `Project: ${meta.projectName}`,
    `Export: ${meta.exportedAt}`,
    `Norm catalog: ${meta.catalogVersion}`,
    '',
  ];

  const colHeader = [
    'No.',
    'Symbol',
    'Article description',
    'Unit',
    'Quantity',
    'Chapter',
    'Work category',
    'Storey',
  ].join(',');

  const dataRows = rows.map((r) => [
    r.nrCrt,
    escapeCsv(r.symbol),
    escapeCsv(r.denumire),
    r.unit,
    r.quantity.toFixed(2),
    escapeCsv(r.capitol),
    escapeCsv(r.categorie),
    escapeCsv(r.storeyName),
  ].join(','));

  return [...header, colHeader, ...dataRows].join('\r\n');
}

/** Build detail CSV with per-node breakdown. */
export function buildTakeoffDetailCsv(lines: TakeoffLine[], meta: F3ExportMeta): string {
  const header = [
    'Takeoff detail',
    `Project: ${meta.projectName}`,
    `Export: ${meta.exportedAt}`,
    `Norm catalog: ${meta.catalogVersion}`,
    '',
  ];

  const colHeader = [
    'Symbol',
    'Node',
    'Node type',
    'Element type',
    'Storey',
    'Quantity',
    'Unit',
    'Calc source',
  ].join(',');

  const dataRows = lines.map((l) => [
    escapeCsv(l.normId),
    escapeCsv(l.nodeName),
    l.nodeType,
    escapeCsv(l.elementTypeId),
    escapeCsv(l.storeyName),
    l.quantity.toFixed(2),
    l.unit,
    escapeCsv(l.source),
  ].join(','));

  return [...header, colHeader, ...dataRows].join('\r\n');
}

/** Trigger browser download of F3 CSV. */
export function downloadF3Csv(rows: F3Row[], projectName: string): void {
  const meta: F3ExportMeta = {
    projectName,
    exportedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    catalogVersion: getActiveCatalog().version,
  };
  const csv = buildF3Csv(rows, meta);
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName || 'project'}_F3_quantities.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Trigger browser download of detail CSV. */
export function downloadTakeoffDetailCsv(lines: TakeoffLine[], projectName: string): void {
  const meta: F3ExportMeta = {
    projectName,
    exportedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    catalogVersion: getActiveCatalog().version,
  };
  const csv = buildTakeoffDetailCsv(lines, meta);
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName || 'project'}_takeoff_detail.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
