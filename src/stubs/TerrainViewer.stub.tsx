import React from 'react';

interface Props {
  tabId?: string;
  className?: string;
}

export function TerrainViewer({ className }: Props) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      Terrain Viewer not available in lite mode
    </div>
  );
}
