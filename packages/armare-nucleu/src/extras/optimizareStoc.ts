import { numarTotalCaleArray, sablonFormaDinCale, type CaleArray } from "../array-path/arrayPath";
import { definitiePentru, lungimeDesfasurata } from "../forme/catalog";
import { masaBara } from "../model/otel";
import { totalInstanteAxa, type FormaArmare } from "../model/tipuri";

/** Lungimea implicită a unei bare comerciale de oțel-beton (mm). */
export const LUNGIME_STOC_IMPLICITA = 12000;

/** Pragul peste care un rebut este considerat reutilizabil la o comandă viitoare (mm). */
export const PRAG_REBUT_REUTILIZABIL_IMPLICIT = 2000;

/** O cerere de debitare: o marcă are nevoie de `numar` bucăți de `lungime` mm. */
export interface CerereOptimizare {
  marca: number;
  diametru: number;
  clasaOtel: string;
  /** Lungimea de debitare a unei bucăți (mm) — vine din design, nu se modifică. */
  lungime: number;
  numar: number;
}

/**
 * Extrage cererile de debitare pentru optimizarea din stoc, pornind din formele
 * și cale-array-urile proiectului (aceeași sursă ca `extrasArmare`, dar
 * grupată pe piesă individuală în loc de marcă agregată). Formele simple nu au
 * clasă de oțel proprie, așa că folosesc clasa implicită a proiectului;
 * cale-array-urile își păstrează propria clasă (setată per distribuție).
 */
export function cerereOptimizareDin(
  forme: FormaArmare[],
  caleArrays: CaleArray[] = [],
  clasaOtelImplicitaProiect = "BSTC",
): CerereOptimizare[] {
  const cereri: CerereOptimizare[] = [];

  for (const forma of forme) {
    if (forma.excludeExtras) continue;
    if (definitiePentru(forma.tip).categorie === "cofraj") continue;
    const diametru = forma.parametri.diametru ?? 0;
    const lungime = lungimeDesfasurata(forma);
    const instante = forma.array
      ? totalInstanteAxa(forma.array, "x") * totalInstanteAxa(forma.array, "y")
      : 1;
    const numar = Math.max(0, Math.round(forma.numar)) * instante;
    if (numar <= 0 || lungime <= 0) continue;
    cereri.push({ marca: forma.marca, diametru, clasaOtel: clasaOtelImplicitaProiect, lungime, numar });
  }

  for (const cale of caleArrays) {
    if (cale.excludeExtras) continue;
    const sablon = sablonFormaDinCale(cale);
    const diametru = sablon.parametri.diametru ?? 0;
    const lungime = lungimeDesfasurata(sablon);
    const numar = numarTotalCaleArray(cale);
    if (numar <= 0 || lungime <= 0) continue;
    cereri.push({
      marca: cale.marca,
      diametru,
      clasaOtel: cale.clasaOtel ?? clasaOtelImplicitaProiect,
      lungime,
      numar,
    });
  }

  return cereri;
}

/** O piesă (bucată) tăiată dintr-o bară-stoc. */
export interface PiesaTaiata {
  marca: number;
  lungime: number;
}

/** O bară-stoc (12 m implicit) și modul în care a fost debitată. */
export interface BaraTaiata {
  taieturi: PiesaTaiata[];
  lungimeUtilizata: number;
  /** Rebutul (capătul rămas) al acestei bare, mm. */
  rebut: number;
  /** True dacă rebutul depășește pragul de reutilizare (implicit 2 m). */
  rebutReutilizabil: boolean;
}

/**
 * O piesă din design care depășește lungimea barei-stoc și nu poate fi
 * debitată dintr-o singură bară — necesită decizie de proiectare (înnădire
 * sau comandă specială).
 */
export interface BaraRespinsa {
  marca: number;
  diametru: number;
  clasaOtel: string;
  lungime: number;
  numar: number;
}

