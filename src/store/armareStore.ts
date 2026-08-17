/**
 * useArmare — store pentru configuratorul de armare 2D, portat din
 * ConfiguratorArmare (`packages/web/src/stare/magazin.ts`).
 *
 * Standalone (nu atinge store-ul principal BubbleBIM). Starea de armare e
 * ținută **per view** (top / secțiune / vedere), cheiată pe `viewId`-ul
 * tab-ului activ, astfel încât fiecare context 2D are propriul set de forme.
 *
 * Toate dimensiunile sunt în **mm** (ca `nucleu`). Actualizări imutabile —
 * store-ul BubbleBIM nu folosește immer.
 */
import { create } from 'zustand';
import {
  type FormaArmare,
  type TipForma,
  type Vector2,
  type Cioc,
  definitiePentru,
  valoriImplicite,
  varfuriImplicitePolilinie,
  matriceForma,
  inversa,
  transformaPunct,
  idNou,
} from '@armare/nucleu';

/** Capătul unei bare la care se aplică un cioc. */
export type CapatCioc = 'start' | 'sfarsit';

/** Unealta activă: „select" sau tipul de formă ce va fi plasat la următorul click. */
export type UnealtaArmare = 'select' | TipForma;

/** Starea de armare a unui singur view 2D. */
export interface ArmareViewState {
  forme: FormaArmare[];
  idsSelectate: string[];
}

const STARE_VID_GOALA: ArmareViewState = { forme: [], idsSelectate: [] };

interface ArmareStore {
  /** Starea de armare pe fiecare viewId. */
  views: Record<string, ArmareViewState>;
  /** ViewId-ul asupra căruia acționează comenzile. */
  activeViewId: string | null;
  /** Unealta curentă (unealtă de plasare formă sau selecție). */
  unealta: UnealtaArmare;
  /** Pas grilă pentru aliniere (mm); 0 = fără snap. */
  pasGrila: number;
  snapActiv: boolean;

  // ── Context ──────────────────────────────────────────────────────────
  setActiveView: (viewId: string | null) => void;
  setUnealta: (u: UnealtaArmare) => void;
  setSnap: (activ: boolean, pas?: number) => void;

  // ── Comenzi (operează pe view-ul activ) ──────────────────────────────
  adaugaFormaLaPozitie: (tip: TipForma, pozitie: Vector2) => string | null;
  selecteaza: (id: string | null) => void;
  toggleSelectie: (id: string) => void;
  stergeSelectia: () => void;
  actualizeazaParametru: (id: string, cheie: string, valoare: number) => void;
  actualizeazaNumar: (id: string, numar: number) => void;
  setMarcaForma: (id: string, marca: number) => void;
  setNumeForma: (id: string, nume: string) => void;
  actualizeazaPozitie: (id: string, pozitie: Vector2) => void;
  aplicaPunctControl: (id: string, idPunct: string, pozitieLocala: Vector2) => void;
  comutaOglindire: (id: string, axa: 'x' | 'y') => void;
  roteste: (id: string, deltaGrade: number) => void;
  setRotatie: (id: string, grade: number) => void;
  setCioc: (id: string, capat: CapatCioc, cioc: Cioc | null) => void;

  // ── Selectori ────────────────────────────────────────────────────────
  formeCurente: () => FormaArmare[];
  selectieCurenta: () => string[];
}

/** Următoarea marcă liberă pentru view-ul dat. */
function marcaUrmatoare(forme: FormaArmare[]): number {
  return forme.reduce((m, f) => Math.max(m, f.marca), 0) + 1;
}

/** Vârfurile inițiale ale unei forme, dacă e cazul (polilinie / etrier). */
function varfuriInitiale(tip: TipForma, parametri: Record<string, number>): Vector2[] | undefined {
  if (tip === 'polilinie' || tip === 'cofraj-polilinie') return varfuriImplicitePolilinie();
  if (tip === 'etrier') return definitiePentru(tip).genereazaVarfuri(parametri).varfuri;
  return undefined;
}

