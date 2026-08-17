import { CLASA_OTEL_CALE_ARRAY_IMPLICITA, type CaleArray } from "../array-path/arrayPath";
import type { FormaArmare, EtichetaBara, Hasura, CadruPrintare, SimbolDistributie, SimbolBara, CotaElevatie, SimbolSectiune, TabelExtrasConfig } from "../model/tipuri";
import type { Adnotatie, CotaLibera, LinieAxa, Stalp, Dreptunghi } from "../model/cofraj";
import { OPTIUNI_ANCORAJ_IMPLICITE, type OptiuniAncoraj } from "../ancoraj/ancoraj";
import type { GeometrieDxf, SubstratImport } from "../dxf/importDxf";
import type { SablonCartus } from "../cartus/cartus";
import type { ConfigLayout, RegiuneModel, LegendaLayoutConfig, EtichetaLayoutConfig } from "../layout/layout";
import { CONFIG_LAYOUT_IMPLICIT } from "../layout/layout";
import { migrareCadreLaLayout } from "../layout/migrare";

/**
 * Formatul de proiect salvabil/încărcabil. Conține tot ce e necesar pentru a
 * reproduce planșa: formele parametrice, opțiunile de ancoraj, substratul DXF
 * și setările de lucru. Versionat pentru migrări viitoare.
 */
export const VERSIUNE_PROIECT = 2;

export interface Proiect {
  versiune: number;
  forme: FormaArmare[];
  adnotatii: Adnotatie[];
  coteLibere: CotaLibera[];
  etichete: EtichetaBara[];
  hasuri: Hasura[];
  axe: LinieAxa[];
  stalpi: Stalp[];
  dreptunghiuri: Dreptunghi[];
  /** @deprecated Folosiți regiuniModel + layout. Păstrat pentru compatibilitate la încărcare v1. */
  cadre: CadruPrintare[];
  /** Regiuni sursă pe canvas Model (pentru viewporturi). */
  regiuniModel: RegiuneModel[];
  /** Compunere planșe pe canvas Layout. */
  layout: ConfigLayout;
  simboluriDistributie: SimbolDistributie[];
  caleArrays: CaleArray[];
  simboluriBare: SimbolBara[];
  coteElevatie: CotaElevatie[];
  simboluriSectiuni: SimbolSectiune[];
  ancoraj: OptiuniAncoraj;
  substrat: SubstratImport | null;
  geometriiDxf: GeometrieDxf[];
  sabloaneCartus: SablonCartus[];
  tabeleExtras: TabelExtrasConfig[];
  legendeLayout: LegendaLayoutConfig[];
  eticheteLayout: EtichetaLayoutConfig[];
  pasGrila: number;
  snapActiv: boolean;
  /**
   * Clasă de oțel implicită a proiectului, folosită pentru formele care nu au
   * o clasă proprie (cale-array-urile își păstrează propria clasă setată per
   * distribuție). Folosită la etichete și la optimizarea tăierii din stoc.
   */
  clasaOtelImplicita: string;
}

/** Eroare ridicată la încărcarea unui fișier de proiect invalid. */
export class EroareProiect extends Error {}

function normalizeazaProiect(partial: Partial<Proiect>): Proiect {
  const cadre = partial.cadre ?? [];
  let regiuniModel = partial.regiuniModel ?? [];
  let layout = partial.layout ?? { ...CONFIG_LAYOUT_IMPLICIT };

  if (regiuniModel.length === 0 && layout.foi.length === 0 && cadre.length > 0) {
    const migrat = migrareCadreLaLayout(cadre);
    regiuniModel = migrat.regiuniModel;
    layout = migrat.layout;
  }

  return {
    versiune: VERSIUNE_PROIECT,
    forme: partial.forme ?? [],
    adnotatii: partial.adnotatii ?? [],
    coteLibere: partial.coteLibere ?? [],
    etichete: partial.etichete ?? [],
    hasuri: partial.hasuri ?? [],
    axe: partial.axe ?? [],
    stalpi: partial.stalpi ?? [],
    dreptunghiuri: partial.dreptunghiuri ?? [],
    cadre: [],
    regiuniModel,
    layout,
    simboluriDistributie: partial.simboluriDistributie ?? [],
    caleArrays: partial.caleArrays ?? [],
    simboluriBare: partial.simboluriBare ?? [],
    coteElevatie: partial.coteElevatie ?? [],
    simboluriSectiuni: partial.simboluriSectiuni ?? [],
    ancoraj: partial.ancoraj ?? OPTIUNI_ANCORAJ_IMPLICITE,
    substrat: partial.substrat ?? null,
    geometriiDxf: partial.geometriiDxf ?? [],
    sabloaneCartus: partial.sabloaneCartus ?? [],
    tabeleExtras: partial.tabeleExtras ?? [],
    legendeLayout: partial.legendeLayout ?? [],
    eticheteLayout: partial.eticheteLayout ?? [],
    pasGrila: partial.pasGrila ?? 25,
    snapActiv: partial.snapActiv ?? true,
    clasaOtelImplicita: partial.clasaOtelImplicita ?? CLASA_OTEL_CALE_ARRAY_IMPLICITA,
  };
}

