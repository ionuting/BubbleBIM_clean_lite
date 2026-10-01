/**
 * Style packs — parameter sets over the shared rules in `engine.ts`.
 *
 * A pack is only the numbers and materials that make a style recognisable, and
 * the range each number may move in without leaving the style. Three families:
 *
 * Traditional Romanian (rural houses, 19th – early 20th c.)
 *   Câmpie (Muntenia, Oltenia) — hip roof in ceramic tile, lime-washed walls,
 *     a porch (prispă) on timber posts along the entrance front, low stone plinth.
 *   Maramureș — steep hip roof in wooden shingle, timber walls, high plinth, târnaț.
 *   Bucovina — shingle hip roof, lime-washed walls with a coloured band (brâu).
 *   Dobrogea — low hip roof, white walls, deep porch, woodwork painted blue.
 *
 * Modern
 *   Minimalist — flat roof behind a parapet, white render, large glazing,
 *     a thin canopy over the door, no ornament.
 *   Barn house — steep gable with no overhang, metal roof, dark timber
 *     cladding, large glazing: the Nordic reading of the farm barn.
 *   Contemporary mono-pitch — a single low slope, timber cladding, canopy.
 *
 * Classic
 *   Neoclassical villa — low hip roof in metal, cream render, cornice, corner
 *     pilasters, tall windows, a columned portico raised on a stone base.
 *   Mansard (Beaux-Arts) — mansard roof in slate, cornice, tall windows.
 *
 * These are starting points for a designer, not a survey: every value is a
 * parameter, inside the pack's range.
 */
import type { StylePack, StyleParamDef, StyleParams } from './types';

