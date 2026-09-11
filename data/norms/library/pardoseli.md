---
categorie: Pardoseli
capitol: 4. Investiție de bază
---

Finisajul de călcare, măsurat pe aria camerei. Nu exista până acum în deviz —
adăugarea lui ridică baseline-ul oricărui proiect, ceea ce e corect: o casă fără
pardoseală nu e un model de cost complet. Opțiunea `fara` o scoate la loc.

Prețuri orientative, nu cotații.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0023_PD01_LAM | PD01 LAM | PARCHET LAMINAT CLASA 32, CU FOLIE SI IZOFON, MONTAJ FLOTANT INCLUSIV PLINTA | mp | 85 | 32 | 1 | 4 | estimare | 2026-09 |
| 0023_PD02_STR | PD02 STR | PARCHET STRATIFICAT CU STRAT DE UZURA DIN LEMN, MONTAJ FLOTANT INCLUSIV PLINTA | mp | 175 | 42 | 1 | 5 | estimare | 2026-09 |
| 0023_PD03_GRE | PD03 GRE | PARDOSELI DIN GRESIE PORTELANATA LIPITA CU ADEZIV, INCLUSIV ROSTUIRE SI PLINTA | mp | 120 | 78 | 2 | 6 | estimare | 2026-09 |
| 0023_PD04_LVT | PD04 LVT | PARDOSEALA DIN VINIL LVT LIPIT PE SUPORT EGALIZAT, INCLUSIV PLINTA | mp | 140 | 48 | 1 | 4 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|---|
| 0023_PD01_LAM | room | * |  |  | pardoseala:parchet_laminat | area |  |  |
| 0023_PD02_STR | room | * |  |  | pardoseala:parchet_stratificat | area |  |  |
| 0023_PD03_GRE | room | * |  |  | pardoseala:gresie | area |  |  |
| 0023_PD04_LVT | room | * |  |  | pardoseala:lvt | area |  |  |
