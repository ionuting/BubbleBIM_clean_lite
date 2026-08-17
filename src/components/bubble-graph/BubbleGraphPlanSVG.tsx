import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';

export interface BubbleGraphPlanSVGProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
  storeyId?: string | null;
  className?: string;
  padding?: number;
  onElementClick?: (elementId: string) => void;
}

/**
 * BubbleGraphPlanSVG — architectural 2D floor-plan SVG renderer (STUB)
 *
 * This is a stub implementation since @ifc-lite/drawing-2d is not available
 * in this standalone distribution.
 *
 * To implement full floor-plan rendering, you would need to:
 * 1. Add @ifc-lite/drawing-2d to package.json
 * 2. Import { resolveObjectStyle, LINE_PATTERN_DASH_ARRAYS, ObjectStylesConfig }
 * 3. Implement SVG path generation from node positions and edges
 */
export function BubbleGraphPlanSVG({
  nodes,
}: BubbleGraphPlanSVGProps) {
  return (
    <svg
      viewBox="0 0 800 600"
      xmlns="http://www.w3.org/2000/svg"
      style={{ background: '#f5f5f5' }}
    >
      <text x="400" y="300" textAnchor="middle" fill="#999" fontSize="16">
        Floor-plan SVG rendering not available in standalone version
      </text>
      <text x="400" y="330" textAnchor="middle" fill="#999" fontSize="14">
        Install @ifc-lite/drawing-2d to enable floor-plan visualization
      </text>
      <text x="400" y="360" textAnchor="middle" fill="#ccc" fontSize="12">
        Nodes: {nodes.length}
      </text>
    </svg>
  );
}
