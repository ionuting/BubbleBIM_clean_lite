import React from 'react';

export function IFCTilesViewer({ className }: { tabId?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      IFC Tiles Viewer not available in lite mode
    </div>
  );
}