export const STYLE_PARAMS: StyleParamDef[] = [
  // ── Roof ─────────────────────────────────────────────────────────────────
  { key: 'roof_type', label: 'Tip acoperiș', group: 'roof', kind: 'choice',
    options: [
      { value: 'hip', label: 'În patru ape' },
      { value: 'gable', label: 'În două ape' },
      { value: 'shed', label: 'Într-o apă' },
      { value: 'mansard', label: 'Mansardă (două pante)' },
      { value: 'flat', label: 'Terasă cu atic' },
    ] },
  { key: 'roof_pitch_deg', label: 'Pantă', group: 'roof', kind: 'number', unit: '°', min: 3, max: 75, step: 1,
    help: 'La mansardă: panta de jos, abruptă.' },
  { key: 'roof_upper_pitch_deg', label: 'Pantă superioară (mansardă)', group: 'roof', kind: 'number', unit: '°', min: 10, max: 45, step: 1 },
  { key: 'roof_overhang_mm', label: 'Streașină (față de fațadă)', group: 'roof', kind: 'number', unit: 'mm', min: 0, max: 2500, step: 50,
    help: 'Cât iese acoperișul peste fața exterioară. Cu prispă, crește cât să o acopere.' },
  { key: 'roof_seat', label: 'Așezarea acoperișului', group: 'roof', kind: 'choice',
    options: [
      { value: 'walls', label: 'Pe ziduri — streașina coboară' },
      { value: 'frieze', label: 'Peste friză — streașina la coronament' },
    ],
    help: 'Pe ziduri: planul acoperișului trece prin coronament. Peste friză: zidul urcă până sub streașină.' },
  { key: 'roof_covering', label: 'Învelitoare', group: 'roof', kind: 'choice',
    options: [
      { value: 'Țiglă ceramică', label: 'Țiglă ceramică' },
      { value: 'Șindrilă de lemn', label: 'Șindrilă de lemn' },
      { value: 'Tablă', label: 'Tablă fălțuită' },
      { value: 'Ardezie', label: 'Ardezie' },
      { value: 'Șindrilă bituminoasă', label: 'Șindrilă bituminoasă' },
      { value: 'Membrană bituminoasă', label: 'Membrană (terasă)' },
    ] },
  { key: 'roof_parapet_h_mm', label: 'Înălțime atic', group: 'roof', kind: 'number', unit: 'mm', min: 200, max: 1200, step: 50,
    help: 'Doar la terasă.' },
  { key: 'roof_dormers', label: 'Lucarne „ochi”', group: 'roof', kind: 'choice',
    options: [
      { value: 'none', label: 'Fără' },
      { value: 'front', label: 'Pe apa dinspre intrare' },
      { value: 'all', label: 'Pe fiecare apă' },
    ],
    help: 'Învelitoarea se ridică în val peste o fereastră semicirculară.' },
  { key: 'dormer_width_mm', label: 'Lățime fereastră lucarnă', group: 'roof', kind: 'number', unit: 'mm', min: 900, max: 2400, step: 50 },
  { key: 'dormer_rise_mm', label: 'Înălțime lucarnă', group: 'roof', kind: 'number', unit: 'mm', min: 500, max: 1400, step: 50 },
  { key: 'wall_plate_lift_max_mm', label: 'Cosoroabă ridicată max.', group: 'roof', kind: 'number', unit: 'mm', min: 0, max: 1500, step: 50,
    help: 'Cât se poate ridica baza acoperișului peste zid ca streașina să treacă peste prispă.' },

  // ── Envelope ─────────────────────────────────────────────────────────────
  { key: 'wall_finish', label: 'Finisaj pereți', group: 'envelope', kind: 'choice',
    options: [
      { value: 'Tencuială de var', label: 'Tencuială (văruit)' },
      { value: 'Lemn masiv', label: 'Lemn (bârne)' },
      { value: 'Placaj lemn', label: 'Placaj de lemn' },
      { value: 'Beton aparent', label: 'Beton aparent' },
      { value: 'Cărămidă aparentă', label: 'Cărămidă aparentă' },
      { value: 'Piatră', label: 'Piatră' },
      { value: '', label: 'Păstrează finisajul actual' },
    ] },
  { key: 'wall_color', label: 'Culoare pereți', group: 'envelope', kind: 'color',
    help: 'Gol = culoarea materialului.' },
  { key: 'plinth_material', label: 'Soclu', group: 'envelope', kind: 'choice',
    options: [
      { value: 'Piatră', label: 'Piatră' },
      { value: 'Cărămidă', label: 'Cărămidă' },
      { value: 'Beton', label: 'Beton' },
      { value: 'Tencuială de var', label: 'Tencuit și vopsit' },
      { value: '', label: 'Fără soclu aparent' },
    ] },
  { key: 'plinth_color', label: 'Culoare soclu', group: 'envelope', kind: 'color',
    help: 'Gol = culoarea materialului. Soclul vopsit închis e semnul caselor din Moldova.' },
  { key: 'floor_raise_mm', label: 'Pardoseala peste teren', group: 'envelope', kind: 'number', unit: 'mm', min: 0, max: 1200, step: 50,
    help: 'Înălțimea soclului și a platformei de la intrare, de la teren la cota ±0.00.' },
  { key: 'windows', label: 'Ferestre', group: 'envelope', kind: 'choice',
    options: [
      { value: 'keep', label: 'Păstrează' },
      { value: 'large', label: 'Mari, până aproape de pardoseală' },
      { value: 'tall', label: 'Înalte, proporție verticală' },
    ] },
  { key: 'brau', label: 'Brâu', group: 'envelope', kind: 'bool' },
  { key: 'brau_color', label: 'Culoare brâu', group: 'envelope', kind: 'color' },
  { key: 'brau_z_mm', label: 'Cota brâului', group: 'envelope', kind: 'number', unit: 'mm', min: 200, max: 2800, step: 50,
    help: 'Măsurată de la pardoseală; implicit deasupra golurilor.' },
  { key: 'cornice', label: 'Cornișă', group: 'envelope', kind: 'bool' },
  { key: 'pilasters', label: 'Pilaștri la colțuri', group: 'envelope', kind: 'bool' },
  { key: 'trim_color', label: 'Culoare ornamente', group: 'envelope', kind: 'color',
    help: 'Cornișă, pilaștri, coloane. Gol = ca pereții.' },

  // ── Ornament: what the envelope carries round its openings and corners ──
  { key: 'window_trim', label: 'Ancadramente', group: 'ornament', kind: 'choice',
    options: [
      { value: 'none', label: 'Fără' },
      { value: 'band', label: 'Bandă în relief, colorată' },
      { value: 'classic', label: 'Clasic — arhitravă, friză, cornișă, console' },
      { value: 'traditional', label: 'Scânduri de lemn, cu urechi și lăcrimar' },
      { value: 'modern', label: 'Chenar modern ieșit din fațadă' },
    ],
    help: 'În jurul ferestrelor și ușilor exterioare. Merg cu golul: mutat sau redimensionat, ancadramentul îl urmează.' },
  { key: 'window_sill', label: 'Solbanc (exterior)', group: 'ornament', kind: 'choice',
    options: [
      { value: 'none', label: 'Fără' },
      { value: 'stone', label: 'Piatră' },
      { value: 'metal', label: 'Tablă' },
      { value: 'wood', label: 'Lemn' },
    ] },
  { key: 'window_glaf', label: 'Glaf (interior)', group: 'ornament', kind: 'choice',
    options: [
      { value: 'none', label: 'Fără' },
      { value: 'wood', label: 'Lemn' },
      { value: 'stone', label: 'Marmură' },
      { value: 'pvc', label: 'PVC' },
    ] },
  { key: 'corner_trim', label: 'Colțurile fațadei', group: 'ornament', kind: 'choice',
    options: [
      { value: 'none', label: 'Simple' },
      { value: 'quoins', label: 'Bosaje alternante' },
      { value: 'boards', label: 'Scânduri de colț' },
      { value: 'metal', label: 'Cornier metalic' },
    ],
    help: 'Pe colțurile ieșite ale stratului exterior, pe toată înălțimea fiecărui etaj.' },

  // ── Entrance ─────────────────────────────────────────────────────────────
  { key: 'entrance', label: 'Intrarea', group: 'porch', kind: 'choice',
    options: [
      { value: 'prispa', label: 'Prispă pe toată fațada' },
      { value: 'cerdac', label: 'Cerdac cu arcade și fronton' },
      { value: 'portic', label: 'Portic cu coloane' },
      { value: 'copertina', label: 'Copertină' },
      { value: 'none', label: 'Doar trepte' },
    ] },
  { key: 'porch_depth_mm', label: 'Adâncime', group: 'porch', kind: 'number', unit: 'mm', min: 800, max: 2500, step: 50 },
  { key: 'post_size_mm', label: 'Stâlpi (latură)', group: 'porch', kind: 'number', unit: 'mm', min: 100, max: 250, step: 10 },
  { key: 'post_spacing_mm', label: 'Distanță max. între stâlpi', group: 'porch', kind: 'number', unit: 'mm', min: 1500, max: 3500, step: 100 },
  { key: 'porch_clear_mm', label: 'Înălțime liberă sub grindă', group: 'porch', kind: 'number', unit: 'mm', min: 1900, max: 2600, step: 50 },
  { key: 'parapet', label: 'Parmaclac (parapet)', group: 'porch', kind: 'bool' },
  { key: 'parapet_h_mm', label: 'Înălțime parmaclac', group: 'porch', kind: 'number', unit: 'mm', min: 500, max: 1100, step: 50 },
  { key: 'woodwork_color', label: 'Culoare lemnărie', group: 'porch', kind: 'color',
    help: 'Stâlpi, grindă, parmaclac. Gol = culoarea lemnului.' },
  { key: 'arch_rise_mm', label: 'Săgeata arcadelor', group: 'porch', kind: 'number', unit: 'mm', min: 150, max: 900, step: 25,
    help: 'Cât urcă arcul dintre doi stâlpi, de la capete la cheie.' },
  { key: 'portico_columns', label: 'Coloane portic', group: 'porch', kind: 'number', unit: 'buc', min: 2, max: 6, step: 2 },
  { key: 'column_d_mm', label: 'Diametru coloane', group: 'porch', kind: 'number', unit: 'mm', min: 200, max: 600, step: 10 },

  { key: 'terraces', label: 'Terasă cu trepte la celelalte uși', group: 'porch', kind: 'bool',
    help: 'La parter, la fiecare ușă exterioară în afară de intrare: o platformă la cota pardoselii și treptele până la teren.' },
  { key: 'balconies', label: 'Balcon la ușile de la etaj', group: 'porch', kind: 'bool',
    help: 'O placă în consolă cu parapet, la fiecare ușă exterioară de la etaj.' },
  { key: 'terrace_depth_mm', label: 'Adâncime terasă / balcon', group: 'porch', kind: 'number', unit: 'mm', min: 900, max: 3000, step: 50,
    help: 'Balconul se oprește la 1500 mm.' },
  { key: 'terrace_material', label: 'Pardoseală terasă', group: 'porch', kind: 'choice',
    options: [
      { value: 'Lemn', label: 'Deck de lemn' },
      { value: 'Piatră', label: 'Piatră' },
      { value: 'Beton', label: 'Beton' },
    ] },

  // ── Details ──────────────────────────────────────────────────────────────
  { key: 'chimney', label: 'Horn', group: 'details', kind: 'bool' },
];

