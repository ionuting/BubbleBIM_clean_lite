---
categorie: Pereti lemn
capitol: 4. Investiție de bază
---

Pereți în cadre de lemn (platform framing): montanți + tălpi, buiandrugi
dimensionați după deschidere, placare OSB și vată la exterior, gips-carton la
interior, folii, ancorarea tălpii, fixări mecanice. Cantitățile de lemn vin
din framing-ul DERIVAT al peretelui (lib/framing) — nu din noduri stocate —
deci aceleași cifre le vede și 3D-ul.

Sub sistemul `timber_frame` orice perete (inclusiv unul tipat W25 dintr-un
scenariu cu `keepTypes`) se descompune așa. `is_exterior` / `is_interior`
(1/0, din inelul exterior al etajului) pun OSB-ul, vata și foliile doar pe
pereții exteriori, iar gips-cartonul pe o față la exterior și pe două la
interior. Tipurile TF14/TF20/TF25 au și reguli fără sistem, pentru un perete
de lemn într-un proiect de zidărie: TF14 e o compartimentare (gips pe ambele
fețe), TF20/TF25 sunt pereți exteriori prin definiție.

Prețuri orientative, nu cotații — vezi avertismentul din preturiDefault.ts.

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0019_LF01_TF | LF01 TF | MONTANTI SI TALPI DIN LEMN ECARISAT C24 45X145 MM, TAIERE, MONTAJ SI FIXARE MECANICA | ml | 14 | 9 | 0.5 | 1 | estimare | 2026-09 |
| 0019_LF02_OSB | LF02 OSB | PLACARE EXTERIOARA CU PLACI OSB/3 12 MM, FIXATE PE MONTANTI | mp | 38 | 16 | 1 | 3 | estimare | 2026-09 |
| 0019_LF03_MW | LF03 MW | TERMOIZOLATIE DIN VATA MINERALA 140 MM MONTATA INTRE MONTANTI | mp | 34 | 9 | 0 | 3 | estimare | 2026-09 |
| 0019_LF04_GK | LF04 GK | PLACARE INTERIOARA CU GIPS-CARTON 12.5 MM PE MONTANTI, ROSTURI CHITUITE | mp | 28 | 22 | 1 | 2 | estimare | 2026-09 |
| 0019_LF05_VB | LF05 VB | BARIERA DE VAPORI DIN FOLIE PE, LA INTERIOR, CU BANDA DE ETANSARE | mp | 6 | 5 | 0 | 0.5 | estimare | 2026-09 |
| 0019_LF06_WB | LF06 WB | FOLIE ANTICONDENS PERMEABILA LA VAPORI, LA EXTERIOR, PESTE OSB | mp | 8 | 5 | 0 | 0.5 | estimare | 2026-09 |
| 0019_LF07_TJ | LF07 TJ | GRINZI DE PLANSEU DIN LEMN ECARISAT C24 45X195 MM LA 500 MM, MONTAJ | ml | 22 | 10 | 0.5 | 1.5 | estimare | 2026-09 |
| 0019_LF08_HDR | LF08 HDR | BUIANDRUGI DIN DULAPI DUBLI C24 SAU LVL LA GOLURI, TAIERE SI MONTAJ PE MONTANTI JACK | ml | 38 | 12 | 0.5 | 2 | estimare | 2026-09 |
| 0019_LF09_ANC | LF09 ANC | ANCORAREA TALPII INFERIOARE IN PLACA DE BETON CU ANCORE CHIMICE M12 LA 600 MM | ml | 9 | 7 | 0.5 | 0.5 | estimare | 2026-09 |
| 0019_LF10_FIX | LF10 FIX | FIXARI MECANICE (CUIE INELARE, HOLZSURUBURI, COLTARE) PENTRU CADRE DE LEMN, PER MONTANT | buc | 3.5 | 2.5 | 0.2 | 0.2 | estimare | 2026-09 |
| 0019_LF11_GL | LF11 GL | MONTANTI SI TALPI DIN LEMN LAMELAR INCLEIAT GL24H, TAIERE SI MONTAJ | ml | 38 | 10 | 0.5 | 2 | estimare | 2026-09 |
| 0019_LF12_LVL | LF12 LVL | MONTANTI SI TALPI DIN LVL FURNIR LAMINAT, TAIERE SI MONTAJ | ml | 46 | 10 | 0.5 | 2 | estimare | 2026-09 |

