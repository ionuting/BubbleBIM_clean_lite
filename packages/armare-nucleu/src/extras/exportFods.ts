import type { Extras } from "./extras";

/**
 * Export al extrasului de armare în format FODS (Flat OpenDocument Spreadsheet) —
 * un singur fișier XML deschis nativ de LibreOffice Calc, cu FORMULE introduse
 * (L total = L/buc × Nr, Masă = Ø²·k·Ltot, totaluri = SUM).
 */

export interface OptExportFods {
  titlu?: string;
  /** Etichete personalizate pe cheie de coloană (marca, diam, tip, nr, lbuc, ltot, masa). */
  eticheteColoane?: Record<string, string>;
  /** Denumiri personalizate pentru coloana „Tip", pe marcă. */
  numeRanduri?: Record<number, string>;
}

/** Constantă masă: π/4 × densitate(7850 kg/m³) × 1e-6 = kg/(m·mm²). */
const K_MASA = 0.006165375;

const COLOANE = [
  { key: "marca", label: "Marcă" },
  { key: "diam", label: "Ø (mm)" },
  { key: "tip", label: "Tip" },
  { key: "nr", label: "Nr. buc." },
  { key: "lbuc", label: "L/buc (m)" },
  { key: "ltot", label: "L tot (m)" },
  { key: "masa", label: "Masă (kg)" },
] as const;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function celulaText(text: string, stil?: string): string {
  const s = stil ? ` table:style-name="${stil}"` : "";
  return `<table:table-cell${s} office:value-type="string"><text:p>${esc(text)}</text:p></table:table-cell>`;
}

function celulaNumar(valoare: number, display: string, stil?: string): string {
  const s = stil ? ` table:style-name="${stil}"` : "";
  return `<table:table-cell${s} office:value-type="float" office:value="${valoare}"><text:p>${esc(display)}</text:p></table:table-cell>`;
}

function celulaFormula(formula: string, cached: number, display: string, stil?: string): string {
  const s = stil ? ` table:style-name="${stil}"` : "";
  return `<table:table-cell${s} table:formula="of:=${esc(formula)}" office:value-type="float" office:value="${cached}"><text:p>${esc(display)}</text:p></table:table-cell>`;
}

function celulaGoala(): string {
  return `<table:table-cell/>`;
}

function rand(celule: string[]): string {
  return `<table:table-row>${celule.join("")}</table:table-row>`;
}

export function exportaExtrasFods(extras: Extras, opt: OptExportFods = {}): string {
  const { randuri, total } = extras;
  const eticheta = (key: string, def: string) => opt.eticheteColoane?.[key] ?? def;

  const randuriXml: string[] = [];

  // Rând titlu (opțional) → împinge antetul cu 1.
  let rndCurent = 1;
  if (opt.titlu) {
    randuriXml.push(rand([celulaText(opt.titlu, "ce-titlu")]));
    rndCurent++;
  }

  // Antet.
  randuriXml.push(
    rand(COLOANE.map((c) => celulaText(eticheta(c.key, c.label), "ce-antet"))),
  );
  rndCurent++;

  const primulData = rndCurent;
  const ultimulData = primulData + randuri.length - 1;

  for (const r of randuri) {
    const rn = rndCurent;
    const lbucM = r.lungimeBucata / 1000;
    const ltotM = r.lungimeTotala / 1000;
    const tip = opt.numeRanduri?.[r.marca] ?? r.numeForma;
    randuriXml.push(
      rand([
        celulaNumar(r.marca, String(r.marca)),
        celulaNumar(r.diametru, String(r.diametru)),
        celulaText(tip),
        celulaNumar(r.numar, String(r.numar)),
        celulaNumar(+lbucM.toFixed(3), lbucM.toFixed(3)),
        // L tot = L/buc × Nr
        celulaFormula(`[.E${rn}]*[.D${rn}]`, +ltotM.toFixed(3), ltotM.toFixed(3)),
        // Masă = Ø² × K × L tot
        celulaFormula(`[.B${rn}]*[.B${rn}]*${K_MASA}*[.F${rn}]`, +r.masaTotala.toFixed(2), r.masaTotala.toFixed(2)),
      ]),
    );
    rndCurent++;
  }

  // Rând total (SUM pe coloanele Nr, L tot, Masă).
  const ltotTotM = total.lungimeTotala / 1000;
  randuriXml.push(
    rand([
      celulaText("TOTAL", "ce-antet"),
      celulaGoala(),
      celulaGoala(),
      celulaFormula(`SUM([.D${primulData}:.D${ultimulData}])`, total.numarBare, String(total.numarBare), "ce-total"),
      celulaGoala(),
      celulaFormula(`SUM([.F${primulData}:.F${ultimulData}])`, +ltotTotM.toFixed(3), ltotTotM.toFixed(3), "ce-total"),
      celulaFormula(`SUM([.G${primulData}:.G${ultimulData}])`, +total.masaTotala.toFixed(2), total.masaTotala.toFixed(2), "ce-total"),
    ]),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:automatic-styles>
  <style:style style:name="ce-antet" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="ce-total" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="ce-titlu" style:family="table-cell"><style:text-properties fo:font-weight="bold" fo:font-size="14pt"/></style:style>
 </office:automatic-styles>
 <office:body>
  <office:spreadsheet>
   <table:table table:name="Extras">
    <table:table-column table:number-columns-repeated="${COLOANE.length}"/>
    ${randuriXml.join("\n    ")}
   </table:table>
  </office:spreadsheet>
 </office:body>
</office:document>`;
}
