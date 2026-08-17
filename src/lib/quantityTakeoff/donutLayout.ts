/**
 * donutLayout.ts — geometria pură a donut-ului + plasarea etichetelor directe.
 * Extras din componentă ca să poată fi VERIFICAT numeric (overflow în viewBox,
 * coliziuni verticale) — ghidul de dataviz cere „render it and look at it", iar
 * fără browser aceasta e substituirea verificabilă.
 */

export interface DonutGeom {
  W: number; H: number;
  cx: number; cy: number;
  rO: number; rI: number;
  /** Distanța etichetei față de raza exterioară. */
  labelPad: number;
  /** Separare verticală minimă între etichete pe aceeași parte. */
  minGap: number;
  /** Lățime estimată per caracter (pentru verificarea overflow-ului). */
  charW: number;
}

export const DONUT_GEOM: DonutGeom = {
  W: 360, H: 200,
  cx: 180, cy: 96,
  rO: 62, rI: 38,
  labelPad: 10,
  minGap: 13,
  charW: 4.6,
};

export interface DonutInput { categorie: string; share: number; total: number }

export interface DonutArc extends DonutInput {
  a0: number; a1: number; mid: number;
  colorSlot: number;
}

export interface DonutLabel {
  text: string;
  x: number; y: number;
  anchor: 'start' | 'end';
  /** Extremele orizontale estimate ale textului (pentru verificarea overflow-ului). */
  x0: number; x1: number;
}

export interface DonutLayout {
  arcs: DonutArc[];
  labels: DonutLabel[];
}

const pctText = (s: number) => `${(s * 100).toFixed(1)}%`;

/** Separă greedy etichetele de pe aceeași parte, păstrând ordinea verticală. */
function decollide(labels: DonutLabel[], minGap: number, H: number): void {
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < minGap) labels[i].y = labels[i - 1].y + minGap;
  }
  // Dacă am împins peste marginea de jos, deplasăm tot blocul în sus.
  const overflow = labels.length > 0 ? labels[labels.length - 1].y - (H - 6) : 0;
  if (overflow > 0) for (const l of labels) l.y -= overflow;
  // Și dacă am ieșit pe sus, coborâm.
  const under = labels.length > 0 ? 6 - labels[0].y : 0;
  if (under > 0) for (const l of labels) l.y += under;
}

/** Construiește arcele și etichetele directe, fără coliziuni și fără overflow. */
export function layoutDonut(slices: DonutInput[], geom: DonutGeom = DONUT_GEOM): DonutLayout {
  const { cx, cy, rO, labelPad, minGap, charW, H } = geom;
  let angle = -Math.PI / 2;
  const arcs: DonutArc[] = slices.map((s, i) => {
    const a0 = angle;
    const a1 = angle + s.share * Math.PI * 2;
    angle = a1;
    return { ...s, a0, a1, mid: (a0 + a1) / 2, colorSlot: i };
  });

  const left: DonutLabel[] = [];
  const right: DonutLabel[] = [];
  for (const a of arcs) {
    const text = `${a.categorie} ${pctText(a.share)}`;
    const r = rO + labelPad;
    const x = cx + r * Math.cos(a.mid);
    const y = cy + r * Math.sin(a.mid);
    const isRight = Math.cos(a.mid) >= 0;
    const w = text.length * charW;
    const label: DonutLabel = {
      text, x, y,
      anchor: isRight ? 'start' : 'end',
      x0: isRight ? x : x - w,
      x1: isRight ? x + w : x,
    };
    (isRight ? right : left).push(label);
  }
  decollide(left, minGap, H);
  decollide(right, minGap, H);

  // Recalculăm extremele după de-coliziune (y s-a schimbat, x nu).
  return { arcs, labels: [...left, ...right] };
}

/** Cale SVG pentru un segment de donut. */
export function arcPath(cx: number, cy: number, rO: number, rI: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(rO, a0), [x1, y1] = p(rO, a1);
  const [x2, y2] = p(rI, a1), [x3, y3] = p(rI, a0);
  return `M ${x0} ${y0} A ${rO} ${rO} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rI} ${rI} 0 ${large} 0 ${x3} ${y3} Z`;
}
