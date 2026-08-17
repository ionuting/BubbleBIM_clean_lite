import type { CadruPrintare } from "../model/tipuri";
import { dimensiuniCadru } from "../model/tipuri";
import type { ConfigLayout, FoaieLayout, RegiuneModel } from "./layout";
import { CONFIG_LAYOUT_IMPLICIT, dimensiuniFoaieLayout } from "./layout";

function dimensiuniHartieCadru(cadru: CadruPrintare): { w: number; h: number } {
  const foaieTemp: FoaieLayout = {
    id: "",
    nume: "",
    format: cadru.format,
    orientare: cadru.orientare,
    pozitie: { x: 0, y: 0 },
    latimeCustom: cadru.latimeCustom,
    inaltimeCustom: cadru.inaltimeCustom,
    viewporturi: [],
  };
  const dim = dimensiuniFoaieLayout(foaieTemp);
  return { w: dim.latime, h: dim.inaltime };
}

export interface RezultatMigrareLayout {
  regiuniModel: RegiuneModel[];
  layout: ConfigLayout;
}

/** Convertește cadrele v1 (model print) în regiuni model + foi layout. */
export function migrareCadreLaLayout(cadre: CadruPrintare[]): RezultatMigrareLayout {
  if (cadre.length === 0) {
    return { regiuniModel: [], layout: { ...CONFIG_LAYOUT_IMPLICIT } };
  }

  const distanta = CONFIG_LAYOUT_IMPLICIT.distantaFoi ?? 20;
  const regiuniModel: RegiuneModel[] = [];
  const foi: FoaieLayout[] = [];
  let cursorX = 0;

  for (const cadru of cadre) {
    const dimModel = dimensiuniCadru(cadru);
    const paper = dimensiuniHartieCadru(cadru);
    const regiuneId = cadru.id.startsWith("cadru-") ? cadru.id.replace("cadru-", "regiune-") : `regiune-${cadru.id}`;

    regiuniModel.push({
      id: regiuneId,
      nume: cadru.nume,
      pozitie: { ...cadru.pozitie },
      latime: dimModel.latime,
      inaltime: dimModel.inaltime,
      scaraSugerata: cadru.scara,
    });

    const vpId = `vp-${cadru.id}`;
    foi.push({
      id: `foaie-${cadru.id}`,
      nume: cadru.nume,
      format: cadru.format,
      orientare: cadru.orientare,
      pozitie: { x: cursorX, y: 0 },
      latimeCustom: cadru.latimeCustom,
      inaltimeCustom: cadru.inaltimeCustom,
      sablonId: cadru.sablonId,
      valoriCampuri: cadru.valoriCampuri ? { ...cadru.valoriCampuri } : undefined,
      viewporturi: [
        {
          id: vpId,
          nume: cadru.nume,
          pozitie: { x: 0, y: 0 },
          latime: paper.w,
          inaltime: paper.h,
          scara: cadru.scara,
          regiuneModelId: regiuneId,
        },
      ],
    });

    cursorX += paper.w + distanta;
  }

  return {
    regiuniModel,
    layout: { foi, distantaFoi: distanta },
  };
}
