/**
 * bimxExport.ts — Generate a self-contained HTML file (BIMx-style) that
 * includes a read-only 3D viewer with the project data embedded inline.
 *
 * The exported HTML loads Babylon.js from CDN and reconstructs a simplified
 * 3D scene from the embedded project data. Users can orbit, pan, and zoom
 * the model without any backend or server.
 *
 * Limitations vs full app:
 *  - No IFC library meshes (uses box placeholders for windows/doors)
 *  - No material config overrides (uses default colors)
 *  - No 2D floor plan or section views (3D only)
 *  - Read-only (no editing)
 */

import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';

export interface BimxExportData {
  projectName: string;
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  buildingAxes: BuildingAxes;
}

/**
 * Generate and download a BIMx ZIP package containing:
 *   viewer.html   — Three.js BIM viewer (references sibling files via <script src>)
 *   model.js      — window.MODEL_DATA = {...}  (project graph JSON)
 *   three.min.js  — Three.js r128 library (fetched at export time; CDN fallback if offline)
 *
 * Opening viewer.html from file:// works without a server because
 * <script src="model.js"> and <script src="three.min.js"> are NOT subject to
 * the same-origin fetch restriction that blocked the original CDN approach.
 */
export async function exportBimxHtml(data: BimxExportData): Promise<void> {
  const enc = new TextEncoder();

  // Fetch Three.js at export time (app context — not file://, so CDN works).
  // Strip sourceMappingURL to prevent browsers trying to fetch it from file://.
  // No </script escaping needed here — it goes into a standalone .js file, not inline HTML.
  let threeJsBytes: Uint8Array | null = null;
  try {
    const res = await fetch('https://unpkg.com/three@0.128.0/build/three.min.js');
    if (res.ok) {
      const src = (await res.text()).replace(/\/\/# sourceMappingURL=\S+/g, '');
      threeJsBytes = enc.encode(src);
    }
  } catch { /* offline — viewer will fall back to CDN at open time */ }

  const modelData = JSON.stringify({
    projectName: data.projectName,
    nodes: data.nodes,
    edges: data.edges,
    buildingAxes: data.buildingAxes,
  });

  // model.js sets a global so viewer.html can read it from file://
  const modelJs    = `window.MODEL_DATA=${modelData};`;
  const viewerHtml = buildViewerHtml(data.projectName, threeJsBytes !== null);

  const zipData = makeZip([
    { name: 'viewer.html', data: enc.encode(viewerHtml) },
    { name: 'model.js',   data: enc.encode(modelJs)    },
    ...(threeJsBytes ? [{ name: 'three.min.js', data: threeJsBytes }] : []),
  ]);
  const blob    = new Blob([zipData], { type: 'application/zip' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = `${data.projectName || 'project'}_BIMx.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build the viewer.html content.
 * Three.js and model data are loaded via <script src> (not inline),
 * so no </script escaping is needed in either file.
 * hasLocalThree=true  → references './three.min.js' (bundled in ZIP)
 * hasLocalThree=false → references CDN URL (requires internet when opening)
 */
function buildViewerHtml(projectName: string, hasLocalThree: boolean): string {
  const threeTag = hasLocalThree
    ? `<script src="three.min.js"><\/script>`
    : `<script src="https://unpkg.com/three@0.128.0/build/three.min.js"><\/script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(projectName)} — BIMx Viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0e0e14; color: #e0e0e0; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; }
  #header { position: fixed; top: 0; left: 0; right: 0; z-index: 10; padding: 10px 16px; background: rgba(14,14,20,0.85); backdrop-filter: blur(8px); border-bottom: 1px solid #2a2a3a; display: flex; align-items: center; gap: 12px; }
  #header h1 { font-size: 14px; font-weight: 700; }
  #header .badge { font-size: 11px; color: #8888aa; }
  #header .info { margin-left: auto; font-size: 10px; color: #666; }
  canvas { width: 100%; height: 100%; display: block; }
  #controls { position: fixed; bottom: 12px; right: 12px; font-size: 10px; color: #555; text-align: right; line-height: 1.6; pointer-events: none; }
  #loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: #0e0e14; z-index: 100; }
  #loading span { font-size: 14px; color: #888; }
</style>
</head>
<body>
<div id="loading"><span>Loading 3D model…</span></div>
<div id="header">
  <h1>🏗️ ${esc(projectName)}</h1>
  <span class="badge">BIMx Export</span>
  <span class="info" id="stats"></span>
</div>
<div id="controls">
  Left drag — orbit<br>
  Right drag — pan<br>
  Scroll — zoom
</div>

${threeTag}
<script src="model.js"><\/script>
<script>
// MODEL_DATA is loaded from model.js via <script src> above
var PROJECT = window.MODEL_DATA;

// ─── Constants ───────────────────────────────────────────────────────────
var MM = 0.001;
var NODE_COLOR = {
  column:     [0.55, 0.65, 0.75],
  wall:       [0.72, 0.70, 0.65],
  beam:       [0.60, 0.50, 0.42],
  slab:       [0.45, 0.50, 0.58],
  foundation: [0.50, 0.45, 0.40],
  room:       [0.30, 0.55, 0.70],
  window:     [0.22, 0.74, 0.97],
  door:       [0.72, 0.52, 0.24],
  ax:         [0.28, 0.55, 0.85],
};

function parseAxes(v) {
  if (Array.isArray(v)) return v.map(Number).filter(function(n){return !isNaN(n);});
  if (typeof v === 'string') {
    try { var p = JSON.parse(v); if (Array.isArray(p)) return p.map(Number).filter(function(n){return !isNaN(n);}); } catch(e) {}
  }
  return [];
}
function parseDims(t, prefix, defA, defB) {
  var m = String(t).match(new RegExp(prefix + '(\\\\d+)x(\\\\d+)', 'i'));
  return m ? [parseFloat(m[1]) * 0.01, parseFloat(m[2]) * 0.01] : [defA, defB];
}
function parseThickness(t) {
  var m = String(t).match(/W(\\d+)/i);
  return m ? parseFloat(m[1]) * 0.01 : 0.20;
}
function getStoreyBand(n, nodeMap) {
  var s = n.parentId ? nodeMap.get(n.parentId) : null;
  var bot = Number((s && s.properties && s.properties.bottomElevation != null) ? s.properties.bottomElevation : 0);
  var top = Number((s && s.properties && s.properties.topElevation != null) ? s.properties.topElevation : 3000);
  return { bot: bot, top: top };
}
function getAxRealPos(n, nodeMap) {
  var s = n.parentId ? nodeMap.get(n.parentId) : null;
  var axesX = parseAxes(s && s.properties ? s.properties.axesX : []);
  var axesY = parseAxes(s && s.properties ? s.properties.axesY : []);
  var gx = Number(n.properties.gridX || 0);
  var gy = Number(n.properties.gridY || 0);
  return { x: (axesX[gx] != null ? axesX[gx] : 0), y: (axesY[gy] != null ? axesY[gy] : 0) };
}
function getNodeBimPos(n, nodeMap) {
  if (n.type === 'ax') { var p = getAxRealPos(n, nodeMap); return { x: p.x, y: p.y }; }
  return { x: n.x, y: n.y };
}
function getConnected(nodeId, edges, nodeMap) {
  var result = [];
  for (var i = 0; i < edges.length; i++) {
    var e = edges[i];
    if (e.from === nodeId && nodeMap.has(e.to)) result.push(nodeMap.get(e.to));
    else if (e.to === nodeId && nodeMap.has(e.from)) result.push(nodeMap.get(e.from));
  }
  return result;
}

// ─── Three.js Scene Builder ─────────────────────────────────────────────
function buildScene() {
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12121e);
  scene.fog = new THREE.Fog(0x12121e, 80, 200);

  var w = window.innerWidth, h = window.innerHeight;
  var camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 500);
  camera.position.set(15, 12, 15);

  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  // Lights
  var hemi = new THREE.HemisphereLight(0xffffff, 0x1a1a26, 0.7);
  scene.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(20, 40, 20);
  scene.add(sun);
  var amb = new THREE.AmbientLight(0x303040, 0.3);
  scene.add(amb);

  // Ground
  var gGeo = new THREE.PlaneGeometry(200, 200);
  var gMat = new THREE.MeshStandardMaterial({ color: 0x1a1a26, roughness: 0.9 });
  var ground = new THREE.Mesh(gGeo, gMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  var nodes = PROJECT.nodes, edges = PROJECT.edges;
  var nodeMap = new Map();
  for (var i = 0; i < nodes.length; i++) nodeMap.set(nodes[i].id, nodes[i]);
  var matCache = {};
  var meshCount = 0;

  function getMat(type, alpha) {
    var a = alpha != null ? alpha : 1;
    var key = type + '@' + a;
    if (matCache[key]) return matCache[key];
    var c = NODE_COLOR[type] || [0.5, 0.5, 0.5];
    var params = { color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.65, metalness: 0.15 };
    if (a < 1) { params.transparent = true; params.opacity = a; params.side = THREE.DoubleSide; }
    var mat = new THREE.MeshStandardMaterial(params);
    matCache[key] = mat;
    return mat;
  }

  // BIM mm -> Three.js Y-up metres: X=East, Y=Up(Z_bim), Z=-North(-BIM_Y)
  // Three.js Z = -(BIM Y)  — same as WebIfcViewer's szM = -szMm * MM
  function bimV(bx, by, bz) { return new THREE.Vector3(bx * MM, bz * MM, -by * MM); }

  function addBox(w, h, d, px, py, pz, rotY, mat) {
    var geo = new THREE.BoxGeometry(w, h, d);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, py, pz);
    if (rotY) mesh.rotation.y = rotY;
    scene.add(mesh);
    meshCount++;
    return mesh;
  }

  function spanBox(ax, az, bx, bz, width, height, baseY, mat) {
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-4) return null;
    var rotY = Math.atan2(dz, dx);
    return addBox(len, height, width, (ax+bx)/2, baseY + height/2, (az+bz)/2, rotY, mat);
  }

  // ── Storeys (floor planes) ──────────────────────────────────────────────
  var storeys = nodes.filter(function(n){return n.type==='storey';});
  for (var si = 0; si < storeys.length; si++) {
    var s = storeys[si];
    var bot = Number(s.properties.bottomElevation || 0);
    var axX = parseAxes(s.properties.axesX), axY = parseAxes(s.properties.axesY);
    if (!axX.length || !axY.length) continue;
    var pad = 500;
    var mnX = Math.min.apply(null,axX)-pad, mxX = Math.max.apply(null,axX)+pad;
    var mnY = Math.min.apply(null,axY)-pad, mxY = Math.max.apply(null,axY)+pad;
    var fGeo = new THREE.PlaneGeometry((mxX-mnX)*MM, (mxY-mnY)*MM);
    var fMat = new THREE.MeshStandardMaterial({color:0x383850, transparent:true, opacity:0.35, side:THREE.DoubleSide, roughness:0.9});
    var fl = new THREE.Mesh(fGeo, fMat);
    fl.rotation.x = -Math.PI/2;
    fl.position.set(((mnX+mxX)/2)*MM, bot*MM, -((mnY+mxY)/2)*MM);
    scene.add(fl); meshCount++;
  }

  // ── Grid lines ──────────────────────────────────────────────────────────
  var allAX = {}, allAY = {};
  for (var gi = 0; gi < storeys.length; gi++) {
    parseAxes(storeys[gi].properties.axesX).forEach(function(v){allAX[v]=1;});
    parseAxes(storeys[gi].properties.axesY).forEach(function(v){allAY[v]=1;});
  }
  var uxArr = Object.keys(allAX).map(Number).sort(function(a,b){return a-b;});
  var uyArr = Object.keys(allAY).map(Number).sort(function(a,b){return a-b;});
  var gBots = storeys.map(function(s){return Number(s.properties.bottomElevation||0);});
  var gBot = gBots.length ? Math.min.apply(null,gBots) : 0;
  var gPad = 1000;
  var gMinX = uxArr.length ? (uxArr[0]-gPad)*MM : -5;
  var gMaxX = uxArr.length ? (uxArr[uxArr.length-1]+gPad)*MM : 5;
  var gMinZ = uyArr.length ? -(uyArr[uyArr.length-1]+gPad)*MM : -5;
  var gMaxZ = uyArr.length ? -(uyArr[0]-gPad)*MM : 5;
  var gElev = gBot*MM - 0.02;
  var pts = [];
  for (var xi = 0; xi < uxArr.length; xi++) {
    var bx2 = uxArr[xi]*MM;
    pts.push(bx2,gElev,gMinZ, bx2,gElev,gMaxZ);
  }
  for (var yi = 0; yi < uyArr.length; yi++) {
    var bz2 = -(uyArr[yi]*MM);
    pts.push(gMinX,gElev,bz2, gMaxX,gElev,bz2);
  }
  if (pts.length) {
    var lGeo = new THREE.BufferGeometry();
    lGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    var lMat = new THREE.LineBasicMaterial({color:0x4488DD});
    scene.add(new THREE.LineSegments(lGeo, lMat)); meshCount++;
  }

  // ── Columns ─────────────────────────────────────────────────────────────
  for (var ci = 0; ci < nodes.length; ci++) {
    var n = nodes[ci]; if (n.type !== 'column') continue;
    var sb = getStoreyBand(n, nodeMap), ht = (sb.top-sb.bot)*MM;
    var cd = parseDims(n.properties.column_type||'C25x25','C',0.25,0.25);
    var pos = bimV(n.x, n.y, sb.bot+(sb.top-sb.bot)/2);
    addBox(cd[0],ht,cd[1], pos.x,pos.y,pos.z, 0, getMat('column'));
  }

  // ── Ax markers (columns at grid intersections) ──────────────────────────
  for (var ai = 0; ai < nodes.length; ai++) {
    var n = nodes[ai]; if (n.type !== 'ax') continue;
    if (String(n.properties.has_column||'').toLowerCase() !== 'true') continue;
    var sb = getStoreyBand(n, nodeMap), rp = getAxRealPos(n, nodeMap);
    var ht = (sb.top-sb.bot)*MM;
    var cd = parseDims(n.properties.column_type||'C25x25','C',0.25,0.25);
    var pos = bimV(rp.x, rp.y, sb.bot+(sb.top-sb.bot)/2);
    addBox(cd[0],ht,cd[1], pos.x,pos.y,pos.z, 0, getMat('column'));
  }

  // ── Walls ───────────────────────────────────────────────────────────────
  // BIM Y → Three.js -Z  (same negation as WebIfcViewer / bimGeometry.ts)
  for (var wi = 0; wi < nodes.length; wi++) {
    var wn = nodes[wi]; if (wn.type !== 'wall') continue;
    var wPts = getConnected(wn.id, edges, nodeMap).filter(function(n){return n.type!=='window'&&n.type!=='door';});
    if (wPts.length < 2) continue;
    var pA = getNodeBimPos(wPts[0], nodeMap), pB = getNodeBimPos(wPts[1], nodeMap);
    var sb = getStoreyBand(wn, nodeMap);
    var wallH = Number(wn.properties.height || (sb.top - sb.bot));
    var th = parseThickness(wn.properties.wall_type || 'W20');
    spanBox(pA.x*MM, -pA.y*MM, pB.x*MM, -pB.y*MM, th, wallH*MM, sb.bot*MM, getMat('wall'));
  }

  // ── Beams ───────────────────────────────────────────────────────────────
  for (var bi2 = 0; bi2 < nodes.length; bi2++) {
    var bn = nodes[bi2]; if (bn.type !== 'beam') continue;
    var bPts = getConnected(bn.id, edges, nodeMap);
    if (bPts.length < 2) continue;
    var pA = getNodeBimPos(bPts[0], nodeMap), pB = getNodeBimPos(bPts[1], nodeMap);
    var sb = getStoreyBand(bn, nodeMap);
    var bd = parseDims(bn.properties.beam_section||bn.properties.beam_type||'B30x60','B',0.30,0.60);
    spanBox(pA.x*MM, -pA.y*MM, pB.x*MM, -pB.y*MM, bd[0], bd[1], sb.top*MM-bd[1], getMat('beam'));
  }

  // ── Slabs ───────────────────────────────────────────────────────────────
  // Use storey axesX/axesY for the footprint — ax node canvas x,y are NOT mm,
  // so using sibling s.x * MM produces wrong bounds. Axes are always in mm.
  for (var sli = 0; sli < nodes.length; sli++) {
    var n = nodes[sli]; if (n.type !== 'slab') continue;
    var sb = getStoreyBand(n, nodeMap);
    var slabStor = n.parentId ? nodeMap.get(n.parentId) : null;
    var m2 = String(n.properties.slab_type||'SLAB15').match(/SLAB(\\d+)/i);
    var th = m2 ? parseFloat(m2[1])*0.01 : 0.15;
    var sAxX = parseAxes(slabStor && slabStor.properties ? slabStor.properties.axesX : []);
    var sAxY = parseAxes(slabStor && slabStor.properties ? slabStor.properties.axesY : []);
    if (sAxX.length >= 2 && sAxY.length >= 2) {
      var sMinX=Math.min.apply(null,sAxX), sMxX=Math.max.apply(null,sAxX);
      var sMinY=Math.min.apply(null,sAxY), sMxY=Math.max.apply(null,sAxY);
      addBox((sMxX-sMinX)*MM, th, (sMxY-sMinY)*MM,
             (sMinX+sMxX)/2*MM, sb.top*MM-th/2, -((sMinY+sMxY)/2*MM),
             0, getMat('slab'));
    }
  }

  // ── Foundations ──────────────────────────────────────────────────────────
  for (var fi = 0; fi < nodes.length; fi++) {
    var n = nodes[fi]; if (n.type !== 'foundation') continue;
    var sb = getStoreyBand(n, nodeMap);
    var pos = bimV(n.x, n.y, sb.bot-250);
    addBox(1.2,0.5,1.2, pos.x,pos.y,pos.z, 0, getMat('foundation'));
  }

  // ── Windows & Doors ──────────────────────────────────────────────────────
  // Position is computed identically to calcWallGeometry in bimGeometry.ts:
  //   cx = wallStartX + wallUnitX * openingCentreT  (in metres)
  //   cz = wallStartZ + wallUnitZ * openingCentreT  (BIM Y negated to Three Z)
  // node.x/y are canvas drag coords — NOT used for position here.
  for (var wi2 = 0; wi2 < nodes.length; wi2++) {
    var n = nodes[wi2];
    if (n.type !== 'window' && n.type !== 'door') continue;
    var isDoor = (n.type === 'door');

    // Resolve dimensions from type string (e.g. W-FIX-100x120 → 100cm × 120cm)
    var typeStr = String(isDoor ? (n.properties.door_type||'D-SWING-90x210') : (n.properties.window_type||'W-FIX-100x120'));
    var dm = typeStr.match(/(\\d+)x(\\d+)/);
    var oW = dm ? parseFloat(dm[1])*0.01 : (isDoor ? 0.9 : 1.0);
    var oH = dm ? parseFloat(dm[2])*0.01 : (isDoor ? 2.1 : 1.2);
    var sill = isDoor ? 0 : Number(n.properties.sill_height_mm != null ? n.properties.sill_height_mm : 900) * MM;
    var sb = getStoreyBand(n, nodeMap);

    // Find connected wall
    var connWall2 = null;
    for (var oei = 0; oei < edges.length; oei++) {
      var oe2 = edges[oei];
      var oid = (oe2.from===n.id)?oe2.to:(oe2.to===n.id)?oe2.from:null;
      if (oid) { var ow2 = nodeMap.get(oid); if (ow2 && ow2.type==='wall') { connWall2=ow2; break; } }
    }
    if (!connWall2) continue;

    // Wall endpoint nodes (not windows/doors)
    var wEps2 = getConnected(connWall2.id, edges, nodeMap).filter(function(p){return p.type!=='window'&&p.type!=='door';});
    if (wEps2.length < 2) continue;

    var pA2 = getNodeBimPos(wEps2[0], nodeMap);
    var pB2 = getNodeBimPos(wEps2[1], nodeMap);
    // Three.js coords: X=BIM_X*MM, Z=-(BIM_Y*MM)  (same as WebIfcViewer)
    var sxM2 = pA2.x*MM, szM2 = -pA2.y*MM;
    var exM2 = pB2.x*MM, ezM2 = -pB2.y*MM;
    var wdx2 = exM2-sxM2, wdz2 = ezM2-szM2;
    var wallLenM2 = Math.sqrt(wdx2*wdx2 + wdz2*wdz2);
    if (wallLenM2 < 1e-4) continue;
    var wux2 = wdx2/wallLenM2, wuz2 = wdz2/wallLenM2;

    // Opening offset along wall (mm → m)
    var rawOff = n.properties.offset;
    var offM = (rawOff === null || rawOff === undefined || rawOff === '')
      ? (wallLenM2 - oW) / 2
      : Math.max(0, Number(rawOff)) * MM;
    var centreT = offM + oW/2; // distance to centre of opening along wall

    var cx2 = sxM2 + wux2 * centreT;
    var cz2 = szM2 + wuz2 * centreT;
    var rotY2 = Math.atan2(wdz2, wdx2);
    var wallTh2 = parseThickness(connWall2.properties.wall_type||'W20');
    var cy2 = sb.bot*MM + sill + oH/2;

    addBox(oW, oH, wallTh2+0.02, cx2, cy2, cz2, rotY2, getMat(isDoor ? 'door' : 'window', isDoor ? 0.9 : 0.55));
  }

  // ── Rooms ───────────────────────────────────────────────────────────────
  for (var ri = 0; ri < nodes.length; ri++) {
    var n = nodes[ri]; if (n.type !== 'room') continue;
    var sb = getStoreyBand(n, nodeMap);
    var rh = (sb.top-sb.bot)*MM;
    var pos = bimV(n.x, n.y, sb.bot+(sb.top-sb.bot)/2);
    addBox(4,rh*0.95,4, pos.x,pos.y,pos.z, 0, getMat('room',0.12));
  }

  // ── Fit camera ──────────────────────────────────────────────────────────
  var bbox = new THREE.Box3();
  scene.traverse(function(obj) {
    if (obj.isMesh && obj !== ground) bbox.expandByObject(obj);
  });
  if (!bbox.isEmpty()) {
    var center = bbox.getCenter(new THREE.Vector3());
    var size = bbox.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z);
    var dist = maxDim / (2 * Math.tan(camera.fov * Math.PI / 360)) * 1.3;
    camera.position.set(center.x + dist*0.5, center.y + dist*0.4, center.z + dist*0.5);
    camera.lookAt(center);
  }

  // ── Orbit Controls (inline, no import needed) ─────────────────────────
  var target = new THREE.Vector3();
  if (!bbox.isEmpty()) bbox.getCenter(target);
  var spherical = new THREE.Spherical();
  spherical.setFromVector3(camera.position.clone().sub(target));
  var isDrag = false, isRight = false, prevX = 0, prevY = 0;

  renderer.domElement.addEventListener('mousedown', function(e) {
    isDrag = true; isRight = e.button === 2;
    prevX = e.clientX; prevY = e.clientY;
  });
  window.addEventListener('mousemove', function(e) {
    if (!isDrag) return;
    var dx = e.clientX - prevX, dy = e.clientY - prevY;
    prevX = e.clientX; prevY = e.clientY;
    if (isRight) {
      // Pan
      var dist = camera.position.distanceTo(target);
      var panScale = dist * 0.002;
      var right = new THREE.Vector3(); camera.getWorldDirection(right);
      var up = camera.up.clone();
      right.cross(up).normalize();
      up = new THREE.Vector3(); up.crossVectors(right, camera.getWorldDirection(new THREE.Vector3())).normalize();
      var pan = right.multiplyScalar(-dx * panScale).add(up.multiplyScalar(dy * panScale));
      target.add(pan); camera.position.add(pan);
    } else {
      // Orbit
      spherical.setFromVector3(camera.position.clone().sub(target));
      spherical.theta -= dx * 0.005;
      spherical.phi -= dy * 0.005;
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi));
      var v = new THREE.Vector3().setFromSpherical(spherical);
      camera.position.copy(target).add(v);
      camera.lookAt(target);
    }
  });
  window.addEventListener('mouseup', function() { isDrag = false; });
  renderer.domElement.addEventListener('wheel', function(e) {
    e.preventDefault();
    spherical.setFromVector3(camera.position.clone().sub(target));
    spherical.radius *= e.deltaY > 0 ? 1.08 : 0.92;
    spherical.radius = Math.max(0.5, Math.min(200, spherical.radius));
    var v = new THREE.Vector3().setFromSpherical(spherical);
    camera.position.copy(target).add(v);
    camera.lookAt(target);
  }, {passive: false});
  renderer.domElement.addEventListener('contextmenu', function(e){e.preventDefault();});

  // ── Stats & render ────────────────────────────────────────────────────
  document.getElementById('stats').textContent =
    nodes.length + ' nodes · ' + edges.length + ' edges · ' + meshCount + ' meshes';
  document.getElementById('loading').style.display = 'none';

  function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();
  window.addEventListener('resize', function() {
    var w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
}

buildScene();
<\/script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Minimal ZIP encoder (STORE method — no compression, no external deps) ────
// Produces a valid ZIP file readable by all OS zip utilities and JSZip/fflate.

function crc32(data: Uint8Array): number {
  // Build CRC-32 table on first call
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (table[(crc ^ data[i]) & 0xFF]! ^ (crc >>> 8)) >>> 0;
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0);
}

