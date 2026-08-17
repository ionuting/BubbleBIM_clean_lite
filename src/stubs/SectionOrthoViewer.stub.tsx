import React from 'react';

interface Props {
  className?: string;
  [key: string]: unknown;
}

export function SectionOrthoViewer({ className }: Props) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      Section Ortho not available in clean-lite mode
    </div>
  );
}
export default SectionOrthoViewer;
