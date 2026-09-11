---
categorie: Faianta
capitol: 4. Investiție de bază
---

Placarea ceramică a pereților, măsurată ca perimetrul camerei pe înălțimea de
placare. Implicit `fara`, fiindcă faianța se pune doar în camerele umede: o
setezi pe baie și pe bucătărie prin proprietatea `spec_faianta` a camerei, nu pe
tot proiectul.

Înălțimea de placare NU mai e scrisă în formulă. Până în 2026-09 era `2.1`
fixat, ceea ce însemna și că restul peretelui se tencuia oricum pe toată
înălțimea — placarea și tencuiala se suprapuneau. Acum formula e
`perimeter_m * height_m` și înălțimea vine din BANDA camerei
(`covering_layers`, vezi `lib/zones/heightZones.ts`): pui faianță pe banda
0–1.5 m cu `spec = faianta:standard, tencuiala_int:fara`, iar banda de deasupra
se tencuiește normal. Fără benzi, o cameră cu faianță se placează pe toată
înălțimea — ceea ce e explicit, nu un 2.1 ascuns.

Prețuri orientative, nu cotații.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0024_FA01_STD | FA01 STD | PLACARE PERETI CU FAIANTA CERAMICA FORMAT UZUAL, LIPITA CU ADEZIV SI ROSTUITA | mp | 95 | 85 | 2 | 5 | estimare | 2026-09 |
| 0024_FA02_POR | FA02 POR | PLACARE PERETI CU GRESIE PORTELANATA, ROSTURI FINE, LIPITA CU ADEZIV FLEXIBIL | mp | 135 | 95 | 2 | 6 | estimare | 2026-09 |
| 0024_FA03_MAR | FA03 MAR | PLACARE PERETI CU PLACI MARE FORMAT PESTE 120X60 CM, MONTAJ IN DOI, ADEZIV C2TE | mp | 210 | 145 | 6 | 9 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|---|
| 0024_FA01_STD | room | * |  |  | faianta:standard | formula | perimeter_m * height_m |  |
| 0024_FA02_POR | room | * |  |  | faianta:portelanata | formula | perimeter_m * height_m |  |
| 0024_FA03_MAR | room | * |  |  | faianta:mare_format | formula | perimeter_m * height_m |  |