/** Rezultatul optimizării pentru un grup (diametru, clasă oțel). */
export interface GrupOptimizareStoc {
  diametru: number;
  clasaOtel: string;
  bare: BaraTaiata[];
  numarBare: number;
  lungimeUtilizataTotala: number;
  rebutTotal: number;
  rebutReutilizabilTotal: number;
  rebutNerecuperabilTotal: number;
  /** Procent rebut din lungimea totală de bare-stoc consumate în acest grup. */
  procentRebut: number;
  /** Masa rebutului nerecuperabil (kg) — pierdere reală de material. */
  masaRebutNerecuperabil: number;
}

export interface RezultatOptimizareStoc {
  grupuri: GrupOptimizareStoc[];
  bareRespinse: BaraRespinsa[];
  totalBareStoc: number;
  totalRebut: number;
  totalRebutReutilizabil: number;
  totalRebutNerecuperabil: number;
  procentRebutGlobal: number;
  masaRebutNerecuperabilTotal: number;
}

export interface OptiuniOptimizareStoc {
  /** Lungimea barei comerciale (mm). Implicit 12000. */
  lungimeStoc?: number;
  /** Prag peste care rebutul e marcat reutilizabil (mm). Implicit 2000. */
  pragRebutReutilizabil?: number;
}

interface BaraLucru {
  taieturi: PiesaTaiata[];
  ramas: number;
}

/**
 * Împachetează piesele într-un set minim de bare-stoc folosind euristica
 * First Fit Decreasing (FFD): piesele sunt sortate descrescător după lungime,
 * iar fiecare e plasată în prima bară deschisă (în ordinea creării) unde mai
 * încape; altfel se deschide o bară nouă. Problema (bin packing 1D) e
 * NP-hard — FFD nu garantează soluția optimă, dar rulează rapid și dă
 * rezultate tipic foarte apropiate de optim, suficient de bune pentru
 * planificarea tăierii pe șantier.
 *
 * Optimizare de performanță: o bară a cărei capacitate rămasă e sub cea mai
 * mică lungime dintre piesele încă neplasate nu mai poate primi nimic, deci e
 * scoasă din lista activă de scanare (nu afectează rezultatul, doar viteza).
 */
function ffdImpacheteazaBare(piese: PiesaTaiata[], lungimeStoc: number, pragReutilizabil: number): BaraTaiata[] {
  const sortate = [...piese].sort((a, b) => b.lungime - a.lungime);
  const n = sortate.length;

  const sufixMin = new Array<number>(n + 1);
  sufixMin[n] = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    sufixMin[i] = Math.min(sufixMin[i + 1]!, sortate[i]!.lungime);
  }

  const active: BaraLucru[] = [];
  const inchise: BaraLucru[] = [];

  for (let i = 0; i < n; i++) {
    const piesa = sortate[i]!;
    const pragMin = sufixMin[i]!;

    for (let j = active.length - 1; j >= 0; j--) {
      if (active[j]!.ramas < pragMin) {
        inchise.push(active[j]!);
        active.splice(j, 1);
      }
    }

    let gasit: BaraLucru | undefined;
    for (const bara of active) {
      if (bara.ramas >= piesa.lungime) {
        gasit = bara;
        break;
      }
    }
    if (!gasit) {
      gasit = { taieturi: [], ramas: lungimeStoc };
      active.push(gasit);
    }
    gasit.taieturi.push({ marca: piesa.marca, lungime: piesa.lungime });
    gasit.ramas -= piesa.lungime;
  }

  return [...inchise, ...active].map((b) => ({
    taieturi: b.taieturi,
    lungimeUtilizata: lungimeStoc - b.ramas,
    rebut: b.ramas,
    rebutReutilizabil: b.ramas >= pragReutilizabil,
  }));
}

