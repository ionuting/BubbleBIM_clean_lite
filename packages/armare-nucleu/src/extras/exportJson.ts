import type { CaleArray } from "../array-path/arrayPath";
import { definitiePentru } from "../forme/catalog";
import type { FormaArmare, TabelExtrasConfig } from "../model/tipuri";
import { extrasArmare, type Extras } from "./extras";

export const FORMAT_EXTRAS_TABEL_JSON = "armare-extras-tabel" as const;
export const VERSIUNE_EXTRAS_TABEL_JSON = 1;

/** Fișier JSON portabil — extras + bare sursă + setări tabel. */
export interface ExtrasTabelExportJson {
  format: typeof FORMAT_EXTRAS_TABEL_JSON;
  versiune: typeof VERSIUNE_EXTRAS_TABEL_JSON;
  exportatLa: string;
  titlu?: string;
  extras: Extras;
  /** Setări tabel (fără id / foaie layout). */
  tabel?: Omit<TabelExtrasConfig, "id" | "foaieLayoutId">;
  forme: FormaArmare[];
  caleArrays: CaleArray[];
}

export class EroareExtrasTabelJson extends Error {}

export interface OptExportExtrasTabelJson {
  tabel?: Partial<Omit<TabelExtrasConfig, "id" | "foaieLayoutId">>;
  titlu?: string;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function marciDinExtras(extras: Extras): number[] {
  return extras.randuri.map((r) => r.marca);
}

/** Forme și array-path-uri care alimentează mărcile din extras. */
export function entitatiPentruMarciExtras(
  forme: FormaArmare[],
  caleArrays: CaleArray[],
  marci: number[],
): { forme: FormaArmare[]; caleArrays: CaleArray[] } {
  const set = new Set(marci);
  return {
    forme: forme
      .filter((f) => {
        if (!set.has(f.marca)) return false;
        if (f.excludeExtras) return false;
        return definitiePentru(f.tip).categorie !== "cofraj";
      })
      .map(clone),
    caleArrays: caleArrays
      .filter((c) => set.has(c.marca) && !c.excludeExtras)
      .map(clone),
  };
}

/** Construiește payload-ul de export JSON. */
export function exportExtrasTabelJson(
  forme: FormaArmare[],
  caleArrays: CaleArray[],
  opt: OptExportExtrasTabelJson = {},
): ExtrasTabelExportJson {
  const filtru = opt.tabel?.filtruMarci;
  const extrasComplet = extrasArmare(forme, caleArrays);
  const extras: Extras = filtru?.length
    ? (() => {
        const randuri = extrasComplet.randuri.filter((r) => filtru.includes(r.marca));
        const total = randuri.reduce(
          (acc, r) => ({
            numarBare: acc.numarBare + r.numar,
            lungimeTotala: acc.lungimeTotala + r.lungimeTotala,
            masaTotala: acc.masaTotala + r.masaTotala,
            masaPeDiametru: {
              ...acc.masaPeDiametru,
              [r.diametru]: (acc.masaPeDiametru[r.diametru] ?? 0) + r.masaTotala,
            },
          }),
          { numarBare: 0, lungimeTotala: 0, masaTotala: 0, masaPeDiametru: {} as Record<number, number> },
        );
        return { randuri, total };
      })()
    : extrasComplet;

  const marci = marciDinExtras(extras);
  const { forme: formeExp, caleArrays: caleExp } = entitatiPentruMarciExtras(forme, caleArrays, marci);

  let tabel: ExtrasTabelExportJson["tabel"];
  if (opt.tabel) {
    const { id: _id, foaieLayoutId: _foaie, ...rest } = opt.tabel as Partial<TabelExtrasConfig>;
    tabel = clone(rest) as ExtrasTabelExportJson["tabel"];
  }

  return {
    format: FORMAT_EXTRAS_TABEL_JSON,
    versiune: VERSIUNE_EXTRAS_TABEL_JSON,
    exportatLa: new Date().toISOString(),
    titlu: opt.titlu ?? opt.tabel?.titlu,
    extras,
    tabel,
    forme: formeExp,
    caleArrays: caleExp,
  };
}

export function serializeazaExtrasTabelJson(data: ExtrasTabelExportJson): string {
  return JSON.stringify(data, null, 2);
}

export function parseazaExtrasTabelJson(text: string): ExtrasTabelExportJson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EroareExtrasTabelJson("Fișier JSON invalid.");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new EroareExtrasTabelJson("Conținut JSON invalid.");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== FORMAT_EXTRAS_TABEL_JSON) {
    throw new EroareExtrasTabelJson("Nu este un fișier de extras de armare (format necunoscut).");
  }
  if (obj.versiune !== VERSIUNE_EXTRAS_TABEL_JSON) {
    throw new EroareExtrasTabelJson(`Versiune nesuportată: ${String(obj.versiune)}.`);
  }
  const extras = obj.extras as Extras | undefined;
  if (!extras || !Array.isArray(extras.randuri)) {
    throw new EroareExtrasTabelJson("Lipsesc datele extras (randuri).");
  }
  if (!Array.isArray(obj.forme)) {
    throw new EroareExtrasTabelJson("Lipsesc formele sursă.");
  }
  return {
    format: FORMAT_EXTRAS_TABEL_JSON,
    versiune: VERSIUNE_EXTRAS_TABEL_JSON,
    exportatLa: typeof obj.exportatLa === "string" ? obj.exportatLa : new Date().toISOString(),
    titlu: typeof obj.titlu === "string" ? obj.titlu : undefined,
    extras,
    tabel: obj.tabel as ExtrasTabelExportJson["tabel"],
    forme: obj.forme as FormaArmare[],
    caleArrays: Array.isArray(obj.caleArrays) ? (obj.caleArrays as CaleArray[]) : [],
  };
}