export const useArmare = create<ArmareStore>()((set, get) => {
  /** Rotunjește la pasul grilei dacă snap-ul e activ. */
  const aliniaza = (v: number): number => {
    const { snapActiv, pasGrila } = get();
    return snapActiv && pasGrila > 0 ? Math.round(v / pasGrila) * pasGrila : v;
  };

  /** Actualizează imutabil starea view-ului activ. */
  const patchView = (fn: (v: ArmareViewState) => ArmareViewState) =>
    set((s) => {
      const vid = s.activeViewId;
      if (!vid) return s;
      const curent = s.views[vid] ?? STARE_VID_GOALA;
      return { views: { ...s.views, [vid]: fn(curent) } };
    });

  /** Actualizează imutabil o singură formă din view-ul activ. */
  const patchForma = (id: string, fn: (f: FormaArmare) => FormaArmare) =>
    patchView((v) => ({
      ...v,
      forme: v.forme.map((f) => (f.id === id ? fn(f) : f)),
    }));

  return {
    views: {},
    activeViewId: null,
    unealta: 'select',
    pasGrila: 10,
    snapActiv: true,

    setActiveView: (viewId) => set({ activeViewId: viewId }),
    setUnealta: (u) => set({ unealta: u }),
    setSnap: (activ, pas) => set((s) => ({ snapActiv: activ, pasGrila: pas ?? s.pasGrila })),

    adaugaFormaLaPozitie: (tip, pozitie) => {
      const vid = get().activeViewId;
      if (!vid) return null;
      const def = definitiePentru(tip);
      const id = idNou(tip);
      const parametri = valoriImplicite(def);
      patchView((v) => ({
        forme: [
          ...v.forme,
          {
            id,
            tip,
            nume: def.nume,
            marca: marcaUrmatoare(v.forme),
            numar: 1,
            pozitie,
            parametri,
            varfuri: varfuriInitiale(tip, parametri),
          },
        ],
        idsSelectate: [id],
      }));
      // După plasare revenim la unealta de selecție (comportament CAD standard).
      set({ unealta: 'select' });
      return id;
    },

    selecteaza: (id) => patchView((v) => ({ ...v, idsSelectate: id ? [id] : [] })),

    toggleSelectie: (id) =>
      patchView((v) => ({
        ...v,
        idsSelectate: v.idsSelectate.includes(id)
          ? v.idsSelectate.filter((x) => x !== id)
          : [...v.idsSelectate, id],
      })),

    stergeSelectia: () =>
      patchView((v) => {
        const ids = new Set(v.idsSelectate);
        if (ids.size === 0) return v;
        return { forme: v.forme.filter((f) => !ids.has(f.id)), idsSelectate: [] };
      }),

    actualizeazaParametru: (id, cheie, valoare) =>
      patchForma(id, (f) => ({ ...f, parametri: { ...f.parametri, [cheie]: valoare } })),

    actualizeazaNumar: (id, numar) =>
      patchForma(id, (f) => ({ ...f, numar: Math.max(0, Math.round(numar)) })),

    setMarcaForma: (id, marca) =>
      patchForma(id, (f) => ({ ...f, marca: Math.max(1, Math.round(marca)) })),

    setNumeForma: (id, nume) => patchForma(id, (f) => ({ ...f, nume })),

    actualizeazaPozitie: (id, pozitie) => patchForma(id, (f) => ({ ...f, pozitie })),

    aplicaPunctControl: (id, idPunct, pozitieLocala) =>
      patchForma(id, (forma) => {
        // Punctul vine în spațiul local-transformat; îl readucem în spațiul
        // local nerotit, apoi aliniem la grilă.
        const localBrut = transformaPunct(inversa(matriceForma(forma)), pozitieLocala);
        const local = { x: aliniaza(localBrut.x), y: aliniaza(localBrut.y) };

        if (forma.tip === 'polilinie' || forma.tip === 'etrier' || forma.tip === 'cofraj-polilinie') {
          const i = Number(idPunct.slice(1));
          if (forma.varfuri && forma.varfuri[i]) {
            const varfuri = forma.varfuri.map((vf, idx) => (idx === i ? local : vf));
            return { ...forma, varfuri };
          }
          return forma;
        }
        return {
          ...forma,
          parametri: definitiePentru(forma.tip).aplicaDeplasare(forma.parametri, idPunct, local),
        };
      }),

    comutaOglindire: (id, axa) =>
      patchForma(id, (f) =>
        axa === 'x' ? { ...f, oglinditX: !f.oglinditX } : { ...f, oglinditY: !f.oglinditY },
      ),

    roteste: (id, deltaGrade) =>
      patchForma(id, (f) => ({
        ...f,
        rotatie: ((((f.rotatie ?? 0) + deltaGrade) % 360) + 360) % 360,
      })),

    setRotatie: (id, grade) =>
      patchForma(id, (f) => ({ ...f, rotatie: ((grade % 360) + 360) % 360 })),

    setCioc: (id, capat, cioc) =>
      patchForma(id, (f) => {
        const c = { ...(f.ciocuri ?? {}) };
        if (cioc) c[capat] = cioc;
        else delete c[capat];
        return { ...f, ciocuri: c.start || c.sfarsit ? c : undefined };
      }),

    formeCurente: () => {
      const { views, activeViewId } = get();
      return activeViewId ? (views[activeViewId]?.forme ?? []) : [];
    },
    selectieCurenta: () => {
      const { views, activeViewId } = get();
      return activeViewId ? (views[activeViewId]?.idsSelectate ?? []) : [];
    },
  };
});
