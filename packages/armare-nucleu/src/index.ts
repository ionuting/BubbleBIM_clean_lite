/**
 * @armare/nucleu — logica de domeniu a configuratorului de armare.
 * Punct unic de export pentru consumatori (web, Node, Tauri, backend).
 */

// Geometrie
export * from "./geometrie/vector";
export * from "./geometrie/polilinie";
export * from "./geometrie/transform";

// Snap
export * from "./snap/snap";
export * from "./snap/ancoraForma";

// Elevație
export * from "./elevatie/geometrie";
export * from "./elevatie/niveluri";

// Model
export * from "./model/tipuri";
export * from "./model/otel";

// Extras de armare
export * from "./extras/extras";
export * from "./extras/tabelLayout";
export * from "./extras/exportFods";
export * from "./extras/exportJson";
export * from "./extras/optimizareStoc";

// Ancoraj (Eurocod 2)
export * from "./ancoraj/ancoraj";

// Proiect (salvare / încărcare)
export * from "./proiect/proiect";

// Forme
export * from "./forme/indoire";
export * from "./forme/ciocuri";
export * from "./forme/catalog";
export * from "./forme/vedereSimbol";

// Cote
export * from "./cote/cote";

// DXF
export * from "./dxf/exportDxf";
export * from "./dxf/importDxf";

// Cofraj și adnotații
export * from "./model/cofraj";

// Array pe path
export * from "./array-path/arrayPath";

// Formatare etichete
export * from "./label/formateazaLabel";
export * from "./label/etichetaBara";

// Cartuș (title block) pentru printare
export * from "./cartus/cartus";
export * from "./cartus/dxfCartus";

// Layout (paper space) și viewporturi
export * from "./layout/layout";
export * from "./layout/migrare";

// Utilitar: generează un id unic simplu pentru forme noi.
export function idNou(prefix = "forma"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
