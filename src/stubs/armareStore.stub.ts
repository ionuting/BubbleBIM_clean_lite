/**
 * No-op armare store for Clean Lite — rebar 2D excluded from the bundle.
 */
import { useSyncExternalStore } from 'react';

const state = {
  views: {} as Record<string, { forme: unknown[]; idsSelectate: string[] }>,
  activeViewId: null as string | null,
  unealta: 'select' as const,
  pasGrila: 0,
  snapActiv: false,
  setActiveView: (_viewId: string | null) => {},
  setUnealta: (_u: unknown) => {},
  setSnap: (_activ: boolean, _pas?: number) => {},
  adaugaFormaLaPozitie: () => null as string | null,
  selecteaza: () => {},
  toggleSelectie: () => {},
  stergeSelectia: () => {},
  actualizeazaParametru: () => {},
  actualizeazaNumar: () => {},
  setMarcaForma: () => {},
  setNumeForma: () => {},
  actualizeazaPozitie: () => {},
  aplicaPunctControl: () => {},
  comutaOglindire: () => {},
  roteste: () => {},
  setRotatie: () => {},
  setCioc: () => {},
  formeCurente: () => [] as unknown[],
  selectieCurenta: () => [] as string[],
};

type ArmareState = typeof state;

const subscribe = (_onStoreChange: () => void) => () => {};
const getSnapshot = () => state;

export function useArmare(): ArmareState;
export function useArmare<T>(selector: (s: ArmareState) => T): T;
export function useArmare<T>(selector?: (s: ArmareState) => T): T | ArmareState {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return selector ? selector(s) : s;
}

useArmare.getState = () => state;

export type UnealtaArmare = 'select' | string;
export type CapatCioc = 'start' | 'sfarsit';
