---
categorie: Rigips
capitol: 4. Investiție de bază
---

Compartimentări ușoare din gips-carton pe schelet metalic — tipurile `W10` și
`W12` din librăria de elemente, care până acum nu aveau nicio mapare și se
decontau cu zero. Placarea se măsoară pe ambele fețe (`sheathing_area_m2` e o
față, netă de goluri); scheletul și vata, o dată pe perete.

Grupul `rigips` rotește tipul de placă. Opțiunea implicită își poartă propriile
mapări, deci nu scoate niciun articol existent.

Prețuri orientative, nu cotații.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0022_GK01_STD | GK01 STD | PLACARE CU GIPS-CARTON STANDARD 12.5 MM PE SCHELET METALIC, ROSTURI CHITUITE | mp | 28 | 22 | 1 | 2 | estimare | 2026-09 |
| 0022_GK02_SCH | GK02 SCH | SCHELET METALIC CW/UW 75 MM PENTRU PERETI DE COMPARTIMENTARE, MONTAJ SI FIXARE | mp | 24 | 18 | 1 | 2 | estimare | 2026-09 |
| 0022_GK03_IZO | GK03 IZO | VATA MINERALA 50 MM IN SCHELETUL PERETILOR DE GIPS-CARTON | mp | 16 | 7 | 0 | 1.5 | estimare | 2026-09 |
| 0022_GK04_RU | GK04 RU | PLACARE CU GIPS-CARTON REZISTENT LA UMEZEALA 12.5 MM PE SCHELET METALIC | mp | 36 | 22 | 1 | 2 | estimare | 2026-09 |
| 0022_GK05_RF | GK05 RF | PLACARE CU GIPS-CARTON REZISTENT LA FOC 12.5 MM PE SCHELET METALIC | mp | 42 | 24 | 1 | 2 | estimare | 2026-09 |
| 0022_GK06_DBL | GK06 DBL | DUBLA PLACARE CU GIPS-CARTON 2X12.5 MM PE FIECARE FATA, ROSTURI DECALATE | mp | 54 | 38 | 1.5 | 3 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|---|
| 0022_GK02_SCH | wall | W10 |  |  |  | formula | sheathing_area_m2 |  |
| 0022_GK03_IZO | wall | W10 |  |  |  | formula | sheathing_area_m2 |  |
| 0022_GK02_SCH | wall | W12 |  |  |  | formula | sheathing_area_m2 |  |
| 0022_GK03_IZO | wall | W12 |  |  |  | formula | sheathing_area_m2 |  |
| 0022_GK01_STD | wall | W10 |  |  | rigips:standard | formula | sheathing_area_m2 * 2 |  |
| 0022_GK01_STD | wall | W12 |  |  | rigips:standard | formula | sheathing_area_m2 * 2 |  |
| 0022_GK04_RU | wall | W10 |  |  | rigips:ru | formula | sheathing_area_m2 * 2 |  |
| 0022_GK04_RU | wall | W12 |  |  | rigips:ru | formula | sheathing_area_m2 * 2 |  |
| 0022_GK05_RF | wall | W10 |  |  | rigips:rf | formula | sheathing_area_m2 * 2 |  |
| 0022_GK05_RF | wall | W12 |  |  | rigips:rf | formula | sheathing_area_m2 * 2 |  |
| 0022_GK06_DBL | wall | W10 |  |  | rigips:dubla | formula | sheathing_area_m2 * 2 |  |
| 0022_GK06_DBL | wall | W12 |  |  | rigips:dubla | formula | sheathing_area_m2 * 2 |  |
