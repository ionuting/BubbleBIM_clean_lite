/**
 * Clean Lite: librăria de materiale și procese ține de modulul de cantități,
 * care e exclus din acest profil (vezi `quantityTakeoff.stub.ts`). Butonul care
 * o deschide e ascuns, deci panoul nu se montează niciodată — dar stubul există
 * ca importul din BubbleGraphPanel să nu tragă motorul de antemăsurători în
 * pachetul lite.
 */
export function LibraryPanel(_props: Record<string, unknown>): null {
  return null;
}
