/**
 * fragmentsExport.ts — write a loaded model out as a `.frag` file.
 *
 * `.frag` is That Open Company's own binary model format: the tiled, indexed
 * form their viewer streams. Anything the viewer has loaded is ALREADY one —
 * `OBC.IfcLoader` converts IFC to fragments in a worker before the geometry ever
 * reaches the scene, and the project's own graph is built into a fragments model
 * too (`fragModelBuilder.ts`). So exporting is not a conversion; it is asking the
 * worker for the buffer it is already holding.
 *
 * That is also why this is worth having: converting a large IFC takes seconds
 * every time it is opened, and a `.frag` opens immediately. Export once, and the
 * file is ready for any That Open viewer — or for coming back into this one.
 *
 * ## raw vs compressed
 *
 * `getBuffer(raw)` returns the uncompressed FlatBuffer when `raw` is true. The
 * files That Open's tooling reads and writes are the compressed form, so that is
 * the default here; `raw` exists for the seed-buffer case in `fragModelBuilder`,
 * which loads with `raw: true`.
 */

import type { FragmentsModel } from '@thatopen/fragments';
import { downloadBytes, safeFilename } from '@/lib/download';

export const FRAG_EXT = 'frag';
export const FRAG_MIME = 'application/octet-stream';

/** The file name a model is saved under. Strips a trailing `.ifc` first. */
export function fragFileName(modelName: string): string {
  const base = modelName.replace(/\.(ifc|ifcxml|ifczip)$/i, '');
  return safeFilename(base, FRAG_EXT, 'model');
}

/**
 * Normalise what the worker hands back.
 *
 * `getBuffer` is typed `Promise<ArrayBuffer>`, but it crosses a worker boundary
 * and comes back as whatever structured clone produced — an ArrayBuffer in
 * practice, a typed-array view if the implementation changes. Both are accepted;
 * anything else is a bug worth naming rather than a silent empty download.
 */
export function toFragBytes(buffer: unknown): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) {
    const v = buffer as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  throw new Error('Fragments buffer has an unexpected type — nothing was written.');
}

/** Human-readable size, for the toast that says the export happened. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Ask a loaded model for its bytes.
 *
 * An empty buffer is treated as a failure: the download would succeed, produce a
 * 0-byte `.frag`, and the problem would only surface later in another tool.
 */
export async function fragmentsBytes(model: FragmentsModel, raw = false): Promise<Uint8Array> {
  const bytes = toFragBytes(await model.getBuffer(raw));
  if (bytes.byteLength === 0) {
    throw new Error('The model returned an empty buffer — it may still be loading.');
  }
  return bytes;
}

/** Save one loaded model as `<name>.frag`. Returns the size written. */
export async function exportFragmentsModel(
  model: FragmentsModel,
  fileName: string,
  raw = false,
): Promise<number> {
  const bytes = await fragmentsBytes(model, raw);
  downloadBytes(fileName, bytes, FRAG_MIME);
  return bytes.byteLength;
}