function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  type Entry = { nameBytes: Uint8Array; data: Uint8Array; crc: number; offset: number };
  const entries: Entry[] = [];
  let localOffset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc       = crc32(f.data);
    entries.push({ nameBytes, data: f.data, crc, offset: localOffset });
    localOffset += 30 + nameBytes.length + f.data.length;
  }

  const centralSize = entries.reduce((s, e) => s + 46 + e.nameBytes.length, 0);
  const total       = localOffset + centralSize + 22;
  const buf         = new ArrayBuffer(total);
  const view        = new DataView(buf);
  const u8          = new Uint8Array(buf);

  function w16(off: number, v: number) { view.setUint16(off, v, true); }
  function w32(off: number, v: number) { view.setUint32(off, v, true); }

  let off = 0;
  for (const e of entries) {
    w32(off, 0x04034b50); off += 4;           // local file header sig
    w16(off, 20);         off += 2;           // version needed
    w16(off, 0);          off += 2;           // flags
    w16(off, 0);          off += 2;           // compression: STORE
    w16(off, 0);          off += 2;           // mod time
    w16(off, 0);          off += 2;           // mod date
    w32(off, e.crc);      off += 4;
    w32(off, e.data.length); off += 4;        // compressed size
    w32(off, e.data.length); off += 4;        // uncompressed size
    w16(off, e.nameBytes.length); off += 2;
    w16(off, 0);          off += 2;           // extra field length
    u8.set(e.nameBytes, off); off += e.nameBytes.length;
    u8.set(e.data, off);  off += e.data.length;
  }

  const centralStart = off;
  for (const e of entries) {
    w32(off, 0x02014b50); off += 4;           // central dir sig
    w16(off, 20);         off += 2;           // version made by
    w16(off, 20);         off += 2;           // version needed
    w16(off, 0);          off += 2;           // flags
    w16(off, 0);          off += 2;           // compression: STORE
    w16(off, 0);          off += 2;           // mod time
    w16(off, 0);          off += 2;           // mod date
    w32(off, e.crc);      off += 4;
    w32(off, e.data.length); off += 4;
    w32(off, e.data.length); off += 4;
    w16(off, e.nameBytes.length); off += 2;
    w16(off, 0);          off += 2;           // extra field
    w16(off, 0);          off += 2;           // comment
    w16(off, 0);          off += 2;           // disk start
    w16(off, 0);          off += 2;           // internal attr
    w32(off, 0);          off += 4;           // external attr
    w32(off, e.offset);   off += 4;           // local header offset
    u8.set(e.nameBytes, off); off += e.nameBytes.length;
  }

  // End of central directory record
  w32(off, 0x06054b50);             off += 4;
  w16(off, 0);                      off += 2; // disk
  w16(off, 0);                      off += 2; // disk w/ central dir start
  w16(off, entries.length);         off += 2;
  w16(off, entries.length);         off += 2;
  w32(off, centralSize);            off += 4;
  w32(off, centralStart);           off += 4;
  w16(off, 0);                      off += 2; // comment length

  return u8;
}
