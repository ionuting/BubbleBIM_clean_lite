---
categorie: Radier celular
capitol: 4. Investiție de bază
---

Rețele de grinzi din beton armat și radiere celulare, măsurate din nodul
`shell` cu rolul `beam_grid` sau `foundation`.

Modelul geometric e unul singur (vezi `lib/shell/region.ts`): conturul e
shell-ul, celulele sunt nodurile `cell` din interiorul lui, iar PLINUL e ce
rămâne — aria conturului minus ariile celulelor. De aici:

- `net_solid_area_m2` = aria plinului = aria tălpii;
- `volume` la aceste roluri = aria plinului × înălțime, adică betonul;
- `perimeter_m` + `hole_perimeter_m` × înălțime = fețele de cofrat, exterioare
  și interioare deopotrivă (`outer_face_area_m2`, `inner_face_area_m2`).

Fiindcă toate vârfurile sunt puncte de ax, mutarea unui ax recalculează tot.

Armarea e la 110 kg/mc pentru grinzi și 90 kg/mc pentru radier — valori de
pornire uzuale, nu un calcul de rezistență.

Prețuri orientative, nu cotații.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0031_RC01_BET | RC01 BET | BETON C25/30 TURNAT CU POMPA IN GRINZI DE FUNDARE SI RADIERE CELULARE | mc | 500 | 80 | 85 | 45 | estimare | 2026-09 |
| 0031_RC02_COF | RC02 COF | COFRAJE PENTRU GRINZI DE FUNDARE SI PERETI DE RADIER, INCLUSIV SUSTINERI | mp | 36 | 46 | 5 | 5 | estimare | 2026-09 |
| 0031_RC03_ARM | RC03 ARM | ARMATURI DIN OTEL BST500 IN GRINZI DE FUNDARE SI RADIERE, CARCASE LEGATE | kg | 5.6 | 2.2 | 0.2 | 0.3 | estimare | 2026-09 |
| 0031_RC04_EGA | RC04 EGA | BETON DE EGALIZARE C8/10 DE 10 CM SUB TALPA FUNDATIEI | mp | 62 | 22 | 8 | 8 | estimare | 2026-09 |
| 0031_RC05_HID | RC05 HID | HIDROIZOLATIE BITUMINOASA IN DOUA STRATURI SUB SI PE LATERALUL RADIERULUI | mp | 34 | 26 | 1 | 4 | estimare | 2026-09 |
| 0031_RC06_UMP | RC06 UMP | UMPLUTURA COMPACTATA DIN BALAST IN CELULELE RADIERULUI, IN STRATURI DE 20 CM | mc | 95 | 34 | 26 | 30 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|---|
| 0031_RC01_BET | shell | beam_grid |  |  |  | volume |  |  |
| 0031_RC02_COF | shell | beam_grid |  |  |  | formula | outer_face_area_m2 + inner_face_area_m2 |  |
| 0031_RC03_ARM | shell | beam_grid |  |  |  | formula | volume_m3 * 110 |  |
| 0031_RC01_BET | shell | foundation |  |  |  | volume |  |  |
| 0031_RC02_COF | shell | foundation |  |  |  | formula | outer_face_area_m2 + inner_face_area_m2 |  |
| 0031_RC03_ARM | shell | foundation |  |  |  | formula | volume_m3 * 90 |  |
| 0031_RC04_EGA | shell | foundation |  |  |  | formula | net_solid_area_m2 |  |
| 0031_RC05_HID | shell | foundation |  |  |  | formula | net_solid_area_m2 + outer_face_area_m2 |  |
| 0031_RC06_UMP | shell | foundation |  |  |  | formula | hole_area_m2 * height_m |  |
