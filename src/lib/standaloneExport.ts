/**
 * standaloneExport.ts — one `.html` that opens the model anywhere.
 *
 * The idea: bake, don't rebuild. The exported file carries the exact scene
 * the app's own 3D viewer shows (`buildOGScene` — walls with their openings
 * cut, materials, the roof as a solid, the stairs), frozen as a GLB, plus
 * the 2D drawings as static SVG, plus the `.bbim` itself so the file is also
 * the project. The viewer inside the file (`src/standalone/viewer.ts`, built
 * separately and inlined here `?raw`) knows nothing about BIM: it displays
 * triangles and looks ids up. Nothing in the export re-implements geometry.
 *
 * The file is not tied to the project's own building. Whatever goes in is a
 * `StandaloneSource` — meshes with ids on them and the records those ids
 * name — and the project is one such source, built here; an imported IFC is
 * another, built in `standaloneSources.ts`. `buildStandaloneHtmlFromSources`
 * takes any number of them and bakes them into one file.
 *
 * Browser-only — the kernel, `GLTFExporter` and the download all need one.
 * The pure parts (assembly, the drawings) live in `standaloneHtml.ts` and
 * `standaloneDrawings.tsx`, where the tests are.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import viewerJs from '@/generated/standalone-viewer.js?raw';
import type { BubbleGraphNode, BubbleGraphEdge, BuildingAxes } from '@/store';
import type { MaterialConfig } from '@/lib/materialConfig';
import type { BbimFile } from '@/lib/projectFile';
import { ensureOpenGeoReady } from '@/lib/openGeoInit';
import { buildOGScene } from '@/lib/ogBimMapper';
import { entitiesFromScene, projectOgLines } from '@/lib/ogProjection';
import { downloadText, safeFilename } from '@/lib/download';
import { buildStandaloneBoq } from './standaloneBoq';
import { buildStandaloneDrawings } from './standaloneDrawings';
import { GENERATOR, assembleStandaloneHtml, bytesToBase64, elementInfo, storeyInfo } from './standaloneHtml';
import type { StandaloneSource } from './standaloneSources';
import type { LoadedIfc } from './loadedIfcRegistry';
import { readIndexedColours } from '@/lib/ifc/indexedColours';
import type { StandaloneBoq, StandaloneData, StandaloneDrawing } from './standaloneTypes';

export interface StandaloneExportInput {
  projectName: string;
  nodes: BubbleGraphNode[];
  edges: BubbleGraphEdge[];
  /** The project's axis grid — what the floor plans are drawn on. */
  buildingAxes: BuildingAxes;
  matConfig: MaterialConfig | null;
  /** The serialized project to carry inside the file; omit to leave it out. */
  project?: BbimFile | null;
  /** IFC models open in the viewers, carried as sources next to the project. */
  ifcModels?: LoadedIfc[];
}

export interface StandaloneExportResult {
  fileName: string;
  /** Size of the HTML in bytes. */
  bytes: number;
  meshes: number;
  drawings: number;
  /** Articles in the bill of quantities, 0 when the file carries none. */
  boqRows: number;
  /** IFC models carried next to the project. */
  ifcModels: number;
}

/** Build the HTML and hand it to the browser as a download. */
export async function exportStandaloneHtml(input: StandaloneExportInput): Promise<StandaloneExportResult> {
  const { html, meshes, drawings, boqRows, ifcModels } = await buildStandaloneHtml(input);
  const fileName = safeFilename(input.projectName, 'html', 'proiect');
  downloadText(fileName, html, 'text/html');
  return { fileName, bytes: new TextEncoder().encode(html).length, meshes, drawings, boqRows, ifcModels };
}

