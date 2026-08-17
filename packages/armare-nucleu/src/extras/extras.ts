import { numarTotalCaleArray, sablonFormaDinCale, type CaleArray } from "../array-path/arrayPath";
import { definitiePentru, lungimeDesfasurata } from "../forme/catalog";
import { masaBara } from "../model/otel";
import { totalInstanteAxa, type FormaArmare, type TipForma } from "../model/tipuri";
// lungimeDesfasurata acum primește întreaga formă (include ciocurile).

/** Un rând din extrasul de armare (bar bending schedule). */
export interface RandExtras {
  marca: number;
  tip: TipForma;
  numeForma: string;
  diametru: number;
  /** Lungimea desfășurată a unei bucăți (mm) — a primului element cu această marcă. */
  lungimeBucata: number;
  numar: number;
  /** Lungimea totală = sumă(lungimeBucata_i × numar_i) pentru toate elementele cu această marcă. */
  lungimeTotala: number;
  /** Masa totală a poziției (kg). */
  masaTotala: number;
  /**
   * True dacă mai multe elemente cu aceeași marcă au diametru sau lungime/bucată diferite.
   * Indică o posibilă eroare de atribuire a mărcii.
   */
  conflictProprietati?: boolean;
}

/** Totalurile generale ale extrasului. */
export interface TotalExtras {
  numarBare: number;
  lungimeTotala: number;
  masaTotala: number;
  /** Masă pe diametru (kg), pentru centralizatorul pe diametre. */
  masaPeDiametru: Record<number, number>;
}

export interface Extras {
  randuri: RandExtras[];
  total: TotalExtras;
}

/**
 * Generează extrasul de armare pentru o listă de forme. Formele cu aceeași
 * marcă se cumulează într-un singur rând (numărul de bare se însumează, lungimea
 * totală se acumulează corect chiar dacă lungimile individuale diferă).
 */
function adaugaLaExtras(
  peMarci: Map<number, RandExtras>,
  marca: number,
  tip: TipForma,
  diametru: number,
  lungimeBucata: number,
  numar: number,
) {
  const existent = peMarci.get(marca);
  if (existent) {
    existent.numar += numar;
    // Acumulăm lungimea totală direct pentru a gestiona corect lungimi diferite pe același marcaj.
    existent.lungimeTotala += lungimeBucata * numar;
    // Detectăm conflict dacă diametrul sau lungimea per bucată diferă.
    if (existent.diametru !== diametru || Math.round(existent.lungimeBucata) !== Math.round(lungimeBucata)) {
      existent.conflictProprietati = true;
    }
  } else {
    peMarci.set(marca, {
      marca,
      tip,
      numeForma: definitiePentru(tip).nume,
      diametru,
      lungimeBucata,
      numar,
      lungimeTotala: lungimeBucata * numar,
      masaTotala: 0,
    });
  }
}

export function extrasArmare(forme: FormaArmare[], caleArrays: CaleArray[] = []): Extras {
  const peMarci = new Map<number, RandExtras>();

  for (const forma of forme) {
    if (forma.excludeExtras) continue;
    if (definitiePentru(forma.tip).categorie === "cofraj") continue;
    const diametru = forma.parametri.diametru ?? 0;
    const lungimeBucata = lungimeDesfasurata(forma);
    const instante = forma.array
      ? totalInstanteAxa(forma.array, "x") * totalInstanteAxa(forma.array, "y")
      : 1;
    const numar = Math.max(0, Math.round(forma.numar)) * instante;
    adaugaLaExtras(peMarci, forma.marca, forma.tip, diametru, lungimeBucata, numar);
  }

  for (const cale of caleArrays) {
    if (cale.excludeExtras) continue;
    const sablon = sablonFormaDinCale(cale);
    const diametru = sablon.parametri.diametru ?? 0;
    const lungimeBucata = lungimeDesfasurata(sablon);
    const numar = numarTotalCaleArray(cale);
    adaugaLaExtras(peMarci, cale.marca, cale.tipForma, diametru, lungimeBucata, numar);
  }

  const randuri = [...peMarci.values()].sort((a, b) => a.marca - b.marca);

  const total: TotalExtras = {
    numarBare: 0,
    lungimeTotala: 0,
    masaTotala: 0,
    masaPeDiametru: {},
  };

  for (const r of randuri) {
    // lungimeTotala deja acumulată în adaugaLaExtras; calculăm doar masa.
    r.masaTotala = masaBara(r.diametru, r.lungimeTotala);

    total.numarBare += r.numar;
    total.lungimeTotala += r.lungimeTotala;
    total.masaTotala += r.masaTotala;
    total.masaPeDiametru[r.diametru] =
      (total.masaPeDiametru[r.diametru] ?? 0) + r.masaTotala;
  }

  return { randuri, total };
}
