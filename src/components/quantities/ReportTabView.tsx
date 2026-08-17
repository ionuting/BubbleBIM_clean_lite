/**
 * ReportTabView — conținutul tab-ului `report`: comută între memoriul de calcul
 * (read-only, derivat din norme) și editorul de calcul custom (Faza 3B, editabil).
 */
import { useState } from 'react';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { CalcReportPanel } from './CalcReportPanel';
import { CustomCalcEditor } from './CustomCalcEditor';
import { PriceConfigPanel } from './PriceConfigPanel';

type ReportMode = 'memoriu' | 'editor' | 'preturi';
const MODE_LABEL: Record<ReportMode, string> = {
  memoriu: 'Calculation memo',
  editor: 'Custom calc editor',
  preturi: 'Unit prices',
};

interface ReportTabViewProps {
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  projectName: string;
  onHighlightNodes: (nodeIds: string[]) => void;
}

export function ReportTabView({ nodes, edges, projectName, onHighlightNodes }: ReportTabViewProps) {
  const [mode, setMode] = useState<ReportMode>('memoriu');

  return (
    <div style={{ padding: '10px 12px' }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {(['memoriu', 'editor', 'preturi'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              fontSize: 11,
              padding: '5px 12px',
              borderRadius: 6,
              border: '1px solid hsl(var(--border))',
              cursor: 'pointer',
              background: mode === m ? 'hsl(var(--primary))' : 'transparent',
              color: mode === m ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
            }}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {mode === 'memoriu' && (
        <CalcReportPanel nodes={nodes} edges={edges} projectName={projectName} onHighlightNodes={onHighlightNodes} />
      )}
      {mode === 'editor' && <CustomCalcEditor nodes={nodes} edges={edges} height={520} />}
      {mode === 'preturi' && <PriceConfigPanel nodes={nodes} edges={edges} />}
    </div>
  );
}
