/** Densitatea oțelului de armătură (kg/m³). */
export const DENSITATE_OTEL = 7850;

/** Aria secțiunii unei bare (mm²) pentru un diametru dat. */
export function ariaBara(diametru: number): number {
  return (Math.PI * diametru * diametru) / 4;
}

/** Masa pe metru liniar (kg/m) pentru un diametru de bară dat. */
export function masaPeMetru(diametru: number): number {
  // arie [mm²] -> [m²] (×1e-6) × densitate [kg/m³] = kg/m
  return ariaBara(diametru) * 1e-6 * DENSITATE_OTEL;
}

/** Masa unei bare de lungime dată (kg). lungime în mm. */
export function masaBara(diametru: number, lungimeMm: number): number {
  return masaPeMetru(diametru) * (lungimeMm / 1000);
}
