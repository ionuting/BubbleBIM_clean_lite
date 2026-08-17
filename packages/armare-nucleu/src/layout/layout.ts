import type { Vector2 } from "../geometrie/vector";
import {
  DIMENSIUNI_HARTIE,
  factorScara,
  type FormatHartie,
  type OrientareHartie,
  type ScaraConventionala,
} from "../model/tipuri";

/** Regiune dreptunghiulară pe canvasul Model — sursă pentru viewporturi. */
export interface RegiuneModel {
  id: string;
  nume: string;
  /** Colț stânga-jos în mm model. */
  pozitie: Vector2;
  latime: number;
  inaltime: number;
  scaraSugerata?: ScaraConventionala;
}

/** Viewport pe o foaie layout — afișează o zonă din model la scară. */
export interface Viewport {
  id: string;
  nume?: string;
  /** Colț stânga-jos pe foaie, mm hârtie. */
  pozitie: Vector2;
  latime: number;
  inaltime: number;
  scara: ScaraConventionala;
  regiuneModelId?: string;
  /** Dreptunghi liber în model (mm), dacă nu e legat de regiune. */
  sursaRect?: { x: number; y: number; latime: number; inaltime: number };
  blocat?: boolean;
  offsetModel?: Vector2;
}

/** Foaie de print pe canvasul Layout (1 mm = 1 mm hârtie). */
export interface CartusLayoutConfig {
  /** Implicit true dacă există sablonId. */
  vizibil?: boolean;
  /** Colț stânga-jos pe foaie, mm hârtie. */
  pozitie?: Vector2;
  /** Dimensiuni cartuș pe hârtie (mm). Implicit = dimensiunea foii. */
  latime?: number;
  inaltime?: number;
}

/** Legendă culori Ø — plasată pe foaie layout. */
export interface LegendaLayoutConfig {
  id: string;
  foaieLayoutId: string;
  /** Colț stânga-jos pe foaie, mm hârtie. */
  pozitie: Vector2;
  scalaUtilizator?: number;
  titlu?: string;
  /** Lățime de bază (mm hârtie), înainte de scală. */
  latime?: number;
}

/** Etichetă text liberă pe foaie layout. */
export interface EtichetaLayoutConfig {
  id: string;
  foaieLayoutId: string;
  pozitie: Vector2;
  text: string;
  /** Dimensiune font pe hârtie (mm). */
  marime?: number;
  bold?: boolean;
  culoare?: string;
  aliniere?: "left" | "center" | "right";
}

export interface FoaieLayout {
  id: string;
  nume: string;
  format: FormatHartie;
  orientare: OrientareHartie;
  /** Poziție colț stânga-jos pe canvas layout (mm). */
  pozitie: Vector2;
  latimeCustom?: number;
  inaltimeCustom?: number;
  sablonId?: string;
  valoriCampuri?: Record<string, string>;
  /** Poziție/dimensiune cartuș pe foaie (implicit full-bleed). */
  cartusLayout?: CartusLayoutConfig;
  viewporturi: Viewport[];
}

export interface ConfigLayout {
  foi: FoaieLayout[];
  /** Spațiere între foi la aranjare automată (mm). */
  distantaFoi?: number;
}

export const REGIUNE_MODEL_IMPLICITA: Omit<RegiuneModel, "id" | "pozitie" | "latime" | "inaltime"> = {
  nume: "New region",
  scaraSugerata: "1:50",
};

export const FOAIE_LAYOUT_IMPLICITA: Omit<FoaieLayout, "id" | "pozitie" | "viewporturi"> = {
  nume: "New sheet",
  format: "A3",
  orientare: "landscape",
};

export const VIEWPORT_IMPLICIT: Omit<Viewport, "id" | "pozitie" | "latime" | "inaltime"> = {
  scara: "1:50",
};

export const CONFIG_LAYOUT_IMPLICIT: ConfigLayout = {
  foi: [],
  distantaFoi: 20,
};

/** Dimensiuni hârtie ale unei foi layout (mm, 1:1). */
export function dimensiuniFoaieLayout(foaie: FoaieLayout): { latime: number; inaltime: number } {
  if (foaie.format === "custom") {
    return {
      latime: foaie.latimeCustom ?? 420,
      inaltime: foaie.inaltimeCustom ?? 297,
    };
  }
  const dim = DIMENSIUNI_HARTIE[foaie.format];
  return foaie.orientare === "landscape"
    ? { latime: dim.latime, inaltime: dim.inaltime }
    : { latime: dim.inaltime, inaltime: dim.latime };
}

export interface RectModel {
  x: number;
  y: number;
  latime: number;
  inaltime: number;
}

/** Rezolvă dreptunghiul sursă din model pentru un viewport. */
export function sursaViewport(
  vp: Viewport,
  regiuni: RegiuneModel[],
): RectModel | null {
  if (vp.regiuneModelId) {
    const r = regiuni.find((x) => x.id === vp.regiuneModelId);
    if (!r) return null;
    return { x: r.pozitie.x, y: r.pozitie.y, latime: r.latime, inaltime: r.inaltime };
  }
  if (vp.sursaRect) return vp.sursaRect;
  return null;
}

/** Transform Konva pentru conținut model într-un viewport (y-sus în model → Konva). */
export function transformViewport(
  sursa: RectModel,
  vp: Viewport,
): { scale: number; offsetX: number; offsetY: number } {
  const f = factorScara(vp.scara);
  const scale = 1 / f;
  const modelW = vp.latime * f;
  const modelH = vp.inaltime * f;
  const panX = vp.offsetModel?.x ?? 0;
  const panY = vp.offsetModel?.y ?? 0;
  const originX = sursa.x + (sursa.latime - modelW) / 2 + panX;
  const originY = sursa.y + (sursa.inaltime - modelH) / 2 + panY;
  return {
    scale,
    offsetX: -originX * scale,
    offsetY: originY * scale + vp.inaltime,
  };
}

/** Dimensiuni viewport pe hârtie (mm) derivate din sursa model și scară. */
export function dimensiuniViewportDinSursa(
  sursa: RectModel,
  scara: ScaraConventionala,
): { latime: number; inaltime: number } {
  const f = factorScara(scara);
  return {
    latime: sursa.latime / f,
    inaltime: sursa.inaltime / f,
  };
}

/** Găsește foaia care conține un viewport (după id viewport). */
export function foaieCuViewport(
  layout: ConfigLayout,
  viewportId: string,
): FoaieLayout | undefined {
  return layout.foi.find((f) => f.viewporturi.some((v) => v.id === viewportId));
}
