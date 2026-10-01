export * from './types';
export * from './contour';
export * from './straightSkeleton';
export * from './skeleton';
export * from './faceGeometry';
export * from './skylight';
export * from './dormer';
export { eyebrowEdge, eyebrowIntentOf, extrudePolygon3, placeEyebrow, solidVolume, type EyebrowGeometry, type EyebrowIntent, type EyebrowNotch, type Tri } from './eyebrow';
export * from './details';
export * from './roofPlan';
export { buildRoofFraming } from './framing';
export {
  parseRoofIntent,
  computeRoofFaces,
  solveRoof,
  applyRoofResult,
  createRoofForStorey,
  parseTimberSection,
} from './solver';
export { gabletIntentOf, placeGablet, type GabletGeometry, type GabletIntent } from './gablet';
