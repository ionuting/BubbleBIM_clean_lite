/**
 * RebarLayer — stratul SVG de armare 2D, montat ca <g> în interiorul <svg>-ului
 * unui viewer 2D (top / secțiune / vedere). View-agnostic: primește doar
 * transformările de coordonate ale gazdei.
 *
 * Randează formele din `useArmare` folosind geometria pură din `nucleu`
 * (`segmenteForma`, `cercForma`, `puncteControlForma`) și traduce interacțiunea
 * (drag de grip / mutare) înapoi în parametri prin acțiunile store-ului.
 *
 * Convenții de coordonate:
 *  - `nucleu` lucrează în mm, Y în sus; geometria e rotită/oglindită dar
 *    NEtranslate (translația = `forma.pozitie`, aplicată aici).
 *  - Arcele sunt discretizate în polilinii → evităm ambiguitățile de sweep/mirror
 *    la maparea Y-flip din SVG.
 */
import { useRef } from 'react';
import {
  type FormaArmare,
  type Vector2,
  segmenteForma,
  cercForma,
  puncteControlForma,
  discretizeazaSegmente,
  lanturiContinue,
} from '@armare/nucleu';
import { useArmare } from '@/store/armareStore';

/** Transformări furnizate de viewer-ul gazdă. */
export interface RebarHostTransforms {
  /** World mm → unități SVG (viewBox). */
  toSvg: (wx: number, wy: number) => { x: number; y: number };
  /** Eveniment de pointer → world mm. */
  fromSvgEvent: (e: { clientX: number; clientY: number }) => { x: number; y: number };
  /** Unități SVG per mm (pentru dimensionarea grosimilor/gripurilor). */
  scale: number;
}

interface RebarLayerProps extends RebarHostTransforms {}

// Culori (desen tehnic).
const CULOARE_ARMARE = '#c0392b';
const CULOARE_COFRAJ = '#64748b';
const CULOARE_SELECT = '#2563eb';
const CULOARE_GRIP = '#2563eb';
const CULOARE_GRIP_FILL = '#ffffff';

const GRIP_MM = 55; // rază grip în mm (dimensiune vizuală)
const STROKE_ARMARE_MM = 22;
const STROKE_COFRAJ_MM = 14;

function esteCofraj(forma: FormaArmare): boolean {
  return forma.tip.startsWith('cofraj-');
}

/** Construiește atributul `d` al unei forme, discretizând arcele. */
function pathForma(forma: FormaArmare, toSvg: RebarHostTransforms['toSvg']): string {
  const segmente = segmenteForma(forma);
  if (segmente.length === 0) return '';
  const p = forma.pozitie;
  const chains = lanturiContinue(segmente);
  const parts: string[] = [];
  for (const chain of chains) {
    const pts: Vector2[] = discretizeazaSegmente(chain);
    if (pts.length === 0) continue;
    pts.forEach((pt, i) => {
      const s = toSvg(p.x + pt.x, p.y + pt.y);
      parts.push(`${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)}`);
    });
  }
  return parts.join(' ');
}

export function RebarLayer({ toSvg, fromSvgEvent, scale }: RebarLayerProps) {
  const forme = useArmare((s) => (s.activeViewId ? s.views[s.activeViewId]?.forme ?? [] : []));
  const idsSelectate = useArmare((s) =>
    s.activeViewId ? s.views[s.activeViewId]?.idsSelectate ?? [] : [],
  );
  const selecteaza = useArmare((s) => s.selecteaza);
  const actualizeazaPozitie = useArmare((s) => s.actualizeazaPozitie);
  const aplicaPunctControl = useArmare((s) => s.aplicaPunctControl);

  // Starea de drag activă (grip sau corp). Ref pentru a evita re-render la fiecare mișcare.
  const drag = useRef<
    | { fel: 'grip'; id: string; gripId: string }
    | { fel: 'corp'; id: string; startMouse: Vector2; startPoz: Vector2 }
    | null
  >(null);

  const gripR = GRIP_MM * scale;

  // ── Drag handlers (window) ────────────────────────────────────────────
  function onWindowMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const w = fromSvgEvent(e);
    if (d.fel === 'grip') {
      const forma = forme.find((f) => f.id === d.id);
      if (!forma) return;
      // Punctul de control se aplică în spațiul local rotit (world - pozitie).
      aplicaPunctControl(d.id, d.gripId, { x: w.x - forma.pozitie.x, y: w.y - forma.pozitie.y });
    } else {
      actualizeazaPozitie(d.id, {
        x: d.startPoz.x + (w.x - d.startMouse.x),
        y: d.startPoz.y + (w.y - d.startMouse.y),
      });
    }
  }

  function endDrag() {
    drag.current = null;
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', endDrag);
  }

  function startDrag(d: NonNullable<typeof drag.current>) {
    drag.current = d;
    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', endDrag);
  }

  return (
    <g className="rebar-layer">
      {forme.map((forma) => {
        const selectat = idsSelectate.includes(forma.id);
        const cofraj = esteCofraj(forma);
        const culoare = selectat ? CULOARE_SELECT : cofraj ? CULOARE_COFRAJ : CULOARE_ARMARE;
        const stroke = (cofraj ? STROKE_COFRAJ_MM : STROKE_ARMARE_MM) * scale;
        const cerc = cercForma(forma);

        return (
          <g key={forma.id}>
            {/* Corp: hit-area transparentă (mai groasă) + linia vizibilă. */}
            {cerc ? (
              (() => {
                const c = toSvg(forma.pozitie.x + cerc.centru.x, forma.pozitie.y + cerc.centru.y);
                return (
                  <circle
                    cx={c.x}
                    cy={c.y}
                    r={Math.max(cerc.raza * scale, 3)}
                    fill={culoare}
                    stroke={selectat ? CULOARE_SELECT : 'none'}
                    strokeWidth={2}
                    style={{ cursor: 'move' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      selecteaza(forma.id);
                      const w = fromSvgEvent(e);
                      startDrag({ fel: 'corp', id: forma.id, startMouse: w, startPoz: forma.pozitie });
                    }}
                  />
                );
              })()
            ) : (
              <>
                <path
                  d={pathForma(forma, toSvg)}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(stroke * 3, 14)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ cursor: 'move' }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    selecteaza(forma.id);
                    const w = fromSvgEvent(e);
                    startDrag({ fel: 'corp', id: forma.id, startMouse: w, startPoz: forma.pozitie });
                  }}
                />
                <path
                  d={pathForma(forma, toSvg)}
                  fill="none"
                  stroke={culoare}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pointerEvents="none"
                />
              </>
            )}

            {/* Grips: doar pe formele selectate. */}
            {selectat &&
              puncteControlForma(forma).map((pc) => {
                const s = toSvg(forma.pozitie.x + pc.pozitie.x, forma.pozitie.y + pc.pozitie.y);
                return (
                  <rect
                    key={pc.id}
                    x={s.x - gripR}
                    y={s.y - gripR}
                    width={gripR * 2}
                    height={gripR * 2}
                    fill={CULOARE_GRIP_FILL}
                    stroke={CULOARE_GRIP}
                    strokeWidth={Math.max(gripR * 0.25, 1.5)}
                    style={{ cursor: 'grab' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startDrag({ fel: 'grip', id: forma.id, gripId: pc.id });
                    }}
                  >
                    <title>{pc.descriere}</title>
                  </rect>
                );
              })}
          </g>
        );
      })}
    </g>
  );
}