/** Where each parameter matters — the dialog hides what the current choices make moot. */
export function paramApplies(key: string, p: StyleParams): boolean {
  const roof = String(p.roof_type);
  const entrance = String(p.entrance);
  switch (key) {
    case 'roof_pitch_deg': case 'roof_seat': return roof !== 'flat';
    case 'roof_upper_pitch_deg': return roof === 'mansard';
    case 'roof_parapet_h_mm': return roof === 'flat';
    case 'roof_dormers': return roof !== 'flat';
    case 'dormer_width_mm': case 'dormer_rise_mm': return roof !== 'flat' && p.roof_dormers !== 'none';
    case 'wall_plate_lift_max_mm': return roof !== 'flat' && (entrance === 'prispa' || entrance === 'cerdac');
    case 'brau_color': case 'brau_z_mm': return !!p.brau;
    case 'trim_color': return !!p.cornice || !!p.pilasters || entrance === 'portic'
      || ['band', 'classic', 'modern'].includes(String(p.window_trim)) || ['quoins', 'metal'].includes(String(p.corner_trim));
    case 'woodwork_color': return entrance === 'prispa' || entrance === 'cerdac' || p.window_trim === 'traditional' || p.corner_trim === 'boards'
      || p.window_sill === 'wood' || p.window_glaf === 'wood';
    case 'corner_trim': return !p.pilasters;
    case 'porch_depth_mm': return entrance !== 'none';
    case 'post_size_mm': case 'post_spacing_mm': case 'porch_clear_mm': case 'parapet':
      return entrance === 'prispa' || entrance === 'cerdac';
    case 'arch_rise_mm': return entrance === 'cerdac';
    case 'plinth_color': return String(p.plinth_material) !== '';
    case 'terrace_depth_mm': return !!p.terraces || !!p.balconies;
    case 'terrace_material': return !!p.terraces;
    case 'parapet_h_mm': return (entrance === 'prispa' || entrance === 'cerdac') && !!p.parapet;
    case 'portico_columns': case 'column_d_mm': return entrance === 'portic';
    default: return true;
  }
}

