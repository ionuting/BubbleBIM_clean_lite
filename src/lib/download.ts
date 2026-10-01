/**
 * download.ts — hand the browser a file.
 *
 * The object URL is revoked on a timer rather than immediately: Safari starts
 * the download asynchronously and a URL revoked in the same tick is already
 * gone by the time it reads it.
 */

/** Turn a string into a downloaded file. */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Turn bytes into a downloaded file — the same dance, without the text encoding. */
export function downloadBytes(
  filename: string,
  bytes: ArrayBuffer | ArrayBufferView,
  mime = 'application/octet-stream',
): void {
  // `BlobPart` accepts both, but a view must be passed as-is: wrapping it in a
  // fresh ArrayBuffer would copy the whole underlying buffer, not the view.
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * A filename the filesystem will accept, from a view's own name.
 *
 * `fallback` is what a name made entirely of stripped characters becomes — a
 * drawing and a model want different words there.
 */
export function safeFilename(name: string, ext: string, fallback = 'desen'): string {
  const base = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `${base || fallback}.${ext}`;
}
