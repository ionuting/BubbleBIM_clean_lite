/**
 * Vector / punct 2D și operații de bază. Toate coordonatele în milimetri.
 */
export interface Vector2 {
  x: number;
  y: number;
}

export function vec(x: number, y: number): Vector2 {
  return { x, y };
}

export function aduna(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scade(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function inmulteste(a: Vector2, scalar: number): Vector2 {
  return { x: a.x * scalar, y: a.y * scalar };
}

export function lungime(a: Vector2): number {
  return Math.hypot(a.x, a.y);
}

export function distanta(a: Vector2, b: Vector2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Normalizează vectorul; întoarce (0,0) pentru vector nul. */
export function normalizeaza(a: Vector2): Vector2 {
  const l = lungime(a);
  if (l < 1e-9) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}

/** Produsul scalar. */
export function produsScalar(a: Vector2, b: Vector2): number {
  return a.x * b.x + a.y * b.y;
}

/** Produsul vectorial (componenta z). Semnul indică sensul de rotație. */
export function produsVectorial(a: Vector2, b: Vector2): number {
  return a.x * b.y - a.y * b.x;
}

/** Rotește vectorul cu un unghi dat (radiani). */
export function roteste(a: Vector2, unghi: number): Vector2 {
  const c = Math.cos(unghi);
  const s = Math.sin(unghi);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** Unghiul vectorului față de axa X, în radiani. */
export function unghi(a: Vector2): number {
  return Math.atan2(a.y, a.x);
}

export function grade(radiani: number): number {
  return (radiani * 180) / Math.PI;
}

export function radiani(grade: number): number {
  return (grade * Math.PI) / 180;
}