/**
 * Optimizează tăierea barelor de armătură din bare-stoc (implicit 12 m),
 * grupând cererile pe diametru + clasă de oțel (nu se pot amesteca diametre
 * sau clase diferite pe aceeași bară). Mărci diferite cu lungimi compatibile
 * sunt împerecheate liber pentru minimizarea rebutului.
 *
 * Piesele mai lungi decât bara-stoc nu pot fi produse dintr-o singură bară și
 * sunt raportate separat în `bareRespinse`, ca eroare de proiectare
 * (necesită înnădire sau comandă specială), nu ca parte a optimizării.
 */
export function optimizeazaTaiereStoc(
  cereri: CerereOptimizare[],
  optiuni: OptiuniOptimizareStoc = {},
): RezultatOptimizareStoc {
  const lungimeStoc = optiuni.lungimeStoc ?? LUNGIME_STOC_IMPLICITA;
  const pragReutilizabil = optiuni.pragRebutReutilizabil ?? PRAG_REBUT_REUTILIZABIL_IMPLICIT;

  const bareRespinse: BaraRespinsa[] = [];
  const grupuriMap = new Map<string, { diametru: number; clasaOtel: string; piese: PiesaTaiata[] }>();

  for (const c of cereri) {
    if (c.lungime > lungimeStoc) {
      bareRespinse.push({ marca: c.marca, diametru: c.diametru, clasaOtel: c.clasaOtel, lungime: c.lungime, numar: c.numar });
      continue;
    }
    const cheie = `${c.diametru}__${c.clasaOtel}`;
    let grup = grupuriMap.get(cheie);
    if (!grup) {
      grup = { diametru: c.diametru, clasaOtel: c.clasaOtel, piese: [] };
      grupuriMap.set(cheie, grup);
    }
    for (let i = 0; i < c.numar; i++) {
      grup.piese.push({ marca: c.marca, lungime: c.lungime });
    }
  }

  const grupuri: GrupOptimizareStoc[] = [];
  let totalBareStoc = 0;
  let totalRebut = 0;
  let totalRebutReutilizabil = 0;
  let totalRebutNerecuperabil = 0;
  let masaRebutNerecuperabilTotal = 0;

  for (const { diametru, clasaOtel, piese } of grupuriMap.values()) {
    const bare = ffdImpacheteazaBare(piese, lungimeStoc, pragReutilizabil);
    const lungimeUtilizataTotala = bare.reduce((s, b) => s + b.lungimeUtilizata, 0);
    const rebutTotal = bare.reduce((s, b) => s + b.rebut, 0);
    const rebutReutilizabilTotal = bare.filter((b) => b.rebutReutilizabil).reduce((s, b) => s + b.rebut, 0);
    const rebutNerecuperabilTotal = rebutTotal - rebutReutilizabilTotal;
    const procentRebut = bare.length > 0 ? (rebutTotal / (bare.length * lungimeStoc)) * 100 : 0;
    const masaRebutNerecuperabil = masaBara(diametru, rebutNerecuperabilTotal);

    grupuri.push({
      diametru,
      clasaOtel,
      bare,
      numarBare: bare.length,
      lungimeUtilizataTotala,
      rebutTotal,
      rebutReutilizabilTotal,
      rebutNerecuperabilTotal,
      procentRebut,
      masaRebutNerecuperabil,
    });

    totalBareStoc += bare.length;
    totalRebut += rebutTotal;
    totalRebutReutilizabil += rebutReutilizabilTotal;
    totalRebutNerecuperabil += rebutNerecuperabilTotal;
    masaRebutNerecuperabilTotal += masaRebutNerecuperabil;
  }

  grupuri.sort((a, b) => a.diametru - b.diametru || a.clasaOtel.localeCompare(b.clasaOtel));
  bareRespinse.sort((a, b) => a.marca - b.marca);

  const procentRebutGlobal = totalBareStoc > 0 ? (totalRebut / (totalBareStoc * lungimeStoc)) * 100 : 0;

  return {
    grupuri,
    bareRespinse,
    totalBareStoc,
    totalRebut,
    totalRebutReutilizabil,
    totalRebutNerecuperabil,
    procentRebutGlobal,
    masaRebutNerecuperabilTotal,
  };
}
