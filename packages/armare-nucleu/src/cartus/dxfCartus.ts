import type { EntitateImport } from "../dxf/importDxf";
import { importaDxf } from "../dxf/importDxf";

/**
 * Convertește un cartuș exportat dintr-un program CAD/BIM (AutoCAD, Revit,
 * Tekla Structures, Civil 3D etc.) — fișier DXF conținând chenarul, textele
 * fixe, atribute de bloc (câmpuri variabile) și eventual un logo raster —
 * într-un `SablonCartus` compatibil cu sistemul intern (SVG cu placeholdere
 * `{{cheie}}`). Atributele de bloc (ATTRIB/ATTDEF) devin automat câmpuri
 * editabile; restul geometriei (chenar, linii, text static) rămâne fixă.
 */

export interface RezultatConversieDxfCartus {
  /** Markup SVG generat, gata de salvat ca `SablonCartus.svg`. */
  svg: string;
  /** Cheile câmpurilor `{{...}}` detectate (din atribute DXF). */
  campuriDetectate: string[];
  /** Numele fișierelor imagine referite în DXF dar nefurnizate (fără potrivire). */
  imaginiLipsa: string[];
  latimeMm: number;
  inaltimeMm: number;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Normalizează un tag de atribut DXF (ex. "NR_PLANSA") la o cheie de placeholder (ex. "nr_plansa"). */
function cheieDinTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "_");
}

function entitateInSvg(
  e: EntitateImport,
  tx: (x: number) => number,
  ty: (y: number) => number,
  campuriSet: Set<string>,
  imaginiLipsa: Set<string>,
  imaginiDisponibile: Map<string, string>,
): string {
  switch (e.tip) {
    case "linie":
      return `<line x1="${tx(e.p1.x)}" y1="${ty(e.p1.y)}" x2="${tx(e.p2.x)}" y2="${ty(e.p2.y)}" stroke="black" stroke-width="0.15"/>`;
    case "cerc":
      return `<circle cx="${tx(e.centru.x)}" cy="${ty(e.centru.y)}" r="${e.raza}" fill="none" stroke="black" stroke-width="0.15"/>`;
    case "arc": {
      const a0 = (e.unghiStartGrade * Math.PI) / 180;
      const a1 = (e.unghiSfarsitGrade * Math.PI) / 180;
      const p0 = { x: tx(e.centru.x + e.raza * Math.cos(a0)), y: ty(e.centru.y + e.raza * Math.sin(a0)) };
      const p1 = { x: tx(e.centru.x + e.raza * Math.cos(a1)), y: ty(e.centru.y + e.raza * Math.sin(a1)) };
      let delta = e.unghiSfarsitGrade - e.unghiStartGrade;
      if (delta < 0) delta += 360;
      const largeArc = delta > 180 ? 1 : 0;
      return `<path d="M ${p0.x} ${p0.y} A ${e.raza} ${e.raza} 0 ${largeArc} 0 ${p1.x} ${p1.y}" fill="none" stroke="black" stroke-width="0.15"/>`;
    }
    case "polilinie": {
      const pts = e.puncte.map((p) => `${tx(p.x)},${ty(p.y)}`).join(" ");
      const el = e.inchis ? "polygon" : "polyline";
      return `<${el} points="${pts}" fill="none" stroke="black" stroke-width="0.15"/>`;
    }
    case "hasura":
      return e.contururi
        .map(
          (c) =>
            `<polygon points="${c.map((p) => `${tx(p.x)},${ty(p.y)}`).join(" ")}" fill="none" stroke="black" stroke-width="0.1" opacity="0.4"/>`,
        )
        .join("\n  ");
    case "text": {
      const x = tx(e.pozitie.x);
      const y = ty(e.pozitie.y);
      let continut: string;
      if (e.atribut) {
        const cheie = cheieDinTag(e.atribut.tag);
        campuriSet.add(cheie);
        continut = `{{${cheie}}}`;
      } else {
        continut = esc(e.continut);
      }
      const rot = -e.rotatie;
      const transform = rot ? ` transform="rotate(${rot} ${x} ${y})"` : "";
      return `<text x="${x}" y="${y}" font-size="${e.inaltime}" font-family="sans-serif" fill="black"${transform}>${continut}</text>`;
    }
    case "imagine": {
      const x = tx(e.pozitie.x);
      const y = ty(e.pozitie.y) - e.inaltime;
      const cheieFisier = e.fisierRef?.toLowerCase();
      const dataUrl = cheieFisier ? imaginiDisponibile.get(cheieFisier) : undefined;
      if (!dataUrl) {
        if (e.fisierRef) imaginiLipsa.add(e.fisierRef);
        return `<rect x="${x}" y="${y}" width="${e.latime}" height="${e.inaltime}" fill="none" stroke="#94a3b8" stroke-width="0.3" stroke-dasharray="2,1.5"/>`;
      }
      return `<image x="${x}" y="${y}" width="${e.latime}" height="${e.inaltime}" href="${dataUrl}" preserveAspectRatio="none"/>`;
    }
  }
}

/**
 * @param text Conținutul fișierului DXF (ASCII).
 * @param imaginiDisponibile Mapare nume-fișier (lowercase, fără cale) → data URL,
 *   pentru rastere referite de entități IMAGE. DXF nu înglobează pixelii —
 *   trebuie furnizate separat (upload paralel cu DXF-ul, potrivire după nume).
 */
export function convertesteDxfInCartus(
  text: string,
  imaginiDisponibile: Map<string, string> = new Map(),
): RezultatConversieDxfCartus {
  const substrat = importaDxf(text);
  const { minX, minY, maxX, maxY } = substrat.anvelopa;
  const latimeMm = Math.max(1, Math.round((maxX - minX) * 100) / 100);
  const inaltimeMm = Math.max(1, Math.round((maxY - minY) * 100) / 100);

  const tx = (x: number) => x - minX;
  const ty = (y: number) => maxY - y;

  const campuriSet = new Set<string>();
  const imaginiLipsa = new Set<string>();
  const elemente = substrat.entitati.map((e) =>
    entitateInSvg(e, tx, ty, campuriSet, imaginiLipsa, imaginiDisponibile),
  );

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${latimeMm} ${inaltimeMm}" width="${latimeMm}mm" height="${inaltimeMm}mm">`,
    `  <rect x="0" y="0" width="${latimeMm}" height="${inaltimeMm}" fill="white" stroke="none"/>`,
    ...elemente.map((el) => `  ${el}`),
    `</svg>`,
  ].join("\n");

  return {
    svg,
    campuriDetectate: [...campuriSet],
    imaginiLipsa: [...imaginiLipsa],
    latimeMm,
    inaltimeMm,
  };
}
