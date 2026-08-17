import React from 'react';

interface Props {
  tabId?: string;
  className?: string;
  [key: string]: unknown;
}

export function BabylonViewer({ className }: Props) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      Babylon Viewer not available in minimal mode
    </div>
  );
}

export default BabylonViewer;
