---
categorie: Scări
capitol: 4. Investiție de bază
---

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0017_CA01D_02 | CA01D 02 | PREPARARE BETON PE SANTIER CU BETONIERA, BETON CLA SA C 20/16 | mc | 450 | 110 | 55 | 45 | estimare (2025–2026) |  |
| 0017_CB01C_02 | CB01C 02 | COFR DIN SCINDURI DE RASINOASE EL.TIP SPECIAL LA C ONSTRUCTII CU H<20M,EXCLUSIV SUSTINERILE | mp | 45 | 55 | 4 | 6 | estimare (2025–2026) |  |
| 0017_CC01A4_02 | CC01A4 02 | FASONAREA BARELOR DIN OTEL BETON PC PE SANTIER, AV AND D= 12,14,16 MM | kg | 5.2 | 1.8 | 0.2 | 0.3 | estimare (2025–2026) |  |

## Mapări BIM
| normId | nodeType | elementType | materialKey | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|
| 0017_CA01D_02 | stairwell | * |  | volume |  |  |
| 0017_CB01C_02 | stairwell | * |  | formula | length_m * width_m |  |
| 0017_CC01A4_02 | stairwell | * |  | formula | volume_m3 * 61.5 |  |

<!--
  Concrete volume comes straight from the solved geometry (waist slab + one
  wedge per step + landings), so it needs no coefficient.

  Formwork is measured as the soffit — the developed length of the flights times
  their width. It leaves out the side edges and the risers, so it reads slightly
  low for a stair with open sides.

  The reinforcement ratio of 61.5 kg/m³ is INHERITED FROM THE BEAM ARTICLES in
  centuri.md, not derived for stairs. Stairs are usually reinforced more heavily
  than a ring beam; replace it with the project's own figure before pricing.
-->
