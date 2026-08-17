import type { FormaArmare } from "../model/tipuri";
import type { CotaElevatie } from "../model/tipuri";
import type { Vector2 } from "../geometrie/vector";
import { rezolvaAncora } from "../snap/ancoraForma";

export interface GeometrieCotaElevatie {
  anchor: Vector2;
  offset: Vector2;
  tip: Vector2;
}

/** Calculează ancoră, offset și vârful simbolului (datum). */
export function geometrieCotaElevatie(
  cota: CotaElevatie,
  forme: FormaArmare[],
): GeometrieCotaElevatie {
  const offset = cota.offsetAncora ?? { x: 0, y: 0 };
  const punctAncora = cota.punctAncora ?? cota.pozitie;
  const anchor = cota.ref
    ? rezolvaAncora(forme, cota.ref, punctAncora)
    : punctAncora;
  const tip = { x: anchor.x + offset.x, y: anchor.y + offset.y };
  return { anchor, offset, tip };
}
