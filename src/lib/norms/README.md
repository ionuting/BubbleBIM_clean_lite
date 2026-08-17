# Norme de deviz — Zidărie confinată

Catalogul activ este importat din **DEVIZ PE CATEGORII.ods** (case din zidărie confinată).
Alternativ: catalog generic Indicator C (`catalog.ts` → `ACTIVE_CATALOG_ID`).

## Structură

| Fișier | Rol |
|--------|-----|
| `types.ts` | Tipuri: `NormArticle`, `NormMappingRule`, `TakeoffLine`, `F3Row` |
| `devizZidarieConfinata.json` | Catalog importat din ODS (29 articole, 12 categorii) |
| `devizZidarieConfinata.ts` | Loader TypeScript pentru JSON |
| `elementNormMappingZidarieConfinata.ts` | Mapări BIM → articole zidărie confinată |
| `catalog.ts` | Catalog activ + `findMappingRules` |
| `indicatorCStarter.ts` | Catalog generic alternativ |
| `elementNormMapping.ts` | Mapări pentru catalogul Indicator C |

## Categorii din ODS (zidărie confinată)

Zidărie, Stalpișori, Centuri, Planseu lemn, Șarpantă, Învelitoare, Șapă egalizare,
Tencuială, Termoizolație, Vopsitorii, Diverse, Soclu.

## Re-import din ODS

După actualizarea fișierului `data/norms/DEVIZ_PE_CATEGORII.ods`:

```bash
python3 scripts/import-deviz-ods.py
```

## Extindere catalog manual

1. Adăugați articol în `devizZidarieConfinata.json` sau re-importați din ODS.
2. Sau adăugați în `indicatorCStarter.ts` (catalog alternativ):

```typescript
{
  id: 'C-4.1.07',
  symbol: 'C-4.1.07',
  denumire: 'Turnare beton în scări',
  unit: 'mc',
  capitol: '4. Investiție de bază',
  categorie: 'Structură beton — turnări',
}
```

2. Adăugați regulă de mapare în `elementNormMapping.ts`:

```typescript
{
  nodeType: 'stair',
  elementTypeId: 'STAIR01',
  outputs: [{ normId: 'C-4.1.07', measure: 'volume' }],
}
```

## Măsuri disponibile în reguli

| `measure` | Descriere |
|-----------|-----------|
| `length` | Lungime (ml) |
| `area` | Suprafață; `netOfOpenings: true` scade golurile |
| `volume` | Volum (mc) |
| `count` | Număr bucăți |
| `opening_area` | Suprafață deschidere |
| `formula` | Expresie: `length_m`, `height_m`, `area_m2`, `volume_m3`, `perimeter_m`, etc. |

## Export F3

Cantitățile se calculează automat din graf (`computeFullTakeoff`) și se exportă ca
Lista F3 (CSV UTF-8 BOM) din panoul **Cantități** din explorer.

Versiune catalog activ: `deviz-zidarie-confinata-1` (vezi `catalog.ts`).
