/** Dimensiuni de bază ale tabelului extras (unități design, ≈ mm la scară 1:1). */
export const TABEL_EXTRAS_BASE = {
  latime: 604,
  titleH: 26,
  hdr: 22,
  row: 64,
  ftr: 22,
  fontSize: 11,
  /** Înălțime font țintă pe hârtie tipărită (mm). */
  fontPaperMm: 2.8,
} as const;

export function inaltimeTabelExtrasBase(nrRanduri: number): number {
  const b = TABEL_EXTRAS_BASE;
  return b.titleH + b.hdr + nrRanduri * b.row + b.ftr;
}

export interface OptScalaTabelHartie {
  scalaUtilizator?: number;
  /** Implicit true. */
  scalaAuto?: boolean;
  margine?: number;
}

/**
 * Scară tabel pe foaie layout — încadrează în foaie și păstrează text lizibil la print.
 */
export function scalaTabelPeHartie(
  nrRanduri: number,
  latimeFoaie: number,
  inaltimeFoaie: number,
  opt: OptScalaTabelHartie = {},
): number {
  const margine = opt.margine ?? 12;
  const user = opt.scalaUtilizator ?? 1;
  if (opt.scalaAuto === false) {
    return Math.max(0.12, user);
  }

  const baseW = TABEL_EXTRAS_BASE.latime;
  const baseH = inaltimeTabelExtrasBase(nrRanduri);
  const maxW = Math.max(40, latimeFoaie - margine * 2);
  const maxH = Math.max(40, inaltimeFoaie - margine * 2);
  const fit = Math.min(maxW / baseW, maxH / baseH, 1.25);
  const minText = TABEL_EXTRAS_BASE.fontPaperMm / TABEL_EXTRAS_BASE.fontSize;
  return Math.max(minText, fit * user);
}