function alocaMarca(marciOcupate: Set<number>, preferata: number): number {
  if (!marciOcupate.has(preferata)) {
    marciOcupate.add(preferata);
    return preferata;
  }
  let m = 1;
  while (marciOcupate.has(m)) m++;
  marciOcupate.add(m);
  return m;
}

export interface ContextImportExtrasTabel {
  forme: FormaArmare[];
  caleArrays: CaleArray[];
  genId: (prefix?: string) => string;
}

export interface RezultatImportExtrasTabel {
  forme: FormaArmare[];
  caleArrays: CaleArray[];
  tabel: TabelExtrasConfig;
  mapareMarci: Record<number, number>;
}

/** Pregătește entități noi pentru proiect (id-uri și mărci unice). */
export function pregateteImportExtrasTabelJson(
  data: ExtrasTabelExportJson,
  ctx: ContextImportExtrasTabel,
): RezultatImportExtrasTabel {
  const marciOcupate = new Set([
    ...ctx.forme.map((f) => f.marca),
    ...ctx.caleArrays.map((c) => c.marca),
  ]);
  const mapMarca = new Map<number, number>();
  const marciSursa = new Set([
    ...data.forme.map((f) => f.marca),
    ...data.caleArrays.map((c) => c.marca),
    ...data.extras.randuri.map((r) => r.marca),
  ]);
  for (const m of marciSursa) {
    mapMarca.set(m, alocaMarca(marciOcupate, m));
  }
  const mapareMarci: Record<number, number> = {};
  for (const [k, v] of mapMarca) mapareMarci[k] = v;

  const forme = data.forme.map((f) => ({
    ...clone(f),
    id: ctx.genId("forma"),
    marca: mapMarca.get(f.marca) ?? f.marca,
  }));

  const caleArrays = data.caleArrays.map((c) => ({
    ...clone(c),
    id: ctx.genId("cale"),
    marca: mapMarca.get(c.marca) ?? c.marca,
  }));

  const numeRanduri: Record<number, string> = {};
  if (data.tabel?.numeRanduri) {
    for (const [k, v] of Object.entries(data.tabel.numeRanduri)) {
      const veche = Number(k);
      const noua = mapMarca.get(veche) ?? veche;
      numeRanduri[noua] = v;
    }
  }

  const filtruMarci = data.tabel?.filtruMarci?.map((m) => mapMarca.get(m) ?? m);

  const tabel: TabelExtrasConfig = {
    id: ctx.genId("tabel-extras"),
    pozitie: data.tabel?.pozitie ?? { x: 0, y: 0 },
    scalaUtilizator: data.tabel?.scalaUtilizator ?? 0.5,
    titlu: data.tabel?.titlu ?? data.titlu,
    eticheteColoane: data.tabel?.eticheteColoane
      ? clone(data.tabel.eticheteColoane)
      : undefined,
    numeRanduri: Object.keys(numeRanduri).length ? numeRanduri : undefined,
    coloaneAscunse: data.tabel?.coloaneAscunse ? [...data.tabel.coloaneAscunse] : undefined,
    filtruMarci,
    scalaAutoLayout: data.tabel?.scalaAutoLayout,
  };

  return { forme, caleArrays, tabel, mapareMarci };
}
