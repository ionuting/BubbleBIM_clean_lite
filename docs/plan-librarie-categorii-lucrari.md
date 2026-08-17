# Plan: librărie de categorii de lucrări (MD → JSON + editor vizual)

Metodă user-friendly de a construi librării de categorii de lucrări și de a mapa
categoriile pe obiecte BIM — atât în librărie (fișiere), cât și în aplicație (vizual).

## Decizii confirmate
- **Format: MD sursă + JSON compilat.** Autorare în `.md` (frontmatter + tabele),
  compilator cu validare → JSON consumat de aplicație. Editorul vizual scrie același
  JSON și poate exporta înapoi în MD.
- **Bug-ul pereților: reparat imediat** (vezi mai jos), înainte de restul planului.

---

## Analiza stării actuale

| Strat | Unde | Formă |
|---|---|---|
| Articole (`NormArticle`) | `norms/devizZidarieConfinata.json` | JSON generat din ODS (`scripts/import-deviz-ods.py`) |
| Mapări BIM→articol (`NormMappingRule`) | `norms/elementNormMappingZidarieConfinata.ts` | **TS hardcodat** |
| Obiecte BIM (WALL/BEAM/COLUMN/…_TYPES) | `lib/elementLibrary.ts` | **TS hardcodat** |
| Prețuri (per articol) | `norms/preturiDefault.ts` | **TS hardcodat** |
| Rezoluție | `findMappingRules()` — `id exact > '*'`, apoi `materialFilter` | pură |
| Comutare catalog | `ACTIVE_CATALOG_ID` | **constantă de compilare** |

Stare măsurată: **29 articole · 12 categorii · 43 reguli**.

### Regresia găsită și reparată (2026-07-22)

`elementLibrary.ts` a fost tradus ro → en (`Caramida`→`Brick`, `Beton`→`Concrete`).
Maparea pereților filtra materialul cu un regex **în română**:

```ts
WALL_TYPES.filter((t) => /caramida|beton/i.test(t.material))  // → [] după traducere
```

Rezultat: **0 reguli pentru `nodeType: 'wall'`** → zidăria dispăruse complet din
deviz, iar articolul principal (`00201A01 02 ZIDARIE POROTHERM`) nu mai era emis.
Takeoff-ul rămânea „verde", pentru că lipsa unei reguli nu e eroare — e doar zero.

**Fix aplicat:** potrivire bilingvă (`/caramid|brick|beton|concrete/i`) +
`norms/mappingCoverage.test.ts` — gardă care pică zgomotos dacă maparea se golește iar.

**Lecția pentru librărie:** potrivirea nu trebuie făcută pe text liber afișabil.
Librăria trebuie să declare explicit **pe ce cheie stabilă** se face potrivirea.

### Ce rămâne descoperit (vizibil abia după măsurare)
- Tipuri BIM fără mapare: **plăci (7), uși (9)** — contribuie tăcut cu 0.
- Articole nefolosite de nicio regulă: **învelitoare (6), planșeu lemn, șarpantă,
  șapă, hidroizolație** — există în catalog, nu ajung niciodată în deviz.

Acesta e argumentul central pentru tooling: **eșecul e tăcut prin construcție.**

---

## Structura librăriei

```
data/norms/library/
  _catalog.md          # metadate catalog (id, versiune, monedă)
  zidarie.md           # o categorie de lucrări per fișier
  stalpisori.md
  invelitoare.md
```

Fiecare fișier ține **împreună** cele trei lucruri azi împrăștiate în 3 locuri
(articole, mapări, prețuri):

```markdown
---
categorie: Zidărie
capitol: 4. Investiție de bază
---

## Articole
| normId | simbol | denumire | UM | material | manoperă | utilaj | transport |
|---|---|---|---|---|---|---|---|

## Mapări BIM
| nodeType | elementType | materialKey | măsură | formulă |
|---|---|---|---|---|
| wall | * | brick | volume | |
```

`materialKey` = cheie stabilă, independentă de eticheta afișată (lecția regresiei).

---

## Faze

**1 — Schemă + compilator + validator.**
Parser MD (frontmatter + tabele, fără dependențe noi) → JSON. Validatorul prinde:
referințe `normId` rupte, reguli duplicate, formule invalide și produce **raportul de
acoperire** (tipuri BIM nemapate, articole nefolosite). Rulează în CI și ca test.

**2 — Migrare + plasă de siguranță.**
Conversia catalogului curent în MD. **Test golden**: F3 identic înainte/după migrare pe
`public/example-project.bbim`. Introducerea `materialKey` în `elementLibrary` se face
aici, ca schimbare separată și vizibilă.

**3 — Runtime din JSON.**
`getActiveCatalog()` / `findMappingRules()` păstrează semnătura → `takeoffEngine`
neatins. Catalogul devine selectabil la runtime, nu constantă de compilare.

**4 — Editor vizual în aplicație.**
Două panouri: obiecte BIM (grupate pe nodeType) ↔ categorii/articole, cu conectare,
măsură și formulă (pattern-ul din `CustomCalcEditor`). **Dashboard de acoperire** ca
ecran principal — transformă eșecul tăcut în informație vizibilă.

**5 — Suprascrieri per proiect.**
Mapările custom se salvează în `.bbim` (ca prețurile), deci adaptezi fără să atingi
librăria.

**6 — Round-trip.**
Export librărie → MD; import ODS/Excel utilizator.

---

## Riscuri
1. **Migrarea nu trebuie să schimbe cifrele accidental** → testul golden din Faza 2;
   orice schimbare intenționată de cifre se face izolat și vizibil.
2. Semantica de specificitate (`exact > '*'`, apoi material) trebuie păstrată exact —
   e testabilă azi.
3. Potrivirea pe text liber e fragilă (a rupt deja producția o dată) → `materialKey`.
4. Traducerile de UI nu trebuie să atingă date de care depinde logica — validatorul de
   acoperire e plasa de siguranță.
