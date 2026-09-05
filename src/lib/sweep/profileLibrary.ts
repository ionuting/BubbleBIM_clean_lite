/**
 * profileLibrary.ts — one resolver over the three profile sources.
 *
 * DXF profiles ride the existing bglib pipeline: drop a QCAD drawing in
 * `backend/library/profiles/symbols2d/<id>.dxf` and it is listed, parsed and
 * cached by the backend with zero backend change (the auto-symbol routes take
 * any lowercase element type). The store's cache is synchronous once
 * `initAutoSymbolList('profile')` has run — WITHOUT that call every dxf id
 * parks as 'loading' forever, so viewers call `ensureProfileLibraryLoaded()`
 * on mount and subscribe to the bglib store for the late arrivals.
 */
import {
  initAutoSymbolList,
  listAutoSymbols,
  resolveAutoSymbol,
} from '@/lib/bglibSymbolStore';
import {
  CATALOGUE_PROFILES,
  PARAMETRIC_PROFILES,
  profileFromBglib,
  resolveBuiltinProfile,
} from './profiles';
import type { SweepDiagnostic, SweepProfile, SweepProfileGroup } from './types';

export const PROFILE_ELEMENT_TYPE = 'profile';

export interface SweepProfileOption {
  id: string;
  label: string;
  group: SweepProfileGroup;
}

export interface ResolvedProfile {
  profile: SweepProfile | null;
  diagnostics: SweepDiagnostic[];
}

export type SweepProfileResolver = (
  id: string,
  params: Record<string, number>,
) => ResolvedProfile;

let _dxfIds: string[] = [];
let _loadStarted = false;

/** Kick off the DXF listing once; safe to call from every consumer's mount. */
export async function ensureProfileLibraryLoaded(): Promise<void> {
  if (_loadStarted) return;
  _loadStarted = true;
  try {
    await initAutoSymbolList(PROFILE_ELEMENT_TYPE);
    const list = await listAutoSymbols(PROFILE_ELEMENT_TYPE);
    _dxfIds = list.map((s) => s.typeId);
  } catch {
    // Backend absent (Clean Lite offline) — built-ins and catalogue carry on.
  }
}

/** Everything the profile picker offers, grouped. */
export function listProfileOptions(): SweepProfileOption[] {
  return [
    ...PARAMETRIC_PROFILES.map((p) => ({ id: p.id, label: p.label, group: 'parametric' as const })),
    ...CATALOGUE_PROFILES.map((p) => ({ id: p.id, label: p.label, group: 'catalogue' as const })),
    ..._dxfIds.map((id) => ({ id: `dxf:${id}`, label: id, group: 'dxf' as const })),
  ];
}

/**
 * Parsed DXF profiles, keyed by (typeId, width, height) — sliders make the
 * size part of the result. Bounded because dragging a width input resolves a
 * new size on every frame, and every viewer rebuild resolves again: unbounded,
 * a long session would accumulate thousands of polygons nobody looks at.
 * Oldest-first eviction is enough; the working set is one or two profiles.
 */
const DXF_CACHE_MAX = 64;
const _dxfCache = new Map<string, ResolvedProfile>();

function cacheDxf(key: string, value: ResolvedProfile): void {
  if (_dxfCache.size >= DXF_CACHE_MAX) {
    const oldest = _dxfCache.keys().next();
    if (!oldest.done) _dxfCache.delete(oldest.value);
  }
  _dxfCache.set(key, value);
}

export const resolveSweepProfile: SweepProfileResolver = (id, params) => {
  if (id.startsWith('dxf:')) {
    const typeId = id.slice(4);
    const sym = resolveAutoSymbol(PROFILE_ELEMENT_TYPE, typeId);
    if (!sym) return { profile: null, diagnostics: [] }; // loading / absent → PROFILE_UNAVAILABLE upstream
    // Sliders make a DXF profile parametric, so the size is part of the key.
    const w = Number.isFinite(params.p_w_mm) ? params.p_w_mm : 0;
    const h = Number.isFinite(params.p_h_mm) ? params.p_h_mm : 0;
    const key = `${typeId}|${w}|${h}`;
    const cached = _dxfCache.get(key);
    if (cached) return cached;
    const { polygon, diagnostics } = profileFromBglib(sym, { widthMm: w, heightMm: h });
    const out: ResolvedProfile = {
      profile: polygon
        ? {
            id, label: sym.name, group: 'dxf', polygon,
            sizing: {
              defaultWidthMm: sym.defaultWidth,
              defaultHeightMm: sym.defaultHeight,
              stretchX: sym.sliders.some((s) => s.axis === 'x'),
              stretchY: sym.sliders.some((s) => s.axis === 'y'),
            },
          }
        : null,
      diagnostics,
    };
    cacheDxf(key, out);
    return out;
  }
  return { profile: resolveBuiltinProfile(id, params), diagnostics: [] };
};
