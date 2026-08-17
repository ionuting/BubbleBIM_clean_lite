import React from 'react';

export function WebIfcViewer({ className }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      WebIfc Viewer not available in lite mode
    </div>
  );
}

// Re-export helper used by WorldViewer — provide a no-op stub
export function buildSceneGeometry() { return null; }
