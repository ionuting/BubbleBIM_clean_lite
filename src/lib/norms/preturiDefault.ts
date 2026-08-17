/**
 * preturiDefault.ts — prețuri unitare ORIENTATIVE pentru articolele catalogului
 * `deviz-zidarie-confinata`, descompuse pe cele patru componente de deviz:
 * material + manoperă + utilaj + transport. Prețul unitar implicit = suma lor.
 *
 * ⚠️ AVERTISMENT — VALORI ORIENTATIVE, NU COTAȚII DE PIAȚĂ
 * ────────────────────────────────────────────────────────
 * Acestea sunt estimări de ordin de mărime pentru România (nivel ~2025–2026),
 * NU prețuri verificate dintr-o sursă oficială de piață. Prețurile reale variază
 * semnificativ cu regiunea, furnizorul, volumul, sezonul și cursul valutar.
 *
 * Sunt un PUNCT DE PORNIRE editabil, nu o bază pentru ofertare. Înainte de orice
 * utilizare comercială, actualizează-le cu prețuri din propriile devize /
 * oferte de furnizor. Toate valorile se pot suprascrie din panoul de prețuri.
 */

/** Componentele de deviz ale unui preț unitar (lei / unitatea articolului). */
export interface ComponentePret {
  material: number;
  manopera: number;
  utilaj: number;
  transport: number;
}

/** Suma componentelor = prețul unitar. */
export function totalPret(c: ComponentePret): number {
  return Math.round((c.material + c.manopera + c.utilaj + c.transport) * 100) / 100;
}

/**
 * Prețuri orientative per normId (catalog `deviz-zidarie-confinata`).
 * Valorile sunt rotunjite deliberat — semnalează că sunt estimări, nu cotații.
 */
export const PRETURI_DEFAULT_RO: Record<string, ComponentePret> = {
  // ── Zidărie ──
  // Zidărie Porotherm la pereți structurali (mc)
  '0001_00201A01_02': { material: 420, manopera: 240, utilaj: 25, transport: 40 },
  // Hidroizolație emulsie bituminoasă, 1 strat (mp)
  '0001_RPCE26A_09': { material: 14, manopera: 12, utilaj: 1, transport: 2 },

  // ── Stâlpișori ──
  // Preparare beton C20/25 pe șantier (mc)
  '0002_CA01D_02': { material: 450, manopera: 110, utilaj: 55, transport: 45 },
  // Cofraj scânduri rășinoase (mp)
  '0002_CB01C_02': { material: 45, manopera: 55, utilaj: 4, transport: 6 },
  // Fasonare oțel-beton PC, D=12 (kg)
  '0002_CC01A4_02': { material: 5.2, manopera: 1.8, utilaj: 0.2, transport: 0.3 },
  // Fasonare oțel-beton PC, D=6 (kg)
  '0002_CC01A1_02': { material: 5.4, manopera: 2.4, utilaj: 0.2, transport: 0.3 },

  // ── Centuri ──
  '0003_CA01D_02': { material: 450, manopera: 110, utilaj: 55, transport: 45 },
  '0003_CC01A4_02': { material: 5.2, manopera: 1.8, utilaj: 0.2, transport: 0.3 },
  '0003_CC01A1_02': { material: 5.4, manopera: 2.4, utilaj: 0.2, transport: 0.3 },
  '0003_CB01C_02': { material: 45, manopera: 55, utilaj: 4, transport: 6 },

  // ── Planșeu lemn ──
  // Planșeu de lemn, deschidere ≤ 4 m (mp)
  '0004_RPCH05A_91': { material: 190, manopera: 90, utilaj: 8, transport: 12 },
  // Termoizolație vată minerală (mp)
  '0004_RPCE19C_09': { material: 42, manopera: 22, utilaj: 1, transport: 4 },

  // ── Șarpantă ──
  // Șarpantă pe scaune, lemn ecarisat (mp)
  '0005_CE28A_02': { material: 130, manopera: 75, utilaj: 6, transport: 10 },

  // ── Învelitoare ──
  // Coame tablă tip Lindab (ml)
  '0006_CE08A_02': { material: 32, manopera: 18, utilaj: 1, transport: 3 },
  // Învelitoare tablă cutată tip Lindab (mp)
  '0006_CE07A_02': { material: 75, manopera: 45, utilaj: 3, transport: 6 },
  // Dolii (ml)
  '0006_CE08B_02': { material: 38, manopera: 20, utilaj: 1, transport: 3 },
  // Pazii (ml)
  '0006_CE08C_02': { material: 28, manopera: 16, utilaj: 1, transport: 2 },
  // Streșini (ml)
  '0006_CE08D_02': { material: 30, manopera: 18, utilaj: 1, transport: 3 },
  // Șorțuri (ml)
  '0006_CE08E_02': { material: 26, manopera: 15, utilaj: 1, transport: 2 },

  // ── Șapă egalizare ──
  // Șapă autonivelantă ipsos 3 cm (mp)
  '0007_CG01F1_82': { material: 34, manopera: 22, utilaj: 2, transport: 4 },

  // ── Tencuială ──
  // Tencuială interioară ipsos 1 cm (mp)
  '0011_CF24A_02': { material: 20, manopera: 28, utilaj: 2, transport: 3 },
  // Tencuială exterioară drișcuită (mp)
  '0011_CF06B1_82': { material: 24, manopera: 36, utilaj: 3, transport: 4 },

  // ── Termoizolație ──
  // Termoizolare fațadă, polistiren expandat (mp)
  '0012_00107A011_02': { material: 70, manopera: 48, utilaj: 3, transport: 6 },

  // ── Vopsitorii ──
  // Vopsitorii interioare lavabile acrilice (mp)
  '0013_CN05A_02': { material: 11, manopera: 16, utilaj: 1, transport: 1 },
  // Vopsitorii exterioare lavabile acrilice (mp)
  '0013_CN11A_02': { material: 17, manopera: 20, utilaj: 1, transport: 2 },

  // ── Diverse ──
  // Glafuri PVC montate la ferestre (ml)
  '0015_CK26A_02': { material: 34, manopera: 22, utilaj: 1, transport: 3 },

  // ── Soclu ──
  '0016_RPCE26A_09': { material: 14, manopera: 12, utilaj: 1, transport: 2 },
  // Zid cărămidă plină presată (mc)
  '0016_CD03A_02': { material: 520, manopera: 300, utilaj: 25, transport: 45 },
  // Tencuială soclu Baumit 3 cm (mp)
  '0016_00301E_02': { material: 38, manopera: 34, utilaj: 2, transport: 4 },
};

/** Prețul unitar orientativ (suma componentelor) pentru un articol, sau undefined. */
export function pretDefaultPentru(normId: string): number | undefined {
  const c = PRETURI_DEFAULT_RO[normId];
  return c ? totalPret(c) : undefined;
}

/** Map normId → preț unitar orientativ, pentru încărcare în masă. */
export function preturiDefaultTotale(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, c] of Object.entries(PRETURI_DEFAULT_RO)) out[id] = totalPret(c);
  return out;
}
