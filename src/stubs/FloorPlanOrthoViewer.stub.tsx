import React from 'react';

interface Props {
  className?: string;
  [key: string]: unknown;
}

function Stub({ label, className }: { label: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center bg-muted/20 text-muted-foreground text-sm ${className ?? ''}`}>
      {label} not available in clean-lite mode
    </div>
  );
}

export function FloorPlanOrthoViewer(props: Props) {
  return <Stub label="Floor Plan Ortho" className={props.className} />;
}
export default FloorPlanOrthoViewer;
