import {
  type Vector2,
  aduna,
  inmulteste,
  normalizeaza,
  radiani,
  roteste,
  scade,
  unghi,
} from "../geometrie/vector";
import type { Cioc, Ciocuri, Segment } from "../model/tipuri";

/** Prag peste care un cioc e tratat ca semicerc (cârlig 180°). */
export const PRAG_CIOC_180 = 175;

/** true dacă ciocul e un cârlig 180° (semicircular). */
export function esteCioc180(c?: Cioc): boolean {
  return !!c && c.unghi >= PRAG_CIOC_180;
}

/**
 * Ciocuri (cârlige / coturi) la capetele barelor, conform practicii curente
 * (SR EN 1992-1-1 + P100). Lungimea extensiei drepte după îndoire:
 *   - cot 90°     →  12 · Ø
 *   - cârlig 135° →  10 · Ø
 *   - alte unghiuri → 5 · Ø
 * cu un minim de 50 mm. Valoarea e o sugestie editabilă de utilizator.
 */
export function lungimeCiocStandard(diametru: number, unghi: number): number {
  let multiplu: number;
  if (unghi <= 90) multiplu = 12;
  else if (unghi <= 135) multiplu = 10;
  else multiplu = 5;
  return Math.max(multiplu * diametru, 50);
}

/** Construiește un cioc cu lungimea standard pentru un diametru dat. */
export function ciocStandard(diametru: number, unghi: number): Cioc {
  return { unghi, lungime: lungimeCiocStandard(diametru, unghi) };
}

/** Combină ciocurile intrinseci formei cu cele setate de utilizator (user are prioritate). */
export function combinaCiocuri(intrinseci?: Ciocuri, utilizator?: Ciocuri): Ciocuri | undefined {
  if (!intrinseci && !utilizator) return undefined;
  return {
    start: utilizator?.start ?? intrinseci?.start,
    sfarsit: utilizator?.sfarsit ?? intrinseci?.sfarsit,
  };
}

/**
 * Adaugă ciocuri la capetele unei polilinii deschise. Fiecare cioc devine un nou
 * vârf, iar îndoirea propriu-zisă (arcul pe rază) rezultă automat la filetarea
 * ulterioară a colțului. `sens` alege partea în care se pliază ciocul (+1 implicit,
 * spre interiorul formelor uzuale).
 */
export function aplicaCiocuri(varfuri: Vector2[], ciocuri?: Ciocuri, sens = 1): Vector2[] {
  if (!ciocuri || varfuri.length < 2) return varfuri;
  let v = [...varfuri];

  // Ciocurile 180° (semicirculare) se generează separat ca segmente, nu ca vârfuri.
  if (ciocuri.sfarsit && !esteCioc180(ciocuri.sfarsit)) {
    const ultim = v[v.length - 1]!;
    const penultim = v[v.length - 2]!;
    const d = normalizeaza(scade(ultim, penultim));
    const sensSfarsit = ciocuri.sfarsit.flipuit ? -sens : sens;
    const dirCioc = roteste(d, sensSfarsit * radiani(ciocuri.sfarsit.unghi));
    v = [...v, aduna(ultim, inmulteste(dirCioc, ciocuri.sfarsit.lungime))];
  }

  if (ciocuri.start && !esteCioc180(ciocuri.start)) {
    const prim = v[0]!;
    const alDoilea = v[1]!;
    const d = normalizeaza(scade(alDoilea, prim));
    const sensStart = ciocuri.start.flipuit ? -sens : sens;
    const dirIntrare = roteste(d, -sensStart * radiani(ciocuri.start.unghi));
    v = [scade(prim, inmulteste(dirIntrare, ciocuri.start.lungime)), ...v];
  }

  return v;
}

/**
 * Versiunea NOMINALĂ a aplicării ciocurilor: adaugă vârful de cioc la fiecare
 * capăt indiferent de unghi (inclusiv 180°), fără filet. Folosită pentru
 * dimensiunile brute (lungimi de segmente/ciocuri), nu pentru geometria reală.
 * Întoarce și ce capete au primit cioc, pentru clasificare ulterioară.
 */