const base: StyleParams = {
  roof_type: 'hip',
  roof_pitch_deg: 35,
  roof_upper_pitch_deg: 30,
  roof_overhang_mm: 600,
  roof_seat: 'walls',
  roof_covering: 'Țiglă ceramică',
  roof_parapet_h_mm: 600,
  wall_plate_lift_max_mm: 900,
  roof_dormers: 'none',
  dormer_width_mm: 1400,
  dormer_rise_mm: 900,
  wall_finish: 'Tencuială de var',
  wall_color: '',
  plinth_material: 'Piatră',
  plinth_color: '',
  floor_raise_mm: 450,
  windows: 'keep',
  brau: false,
  brau_color: '#2E5E8C',
  brau_z_mm: 2250,
  cornice: false,
  pilasters: false,
  trim_color: '',
  entrance: 'prispa',
  porch_depth_mm: 1500,
  post_size_mm: 150,
  post_spacing_mm: 2500,
  porch_clear_mm: 2100,
  parapet: true,
  parapet_h_mm: 800,
  woodwork_color: '',
  arch_rise_mm: 350,
  portico_columns: 4,
  column_d_mm: 350,
  chimney: true,
  window_trim: 'none',
  window_sill: 'none',
  window_glaf: 'none',
  corner_trim: 'none',
  terraces: true,
  balconies: true,
  terrace_depth_mm: 1500,
  terrace_material: 'Lemn',
};

