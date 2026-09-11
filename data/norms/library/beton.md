---
categorie: Beton
capitol: 4. Investiție de bază
---

Clasa betonului și modul de punere în operă, ca alternativă la prepararea pe
șantier din normele de sâmburi și centuri. Grupul `beton` scoate cele două
articole de preparare (`0002_CA01D_02`, `0003_CA01D_02`) și pune în locul lor un
singur articol, indiferent dacă e stâlpișor sau centură — cofrajul și armătura
rămân pe normele lor.

Se aplică pe calea implicită, fără sistem. Sub `rc_frame` betonul de cadru are
propriul articol în `cadre-ba.md` și nu e rotit de aici.

Prețuri orientative, nu cotații.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0030_BT01_C25 | BT01 C25 | BETON GATA PREPARAT C25/30 TURNAT CU POMPA IN ELEMENTE VERTICALE SI ORIZONTALE | mc | 500 | 75 | 85 | 45 | estimare | 2026-09 |
| 0030_BT02_C30 | BT02 C30 | BETON GATA PREPARAT C30/37 TURNAT CU POMPA IN ELEMENTE VERTICALE SI ORIZONTALE | mc | 560 | 75 | 85 | 45 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|---|
| 0030_BT01_C25 | column | * |  |  | beton:c25_pompat | volume |  |  |
| 0030_BT01_C25 | ax | * |  |  | beton:c25_pompat | volume |  |  |
| 0030_BT01_C25 | beam | * |  |  | beton:c25_pompat | volume |  |  |
| 0030_BT02_C30 | column | * |  |  | beton:c30_pompat | volume |  |  |
| 0030_BT02_C30 | ax | * |  |  | beton:c30_pompat | volume |  |  |
| 0030_BT02_C30 | beam | * |  |  | beton:c30_pompat | volume |  |  |