export function aplicaCiocuriNominal(
  varfuri: Vector2[],
  ciocuri?: Ciocuri,
  sens = 1,
): { varfuri: Vector2[]; areStart: boolean; areSfarsit: boolean } {
  if (!ciocuri || varfuri.length < 2) {
    return { varfuri: [...varfuri], areStart: false, areSfarsit: false };
  }
  let v = [...varfuri];
  let areSfarsit = false;
  let areStart = false;

  if (ciocuri.sfarsit) {
    const ultim = v[v.length - 1]!;
    const penultim = v[v.length - 2]!;
    const d = normalizeaza(scade(ultim, penultim));
    const sensSfarsit = ciocuri.sfarsit.flipuit ? -sens : sens;
    const dirCioc = roteste(d, sensSfarsit * radiani(ciocuri.sfarsit.unghi));
    v = [...v, aduna(ultim, inmulteste(dirCioc, ciocuri.sfarsit.lungime))];
    areSfarsit = true;
  }

  if (ciocuri.start) {
    const prim = v[0]!;
    const alDoilea = v[1]!;
    const d = normalizeaza(scade(alDoilea, prim));
    const sensStart = ciocuri.start.flipuit ? -sens : sens;
    const dirIntrare = roteste(d, -sensStart * radiani(ciocuri.start.unghi));
    v = [scade(prim, inmulteste(dirIntrare, ciocuri.start.lungime)), ...v];
    areStart = true;
  }

  return { varfuri: v, areStart, areSfarsit };
}

/** Inversează sensul de parcurgere al unui segment. */
function inverseazaSegment(seg: Segment): Segment {
  if (seg.tip === "linie") return { tip: "linie", start: seg.sfarsit, sfarsit: seg.start };
  return {
    tip: "arc",
    centru: seg.centru,
    raza: seg.raza,
    unghiStart: seg.unghiSfarsit,
    unghiSfarsit: seg.unghiStart,
    sensOrar: !seg.sensOrar,
  };
}

/**
 * Generează segmentele unui cârlig 180° pornind dintr-un capăt `P`, „spre exterior”
 * pe direcția `dirExterior`: un semicerc pe raza de fasonare (offset 2·rază) urmat
 * de o extensie dreaptă paralelă cu bara. Ordinea: [arc(P→Pdiam), linie(Pdiam→vârf)].
 */
function segmenteCiocOutward(
  P: Vector2,
  dirExterior: Vector2,
  raza: number,
  lungime: number,
  sens: number,
): Segment[] {
  const dir = normalizeaza(dirExterior);
  const n = roteste(dir, (sens >= 0 ? 1 : -1) * (Math.PI / 2)); // perpendiculară unitară
  const centru = aduna(P, inmulteste(n, raza));
  const pDiam = aduna(P, inmulteste(n, 2 * raza));
  const varf = aduna(pDiam, inmulteste(dir, -lungime));

  const arc: Segment = {
    tip: "arc",
    centru,
    raza,
    unghiStart: unghi(scade(P, centru)),
    unghiSfarsit: unghi(scade(pDiam, centru)),
    sensOrar: sens < 0,
  };
  const linie: Segment = { tip: "linie", start: pDiam, sfarsit: varf };
  return [arc, linie];
}

/** Segmentele unui cârlig 180° la CAPĂTUL barei (direcția `d` = sosirea în capăt). */
export function segmenteCiocSfarsit(
  capat: Vector2,
  d: Vector2,
  raza: number,
  cioc: Cioc,
  sens = 1,
): Segment[] {
  return segmenteCiocOutward(capat, d, raza, cioc.lungime, sens);
}

/** Segmentele unui cârlig 180° la ÎNCEPUTUL barei (direcția `d0` = plecarea din început). */
export function segmenteCiocStart(
  inceput: Vector2,
  d0: Vector2,
  raza: number,
  cioc: Cioc,
  sens = 1,
): Segment[] {
  // „Spre exterior” la început înseamnă opus direcției de plecare; inversăm ordinea
  // ca segmentele să se termine exact în punctul de început al corpului barei.
  const spreExterior = inmulteste(normalizeaza(d0), -1);
  const seg = segmenteCiocOutward(inceput, spreExterior, raza, cioc.lungime, sens);
  return seg.reverse().map(inverseazaSegment);
}
