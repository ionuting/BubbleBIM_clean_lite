---
categorie: Vopsitorii
capitol: 4. Investiție de bază
---

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0013_CN05A_02 | CN05A 02 | VOPSITORII INTERIOARE CU VOPSELE LAVABILE ACRILICE APLICATE PE SUPORT DE GLET DE IPSOS | mp | 11 | 16 | 1 | 1 | estimare (2025–2026) |  |
| 0013_CN11A_02 | CN11A 02 | VOPSITORII EXTERIOARE CU VOPSELE LAVABILE ACRILICE APLICATE PE TENCUIALA DRISCUITA | mp | 17 | 20 | 1 | 2 | estimare (2025–2026) |  |
| 0013_CN20PR_02 | CN20PR 02 | VOPSITORII INTERIOARE CU LAVABILA PREMIUM REZISTENTA LA SPALARE, DOUA STRATURI | mp | 19 | 18 | 1 | 1.5 | estimare | 2026-09 |
| 0013_CN30SIL_02 | CN30SIL 02 | VOPSITORII EXTERIOARE CU VOPSEA SILICATICA PERMEABILA LA VAPORI, DOUA STRATURI | mp | 28 | 22 | 1 | 2 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|---|
| 0013_CN05A_02 | room | * |  |  |  | formula | perimeter_m * height_m |  |
| 0013_CN05A_02 | room | * |  | timber_frame |  | formula | perimeter_m * height_m |  |
| 0013_CN05A_02 | room | * |  | clt |  | formula | perimeter_m * height_m |  |
| 0013_CN20PR_02 | room | * |  |  | vopsitorie:premium | formula | perimeter_m * height_m |  |
| 0013_CN05A_02 | room | * |  |  | vopsitorie:silicatica | formula | perimeter_m * height_m |  |
| 0013_CN11A_02 | shell | envelope |  |  |  | area |  |  |
| 0013_CN11A_02 | shell | envelope |  |  | vopsitorie:premium | area |  |  |
| 0013_CN30SIL_02 | shell | envelope |  |  | vopsitorie:silicatica | area |  |  |
