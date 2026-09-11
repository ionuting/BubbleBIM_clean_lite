---
categorie: Tencuiala
capitol: 4. Investiție de bază
---

Tencuiala INTERIOARĂ se măsoară pe cameră (perimetru × înălțime). Cea
EXTERIOARĂ se măsoară pe nodul `shell` cu rolul `envelope`, adică pe conturul
real al clădirii — până în 2026-09 era luată tot de pe camere, deci fiecare
cameră interioară genera fațadă și suprafața ieșea de peste două ori mai mare
decât anvelopa.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0011_CF24A_02 | CF24A 02 | TENCUIELI INTERIOARE DIN IPSOS DE 1 CM GROSIME, AP LICATE MANUAL | mp | 20 | 28 | 2 | 3 | estimare (2025–2026) |  |
| 0011_CF06B1_82 | CF06B1 82 | TENCUIELI EXTERIOARE OBISNUITE,DRISCUITE PE ZIDURI ,IN GROSIME MEDIE DE 2,5CM | mp | 24 | 36 | 3 | 4 | estimare (2025–2026) |  |
| 0011_CF25MEC_02 | CF25MEC 02 | TENCUIELI INTERIOARE DIN IPSOS DE 1 CM APLICATE MECANIZAT CU POMPA | mp | 21 | 15 | 6 | 3 | estimare | 2026-09 |
| 0011_CF10VC_02 | CF10VC 02 | TENCUIELI INTERIOARE DIN MORTAR DE VAR-CIMENT DE 2 CM GROSIME, DRISCUITE | mp | 17 | 32 | 2 | 3 | estimare | 2026-09 |
| 0011_CF35DEC_02 | CF35DEC 02 | TENCUIALA DECORATIVA SILICONICA STRUCTURATA 1.5 MM PE TERMOSISTEM, CU AMORSA | mp | 42 | 34 | 2 | 4 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|---|
| 0011_CF24A_02 | room | * |  |  |  | formula | perimeter_m * height_m |  |
| 0011_CF25MEC_02 | room | * |  |  | tencuiala_int:ipsos_mecanizat | formula | perimeter_m * height_m |  |
| 0011_CF10VC_02 | room | * |  |  | tencuiala_int:var_ciment | formula | perimeter_m * height_m |  |
| 0011_CF06B1_82 | shell | envelope |  |  |  | area |  |  |
| 0011_CF35DEC_02 | shell | envelope |  |  | tencuiala_ext:decorativa | area |  |  |