export const STYLE_PACKS: StylePack[] = [
  // ── Traditional ──────────────────────────────────────────────────────────
  {
    id: 'traditional_campie',
    family: 'traditional',
    label: 'Tradițional de câmpie',
    region: 'Muntenia, Oltenia',
    description: 'Acoperiș în patru ape din țiglă, pereți văruiți, prispă pe stâlpi de lemn de-a lungul fațadei cu intrarea, soclu scund de piatră.',
    params: { ...base, window_trim: 'band', trim_color: '#E3D5B8', window_sill: 'wood', window_glaf: 'wood' },
    ranges: { roof_pitch_deg: [28, 42], porch_depth_mm: [1200, 2200] },
  },
  {
    id: 'traditional_maramures',
    family: 'traditional',
    label: 'Tradițional maramureșean',
    region: 'Maramureș',
    description: 'Acoperiș abrupt în patru ape din șindrilă, pereți din bârne, soclu înalt de piatră, târnaț pe stâlpi.',
    params: {
      ...base, window_trim: 'traditional', window_sill: 'wood', window_glaf: 'wood', corner_trim: 'boards', roof_pitch_deg: 50, roof_overhang_mm: 700, roof_covering: 'Șindrilă de lemn',
      wall_plate_lift_max_mm: 1200, wall_finish: 'Lemn masiv', floor_raise_mm: 600,
      porch_depth_mm: 1100, post_size_mm: 180, porch_clear_mm: 2000, parapet_h_mm: 900,
    },
    ranges: { roof_pitch_deg: [45, 62], porch_depth_mm: [900, 1600] },
  },
  {
    id: 'traditional_bucovina',
    family: 'traditional',
    label: 'Tradițional bucovinean',
    region: 'Bucovina',
    description: 'Acoperiș în patru ape din șindrilă, pereți văruiți cu brâu colorat, prispă pe fațada intrării.',
    params: {
      ...base, window_trim: 'band', window_sill: 'metal', window_glaf: 'wood', roof_pitch_deg: 42, roof_overhang_mm: 700, roof_covering: 'Șindrilă de lemn',
      brau: true, brau_color: '#2F6B4F', porch_depth_mm: 1400,
    },
    ranges: { roof_pitch_deg: [35, 50] },
  },
  {
    id: 'traditional_bucovina_modern',
    family: 'traditional',
    label: 'Bucovinean modern',
    region: 'Bucovina, azi',
    description: 'Acoperiș în patru ape, închis la culoare, cu lucarne „ochi” pe fiecare apă; pereți albi, soclu înalt de piatră, prispă pe stâlpi de lemn închis cu parmaclac.',
    params: {
      ...base, window_trim: 'traditional', window_sill: 'metal', window_glaf: 'wood', terrace_material: 'Piatră', roof_pitch_deg: 42, roof_overhang_mm: 600, roof_covering: 'Șindrilă bituminoasă',
      roof_dormers: 'all', dormer_width_mm: 1400, dormer_rise_mm: 900,
      wall_color: '#F7F6F2', plinth_material: 'Piatră', floor_raise_mm: 600,
      porch_depth_mm: 1600, post_size_mm: 180, woodwork_color: '#3B2A20', parapet_h_mm: 900,
    },
    ranges: { roof_pitch_deg: [38, 50], porch_depth_mm: [1200, 2200] },
  },
  {
    id: 'traditional_dobrogea',
    family: 'traditional',
    label: 'Tradițional dobrogean',
    region: 'Dobrogea',
    description: 'Acoperiș jos în patru ape, pereți albi, prispă adâncă, lemnărie vopsită în albastru.',
    params: {
      ...base, window_trim: 'band', window_sill: 'wood', window_glaf: 'wood', terrace_material: 'Piatră', roof_pitch_deg: 25, roof_overhang_mm: 500, floor_raise_mm: 300,
      brau: true, brau_color: '#1F5FAD', porch_depth_mm: 1800, woodwork_color: '#2B64B0',
    },
    ranges: { roof_pitch_deg: [18, 30], porch_depth_mm: [1400, 2500] },
  },

  {
    id: 'traditional_moldova',
    family: 'traditional',
    label: 'Tradițional moldovenesc',
    region: 'Moldova',
    description: 'Acoperiș în patru ape din șindrilă, cu streașină largă; pereți văruiți în alb pe un soclu tencuit și vopsit albastru-închis; prispă pe stâlpi de lemn de-a lungul fațadei; ferestre cu ancadramente de lemn.',
    params: {
      ...base, roof_pitch_deg: 40, roof_overhang_mm: 800, roof_covering: 'Șindrilă de lemn',
      wall_color: '#F8F7F2', plinth_material: 'Tencuială de var', plinth_color: '#2E4A78', floor_raise_mm: 450,
      porch_depth_mm: 1600, post_size_mm: 150, woodwork_color: '#7A5230', parapet_h_mm: 800,
      window_trim: 'traditional', window_sill: 'wood', window_glaf: 'wood',
    },
    ranges: { roof_pitch_deg: [35, 50], roof_overhang_mm: [600, 1100], porch_depth_mm: [1200, 2200] },
  },
  {
    id: 'traditional_basarabia',
    family: 'traditional',
    label: 'Tradițional basarabean',
    region: 'Basarabia',
    description: 'Acoperiș în patru ape din tablă, pereți albaștri cu ancadramente albe în relief, soclu vopsit închis; cerdac pe stâlpi albi cu arcade între ei și un fronton ornamentat peste intrare.',
    params: {
      ...base, roof_pitch_deg: 32, roof_overhang_mm: 600, roof_covering: 'Tablă',
      wall_color: '#9EC3E0', trim_color: '#FAFAF7', plinth_material: 'Tencuială de var', plinth_color: '#24406B',
      floor_raise_mm: 450, entrance: 'cerdac', porch_depth_mm: 1800, post_size_mm: 140, post_spacing_mm: 2200,
      arch_rise_mm: 350, woodwork_color: '#F4F4EF', parapet_h_mm: 800, porch_clear_mm: 2200,
      window_trim: 'band', window_sill: 'metal', window_glaf: 'wood', terrace_material: 'Beton',
    },
    ranges: { roof_pitch_deg: [25, 40], porch_depth_mm: [1400, 2400] },
  },

  // ── Modern ───────────────────────────────────────────────────────────────
  {
    id: 'modern_minimalist',
    family: 'modern',
    label: 'Minimalist',
    region: 'Modern',
    description: 'Terasă cu atic, pereți albi fără ornament, ferestre mari până aproape de pardoseală, copertină subțire peste ușă, soclu discret din beton.',
    params: {
      ...base, window_sill: 'metal', window_glaf: 'pvc', terrace_material: 'Beton', roof_type: 'flat', roof_overhang_mm: 0, roof_covering: 'Membrană bituminoasă', roof_parapet_h_mm: 600,
      wall_color: '#F4F4F2', plinth_material: 'Beton', floor_raise_mm: 150, windows: 'large',
      entrance: 'copertina', porch_depth_mm: 1200, chimney: false,
    },
    ranges: { roof_parapet_h_mm: [300, 1000], porch_depth_mm: [900, 1800], floor_raise_mm: [0, 450] },
  },
  {
    id: 'modern_barn',
    family: 'modern',
    label: 'Barn house',
    region: 'Modern nordic',
    description: 'Acoperiș abrupt în două ape, fără streașină, din tablă închisă; pereți placați cu lemn închis la culoare; ferestre mari; fără ornament.',
    params: {
      ...base, window_sill: 'metal', window_glaf: 'wood', corner_trim: 'metal', roof_type: 'gable', roof_pitch_deg: 42, roof_overhang_mm: 0, roof_covering: 'Tablă',
      wall_finish: 'Placaj lemn', wall_color: '#34312D', plinth_material: '', floor_raise_mm: 150,
      windows: 'large', entrance: 'none', chimney: false,
    },
    ranges: { roof_pitch_deg: [35, 50], roof_overhang_mm: [0, 300], floor_raise_mm: [0, 450] },
  },
  {
    id: 'modern_monopitch',
    family: 'modern',
    label: 'Contemporan într-o apă',
    region: 'Modern',
    description: 'Acoperiș într-o singură pantă joasă, pereți placați cu lemn natur, ferestre mari, copertină peste intrare, soclu din beton.',
    params: {
      ...base, window_trim: 'modern', window_glaf: 'wood', roof_type: 'shed', roof_pitch_deg: 10, roof_overhang_mm: 500, roof_covering: 'Tablă',
      wall_finish: 'Placaj lemn', plinth_material: 'Beton', floor_raise_mm: 150, windows: 'large',
      entrance: 'copertina', porch_depth_mm: 1400, chimney: false,
    },
    ranges: { roof_pitch_deg: [5, 18], floor_raise_mm: [0, 450] },
  },

  // ── Classic ──────────────────────────────────────────────────────────────
  {
    id: 'classic_neoclassical',
    family: 'classic',
    label: 'Vilă neoclasică',
    region: 'Clasic',
    description: 'Acoperiș jos în patru ape din tablă, pereți în tencuială crem cu cornișă și pilaștri albi la colțuri, ferestre înalte, portic cu coloane pe un soclu de piatră cu trepte.',
    params: {
      ...base, window_trim: 'classic', window_sill: 'stone', window_glaf: 'stone', terrace_material: 'Piatră', roof_pitch_deg: 26, roof_overhang_mm: 500, roof_seat: 'frieze', roof_covering: 'Tablă',
      wall_color: '#EADFC8', plinth_material: 'Piatră', floor_raise_mm: 600, windows: 'tall',
      cornice: true, pilasters: true, trim_color: '#FAF8F2',
      entrance: 'portic', porch_depth_mm: 1800, portico_columns: 4, column_d_mm: 360,
    },
    ranges: { roof_pitch_deg: [18, 32], porch_depth_mm: [1400, 2500], floor_raise_mm: [300, 1200] },
  },
  {
    id: 'classic_mansard',
    family: 'classic',
    label: 'Mansardă franceză',
    region: 'Beaux-Arts',
    description: 'Acoperiș mansardă — pantă abruptă jos, joasă sus — din ardezie, cornișă, ferestre înalte, soclu de piatră, intrare pe trepte.',
    params: {
      ...base, window_trim: 'classic', window_sill: 'stone', window_glaf: 'stone', corner_trim: 'quoins', terrace_material: 'Piatră', roof_type: 'mansard', roof_pitch_deg: 70, roof_upper_pitch_deg: 25, roof_overhang_mm: 200,
      roof_seat: 'frieze', roof_covering: 'Ardezie', wall_color: '#E6D8BD', plinth_material: 'Piatră',
      floor_raise_mm: 600, windows: 'tall', cornice: true, trim_color: '#F5F1E6', entrance: 'none',
    },
    ranges: { roof_pitch_deg: [60, 75], roof_upper_pitch_deg: [15, 35], roof_overhang_mm: [100, 400] },
  },
];

