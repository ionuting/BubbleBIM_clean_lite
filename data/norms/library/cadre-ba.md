---
categorie: Cadre beton armat
capitol: 4. Investiție de bază
---

Structură în cadre din beton armat (`rc_frame`): stâlpii și grinzile poartă,
pereții sunt UMPLUTURĂ între elementele cadrului. Sub acest sistem:

- stâlpii (noduri `column`, și `ax` cu `has_column` — regulile sunt scrise pentru
  ambele, ca în stalpisori.md) și grinzile (`beam`,
  sau pereți cu `has_beam`) se decontează cu beton pompat, cofraj metalic și
  armare de cadru (~120 kg/m³ stâlp, ~100 kg/m³ grindă), nu cu normele de
  sâmburi/centuri ale zidăriei confinate;
- pereții de zidărie (W15…W40) devin zidărie de umplutură (volum net de
  goluri), cu buiandrugi prefabricați la goluri (lățimi + 25 cm rezemare pe
  fiecare parte) și ancore de legare de stâlpi;
- compartimentările din gips-carton (W10/W12) nu apar aici, deci rămân pe
  regulile lor implicite.

Prețuri orientative, nu cotații.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0020_CA02C_02 | CA02C 02 | TURNARE BETON C25/30 CU POMPA IN STALPI SI GRINZI DE CADRU, INCLUSIV VIBRARE | mc | 520 | 95 | 90 | 50 | estimare | 2026-09 |
| 0020_CB02A_02 | CB02A 02 | COFRAJE METALICE REFOLOSIBILE PENTRU STALPI SI GRINZI DE CADRU, INCLUSIV SUSTINERI | mp | 38 | 48 | 6 | 5 | estimare | 2026-09 |
| 0020_CC02C_02 | CC02C 02 | MONTARE ARMATURI DIN OTEL BST500 IN STALPI SI GRINZI DE CADRU, CARCASE LEGATE | kg | 5.6 | 2.1 | 0.2 | 0.3 | estimare | 2026-09 |
| 0020_CD01A_02 | CD01A 02 | ZIDARIE DE UMPLUTURA DIN BLOCURI CERAMICE CU GOLURI VERTICALE, INTRE ELEMENTELE CADRULUI | mc | 400 | 210 | 20 | 40 | estimare | 2026-09 |
| 0020_CD02A_02 | CD02A 02 | BUIANDRUGI PREFABRICATI DIN BETON ARMAT LA GOLURI IN ZIDARIA DE UMPLUTURA | ml | 45 | 22 | 3 | 3 | estimare | 2026-09 |
| 0020_CD03A_02 | CD03A 02 | LEGAREA ZIDARIEI DE UMPLUTURA DE STALPI CU ANCORE DIN OTEL LA 50 CM | ml | 6 | 8 | 0 | 0.5 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|
| 0020_CA02C_02 | column | * |  | rc_frame | volume |  |  |
| 0020_CB02A_02 | column | * |  | rc_frame | formula | perimeter_m * height_m |  |
| 0020_CC02C_02 | column | * |  | rc_frame | formula | volume_m3 * 120 |  |
| 0020_CA02C_02 | ax | * |  | rc_frame | volume |  |  |
| 0020_CB02A_02 | ax | * |  | rc_frame | formula | perimeter_m * height_m |  |
| 0020_CC02C_02 | ax | * |  | rc_frame | formula | volume_m3 * 120 |  |
| 0020_CA02C_02 | beam | * |  | rc_frame | volume |  |  |
| 0020_CB02A_02 | beam | * |  | rc_frame | formula | (width_m + 2 * height_m) * length_m |  |
| 0020_CC02C_02 | beam | * |  | rc_frame | formula | volume_m3 * 100 |  |
| 0020_CD01A_02 | wall | W15 |  | rc_frame | formula | net_area_m2 * thickness_m |  |
| 0020_CD02A_02 | wall | W15 |  | rc_frame | formula | opening_width_m + 0.5 * opening_count |  |
| 0020_CD03A_02 | wall | W15 |  | rc_frame | formula | 2 * height_m |  |
| 0020_CD01A_02 | wall | W20 |  | rc_frame | formula | net_area_m2 * thickness_m |  |
| 0020_CD02A_02 | wall | W20 |  | rc_frame | formula | opening_width_m + 0.5 * opening_count |  |
| 0020_CD03A_02 | wall | W20 |  | rc_frame | formula | 2 * height_m |  |
| 0020_CD01A_02 | wall | W25 |  | rc_frame | formula | net_area_m2 * thickness_m |  |
| 0020_CD02A_02 | wall | W25 |  | rc_frame | formula | opening_width_m + 0.5 * opening_count |  |
| 0020_CD03A_02 | wall | W25 |  | rc_frame | formula | 2 * height_m |  |
| 0020_CD01A_02 | wall | W30 |  | rc_frame | formula | net_area_m2 * thickness_m |  |
| 0020_CD02A_02 | wall | W30 |  | rc_frame | formula | opening_width_m + 0.5 * opening_count |  |
| 0020_CD03A_02 | wall | W30 |  | rc_frame | formula | 2 * height_m |  |
| 0020_CD01A_02 | wall | W35 |  | rc_frame | formula | net_area_m2 * thickness_m |  |
| 0020_CD02A_02 | wall | W35 |  | rc_frame | formula | opening_width_m + 0.5 * opening_count |  |
| 0020_CD03A_02 | wall | W35 |  | rc_frame | formula | 2 * height_m |  |
| 0020_CD01A_02 | wall | W40 |  | rc_frame | formula | net_area_m2 * thickness_m |  |
| 0020_CD02A_02 | wall | W40 |  | rc_frame | formula | opening_width_m + 0.5 * opening_count |  |
| 0020_CD03A_02 | wall | W40 |  | rc_frame | formula | 2 * height_m |  |
