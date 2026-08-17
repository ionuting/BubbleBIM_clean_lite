# Window plan symbols — 2D DXF parametric symbols
#
# Convention: one .dxf file per window type ID or opening family.
#
# Filename → maps to:
#   {typeId}.dxf              → window type with id = typeId  (e.g. W-DBL-120x140.dxf)
#   opening_{family}.dxf      → all windows of that opening family (e.g. opening_double.dxf)
#
# DXF layer conventions:
#   frame          → geometry colored by WindowPlan2DConfig.frameColor
#   glass          → geometry colored by WindowPlan2DConfig.glassColor
#   sill           → geometry colored by WindowPlan2DConfig.sillLineColor
#   slider_length    → LWPOLYLINE region: vertices inside shift by (actualW - defaultW) × 1.0
#   slider_0.5length → LWPOLYLINE region: vertices inside shift by (actualW - defaultW) × 0.5
#   slider_height    → LWPOLYLINE region: vertices inside shift by (actualH - defaultH) × 1.0
#   slider_0.5height → LWPOLYLINE region: vertices inside shift by (actualH - defaultH) × 0.5
#   origin         → CIRCLE at insertion point (0, 0) — wall outer face, left jamb
#   ax             → axis reference line (ignored in output)
#   ignore         → any explanatory text/geometry (ignored in output)
#   (layer 0 or any other) → rendered as-is using DXF entity color
#
# Reference coordinate system (same as QCAD world space):
#   X = 0..defaultWidth along the wall (left jamb = 0, right jamb = defaultWidth)
#   Y = -wallThickness/2..+wallThickness/2 perpendicular to wall
#       Y=0 = wall centre line
#       Y>0 = outer face direction
#       Y<0 = inner face direction
#
# The default reference size (defaultWidth) is taken from the drawing bounds.
# The .bglib.json is auto-generated and cached on first request.
