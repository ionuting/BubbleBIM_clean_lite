/**
 * WorldGeoPanel — georeferencing, as a person who has never heard of an EPSG
 * code would need it.
 *
 * The guided path asks three things, in the order a surveyor's drawing gives
 * them: which country, the coordinates of the model origin in that country's
 * grid, and whether to write the position into the IFC. The grid itself is
 * chosen FOR the user from the country and the point — a Madrid project gets
 * UTM 30N, a Viennese one gets Gauss-Krüger M34 — with a one-line reason and
 * a way to override it.
 *
 * Everything that needs prior knowledge (any EPSG code, a converter between
 * arbitrary systems) sits behind "Avansat".
 *
 * Kept out of WorldViewer.tsx, which is already 1500 lines of Cesium
 * lifecycle. This file owns no Cesium — it emits state and lets the viewer
 * draw, so every rule here stays testable without a WebGL context.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorldLocation } from '@/store';
import {
  COUNTRIES, axisLabels, convert, crsInfo, detectCountry, georefFromWorldLocation,
  legacyNote, listCrs, placeOverlay, recommendCrsAt, WGS84,
  type CountryCode, type OverlayCorners, type OverlayPlacement,
} from '@/lib/geo';

export type BasemapId = 'osm' | 'satellite' | 'topo';

export const BASEMAPS: { id: BasemapId; label: string; url: string; credit: string; maxLevel: number }[] = [
  {
    id: 'osm', label: 'Stradal (OSM)',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: '© OpenStreetMap contributors', maxLevel: 19,
  },
  {
    id: 'satellite', label: 'Satelit',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Esri, Maxar, Earthstar Geographics', maxLevel: 19,
  },
  {
    id: 'topo', label: 'Topografic',
    url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    credit: '© OpenTopoMap (CC-BY-SA)', maxLevel: 17,
  },
];

export interface OverlayState {
  /** Object URL of the picked image; null when nothing is loaded. */
  imageUrl: string | null;
  fileName: string | null;
  corners: OverlayCorners;
  opacity: number;
  visible: boolean;
}

export const emptyOverlay = (crs: string): OverlayState => ({
  imageUrl: null, fileName: null, opacity: 0.7, visible: true,
  corners: { crs, minX: 0, minY: 0, maxX: 0, maxY: 0 },
});

interface Props {
  loc: WorldLocation;
  onLocChange: (patch: Partial<WorldLocation>) => void;
  basemap: BasemapId;
  onBasemapChange: (id: BasemapId) => void;
  overlay: OverlayState;
  onOverlayChange: (patch: Partial<OverlayState>) => void;
  /** Fly the camera to a geographic point. */
  onGoTo: (lat: number, lng: number) => void;
}

const HEAD = 'text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2';
const INPUT = 'flex-1 min-w-0 bg-background border border-border rounded px-2 py-0.5 text-xs text-foreground font-mono';
const SELECT = 'w-full bg-background border border-border rounded px-2 py-1 text-xs text-foreground';
const BTN = 'w-full text-xs py-1 rounded bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors';
const BTN_QUIET = 'w-full text-xs py-1 rounded bg-background border border-border hover:bg-muted/50 transition-colors';

function Num({ label, value, onChange, unit, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; unit?: string; placeholder?: string;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-10 shrink-0 text-right">{label}</span>
      <input
        className={INPUT} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} inputMode="decimal"
      />
      {unit && <span className="text-[10px] text-muted-foreground w-4">{unit}</span>}
    </label>
  );
}

function crsLabel(code: string): string {
  const d = crsInfo(code);
  return d ? `${d.label} · ${code}` : code;
}

