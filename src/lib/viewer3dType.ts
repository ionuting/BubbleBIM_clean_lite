/**
 * The 3D engines a '3d-model' tab can use. 'tiles' — BubbleBIM's own IFC Tiles
 * renderer, drawing the model as the exported IFC — replaced the former
 * Three.js (Ara3D) view; projects and broadcasts that still say 'ara3d' open
 * in it.
 */
export type Viewer3DType = 'tiles' | 'webifc' | 'opengeo' | 'brep';

export function normaliseViewer3DType(v: unknown): Viewer3DType {
  return v === 'webifc' || v === 'opengeo' || v === 'brep' ? v : 'tiles';
}
