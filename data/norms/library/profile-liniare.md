---
categorie: Profile liniare
capitol: 4. Investiție de bază
---

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport | sursă | data |
|---|---|---|---|---|---|---|---|---|---|
| 0018_CA01D_02 | CA01D 02 | PREPARARE BETON PE SANTIER CU BETONIERA, BETON CLA SA C 20/16 | mc | 450 | 110 | 55 | 45 | estimare (2025–2026) |  |
| 0018_CB01C_02 | CB01C 02 | COFR DIN SCINDURI DE RASINOASE EL.TIP SPECIAL LA C ONSTRUCTII CU H<20M,EXCLUSIV SUSTINERILE | mp | 45 | 55 | 4 | 6 | estimare (2025–2026) |  |
| 0018_CC01A4_02 | CC01A4 02 | FASONAREA BARELOR DIN OTEL BETON PC PE SANTIER, AV AND D= 12,14,16 MM | kg | 5.2 | 1.8 | 0.2 | 0.3 | estimare (2025–2026) |  |

## Mapări BIM
| normId | nodeType | elementType | materialKey | măsură | formulă | netOfOpenings |
|---|---|---|---|---|---|---|
| 0018_CA01D_02 | sweep | * |  | volume |  |  |
| 0018_CB01C_02 | sweep | * |  | area |  |  |
| 0018_CC01A4_02 | sweep | * |  | formula | volume_m3 * 61.5 |  |

<!--
  Elementele `sweep` — un profil 2D extrudat pe linia de ghidaj dată de axe:
  brâuri, socluri, cornișe, borduri, praguri.

  Volumul vine din mesh-ul real (sumă de tetraedre peste triunghiurile
  afișate), deci include corect îmbinările în unghi de la colțuri: nu e
  arie × lungimea liniei, care greșește cu 2·offset·tg(θ/2) la fiecare colț
  când profilul nu e centrat pe linie.

  Cofrajul e suprafața laterală desfășurată (perimetrul secțiunii × lungimea),
  adică `area_m2`. Supraevaluează pentru un profil turnat pe cofraj pierdut sau
  rezemat pe zidărie — scade partea rezemată dacă e cazul.

  ATENȚIE: maparea e pe `*`, deci se aplică ORICĂRUI sweep, indiferent de
  material — la fel ca la `stairwell`. Un profil de lemn, piatră sau metal va
  primi articole de beton. Până când biblioteca primește mapări pe material,
  corectează-le prin suprascrierile de proiect (mappingOverrideStore).

  Procentul de armare 61,5 kg/mc e MOȘTENIT din articolele de centuri, nu
  dedus pentru profile liniare; înlocuiește-l cu cifra proiectului.
-->
