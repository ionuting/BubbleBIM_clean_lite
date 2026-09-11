/**
 * impactFactors.ts — what one unit of a norm article costs BEYOND money:
 * embodied carbon, and the hours of work behind its labour price.
 *
 * ⚠️ ORDER-OF-MAGNITUDE FACTORS, NOT AN LCA
 * ─────────────────────────────────────────
 * The CO₂e figures are typical cradle-to-gate values (ICE / ÖKOBAUDAT class
 * averages, 2023–2025) applied to the article's unit, rounded on purpose so
 * they read as estimates. They let two scenarios be RANKED — timber vs.
 * masonry — not certified. Replace them with product EPDs before quoting a
 * number to anyone.
 *
 * Articles without a factor contribute 0 and are counted as uncovered, so a
 * comparison view can say "CO₂ covers 12 of 19 articles" instead of showing a
 * confident total that silently skipped a third of the building.
 *
 * Keyed by normId, like prices. Timber articles carry NEGATIVE stored-carbon
 * credit only where the class average conventionally includes it; here every
 * timber value is the fossil-only figure, so the ranking is conservative for
 * wood rather than flattering.
 */

/** kg CO₂e per article unit (mc / mp / ml / kg / buc as the article is measured). */
export const CO2_FACTORS_KG: Readonly<Record<string, number>> = {
  // ── Concrete C20/25 mixed on site (mc) — the same recipe under four category ids ──
  '0002_CA01D_02': 270,
  '0003_CA01D_02': 270,
  '0017_CA01D_02': 270,
  '0018_CA01D_02': 270,
  // ── Reinforcement steel, bent on site (kg) ──
  '0002_CC01A4_02': 1.99,
  '0002_CC01A1_02': 1.99,
  '0003_CC01A4_02': 1.99,
  '0003_CC01A1_02': 1.99,
  '0017_CC01A4_02': 1.99,
  '0018_CC01A4_02': 1.99,
  // ── Softwood board formwork (mp), reused several times → small per-use share ──
  '0002_CB01C_02': 1.6,
  '0003_CB01C_02': 1.6,
  '0017_CB01C_02': 1.6,
  '0018_CB01C_02': 1.6,
  // ── Masonry ──
  '0001_00201A01_02': 200,   // clay block masonry, per mc laid (blocks + mortar)
  '0016_CD03A_02': 260,      // solid fired brick, per mc
  // ── Bituminous emulsion damp-proofing (mp) ──
  '0001_RPCE26A_09': 0.9,
  '0016_RPCE26A_09': 0.9,
  // ── Timber floor and roof (mp) — fossil-only, no stored-carbon credit ──
  '0004_RPCH05A_91': 9,
  '0005_CE28A_02': 8,
  '0004_RPCE19C_09': 3.2,    // mineral wool, per mp of the laid thickness class
  // ── Metal roof sheet (mp) and its trims (ml) ──
  '0006_CE07A_02': 14,
  '0006_CE08A_02': 2.2,
  '0006_CE08B_02': 2.2,
  '0006_CE08C_02': 2.2,
  '0006_CE08D_02': 2.2,
  '0006_CE08E_02': 2.2,
  // ── Finishes (mp) ──
  '0007_CG01F1_82': 5.4,     // 3 cm gypsum self-levelling screed
  '0011_CF24A_02': 2.4,      // 1 cm gypsum plaster
  '0011_CF06B1_82': 5.6,     // cement-lime render
  '0016_00301E_02': 6.5,     // plinth render
  '0012_00107A011_02': 9.5,  // EPS ETICS incl. adhesive
  '0013_CN05A_02': 0.6,      // interior acrylic paint
  '0013_CN11A_02': 0.8,      // exterior acrylic paint
  // ── Misc ──
  '0015_CK26A_02': 1.8,      // PVC window sill, per ml
  // ── Timber framing (pereti-lemn.md) ──
  '0019_LF01_TF': 12,        // C24 studs & plates, per ml of 45×145 (0.0065 mc × ~1.8 t/mc fossil)
  '0019_LF02_OSB': 6.8,      // OSB/3 12 mm sheathing, per mp
  '0019_LF03_MW': 3.9,       // mineral wool 140 mm between studs, per mp
  '0019_LF04_GK': 3.1,       // 12.5 mm gypsum board, per mp
  '0019_LF05_VB': 0.4,       // vapour control membrane, per mp
  '0019_LF06_WB': 0.5,       // breather membrane, per mp
  '0019_LF07_TJ': 11,        // timber joists, per ml
  '0019_LF08_HDR': 22,       // double C24 / LVL header, per ml
  '0019_LF09_ANC': 1.1,      // M12 chemical anchors @ 600, per ml of plate
  '0019_LF10_FIX': 0.25,     // nails / screws / brackets, per stud
  // ── RC frame (cadre-ba.md) ──
  '0020_CA02C_02': 265,      // C25/30 pumped, per mc (cement-heavy mix)
  '0020_CB02A_02': 1.6,      // reusable steel formwork, per mp per use
  '0020_CC02C_02': 1.9,      // BST500 rebar, per kg
  '0020_CD01A_02': 240,      // vertically-perforated clay block infill, per mc
  '0020_CD02A_02': 9,        // precast RC lintel, per ml
  '0020_CD03A_02': 0.3,      // wall ties, per ml
  // ── CLT (clt.md) ──
  '0021_CLT01_PN': 90,       // CLT panel, per mc (fossil share of glue + drying + transport; biogenic C not netted)
  '0021_CLT02_CNC': 0.4,     // CNC machining, per ml
  '0021_CLT03_MNT': 1.2,     // crane assembly, per mp
  '0021_CLT04_CON': 1.5,     // galvanised bracket + screws, per piece
  '0021_CLT05_JNT': 0.6,     // screws + tape, per ml
  '0021_CLT06_GK': 3.1,      // gypsum board, per mp
  '0021_CLT07_FL': 16,       // CLT floor panel incl. assembly, per mp
};

/**
 * Site labour rate the deviz labour component is assumed to embed, lei per
 * hour, so `manoperă / rate` gives hours on site. Indicative for Romania
 * 2025–2026, editable in one place.
 */
export const LABOUR_RATE_LEI_PER_HOUR = 45;

export const co2FactorFor = (normId: string): number | undefined => CO2_FACTORS_KG[normId];
