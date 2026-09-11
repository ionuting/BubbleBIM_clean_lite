/**
 * wallFraming.ts — the studs, plates, headers and cripples inside a
 * timber-frame wall, derived from the wall's geometry and its openings.
 *
 * ## Derived, never stored
 *
 * The roof solver writes its rafters into the graph as nodes, because a
 * rafter can be edited afterwards. Wall framing is different: nobody edits an
 * individual stud, and a scenario that turns a brick house to timber would
 * otherwise have to add hundreds of nodes to a delta that is meant to stay a
 * few lines long. So this module computes framing on demand — the 3D viewer
 * calls it to draw, the takeoff calls it to count — from the same three
 * inputs: length, height, openings. Same inputs, same studs, everywhere.
 *
 * ## Layout rule (platform framing)
 *
 * Bottom plate, double top plate, common studs on a fixed centre-to-centre
 * spacing from the wall's start plus one at the far end. Around every opening
 * a king stud on each side runs full height, a header spans the opening on
 * jack studs, cripples continue the stud rhythm above the header and, for a
 * window, below the sill. Studs whose line falls inside an opening are the
 * ones the header replaces.
 *
 * ## What the structure decides
 *
 * - The HEADER is sized by its span (`headerForSpan`): two plies of the stud
 *   depth up to 1.2 m, deeper solid timber to 2.0 m and 3.0 m, LVL beyond —
 *   the usual span tables for a single-storey load, not a calculation.
 * - Spans over `DOUBLE_KING_SPAN_MM` get a second king each side, because
 *   that is where the header's reaction stops fitting on one stud.
 * - Wall JUNCTIONS get extra studs: a corner is three studs (the classic
 *   nailing corner), a tee gets two backing studs for the partition's board.
 * - The second top plate laps past a corner by the stud depth, tying the two
 *   walls together.
 *
 * Coordinates are wall-local: `x` along the centre-line from the start (mm),
 * `z` up from the wall's base (mm). `placeMember` maps them to BIM plan
 * coordinates for the viewers.
 *
 * Pure: no scene, no store.
 */

export interface FramingSection {
  /** Thickness of the timber as seen along the wall (the 45 in 45×145), mm. */
  wMm: number;
  /** Depth across the wall (the 145 in 45×145), mm. */
  dMm: number;
}

export type FramingMemberKind = 'bottom_plate' | 'top_plate' | 'stud' | 'king' | 'jack' | 'header' | 'sill' | 'cripple';
export type FramingGrade = 'c24' | 'lvl';

export interface FramingMember {
  kind: FramingMemberKind;
  /** Start and end in wall-local (x along, z up), mm. */
  a: { x: number; z: number };
  b: { x: number; z: number };
  /** Section of ONE ply. */
  section: FramingSection;
  /** Plies side by side across the wall (a header is usually 2). Default 1. */
  plies?: number;
  grade?: FramingGrade;
}

export interface FramingOpening {
  /** Left edge from the wall start, mm. */
  x0Mm: number;
  widthMm: number;
  /** Bottom of the opening above the wall base (0 for a door), mm. */
  sillMm: number;
  heightMm: number;
}

export type JunctionKind = 'corner' | 'tee';

export interface FramingJunction {
  /** Along the wall, mm — in practice 0 or the wall length. */
  xMm: number;
  kind: JunctionKind;
}

export interface FramingInput {
  lengthMm: number;
  heightMm: number;
  openings: FramingOpening[];
  spacingMm?: number;
  section?: FramingSection;
  doubleTopPlate?: boolean;
  junctions?: FramingJunction[];
  /** Sheet size for the sheathing count. */
  sheetMm?: { w: number; h: number };
}