/** The whole file as text — what `exportStandaloneHtml` downloads. */
export async function buildStandaloneHtml(
  input: StandaloneExportInput,
): Promise<{ html: string; meshes: number; drawings: number; boqRows: number; ifcModels: number }> {
  const { projectName, nodes, edges, matConfig, buildingAxes } = input;
  await ensureOpenGeoReady();

  const scene = new THREE.Scene();
  let ifc: StandaloneSource[] = [];
  try {
    ifc = await loadedIfcSources(input.ifcModels ?? []);

    buildOGScene(scene, nodes, edges, matConfig);
    scene.updateMatrixWorld(true);

    // The drawings first, off the same scene the GLB comes from.
    const entities = entitiesFromScene(scene);
    const outlinesFor = (cut: Parameters<typeof projectOgLines>[1]) => {
      try { return projectOgLines(entities, cut, nodes, matConfig); } catch { return null; }
    };
    const drawings = buildStandaloneDrawings(nodes, edges, matConfig, outlinesFor, { buildingAxes });
    const boq = await buildStandaloneBoq(nodes, edges);

    const elements = elementInfo(nodes);
    const project: StandaloneSource = {
      info: { id: 'project', name: projectName, kind: 'project', elements: Object.keys(elements).length },
      group: scene,
      storeys: storeyInfo(nodes),
      elements,
      // The scene is disposed by the source builder below, not here: it is
      // handed over whole.
      dispose: () => disposeAll(scene),
    };
    // An empty project next to an IFC adds nothing but an empty entry in
    // the viewer's model list; alone, it is still what the file is.
    const sources = nodes.length > 0 || ifc.length === 0 ? [project, ...ifc] : ifc;
    if (!sources.includes(project)) disposeAll(scene);
    const r = await buildStandaloneHtmlFromSources({
      projectName, sources, drawings, boq, project: input.project,
    });
    return { ...r, ifcModels: ifc.length };
  } catch (err) {
    disposeAll(scene);
    for (const s of ifc) s.dispose?.();
    throw err;
  }
}

// ─── IFC models open in the viewers ───────────────────────────────────────────

/**
 * Each loaded IFC as a source, the way the World view's own HTML export
 * builds one: the fragments model flattened to one mesh per element
 * (`fragmentsToThreeGroup`), then storeys and properties read off the model
 * (`ifcSource`). A viewer that keeps a live fragments model hands it over;
 * one that keeps only the file has it converted here, headless, and the
 * model is dropped again once the source is built.
 *
 * The flattening is built for the export, so the source owns it and frees
 * it. A model that cannot be read is skipped with a warning rather than
 * sinking the whole file.
 */
async function loadedIfcSources(models: LoadedIfc[]): Promise<StandaloneSource[]> {
  if (models.length === 0) return [];
  const [{ ifcSource }, frags] = await Promise.all([
    import('./standaloneSources'),
    import('@/lib/ifc/ifcFragments'),
  ]);
  const out: StandaloneSource[] = [];
  for (const m of models) {
    let headlessId: string | null = null;
    try {
      const bytes = m.file ? new Uint8Array(await m.file.arrayBuffer()) : null;
      let model = m.getModel?.();
      if (!model && bytes) {
        headlessId = `html-export-${m.key}`;
        const frag = await frags.convertIfcToFragments(bytes);
        model = await frags.loadFragments(frags.getHeadlessFragments(), frag, headlessId);
      }
      if (!model) continue;
      const bodyColours = bytes ? readIndexedColours(new TextDecoder().decode(bytes)) : undefined;
      const group = await frags.fragmentsToThreeGroup(model, { bodyColours });
      if (group.children.length === 0) { disposeAll(group); continue; }
      const source = await ifcSource(model, group, { id: m.key, name: m.name });
      out.push({ ...source, dispose: () => disposeAll(group) });
    } catch (err) {
      console.warn(`[standaloneExport] IFC "${m.name}" left out of the HTML:`, err);
    } finally {
      if (headlessId) {
        await frags.getHeadlessFragments().disposeModel(headlessId).catch(() => {});
      }
    }
  }
  return out;
}

// ─── Any models at all ────────────────────────────────────────────────────────

export interface StandaloneSourcesInput {
  projectName: string;
  /** What the file shows. Each is re-parented into the export's scene. */
  sources: StandaloneSource[];
  drawings?: StandaloneDrawing[];
  boq?: StandaloneBoq | null;
  project?: BbimFile | null;
}

/** Build the HTML from the given sources and download it. */
export async function exportStandaloneSources(input: StandaloneSourcesInput): Promise<StandaloneExportResult> {
  const { html, meshes, drawings, boqRows } = await buildStandaloneHtmlFromSources(input);
  const fileName = safeFilename(input.projectName, 'html', 'model');
  downloadText(fileName, html, 'text/html');
  const ifcModels = input.sources.filter((s) => s.info.kind === 'ifc').length;
  return { fileName, bytes: new TextEncoder().encode(html).length, meshes, drawings, boqRows, ifcModels };
}

/**
 * The file, from whatever sources it is given.
 *
 * Each source's group goes under a wrapper carrying its placement, so a
 * model's own transform and where it stands in the shared frame compose the
 * way they do on the globe. Every mesh is stamped with its source id before
 * baking, so the viewer can tell the models apart; a mesh that already
 * names a source keeps it. Sources are disposed when they ask to be — a
 * source built over someone else's geometry does not ask.
 */
