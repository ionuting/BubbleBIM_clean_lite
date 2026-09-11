import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safely parse an axesX / axesY value that may arrive as:
 *  - a real number[]  (JSON file storage — normal case)
 *  - a JSON string    (legacy LadybugDB serialization bug)
 *  - undefined / null
 */
export function parseAxes(val: unknown): number[] {
  // Always a fresh array: a dozen call sites `.sort()` the result in place, and
  // handing them the stored property would silently reorder the storey's axes.
  if (Array.isArray(val)) return (val as number[]).slice();
  if (typeof val === 'string' && val.trim().startsWith('[')) {
    try { return JSON.parse(val) as number[]; } catch { /* fall through */ }
  }
  return [];
}