export interface WallFraming {
  members: FramingMember[];
  /** Full-height studs: commons + kings + junction studs. What the "number of studs" norm counts. */
  studCount: number;
  /** Every member's length summed, plies included — the metres of timber to buy. */
  framingLengthM: number;
  /** Vertical members only (studs, kings, jacks, cripples), plies included. */
  studLengthM: number;
  /** Plates and sills. */
  plateLengthM: number;
  /** Headers, plies included. */
  headerLengthM: number;
  headerCount: number;
  /** Wall face area minus openings, ONE side — sheathing per side reads this. */
  sheathingAreaM2: number;
  /** Whole sheets needed for one face at the given sheet size. */
  sheathingSheetCount: number;
  /** Timber volume, for a per-m³ norm. */
  volumeM3: number;
}

export const DEFAULT_STUD_SPACING_MM = 625;
export const DEFAULT_SECTION: FramingSection = { wMm: 45, dMm: 145 };
export const DEFAULT_SHEET_MM = { w: 1250, h: 2500 };
/** Above this opening span the header gets a second king each side. */
export const DOUBLE_KING_SPAN_MM = 1800;

/** Section from a `T4.5x14.5`-style code (cm, like the roof's timber codes), or the default. */
export function parseFramingSection(code: string | undefined, fallback = DEFAULT_SECTION): FramingSection {
  const m = String(code ?? '').match(/^[Tt](\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (!m) return fallback;
  return { wMm: Math.round(+m[1] * 10), dMm: Math.round(+m[2] * 10) };
}

/**
 * The section a wall type implies when the wall does not say: the deepest stud
 * that fits the build-up with a sheet each side. `TF14` → 95, `TF20` → 145,
 * `TF25` → 195; a masonry code turned to timber by a scenario gets the same
 * reading of its thickness.
 */
export function sectionForThickness(thicknessMm: number): FramingSection {
  const d = thicknessMm - 55;                 // OSB 12 + board 12.5 + tolerance
  const pick = [95, 120, 145, 170, 195, 245].filter((x) => x <= d).pop() ?? 95;
  return { wMm: 45, dMm: pick };
}

/**
 * Header for an opening span, single-storey loads. The header's DEPTH is what
 * the span sets; its plies stack across the wall and never exceed the stud
 * depth (a 2×45 header sits inside a 145 wall with room for insulation).
 */
export function headerForSpan(spanMm: number, stud: FramingSection): { section: FramingSection; plies: number; grade: FramingGrade } {
  const w = stud.wMm;
  if (spanMm <= 1200) return { section: { wMm: w, dMm: Math.max(stud.dMm, 145) }, plies: 2, grade: 'c24' };
  if (spanMm <= 2000) return { section: { wMm: w, dMm: 195 }, plies: 2, grade: 'c24' };
  if (spanMm <= 3000) return { section: { wMm: w, dMm: 245 }, plies: 2, grade: 'c24' };
  return { section: { wMm: w, dMm: 300 }, plies: 2, grade: 'lvl' };
}

const nearlyInside = (x: number, lo: number, hi: number) => x > lo + 1 && x < hi - 1;

/** Stud line positions along the wall — the rhythm the whole layout follows. */
function studLines(lengthMm: number, spacingMm: number): number[] {
  const xs: number[] = [];
  for (let x = 0; x <= lengthMm - 1; x += spacingMm) xs.push(x);
  if (lengthMm - (xs[xs.length - 1] ?? -Infinity) > 1) xs.push(lengthMm);
  return xs;
}

/**
 * Whole sheets for one face: columns of sheets along the wall, rows up the
 * wall, minus the sheets that fall entirely inside one opening. Offcuts are
 * not reused — that is what the site does too.
 */
export function sheathingSheets(
  lengthMm: number, heightMm: number,
  openings: { x0: number; x1: number; sill: number; top: number }[],
  sheet = DEFAULT_SHEET_MM,
): number {
  if (lengthMm < 1 || heightMm < 1) return 0;
  const cols = Math.ceil(lengthMm / sheet.w);
  const rows = Math.ceil(heightMm / sheet.h);
  let n = 0;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const x0 = c * sheet.w, x1 = Math.min(lengthMm, x0 + sheet.w);
      const z0 = r * sheet.h, z1 = Math.min(heightMm, z0 + sheet.h);
      const inside = openings.some((o) => x0 >= o.x0 - 1 && x1 <= o.x1 + 1 && z0 >= o.sill - 1 && z1 <= o.top + 1);
      if (!inside) n++;
    }
  }
  return n;
}

