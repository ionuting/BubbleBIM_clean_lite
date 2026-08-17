import type { SvgSymbolDef } from '@/lib/svgSymbolStore';

/** Intuitive controls for the simple symbol editor (no graph editing). */
export interface SimpleSymbolEdits {
  frameColor: string;
  glassColor: string;
  arcColor: string;
  frameLineWeight: number;
  seenLineWeight: number;
  panelLineWeight: number;
  arcLineWeight: number;
  squareSide_mm: number;
  outerLineOffset_mm: number;
  innerLineOffset_mm: number;
  showFrameSquares: boolean;
  showGlassPanel: boolean;
  showSillZone: boolean;
  sillFillColor: string;
  showSwingArc: boolean;
  showDoorPanel: boolean;
  showWhiteMask: boolean;
  showWallBreaks: boolean;
  breakLineColor: string;
  breakLineWeight: number;
}

export const DEFAULT_WINDOW_EDITS: SimpleSymbolEdits = {
  frameColor: '#222222',
  glassColor: '#5588AA',
  arcColor: '#555555',
  frameLineWeight: 2,
  seenLineWeight: 1,
  panelLineWeight: 2,
  arcLineWeight: 1,
  squareSide_mm: 70,
  outerLineOffset_mm: 125,
  innerLineOffset_mm: 125,
  showFrameSquares: true,
  showGlassPanel: true,
  showSillZone: true,
  sillFillColor: '#D0D0C4',
  showSwingArc: true,
  showDoorPanel: true,
  showWhiteMask: true,
  showWallBreaks: true,
  breakLineColor: '#222222',
  breakLineWeight: 1,
};

export const DEFAULT_DOOR_EDITS: SimpleSymbolEdits = {
  frameColor: '#111111',
  glassColor: '#5588AA',
  arcColor: '#555555',
  frameLineWeight: 2,
  seenLineWeight: 1,
  panelLineWeight: 2,
  arcLineWeight: 1,
  squareSide_mm: 70,
  outerLineOffset_mm: 0,
  innerLineOffset_mm: 0,
  showFrameSquares: false,
  showGlassPanel: false,
  showSillZone: false,
  sillFillColor: '#D0D0C4',
  showSwingArc: true,
  showDoorPanel: true,
  showWhiteMask: true,
  showWallBreaks: true,
  breakLineColor: '#222222',
  breakLineWeight: 1,
};

export interface SymbolTemplate {
  id: string;
  name: string;
  description: string;
  /** Opening family ids this template applies to (e.g. 'single', 'double'). */
  families: string[];
  build: (typeKey: string, name: string) => SvgSymbolDef;
}
