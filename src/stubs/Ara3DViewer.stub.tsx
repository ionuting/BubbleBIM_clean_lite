import React from 'react';

interface Props {
  className?: string;
  [key: string]: unknown;
}

/** Stub — Ara3D / Three.js viewer excluded from clean-lite builds. */
export function Ara3DViewer({ className }: Props) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      Ara3D Viewer not available in clean-lite mode
    </div>
  );
}

export default Ara3DViewer;