export const STYLE_PACK_MAP = new Map(STYLE_PACKS.map((p) => [p.id, p]));

/** The range a numeric parameter may take in a pack. */
export function paramRange(pack: StylePack, def: StyleParamDef): [number, number] | null {
  if (def.kind !== 'number') return null;
  return pack.ranges?.[def.key] ?? [def.min, def.max];
}

/**
 * The pack's defaults under the caller's values, each number clamped to the
 * pack's range and each choice kept to its options — whatever a caller (a
 * slider, a saved project, a language model) passes, the rules only ever see
 * values the style allows.
 */
export function resolveParams(pack: StylePack, given: Partial<StyleParams> = {}): StyleParams {
  const out: StyleParams = { ...pack.params };
  for (const def of STYLE_PARAMS) {
    const v = given[def.key];
    if (v === undefined) continue;
    if (def.kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = paramRange(pack, def)!;
      out[def.key] = Math.min(hi, Math.max(lo, n));
    } else if (def.kind === 'bool') {
      out[def.key] = v === true || v === 'True' || v === 'true';
    } else if (def.kind === 'choice') {
      if (def.options.some((o) => o.value === v)) out[def.key] = String(v);
    } else {
      const s = String(v);
      if (s === '' || /^#[0-9a-f]{6}$/i.test(s)) out[def.key] = s;
    }
  }
  return out;
}
