import React from 'react';

interface Props {
  projectName?: string;
  tabId?: string;
  className?: string;
}

export function WorldViewer({ className }: Props) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      World Viewer not available in lite mode
    </div>
  );
}
