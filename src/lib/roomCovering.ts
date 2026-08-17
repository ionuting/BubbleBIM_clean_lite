import type { BubbleGraphNode } from '@/store';

export const DEFAULT_ROOM_HEIGHT_MM = 2800;
export const DEFAULT_COVERING_HEIGHT_MM = 2800;
export const DEFAULT_COVERING_THICKNESS_MM = 15;

export interface RoomCoveringLayer {
  from_mm: number;
  to_mm: number;
  material?: string;
  thickness_mm?: number;
  color_3d?: string;
  color_2d?: string;
}

export interface ResolvedCoveringLayer {
  fromMm: number;
  toMm: number;
  heightMm: number;
  thicknessMm: number;
  material: string;
  color3d?: string;
  color2d?: string;
}

export const COVERING_PRESETS: Record<string, { label: string; layers: RoomCoveringLayer[] }> = {
  standard: {
    label: 'Standard (plin)',
    layers: [{ from_mm: 0, to_mm: DEFAULT_COVERING_HEIGHT_MM, thickness_mm: DEFAULT_COVERING_THICKNESS_MM }],
  },
  bathroom: {
    label: 'Baie (faianta + tencuiala)',
    layers: [
      { from_mm: 0, to_mm: 1500, material: 'ceramic_tile', thickness_mm: 15, color_3d: '#E8E8E8' },
      { from_mm: 1500, to_mm: DEFAULT_COVERING_HEIGHT_MM, material: 'plaster', thickness_mm: 15, color_3d: '#F5F5DC' },
    ],
  },
  kitchen: {
    label: 'Bucatarie (faianta + tencuiala)',
    layers: [
      { from_mm: 0, to_mm: 600, material: 'ceramic_tile', thickness_mm: 15, color_3d: '#FFFFFF' },
      { from_mm: 600, to_mm: DEFAULT_COVERING_HEIGHT_MM, material: 'plaster', thickness_mm: 15, color_3d: '#F5F5DC' },
    ],
  },
};

function isValidLayer(v: unknown): v is RoomCoveringLayer {
  if (!v || typeof v !== 'object') return false;
  const l = v as RoomCoveringLayer;
  return Number.isFinite(Number(l.from_mm)) && Number.isFinite(Number(l.to_mm));
}

export function roomHasCovering(props: Record<string, unknown>): boolean {
  return props.has_covering !== 'False' && props.has_covering !== false;
}

export function getRoomHeightMm(props: Record<string, unknown>): number {
  const raw = Number(props.height ?? DEFAULT_ROOM_HEIGHT_MM);
  // Legacy nodeLibrary used metres (e.g. 2.80)
  return raw > 0 && raw < 20 ? Math.round(raw * 1000) : raw;
}

export function parseCoveringLayersFromProps(props: Record<string, unknown>): RoomCoveringLayer[] | null {
  const raw = props.covering_layers;
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

export function serializeCoveringLayers(layers: RoomCoveringLayer[]): string {
  return JSON.stringify(layers);
}

export function defaultCoveringLayers(roomHeightMm = DEFAULT_COVERING_HEIGHT_MM): RoomCoveringLayer[] {
  return [{ from_mm: 0, to_mm: roomHeightMm, thickness_mm: DEFAULT_COVERING_THICKNESS_MM, material: '' }];
}

export function scaleCoveringPreset(
  preset: RoomCoveringLayer[],
  roomHeightMm: number,
): RoomCoveringLayer[] {
  const presetMax = Math.max(...preset.map((l) => Number(l.to_mm ?? 0)), 1);
  const scaled = preset.map((l) => ({
    ...l,
    from_mm: Math.round(Number(l.from_mm ?? 0) * roomHeightMm / presetMax),
    to_mm: Math.round(Number(l.to_mm ?? presetMax) * roomHeightMm / presetMax),
  }));
  if (scaled.length > 0) {
    scaled[0].from_mm = 0;
    scaled[scaled.length - 1].to_mm = roomHeightMm;
  }
  return scaled;
}

export function getEditableCoveringLayers(props: Record<string, unknown>): RoomCoveringLayer[] {
  const roomH = getRoomHeightMm(props);
  const stored = parseCoveringLayersFromProps(props);
  if (stored) return stored;

  const covH = Number(props.covering_height ?? DEFAULT_COVERING_HEIGHT_MM);
  const thick = Number(props.covering_thickness ?? DEFAULT_COVERING_THICKNESS_MM);
  const material = String(props.covering_material ?? '');
  return [{ from_mm: 0, to_mm: covH, thickness_mm: thick, material }];
}

export function resolveCoveringLayers(props: Record<string, unknown>): ResolvedCoveringLayer[] {
  const roomH = getRoomHeightMm(props);
  const defaultThick = Number(props.covering_thickness ?? DEFAULT_COVERING_THICKNESS_MM);
  const defaultMat = String(props.covering_material ?? '');

  const source = getEditableCoveringLayers(props);
  return source
    .map((l) => {
      const fromMm = Math.max(0, Number(l.from_mm ?? 0));
      const toMm = Math.min(roomH, Number(l.to_mm ?? roomH));
      const heightMm = toMm - fromMm;
      const thicknessMm = Number(l.thickness_mm ?? defaultThick);
      const material = String(l.material ?? defaultMat);
      const color3d = String(l.color_3d ?? '').trim() || undefined;
      const color2d = String(l.color_2d ?? '').trim() || undefined;
      return { fromMm, toMm, heightMm, thicknessMm, material, color3d, color2d };
    })
    .filter((l) => l.heightMm > 0 && l.thicknessMm > 0);
}

export function syncCoveringSummaryProps(layers: RoomCoveringLayer[]): {
  covering_height: number;
  covering_thickness: number;
  covering_material?: string;
} {
  const maxTo = Math.max(...layers.map((l) => Number(l.to_mm ?? 0)), DEFAULT_COVERING_HEIGHT_MM);
  const first = layers[0];
  return {
    covering_height: maxTo,
    covering_thickness: Number(first?.thickness_mm ?? DEFAULT_COVERING_THICKNESS_MM),
    covering_material: first?.material || undefined,
  };
}

export function syntheticCoveringNodeForLayer(
  room: BubbleGraphNode,
  layer: ResolvedCoveringLayer,
): BubbleGraphNode {
  return {
    ...room,
    properties: {
      ...room.properties,
      material: layer.material,
      ...(layer.color3d ? { color_3d: layer.color3d } : {}),
      ...(layer.color2d ? { color_2d: layer.color2d } : {}),
    },
  };
}
