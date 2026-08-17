import type { BubbleGraphNode } from '@/store';

export const DEFAULT_WALL_HEIGHT_MM = 3000;

export interface WallLayer {
  from_mm: number;
  to_mm: number;
  material?: string;
  wall_type?: string;
  color_3d?: string;
  color_2d?: string;
}

export interface ResolvedWallLayer {
  fromMm: number;
  toMm: number;
  heightMm: number;
  material: string;
  wallType?: string;
  color3d?: string;
  color2d?: string;
}

export const WALL_LAYER_PRESETS: Record<string, { label: string; layers: WallLayer[] }> = {
  standard: {
    label: 'Standard (plin)',
    layers: [{ from_mm: 0, to_mm: DEFAULT_WALL_HEIGHT_MM }],
  },
  bca_socle: {
    label: 'Soc BCA + zidarie',
    layers: [
      { from_mm: 0, to_mm: 600, material: 'aac_block', wall_type: 'W20', color_3d: '#D8D8D8' },
      { from_mm: 600, to_mm: DEFAULT_WALL_HEIGHT_MM, material: 'brick', wall_type: 'W20', color_3d: '#C0614A' },
    ],
  },
  bca_socle_tall: {
    label: 'Soc BCA inalt + zidarie',
    layers: [
      { from_mm: 0, to_mm: 1000, material: 'aac_block', wall_type: 'W25', color_3d: '#D8D8D8' },
      { from_mm: 1000, to_mm: DEFAULT_WALL_HEIGHT_MM, material: 'brick', wall_type: 'W20', color_3d: '#C0614A' },
    ],
  },
};

function isValidLayer(v: unknown): v is WallLayer {
  if (!v || typeof v !== 'object') return false;
  const l = v as WallLayer;
  return Number.isFinite(Number(l.from_mm)) && Number.isFinite(Number(l.to_mm));
}

export function getWallHeightMm(props: Record<string, unknown>, storeyFallbackMm = DEFAULT_WALL_HEIGHT_MM): number {
  const raw = Number(props.height ?? storeyFallbackMm);
  return raw > 0 && raw < 20 ? Math.round(raw * 1000) : raw;
}

export function parseWallLayersFromProps(props: Record<string, unknown>): WallLayer[] | null {
  const raw = props.wall_layers;
  if (raw == null || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return null;
    const layers = parsed.filter(isValidLayer);
    return layers.length > 0 ? layers : null;
  } catch {
    return null;
  }
}

export function serializeWallLayers(layers: WallLayer[]): string {
  return JSON.stringify(layers);
}

export function defaultWallLayers(wallHeightMm = DEFAULT_WALL_HEIGHT_MM): WallLayer[] {
  return [{ from_mm: 0, to_mm: wallHeightMm, material: '' }];
}

export function scaleWallLayerPreset(preset: WallLayer[], wallHeightMm: number): WallLayer[] {
  const presetMax = Math.max(...preset.map((l) => Number(l.to_mm ?? 0)), 1);
  const scaled = preset.map((l) => ({
    ...l,
    from_mm: Math.round(Number(l.from_mm ?? 0) * wallHeightMm / presetMax),
    to_mm: Math.round(Number(l.to_mm ?? presetMax) * wallHeightMm / presetMax),
  }));
  if (scaled.length > 0) {
    scaled[0].from_mm = 0;
    scaled[scaled.length - 1].to_mm = wallHeightMm;
  }
  return scaled;
}

export function getEditableWallLayers(props: Record<string, unknown>, wallHeightMm?: number): WallLayer[] {
  const wallH = wallHeightMm ?? getWallHeightMm(props);
  const stored = parseWallLayersFromProps(props);
  if (stored) return stored;
  return [{
    from_mm: 0,
    to_mm: wallH,
    material: String(props.material ?? ''),
    wall_type: String(props.wall_type ?? 'W20'),
  }];
}

export function resolveWallLayers(
  props: Record<string, unknown>,
  wallHeightMm?: number,
): ResolvedWallLayer[] {
  const wallH = wallHeightMm ?? getWallHeightMm(props);
  const defaultMat = String(props.material ?? '');
  const defaultType = String(props.wall_type ?? 'W20');

  return getEditableWallLayers(props, wallH)
    .map((l) => {
      const fromMm = Math.max(0, Number(l.from_mm ?? 0));
      const toMm = Math.min(wallH, Number(l.to_mm ?? wallH));
      const heightMm = toMm - fromMm;
      const material = String(l.material ?? defaultMat);
      const wallType = String(l.wall_type ?? defaultType) || undefined;
      const color3d = String(l.color_3d ?? '').trim() || undefined;
      const color2d = String(l.color_2d ?? '').trim() || undefined;
      return { fromMm, toMm, heightMm, material, wallType, color3d, color2d };
    })
    .filter((l) => l.heightMm > 0);
}

export function hasMultipleWallLayers(props: Record<string, unknown>): boolean {
  const stored = parseWallLayersFromProps(props);
  return !!stored && stored.length > 1;
}

export function syntheticWallNodeForLayer(
  wall: BubbleGraphNode,
  layer: ResolvedWallLayer,
): BubbleGraphNode {
  return {
    ...wall,
    properties: {
      ...wall.properties,
      material: layer.material,
      ...(layer.wallType ? { wall_type: layer.wallType } : {}),
      ...(layer.color3d ? { color_3d: layer.color3d } : {}),
      ...(layer.color2d ? { color_2d: layer.color2d } : {}),
    },
  };
}
