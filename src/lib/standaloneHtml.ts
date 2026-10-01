/**
 * standaloneHtml.ts — the exported HTML file, assembled from its parts.
 *
 * Everything here is pure so it can be tested without a browser: given the
 * viewer script, the data block, the GLB and (optionally) the project, it
 * returns the text of a file that opens from a double-click anywhere.
 *
 * The file's one rule is that it is self-contained. Opened from `file://` a
 * page may not `fetch`, import a module, spawn a worker or reach a CDN — so
 * every byte the viewer needs is inline, in `<script>` tags:
 *
 *   #bbim-data     application/json   what the viewer knows about the model
 *   #bbim-glb      text/plain         the model, GLB as base64
 *   #bbim-project  application/json   the whole `.bbim`, so the file is also
 *                                     the project and not just a picture of it
 *   (inline)                          the viewer itself, then `boot()`
 *
 * Data tags are not JavaScript, so the only sequence that can break one is
 * `</script`; `jsonForScript` escapes the slash, which JSON allows. The
 * viewer script IS JavaScript and gets the same treatment inside string
 * literals, where such a sequence could only ever appear.
 */
import type { BubbleGraphNode } from '@/store';
import { STANDALONE_TAG, type StandaloneData, type StandaloneElement, type StandaloneStorey } from './standaloneTypes';

export const GENERATOR = 'BubbleBIM';

/** Longer property strings are notes, not values; the info panel truncates them. */
const MAX_PROP_CHARS = 300;

/** Node types that are structure of the graph, not elements of the building. */
const NOT_ELEMENTS = new Set(['storey', 'ax', 'section', 'view', 'sheet']);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JSON that is safe inside a `<script type="application/json">` tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/**
 * JavaScript that is safe inside an inline `<script>` tag. Only `</script`
 * can occur in a bundle, and only inside a string literal, where `<\/script`
 * is the same string; a minifier already keeps `<!--` out of its output.
 */
export function scriptForInline(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

export function storeyInfo(nodes: BubbleGraphNode[]): StandaloneStorey[] {
  return nodes
    .filter((n) => n.type === 'storey')
    .map((n) => ({
      id: n.id,
      name: n.name || n.id,
      bottomMm: Number(n.properties?.bottomElevation ?? 0),
      topMm: Number(n.properties?.topElevation ?? 3000),
    }))
    .sort((a, b) => a.bottomMm - b.bottomMm);
}

/** Every building element by id, with its primitive properties. */
export function elementInfo(nodes: BubbleGraphNode[]): Record<string, StandaloneElement> {
  const storeyOf = storeyResolver(nodes);
  const out: Record<string, StandaloneElement> = {};
  for (const n of nodes) {
    if (NOT_ELEMENTS.has(n.type)) continue;
    const props: StandaloneElement['props'] = {};
    for (const [k, v] of Object.entries(n.properties ?? {})) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'number' || typeof v === 'boolean') props[k] = v;
      else if (typeof v === 'string' && v !== '') props[k] = v.length > MAX_PROP_CHARS ? `${v.slice(0, MAX_PROP_CHARS)}…` : v;
    }
    out[n.id] = { name: n.name || n.id, type: n.type, storeyId: storeyOf(n), props };
  }
  return out;
}

/** The storey ancestor of a node, walking `parentId` up to a `storey`. */
function storeyResolver(nodes: BubbleGraphNode[]): (n: BubbleGraphNode) => string | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (n) => {
    let cur: BubbleGraphNode | undefined = n;
    for (let guard = 0; cur && guard < 32; guard++) {
      if (cur.type === 'storey') return cur.id;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return undefined;
  };
}

export interface StandaloneParts {
  data: StandaloneData;
  /** The viewer bundle — `src/generated/standalone-viewer.js`. */
  viewerJs: string;
  glbBase64: string;
  /** The serialized `.bbim`, or null to leave the project out. */
  projectJson?: string | null;
}

export function assembleStandaloneHtml({ data, viewerJs, glbBase64, projectJson }: StandaloneParts): string {
  const title = escapeHtml(`${data.projectName || 'Proiect'} — ${GENERATOR}`);
  const project = projectJson
    ? `<script id="${STANDALONE_TAG.project}" type="application/json">${projectJson.replace(/<\//g, '<\\/')}</script>\n`
    : '';
  return `<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${GENERATOR}">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#f1f5f9;font-family:system-ui,sans-serif}#app{height:100%}</style>
</head>
<body>
<div id="app"><p style="padding:24px;color:#64748b">Se încarcă modelul…</p></div>
<script id="${STANDALONE_TAG.data}" type="application/json">${jsonForScript(data)}</script>
<script id="${STANDALONE_TAG.glb}" type="text/plain">${glbBase64}</script>
${project}<script>${scriptForInline(viewerJs)}</script>
<script>BubbleBIMViewer.boot();</script>
</body>
</html>
`;
}

/** Bytes → base64, in chunks: `String.fromCharCode` cannot take a whole model at once. */
export function bytesToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[]);
  }
  return btoa(s);
}
