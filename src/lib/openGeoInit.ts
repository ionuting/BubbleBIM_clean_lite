/**
 * openGeoInit.ts — OpenGeometry WASM singleton initializer.
 *
 * Call `ensureOpenGeoReady()` before constructing any OG shape or Vector3.
 * Returns a cached promise so the WASM is only loaded once per session.
 */

import { OpenGeometry } from 'opengeometry';

let _initPromise: Promise<void> | null = null;

/**
 * Initializes the OpenGeometry WASM kernel (idempotent).
 * Safe to call concurrently — all callers share the same Promise.
 */
export async function ensureOpenGeoReady(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const wasmURL = `${import.meta.env.BASE_URL}opengeometry_bg.wasm`.replace('//', '/');
    await OpenGeometry.create({ wasmURL });
  })();
  return _initPromise;
}
