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

/** Stubs — OG 2D ortho viewers excluded (SVG FloorPlan/Section/Elevation used instead). */
export function OGFloorPlanViewer(props: Props) {
  return <Stub label="OG Floor Plan" className={props.className} />;
}
export function OGSectionViewer(props: Props) {
  return <Stub label="OG Section" className={props.className} />;
}
export function OGElevationViewer(props: Props) {
  return <Stub label="OG Elevation" className={props.className} />;
}