const memberLen = (m: FramingMember) => Math.hypot(m.b.x - m.a.x, m.b.z - m.a.z) * (m.plies ?? 1);

export function computeWallFraming(input: FramingInput): WallFraming {
  const L = Math.max(0, input.lengthMm);
  const H = Math.max(0, input.heightMm);
  const spacing = Math.max(200, input.spacingMm ?? DEFAULT_STUD_SPACING_MM);
  const section = input.section ?? DEFAULT_SECTION;
  const t = section.wMm;
  const doubleTop = input.doubleTopPlate ?? true;
  const members: FramingMember[] = [];

  if (L < 1 || H < 1) {
    return {
      members, studCount: 0, framingLengthM: 0, studLengthM: 0, plateLengthM: 0, headerLengthM: 0,
      headerCount: 0, sheathingAreaM2: 0, sheathingSheetCount: 0, volumeM3: 0,
    };
  }

  const plateTop = doubleTop ? 2 * t : t;
  const studBot = t;
  const studTop = H - plateTop;
  const junctions = input.junctions ?? [];
  const cornerAtStart = junctions.some((j) => j.kind === 'corner' && j.xMm <= 1);
  const cornerAtEnd = junctions.some((j) => j.kind === 'corner' && j.xMm >= L - 1);

  // Plates run the full length; the upper top plate laps past a corner.
  members.push({ kind: 'bottom_plate', a: { x: 0, z: t / 2 }, b: { x: L, z: t / 2 }, section });
  members.push({ kind: 'top_plate', a: { x: 0, z: H - t - (doubleTop ? t : 0) + t / 2 }, b: { x: L, z: H - t - (doubleTop ? t : 0) + t / 2 }, section });
  if (doubleTop) {
    members.push({
      kind: 'top_plate',
      a: { x: cornerAtStart ? -section.dMm : 0, z: H - t / 2 },
      b: { x: cornerAtEnd ? L + section.dMm : L, z: H - t / 2 },
      section,
    });
  }

  // Openings clipped to the wall, sorted, so the stud loop can test them.
  const ops = input.openings
    .map((o) => ({
      x0: Math.max(0, o.x0Mm),
      x1: Math.min(L, o.x0Mm + o.widthMm),
      sill: Math.max(0, o.sillMm),
      top: Math.min(H, o.sillMm + o.heightMm),
    }))
    .filter((o) => o.x1 - o.x0 > 1 && o.top - o.sill > 1)
    .sort((a, b) => a.x0 - b.x0);
  const headerOf = (o: { x0: number; x1: number }) => headerForSpan(o.x1 - o.x0, section);

  let studCount = 0;
  const stud = (kind: FramingMemberKind, x: number, z0: number, z1: number) => {
    if (z1 - z0 < 1) return;
    members.push({ kind, a: { x, z: z0 }, b: { x, z: z1 }, section });
  };

  // Common studs on the rhythm, except where an opening's header takes over.
  for (const x of studLines(L, spacing)) {
    const inOpening = ops.find((o) => nearlyInside(x, o.x0, o.x1));
    if (!inOpening) {
      stud('stud', x, studBot, studTop);
      studCount++;
      continue;
    }
    // Cripples keep the rhythm above the header and below a window sill.
    const headerTop = inOpening.top + headerOf(inOpening).section.dMm;
    stud('cripple', x, Math.min(studTop, headerTop), studTop);
    if (inOpening.sill > studBot + t) stud('cripple', x, studBot, inOpening.sill - t);
  }

  // Around each opening: king studs, jacks, header, sill.
  let headerCount = 0;
  for (const o of ops) {
    const span = o.x1 - o.x0;
    const kings = span > DOUBLE_KING_SPAN_MM ? 2 : 1;
    for (let k = 0; k < kings; k++) {
      stud('king', o.x0 - t / 2 - k * t, studBot, studTop);
      stud('king', o.x1 + t / 2 + k * t, studBot, studTop);
      studCount += 2;
    }
    stud('jack', o.x0 + t / 2, studBot, o.top);
    stud('jack', o.x1 - t / 2, studBot, o.top);
    const hdr = headerOf(o);
    const headerZ = o.top + hdr.section.dMm / 2;
    if (o.top + hdr.section.dMm <= studTop + 1) {
      members.push({
        kind: 'header',
        a: { x: o.x0 - t, z: headerZ }, b: { x: o.x1 + t, z: headerZ },
        section: hdr.section, plies: hdr.plies, grade: hdr.grade,
      });
      headerCount++;
    }
    if (o.sill > studBot + t) {
      members.push({ kind: 'sill', a: { x: o.x0, z: o.sill - t / 2 }, b: { x: o.x1, z: o.sill - t / 2 }, section });
    }
  }

  // Junction studs: a three-stud corner, two backing studs at a tee. The stud
  // on the rhythm at x=0 / x=L is already there; these are the extras.
  for (const j of junctions) {
    const x = Math.min(L, Math.max(0, j.xMm));
    const inward = x <= 1 ? 1 : x >= L - 1 ? -1 : 0;
    const extras = 2;
    for (let k = 1; k <= extras; k++) {
      const dx = inward !== 0 ? inward * k * t : (k === 1 ? -t : t);
      stud(j.kind === 'corner' ? 'stud' : 'king', x + dx, studBot, studTop);
      studCount++;
    }
  }

  const verticalKinds: FramingMemberKind[] = ['stud', 'king', 'jack', 'cripple'];
  const plateKinds: FramingMemberKind[] = ['bottom_plate', 'top_plate', 'sill'];
  const sum = (kinds: FramingMemberKind[]) => members.filter((m) => kinds.includes(m.kind)).reduce((s, m) => s + memberLen(m), 0);
  const lengthMm = members.reduce((s, m) => s + memberLen(m), 0);
  const volumeMm3 = members.reduce((s, m) => s + memberLen(m) * m.section.wMm * m.section.dMm, 0);
  const openingArea = ops.reduce((s, o) => s + (o.x1 - o.x0) * (o.top - o.sill), 0);

  return {
    members,
    studCount,
    framingLengthM: Math.round(lengthMm) / 1000,
    studLengthM: Math.round(sum(verticalKinds)) / 1000,
    plateLengthM: Math.round(sum(plateKinds)) / 1000,
    headerLengthM: Math.round(sum(['header'])) / 1000,
    headerCount,
    sheathingAreaM2: Math.max(0, L * H - openingArea) / 1e6,
    sheathingSheetCount: sheathingSheets(L, H, ops, input.sheetMm ?? DEFAULT_SHEET_MM),
    volumeM3: volumeMm3 / 1e9,
  };
}

/**
 * A member's two end points in BIM plan coordinates plus absolute z, for the
 * viewers. `start` is the wall's effective start, `dir` its unit direction,
 * `baseZMm` the wall's base elevation. Members sit on the wall centre-line.
 */
export function placeMember(
  m: FramingMember,
  start: { x: number; y: number },
  dir: { x: number; y: number },
  baseZMm: number,
): { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } } {
  const at = (p: { x: number; z: number }) => ({
    x: start.x + dir.x * p.x,
    y: start.y + dir.y * p.x,
    z: baseZMm + p.z,
  });
  return { a: at(m.a), b: at(m.b) };
}