export function WorldGeoPanel({
  loc, onLocChange, basemap, onBasemapChange, overlay, onOverlayChange, onGoTo,
}: Props) {
  const systems = useMemo(() => listCrs(), []);
  const crs = loc.crs ?? 'EPSG:3844';

  // ── Where the model origin actually stands ────────────────────────────────
  // Through `georefFromWorldLocation`, NOT by projecting lat/lng directly:
  // that is the function the IFC export calls, so the number on screen is the
  // number in the file by construction rather than by coincidence. It also
  // applies the ENU offsets the globe applies — projecting the bare lat/lng
  // showed a point the model was not standing on, off by the whole offset.
  const origin = useMemo(() => {
    try {
      const gr = georefFromWorldLocation(loc, crs);
      return { e: gr.eastings, n: gr.northings, lat: gr.lat, lng: gr.lng };
    } catch {
      return null;
    }
  }, [loc, crs]);

  const here = { lat: origin?.lat ?? loc.lat, lng: origin?.lng ?? loc.lng };

  // ── Country → recommended system ─────────────────────────────────────────
  // The country is a UI choice, not project data: the CRS is what persists,
  // and the country is only the friendliest way to arrive at one. It starts
  // from wherever the model is, and falls back to Romania.
  //
  // It follows the model: carried to another country, the panel shows that
  // country (and the placement itself re-picks the grid — `crsForLocation`).
  // A country chosen by hand holds until the model leaves it. Outside every
  // country listed, the choice is "Altă țară" and the grid is the UTM zone.
  const detected = detectCountry(here.lat, here.lng);
  const [picked, setPicked] = useState<CountryCode | 'other' | null>(null);
  useEffect(() => { setPicked(null); }, [detected]);
  const country: CountryCode | null = picked === 'other' ? null : (picked ?? detected);
  const recommended = useMemo(
    () => recommendCrsAt(here.lat, here.lng, country),
    [country, here.lat, here.lng],
  );
  const usingRecommended = crs === recommended.crs;
  const [overriding, setOverriding] = useState(false);

  // Choosing a country adopts its recommendation. Moving the model within a
  // country does NOT re-pick automatically: a project that started in UTM 30N
  // should not flip to 31N because the user nudged it across 0° — that is a
  // decision, and the panel says "recomandat: …" so it can be made.
  const onCountry = (c: CountryCode | 'other') => {
    setPicked(c);
    setOverriding(false);
    onLocChange({ crs: recommendCrsAt(here.lat, here.lng, c === 'other' ? null : c).crs });
  };

  const legacy = legacyNote(crs);

  // ── Model origin, in the chosen grid ──────────────────────────────────────
  // Two-way: shows where the origin currently lands, and accepts typed
  // coordinates to put it somewhere. Typing goes straight to lat/lng with the
  // ENU offsets cleared — a surveyed point IS the origin, not a nudge from it.
  const [eIn, setEIn] = useState('');
  const [nIn, setNIn] = useState('');
  // Keep the fields showing the live origin until the user starts typing.
  const [editingOrigin, setEditingOrigin] = useState(false);
  useEffect(() => {
    if (!editingOrigin && origin) {
      setEIn(origin.e.toFixed(2));
      setNIn(origin.n.toFixed(2));
    }
  }, [origin, editingOrigin]);

  const placeAtTyped = () => {
    const e = parseFloat(eIn), n = parseFloat(nIn);
    if (!Number.isFinite(e) || !Number.isFinite(n)) return;
    try {
      const g = convert({ x: e, y: n }, crs, WGS84);
      onLocChange({ lat: g.y, lng: g.x, offsetE: 0, offsetN: 0, georeferenced: true });
      onGoTo(g.y, g.x);
      setEditingOrigin(false);
    } catch { /* the readout stays; nothing to place */ }
  };

  const ax = axisLabels(crs);

  // ── Advanced: converter + any EPSG ────────────────────────────────────────
  const [advanced, setAdvanced] = useState(false);
  const [fromCrs, setFromCrs] = useState(crs);
  const [toCrs, setToCrs] = useState(WGS84);
  const [inX, setInX] = useState('');
  const [inY, setInY] = useState('');
  const converted = useMemo(() => {
    const x = parseFloat(inX), y = parseFloat(inY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    try {
      return convert({ x, y }, fromCrs, toCrs);
    } catch {
      return null;
    }
  }, [inX, inY, fromCrs, toCrs]);
  const fromAx = axisLabels(fromCrs);
  const toAx = axisLabels(toCrs);

  // ── Overlay ──────────────────────────────────────────────────────────────
  const fileRef = useRef<HTMLInputElement>(null);
  const placement: OverlayPlacement | null = useMemo(() => {
    const r = placeOverlay(overlay.corners);
    return r.ok ? r.placement : null;
  }, [overlay.corners]);
  const placementError = useMemo(() => {
    const r = placeOverlay(overlay.corners);
    return r.ok ? null : r.message;
  }, [overlay.corners]);
  const setCorner = (k: keyof OverlayCorners, v: string) =>
    onOverlayChange({ corners: { ...overlay.corners, [k]: parseFloat(v) } });
  const ovAx = axisLabels(overlay.corners.crs);
  // The overlay's grid defaults to the project's: same surveyor, same plan.
  const overlaySystems = useMemo(() => {
    const own = COUNTRIES.find((c) => c.code === country)?.systems ?? [];
    return [...own, ...systems.map((s) => s.code).filter((c) => !own.includes(c))];
  }, [country, systems]);

  return (
    <>
      {/* ── Georeferencing, guided ───────────────────────────────────────── */}
      <div className="p-3 border-b border-border">
        <div className={HEAD}>Georeferențiere</div>

        <label className="flex items-center gap-2 mb-2">
          <span className="text-[10px] text-muted-foreground w-10 shrink-0 text-right">Țara</span>
          <select className={SELECT} value={country ?? 'other'} onChange={(e) => onCountry(e.target.value as CountryCode | 'other')}>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            <option value="other">Altă țară — WGS 84 / UTM</option>
          </select>
        </label>

        <div className="flex items-start gap-2 mb-1">
          <span className="text-[10px] text-muted-foreground w-10 shrink-0 text-right pt-0.5">Sistem</span>
          <div className="flex-1 min-w-0">
            {!overriding ? (
              <>
                <div className="text-xs text-foreground leading-tight">{crsLabel(crs)}</div>
                {usingRecommended ? (
                  <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                    ✓ {recommended.reason}
                  </div>
                ) : (
                  <div className="text-[10px] text-amber-500/90 leading-tight mt-0.5">
                    Recomandat pentru această poziție: {crsLabel(recommended.crs)}.{' '}
                    <button className="underline" onClick={() => onLocChange({ crs: recommended.crs })}>
                      Folosește
                    </button>
                  </div>
                )}
                {legacy && (
                  <div className="text-[10px] text-amber-500/90 leading-tight mt-0.5">⚠ {legacy}</div>
                )}
                <button
                  className="text-[10px] text-muted-foreground underline mt-0.5"
                  onClick={() => setOverriding(true)}
                >
                  schimbă…
                </button>
              </>
            ) : (
              <select
                className={SELECT} value={crs} autoFocus
                onChange={(e) => { onLocChange({ crs: e.target.value }); setOverriding(false); }}
                onBlur={() => setOverriding(false)}
              >
                <optgroup label={COUNTRIES.find((c) => c.code === country)?.label}>
                  {(COUNTRIES.find((c) => c.code === country)?.systems ?? []).map((code) => (
                    <option key={code} value={code}>
                      {crsLabel(code)}{legacyNote(code) ? ' — vechi' : ''}
                    </option>
                  ))}
                </optgroup>
              </select>
            )}
          </div>
        </div>

        <div className="mt-3 text-[10px] text-muted-foreground mb-1">
          Originea modelului (BIM 0,0) în {crsInfo(crs)?.label ?? crs}
        </div>
        <div className="flex flex-col gap-1.5">
          <Num
            label={ax.x} value={eIn} unit={ax.unit}
            onChange={(v) => { setEditingOrigin(true); setEIn(v); }}
          />
          <Num
            label={ax.y} value={nIn} unit={ax.unit}
            onChange={(v) => { setEditingOrigin(true); setNIn(v); }}
          />
          {editingOrigin && (
            <div className="flex gap-1">
              <button className={BTN} onClick={placeAtTyped}>Plasează modelul aici</button>
              <button
                className={`${BTN_QUIET} w-auto px-2`}
                title="Renunță"
                onClick={() => setEditingOrigin(false)}
              >
                ✕
              </button>
            </div>
          )}
        </div>

        <label className="mt-3 flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox" className="mt-0.5"
            checked={loc.georeferenced ?? false}
            onChange={(e) => onLocChange({ georeferenced: e.target.checked })}
          />
          <span className="text-[10px] text-muted-foreground leading-tight">
            Scrie poziția în IFC la export.
            {!loc.georeferenced && (
              <span className="block text-amber-500/90">
                Oprit: fișierul iese fără coordonate reale.
              </span>
            )}
          </span>
        </label>
      </div>

      {/* ── Georeferenced overlay ────────────────────────────────────────── */}
      <div className="p-3 border-b border-border">
        <div className={HEAD}>Suprapunere hartă</div>

        <input
          ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            // Revoke the previous URL: a user trying three plans in a row
            // would otherwise pin all three in memory.
            if (overlay.imageUrl) URL.revokeObjectURL(overlay.imageUrl);
            onOverlayChange({
              imageUrl: URL.createObjectURL(f), fileName: f.name,
              // A fresh plan is most likely in the project's own grid.
              corners: { ...overlay.corners, crs: overlay.imageUrl ? overlay.corners.crs : crs },
            });
          }}
        />

        <button className={BTN_QUIET} onClick={() => fileRef.current?.click()}>
          {overlay.fileName ?? 'Alege o imagine…'}
        </button>

        {overlay.imageUrl && (
          <div className="mt-2 flex flex-col gap-1.5">
            <select
              className={SELECT}
              value={overlay.corners.crs}
              onChange={(e) => onOverlayChange({ corners: { ...overlay.corners, crs: e.target.value } })}
              title="Sistemul în care sunt scrise coordonatele planului"
            >
              {overlaySystems.map((code) => (
                <option key={code} value={code}>{crsLabel(code)}{legacyNote(code) ? ' — vechi' : ''}</option>
              ))}
              <option value={WGS84}>WGS 84 (grade)</option>
            </select>

            <div className="text-[10px] text-muted-foreground">Colț stânga-jos</div>
            <Num label={ovAx.x} value={String(overlay.corners.minX)} onChange={(v) => setCorner('minX', v)} />
            <Num label={ovAx.y} value={String(overlay.corners.minY)} onChange={(v) => setCorner('minY', v)} />
            <div className="text-[10px] text-muted-foreground">Colț dreapta-sus</div>
            <Num label={ovAx.x} value={String(overlay.corners.maxX)} onChange={(v) => setCorner('maxX', v)} />
            <Num label={ovAx.y} value={String(overlay.corners.maxY)} onChange={(v) => setCorner('maxY', v)} />

            <label className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-muted-foreground w-10 shrink-0 text-right">Opac.</span>
              <input
                type="range" min={0} max={1} step={0.05} value={overlay.opacity} className="flex-1"
                onChange={(e) => onOverlayChange({ opacity: parseFloat(e.target.value) })}
              />
              <span className="text-[10px] text-muted-foreground w-8 text-right">
                {Math.round(overlay.opacity * 100)}%
              </span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox" checked={overlay.visible}
                onChange={(e) => onOverlayChange({ visible: e.target.checked })}
              />
              <span className="text-xs text-foreground">Vizibilă</span>
            </label>

            {placementError && (
              <div className="text-[10px] text-amber-500/90 leading-tight">{placementError}</div>
            )}
            {legacyNote(overlay.corners.crs) && (
              <div className="text-[10px] text-amber-500/90 leading-tight">⚠ {legacyNote(overlay.corners.crs)}</div>
            )}

            {placement && (
              <div className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                <div>{placement.widthM.toFixed(1)} × {placement.heightM.toFixed(1)} m</div>
                <div>rot {(placement.rotation * 180 / Math.PI).toFixed(3)}°</div>
                {/* The convergence correction, made visible: how far the
                    image would sit from the truth if it were laid down
                    axis-aligned, the way a naive implementation would. */}
                <div title="Cât ar greși o suprapunere nerotită">corecție {placement.skewM.toFixed(2)} m</div>
              </div>
            )}

            <button
              className={BTN_QUIET}
              onClick={() => {
                if (overlay.imageUrl) URL.revokeObjectURL(overlay.imageUrl);
                onOverlayChange(emptyOverlay(overlay.corners.crs));
              }}
            >
              Elimină
            </button>
          </div>
        )}
      </div>

      {/* ── Basemap ──────────────────────────────────────────────────────── */}
      <div className="p-3 border-b border-border">
        <div className={HEAD}>Hartă de fundal</div>
        <div className="flex flex-col gap-1">
          {BASEMAPS.map((b) => (
            <label key={b.id} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="wv-basemap" checked={basemap === b.id} onChange={() => onBasemapChange(b.id)} />
              <span className="text-xs text-foreground">{b.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* ── Advanced ─────────────────────────────────────────────────────── */}
      <div className="p-3 border-b border-border">
        <button
          className="w-full flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-muted-foreground"
          onClick={() => setAdvanced((v) => !v)}
        >
          <span>Avansat</span>
          <span>{advanced ? '▾' : '▸'}</span>
        </button>

        {advanced && (
          <div className="mt-2 flex flex-col gap-3">
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">Orice sistem, indiferent de țară</div>
              <select className={SELECT} value={crs} onChange={(e) => onLocChange({ crs: e.target.value })}>
                {systems.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.label} — {s.code}{s.region ? ` (${s.region})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-[10px] text-muted-foreground mb-1">Convertor</div>
              <div className="flex flex-col gap-1.5">
                <select className={SELECT} value={fromCrs} onChange={(e) => setFromCrs(e.target.value)}>
                  <option value={WGS84}>WGS 84 (grade) — EPSG:4326</option>
                  {systems.map((s) => <option key={s.code} value={s.code}>{s.label} — {s.code}</option>)}
                </select>
                <Num label={fromAx.x} value={inX} onChange={setInX} unit={fromAx.unit} />
                <Num label={fromAx.y} value={inY} onChange={setInY} unit={fromAx.unit} />
                <div className="text-center text-muted-foreground text-[10px] leading-none">↓</div>
                <select className={SELECT} value={toCrs} onChange={(e) => setToCrs(e.target.value)}>
                  <option value={WGS84}>WGS 84 (grade) — EPSG:4326</option>
                  {systems.map((s) => <option key={s.code} value={s.code}>{s.label} — {s.code}</option>)}
                </select>
                {converted ? (
                  <>
                    <div className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1">
                      <div>{toAx.x} {converted.x.toFixed(toCrs === WGS84 ? 7 : 3)}</div>
                      <div>{toAx.y} {converted.y.toFixed(toCrs === WGS84 ? 7 : 3)}</div>
                    </div>
                    <button
                      className={BTN}
                      onClick={() => {
                        const g = toCrs === WGS84 ? converted : convert(converted, toCrs, WGS84);
                        onGoTo(g.y, g.x);
                      }}
                    >
                      Du-te acolo
                    </button>
                  </>
                ) : (
                  <div className="text-[10px] text-muted-foreground">
                    {inX || inY ? 'Coordonate invalide pentru sistemul ales.' : 'Introdu o pereche de coordonate.'}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