## Mapări BIM
| normId | nodeType | elementType | materialKey | sistem | spec | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|---|---|
| 0019_LF01_TF | wall | * |  | timber_frame |  | formula | stud_length_m + plate_length_m |  |
| 0019_LF08_HDR | wall | * |  | timber_frame |  | formula | header_length_m |  |
| 0019_LF02_OSB | wall | * |  | timber_frame |  | formula | sheathing_area_m2 * is_exterior |  |
| 0019_LF03_MW | wall | * |  | timber_frame |  | formula | sheathing_area_m2 * is_exterior |  |
| 0019_LF04_GK | wall | * |  | timber_frame |  | formula | sheathing_area_m2 * (1 + is_interior) |  |
| 0019_LF05_VB | wall | * |  | timber_frame |  | formula | sheathing_area_m2 * is_exterior |  |
| 0019_LF06_WB | wall | * |  | timber_frame |  | formula | sheathing_area_m2 * is_exterior |  |
| 0019_LF09_ANC | wall | * |  | timber_frame |  | formula | length_m |  |
| 0019_LF10_FIX | wall | * |  | timber_frame |  | formula | stud_count |  |
| 0019_LF01_TF | wall | TF14 |  |  |  | formula | stud_length_m + plate_length_m |  |
| 0019_LF08_HDR | wall | TF14 |  |  |  | formula | header_length_m |  |
| 0019_LF04_GK | wall | TF14 |  |  |  | formula | sheathing_area_m2 * 2 |  |
| 0019_LF10_FIX | wall | TF14 |  |  |  | formula | stud_count |  |
| 0019_LF01_TF | wall | TF20 |  |  |  | formula | stud_length_m + plate_length_m |  |
| 0019_LF08_HDR | wall | TF20 |  |  |  | formula | header_length_m |  |
| 0019_LF02_OSB | wall | TF20 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF03_MW | wall | TF20 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF04_GK | wall | TF20 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF05_VB | wall | TF20 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF06_WB | wall | TF20 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF09_ANC | wall | TF20 |  |  |  | formula | length_m |  |
| 0019_LF10_FIX | wall | TF20 |  |  |  | formula | stud_count |  |
| 0019_LF01_TF | wall | TF25 |  |  |  | formula | stud_length_m + plate_length_m |  |
| 0019_LF08_HDR | wall | TF25 |  |  |  | formula | header_length_m |  |
| 0019_LF02_OSB | wall | TF25 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF03_MW | wall | TF25 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF04_GK | wall | TF25 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF05_VB | wall | TF25 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF06_WB | wall | TF25 |  |  |  | formula | sheathing_area_m2 |  |
| 0019_LF09_ANC | wall | TF25 |  |  |  | formula | length_m |  |
| 0019_LF10_FIX | wall | TF25 |  |  |  | formula | stud_count |  |
| 0019_LF07_TJ | slab | TJ20 |  |  |  | formula | area_m2 / 0.5 |  |
| 0019_LF07_TJ | slab | TJ24 |  |  |  | formula | area_m2 / 0.5 |  |
| 0019_LF07_TJ | slab | * |  | timber_frame |  | formula | area_m2 / 0.5 |  |
| 0019_LF11_GL | wall | * |  |  | lemn:lamelar | formula | stud_length_m + plate_length_m |  |
| 0019_LF12_LVL | wall | * |  |  | lemn:lvl | formula | stud_length_m + plate_length_m |  |