/** Construiește un proiect complet din valori parțiale (restul = implicite). */
export function creeazaProiect(partial: Partial<Proiect> = {}): Proiect {
  return normalizeazaProiect(partial);
}

/** Serializează un proiect în JSON (indentat, lizibil). */
export function serializeazaProiect(p: Proiect): string {
  return JSON.stringify(p, null, 2);
}

/**
 * Parsează și validează un proiect dintr-un șir JSON. Aruncă `EroareProiect`
 * dacă fișierul e corupt sau nu are structura așteptată. Pregătit pentru migrări
 * pe baza câmpului `versiune`.
 */
export function deserializeazaProiect(text: string): Proiect {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new EroareProiect("Fișier proiect invalid (JSON corupt).");
  }
  if (typeof data !== "object" || data === null) {
    throw new EroareProiect("Conținut de proiect invalid.");
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.forme)) {
    throw new EroareProiect("Proiectul nu conține lista de forme.");
  }

  const layoutRaw = obj.layout as ConfigLayout | undefined;

  return normalizeazaProiect({
    forme: obj.forme as FormaArmare[],
    adnotatii: Array.isArray(obj.adnotatii) ? (obj.adnotatii as Adnotatie[]) : [],
    coteLibere: Array.isArray(obj.coteLibere) ? (obj.coteLibere as CotaLibera[]) : [],
    etichete: Array.isArray(obj.etichete) ? (obj.etichete as EtichetaBara[]) : [],
    hasuri: Array.isArray(obj.hasuri) ? (obj.hasuri as Hasura[]) : [],
    axe: Array.isArray(obj.axe) ? (obj.axe as LinieAxa[]) : [],
    stalpi: Array.isArray(obj.stalpi) ? (obj.stalpi as Stalp[]) : [],
    dreptunghiuri: Array.isArray(obj.dreptunghiuri) ? (obj.dreptunghiuri as Dreptunghi[]) : [],
    cadre: Array.isArray(obj.cadre) ? (obj.cadre as CadruPrintare[]) : [],
    regiuniModel: Array.isArray(obj.regiuniModel) ? (obj.regiuniModel as RegiuneModel[]) : [],
    layout: layoutRaw && Array.isArray(layoutRaw.foi) ? layoutRaw : undefined,
    simboluriDistributie: Array.isArray(obj.simboluriDistributie) ? (obj.simboluriDistributie as SimbolDistributie[]) : [],
    caleArrays: Array.isArray(obj.caleArrays) ? (obj.caleArrays as CaleArray[]) : [],
    simboluriBare: Array.isArray(obj.simboluriBare) ? (obj.simboluriBare as SimbolBara[]) : [],
    coteElevatie: Array.isArray(obj.coteElevatie) ? (obj.coteElevatie as CotaElevatie[]) : [],
    simboluriSectiuni: Array.isArray(obj.simboluriSectiuni) ? (obj.simboluriSectiuni as SimbolSectiune[]) : [],
    ancoraj: (obj.ancoraj as OptiuniAncoraj | undefined) ?? undefined,
    substrat: (obj.substrat as SubstratImport | null) ?? null,
    geometriiDxf: Array.isArray(obj.geometriiDxf) ? (obj.geometriiDxf as GeometrieDxf[]) : [],
    sabloaneCartus: Array.isArray(obj.sabloaneCartus) ? (obj.sabloaneCartus as SablonCartus[]) : [],
    tabeleExtras: Array.isArray(obj.tabeleExtras) ? (obj.tabeleExtras as TabelExtrasConfig[]) : [],
    legendeLayout: Array.isArray(obj.legendeLayout) ? (obj.legendeLayout as LegendaLayoutConfig[]) : [],
    eticheteLayout: Array.isArray(obj.eticheteLayout) ? (obj.eticheteLayout as EtichetaLayoutConfig[]) : [],
    pasGrila: typeof obj.pasGrila === "number" ? obj.pasGrila : undefined,
    snapActiv: typeof obj.snapActiv === "boolean" ? obj.snapActiv : undefined,
    clasaOtelImplicita: typeof obj.clasaOtelImplicita === "string" ? obj.clasaOtelImplicita : undefined,
  });
}
