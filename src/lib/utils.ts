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
  if (Array.isArray(val)) return val as number[];
  if (typeof val === 'string' && val.trim().startsWith('[')) {
    try { return JSON.parse(val) as number[]; } catch { /* fall through */ }
  }
  return [];
}
