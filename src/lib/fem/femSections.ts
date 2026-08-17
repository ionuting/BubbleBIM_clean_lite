/**
 * femSections.ts — pure section/material property helpers for the FEM spike.
 *
 * All outputs are SI units (metres, Pa, N) — the unit system `@awatif/components`'
 * linear solver expects (see `elementsProps` in its data-model.ts).
 *
 * Material values are approximate Eurocode (EC2) defaults for ordinary reinforced
 * concrete. Good enough for a first generative-design pass (relative stiffness,
 * rough deflection/reaction sanity checks) — NOT for code-checking / certification.
 */

// ─── Material constants (concrete C25/30, EC2 Table 3.1) ─────────────────────

export const CONCRETE_ELASTICITY_PA = 31e9; // E_cm for C25/30
export const CONCRETE_POISSON_RATIO = 0.2;
export const CONCRETE_SHEAR_MODULUS_PA =
  CONCRETE_ELASTICITY_PA / (2 * (1 + CONCRETE_POISSON_RATIO));
export const CONCRETE_DENSITY_KG_M3 = 2500;
export const GRAVITY_ACCEL = 9.81; // m/s²

export interface SectionProps {
  area: number;             // m²
  momentInertiaY: number;   // m⁴ — bending about local y
  momentInertiaZ: number;   // m⁴ — bending about local z
  torsionalConstant: number; // m⁴ — St. Venant torsion constant J
}

/**
 * Rectangular section (width w × depth d, metres).
 * Torsion constant uses the standard thin/thick rectangle approximation
 * (Roark) — exact enough for relative-stiffness generative-design purposes.
 */
export function rectSectionProps(w: number, d: number): SectionProps {
  const area = w * d;
  const momentInertiaZ = (w * d ** 3) / 12;
  const momentInertiaY = (d * w ** 3) / 12;

  const a = Math.max(w, d);
  const b = Math.min(w, d);
  const torsionalConstant =
    a * b ** 3 * (1 / 3 - 0.21 * (b / a) * (1 - b ** 4 / (12 * a ** 4)));

  return { area, momentInertiaY, momentInertiaZ, torsionalConstant };
}

/** Circular section (radius r, metres) — used for `CR{d}` column types. */
export function circularSectionProps(r: number): SectionProps {
  const area = Math.PI * r ** 2;
  const i = (Math.PI * r ** 4) / 4;
  return {
    area,
    momentInertiaY: i,
    momentInertiaZ: i,
    torsionalConstant: (Math.PI * r ** 4) / 2,
  };
}

// ─── Awatif `ElementProps` shape ───────────────────────────────────────────
// Mirrors `@awatif/components`' `data-model.ts` `ElementProps` exactly: 2-node
// frame elements read the required fields; 3-node shell elements read only
// `elasticity`/`poissonRatio`/`thickness` (see getLocalStiffnessMatrix — it
// branches on `nodes.length === 3` and ignores area/inertia/shear/torsion for
// shells). We still fill zeros for the unused side so ONE map type covers
// both element kinds, same as upstream's type does.

export interface FemElementProps {
  elasticity: number;
  area: number;
  momentInertiaY: number;
  momentInertiaZ: number;
  shearModulus: number;
  torsionalConstant: number;
  thickness?: number;    // shell (3-node) elements only
  poissonRatio?: number; // shell (3-node) elements only
}

export function frameElementProps(sec: SectionProps): FemElementProps {
  return {
    ...sec,
    elasticity: CONCRETE_ELASTICITY_PA,
    shearModulus: CONCRETE_SHEAR_MODULUS_PA,
  };
}

export function shellElementProps(thicknessM: number): FemElementProps {
  return {
    elasticity: CONCRETE_ELASTICITY_PA,
    shearModulus: CONCRETE_SHEAR_MODULUS_PA,
    area: 0,
    momentInertiaY: 0,
    momentInertiaZ: 0,
    torsionalConstant: 0,
    thickness: thicknessM,
    poissonRatio: CONCRETE_POISSON_RATIO,
  };
}
