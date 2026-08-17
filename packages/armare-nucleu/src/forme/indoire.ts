/**
 * Reguli de îndoire (fasonare) a barelor conform SR EN 1992-1-1 (Eurocod 2),
 * Tabelul 8.1N — diametrul minim al dornului de îndoire.
 *
 *   - bare cu diametru ≤ 16 mm  →  φm,min = 4 · φ
 *   - bare cu diametru > 16 mm   →  φm,min = 7 · φ
 *
 * Raza de îndoire pe axa barei = φm,min / 2.
 */

/** Diametrul minim al dornului de îndoire (mm) pentru un diametru de bară dat. */
export function diametruDornMinim(diametruBara: number): number {
  return diametruBara <= 16 ? 4 * diametruBara : 7 * diametruBara;
}

/** Raza minimă de îndoire pe axa barei (mm), conform Eurocod 2. */
export function razaIndoireMinima(diametruBara: number): number {
  return diametruDornMinim(diametruBara) / 2;
}

/** Diametre uzuale de bare de armătură (mm) folosite în România. */
export const DIAMETRE_UZUALE = [6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32] as const;
