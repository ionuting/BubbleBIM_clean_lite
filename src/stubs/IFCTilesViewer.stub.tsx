export function IFCTilesViewer({ className }: {
  tabId?: string;
  className?: string;
  source?: { name: string; ifc: string } | null;
  onSelectNode?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
  [key: string]: unknown;
}) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      IFC Tiles Viewer not available in lite mode
    </div>
  );
}

export const nodeIdOfTag = (tag: string | undefined): string | null => (tag ? tag.split(':')[0] || null : null);
