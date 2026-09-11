---
categorie: Pereti CLT
capitol: 4. Investiție de bază
---

Panouri de lemn încleiat încrucișat (`clt`). Peretele e panelizat DERIVAT
(lib/framing/cltPanels): un panou până la lungimea de transport, goluri
decupate CNC, colțare pe rostul de bază, hold-down la capete de panou și la
glafuri, holzșuruburi + bandă pe rosturi. Măsurile: `panel_area_m2` (aria
brută a panourilor — ce facturează fabrica), `cut_length_m`,
`joint_length_m`, `connector_count`, `net_area_m2` (fața netă, pentru
placare). Termoizolația și tencuiala exterioară rămân pe regulile de cameră.

Tipurile CLT100/CLT120/CLT140 se descompun așa în orice proiect; sub sistemul
`clt` și un perete de zidărie (W15…W40, păstrat printr-un scenariu cu
`keepTypes`) se decontează ca panou de aceeași grosime.

Prețuri orientative, nu cotații.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0021_CLT01_PN | CLT01 PN | PANOURI CLT DIN MOLID C24, CALITATE INDUSTRIALA, LIVRATE LA SANTIER (VOLUM BRUT PANOU) | mc | 2100 | 0 | 0 | 120 | estimare | 2026-09 |
| 0021_CLT02_CNC | CLT02 CNC | PRELUCRARE CNC PANOURI CLT: DEBITARE CONTUR SI GOLURI | ml | 9 | 0 | 6 | 0 | estimare | 2026-09 |
| 0021_CLT03_MNT | CLT03 MNT | MONTAJ PANOURI CLT DE PERETE CU MACARAUA, POZITIONARE SI ANCORARE PROVIZORIE | mp | 4 | 32 | 22 | 0 | estimare | 2026-09 |
| 0021_CLT04_CON | CLT04 CON | COLTARE SI HOLD-DOWN DIN OTEL ZINCAT CU HOLZSURUBURI, LA BAZA PANOURILOR SI LA GOLURI | buc | 28 | 14 | 0.5 | 1 | estimare | 2026-09 |
| 0021_CLT05_JNT | CLT05 JNT | HOLZSURUBURI AUTOFILETANTE SI BANDA DE ETANSARE LA ROSTURI PANOU-PANOU SI PANOU-PLANSEU | ml | 12 | 9 | 0.3 | 0.5 | estimare | 2026-09 |
| 0021_CLT06_GK | CLT06 GK | PLACARE INTERIOARA CU GIPS-CARTON 12.5 MM DIRECT PE CLT (PROTECTIE LA FOC) | mp | 26 | 20 | 1 | 2 | estimare | 2026-09 |
| 0021_CLT07_FL | CLT07 FL | PANOURI CLT DE PLANSEU, LIVRARE SI MONTAJ CU MACARAUA, INCLUSIV IMBINARI SI ETANSARE | mp | 380 | 28 | 24 | 20 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|
| 0021_CLT01_PN | wall | CLT100 |  |  | formula | panel_area_m2 * thickness_m |  |
| 0021_CLT02_CNC | wall | CLT100 |  |  | formula | cut_length_m |  |
| 0021_CLT03_MNT | wall | CLT100 |  |  | formula | panel_area_m2 |  |
| 0021_CLT04_CON | wall | CLT100 |  |  | formula | connector_count |  |
| 0021_CLT05_JNT | wall | CLT100 |  |  | formula | joint_length_m |  |
| 0021_CLT06_GK | wall | CLT100 |  |  | formula | net_area_m2 * (1 + is_interior) |  |
| 0021_CLT01_PN | wall | CLT120 |  |  | formula | panel_area_m2 * thickness_m |  |
| 0021_CLT02_CNC | wall | CLT120 |  |  | formula | cut_length_m |  |
| 0021_CLT03_MNT | wall | CLT120 |  |  | formula | panel_area_m2 |  |
| 0021_CLT04_CON | wall | CLT120 |  |  | formula | connector_count |  |
| 0021_CLT05_JNT | wall | CLT120 |  |  | formula | joint_length_m |  |
| 0021_CLT06_GK | wall | CLT120 |  |  | formula | net_area_m2 * (1 + is_interior) |  |
| 0021_CLT01_PN | wall | CLT140 |  |  | formula | panel_area_m2 * thickness_m |  |
| 0021_CLT02_CNC | wall | CLT140 |  |  | formula | cut_length_m |  |
| 0021_CLT03_MNT | wall | CLT140 |  |  | formula | panel_area_m2 |  |
| 0021_CLT04_CON | wall | CLT140 |  |  | formula | connector_count |  |
| 0021_CLT05_JNT | wall | CLT140 |  |  | formula | joint_length_m |  |
| 0021_CLT06_GK | wall | CLT140 |  |  | formula | net_area_m2 * (1 + is_interior) |  |
| 0021_CLT01_PN | wall | W15 |  | clt | formula | panel_area_m2 * thickness_m |  |
| 0021_CLT02_CNC | wall | W15 |  | clt | formula | cut_length_m |  |
| 0021_CLT03_MNT | wall | W15 |  | clt | formula | panel_area_m2 |  |
| 0021_CLT04_CON | wall | W15 |  | clt | formula | connector_count |  |
| 0021_CLT05_JNT | wall | W15 |  | clt | formula | joint_length_m |  |
| 0021_CLT06_GK | wall | W15 |  | clt | formula | net_area_m2 * (1 + is_interior) |  |
| 0021_CLT01_PN | wall | W20 |  | clt | formula | panel_area_m2 * thickness_m |  |
| 0021_CLT02_CNC | wall | W20 |  | clt | formula | cut_length_m |  |
| 0021_CLT03_MNT | wall | W20 |  | clt | formula | panel_area_m2 |  |
| 0021_CLT04_CON | wall | W20 |  | clt | formula | connector_count |  |
| 0021_CLT05_JNT | wall | W20 |  | clt | formula | joint_length_m |  |
| 0021_CLT06_GK | wall | W20 |  | clt | formula | net_area_m2 * (1 + is_interior) |  |
| 0021_CLT01_PN | wall | W25 |  | clt | formula | panel_area_m2 * thickness_m |  |
| 0021_CLT02_CNC | wall | W25 |  | clt | formula | cut_length_m |  |
| 0021_CLT03_MNT | wall | W25 |  | clt | formula | panel_area_m2 |  |
| 0021_CLT04_CON | wall | W25 |  | clt | formula | connector_count |  |
| 0021_CLT05_JNT | wall | W25 |  | clt | formula | joint_length_m |  |
| 0021_CLT06_GK | wall | W25 |  | clt | formula | net_area_m2 * (1 + is_interior) |  |
| 0021_CLT01_PN | wall | W30 |  | clt | formula | panel_area_m2 * thickness_m |  |
| 0021_CLT02_CNC | wall | W30 |  | clt | formula | cut_length_m |  |
| 0021_CLT03_MNT | wall | W30 |  | clt | formula | panel_area_m2 |  |
| 0021_CLT04_CON | wall | W30 |  | clt | formula | connector_count |  |
| 0021_CLT05_JNT | wall | W30 |  | clt | formula | joint_length_m |  |
| 0021_CLT06_GK | wall | W30 |  | clt | formula | net_area_m2 * (1 + is_interior) |  |
| 0021_CLT07_FL | slab | CLT160 |  |  | area |  |  |
| 0021_CLT07_FL | slab | CLT200 |  |  | area |  |  |
| 0021_CLT07_FL | slab | * |  | clt | area |  |  |