export async function buildStandaloneHtmlFromSources(
  input: StandaloneSourcesInput,
): Promise<{ html: string; meshes: number; drawings: number; boqRows: number }> {
  const { projectName, sources } = input;
  const drawings = input.drawings ?? [];
  const boq = input.boq ?? null;

  const scene = new THREE.Scene();
  let baked: THREE.Scene | null = null;
  try {
    for (const s of sources) {
      const wrap = new THREE.Group();
      wrap.name = s.info.id;
      if (s.placement) wrap.applyMatrix4(s.placement);
      s.group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && typeof mesh.userData?.source !== 'string') mesh.userData.source = s.info.id;
      });
      wrap.add(s.group);
      scene.add(wrap);
    }
    scene.updateMatrixWorld(true);

    baked = bakeForGltf(scene);
    const meshes = baked.children.length;
    const glb = await new GLTFExporter().parseAsync(baked, { binary: true, onlyVisible: true }) as ArrayBuffer;

    const elements: Record<string, StandaloneData['elements'][string]> = {};
    for (const s of sources) Object.assign(elements, s.elements);
    const data: StandaloneData = {
      projectName,
      exportedAt: new Date().toISOString(),
      generator: GENERATOR,
      storeys: sources.flatMap((s) => s.storeys),
      elements,
      drawings,
      ...(boq ? { boq } : {}),
      sources: sources.map((s) => s.info),
    };
    const html = assembleStandaloneHtml({
      data,
      viewerJs,
      glbBase64: bytesToBase64(glb),
      projectJson: input.project ? JSON.stringify(input.project) : null,
    });
    return { html, meshes, drawings: drawings.length, boqRows: boq?.rows.length ?? 0 };
  } finally {
    for (const s of sources) s.dispose?.();
    if (baked) disposeAll(baked);
  }
}

// ─── Baking the scene for the exporter ────────────────────────────────────────

/**
 * A copy of the scene the exporter can take as it is: every mesh flat at the
 * root with its world transform applied, non-indexed with flat normals (the
 * kernel's solids are flat-shaded; a loader given no normals would smooth
 * them and a box would look like a balloon), one plain material per look,
 * and the element ids on `userData` where glTF keeps them as `extras`.
 */
export function bakeForGltf(scene: THREE.Object3D): THREE.Scene {
  const out = new THREE.Scene();
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const materialFor = (src: THREE.Material | undefined): THREE.MeshStandardMaterial => {
    const color = src && 'color' in src ? (src.color as THREE.Color).getHex() : 0xbfbfbf;
    const opacity = src?.transparent ? src.opacity : 1;
    const key = `${color}|${opacity.toFixed(2)}`;
    let m = materials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color, metalness: 0, roughness: 0.85, side: THREE.DoubleSide,
        transparent: opacity < 1, opacity,
      });
      materials.set(key, m);
    }
    return m;
  };

  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    if (!pos || pos.count === 0) return;

    const flat = src.index ? src.toNonIndexed() : src.clone();
    const groups = Array.isArray(mesh.material) && flat.groups.length
      ? flat.groups.map((g) => ({ start: g.start, count: g.count === Infinity ? flat.getAttribute('position').count - g.start : g.count, mat: (mesh.material as THREE.Material[])[g.materialIndex ?? 0] }))
      : [{ start: 0, count: flat.getAttribute('position').count, mat: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material }];

    for (const g of groups) {
      if (g.count <= 0) continue;
      const geo = new THREE.BufferGeometry();
      const all = flat.getAttribute('position');
      const slice = new THREE.BufferAttribute((all.array as Float32Array).slice(g.start * 3, (g.start + g.count) * 3), 3);
      geo.setAttribute('position', slice);
      geo.applyMatrix4(mesh.matrixWorld);
      geo.computeVertexNormals();
      const baked = new THREE.Mesh(geo, materialFor(g.mat));
      baked.name = mesh.name || String(mesh.userData?.nodeId ?? '');
      const { nodeId, nodeType, storeyId, layer, source } = mesh.userData ?? {};
      baked.userData = {
        ...(typeof nodeId === 'string' ? { nodeId } : {}),
        ...(typeof nodeType === 'string' ? { nodeType } : {}),
        ...(typeof storeyId === 'string' ? { storeyId } : {}),
        ...(typeof layer === 'string' ? { layer } : {}),
        ...(typeof source === 'string' ? { source } : {}),
      };
      out.add(baked);
    }
    if (flat !== src) flat.dispose();
  });
  return out;
}

function disposeAll(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m?.dispose();
  });
}
