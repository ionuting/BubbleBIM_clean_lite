/**
 * zip.ts — a minimal ZIP writer, because a tileset is never one file.
 *
 * A 3D Tiles set is a `tileset.json` plus one GLB per tile, and the JSON names
 * the GLBs by relative path. Handing the user a folder's worth of separate
 * downloads would put the burden of reassembling them — with exactly the right
 * names, in exactly the right places — on the person least equipped to do it.
 * One archive that unzips into a working tileset is the whole deliverable.
 *
 * ## No compression, on purpose
 *
 * Everything written here is a GLB: binary geometry that DEFLATE would shave a
 * few percent off while costing a compressor this project does not have. The
 * STORE method (0) is a byte-for-byte copy, which means the writer is a header
 * format and a checksum and nothing else — no dependency, and small enough to
 * be read end to end.
 *
 * ## Deliberate limits
 *
 * No ZIP64, so neither the archive nor any entry may reach 4 GB. A tileset that
 * large is a server's job, not a browser download, and the writer says so
 * rather than emitting an archive whose sizes have silently wrapped. No
 * directory entries either: every unzipper creates the folders a path implies.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** ZIP stores sizes and offsets as UINT32; ZIP64 is what lifts this. */
export const ZIP_MAX_BYTES = 0xffffffff;

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. No leading slash, no `..`. */
  path: string;
  data: Uint8Array;
}

// ── CRC-32 ────────────────────────────────────────────────────────────────────

/** The standard IEEE 802.3 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Writing ───────────────────────────────────────────────────────────────────

/**
 * A path the archive will accept.
 *
 * Backslashes become forward slashes (the format's only separator), a leading
 * slash is dropped, and `..` segments are refused outright: a path that climbs
 * out of the archive is how a zip writes over files it was never given.
 */
export function normaliseZipPath(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) throw new Error('Un fișier din arhivă nu are nume.');
  if (clean.split('/').some((seg) => seg === '..')) {
    throw new Error(`Cale nepermisă în arhivă: ${path}`);
  }
  return clean;
}

/**
 * MS-DOS date and time, which is what ZIP records.
 *
 * Two-second resolution and an epoch of 1980 — a date before that cannot be
 * expressed, so it is clamped rather than written as a negative year that
 * every unzipper would read as garbage.
 */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a ZIP archive holding `entries`, uncompressed. */
export function buildZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);

  const prepared = entries.map((e) => {
    const name = encoder.encode(normaliseZipPath(e.path));
    if (e.data.length > ZIP_MAX_BYTES) {
      throw new Error(`"${e.path}" depășește 4 GB — arhiva ar avea nevoie de ZIP64.`);
    }
    return { name, data: e.data, crc: crc32(e.data) };
  });

  const seen = new Set<string>();
  for (const p of prepared) {
    const key = new TextDecoder().decode(p.name);
    if (seen.has(key)) throw new Error(`Două fișiere cu aceeași cale în arhivă: ${key}`);
    seen.add(key);
  }

  const localSize = prepared.reduce((n, p) => n + 30 + p.name.length + p.data.length, 0);
  const centralSize = prepared.reduce((n, p) => n + 46 + p.name.length, 0);
  const total = localSize + centralSize + 22;
  if (total > ZIP_MAX_BYTES) {
    throw new Error('Arhiva depășește 4 GB — ar avea nevoie de ZIP64.');
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v: number) => { view.setUint32(at, v >>> 0, true); at += 4; };
  const bytes = (b: Uint8Array) => { out.set(b, at); at += b.length; };

  // ── Local headers + data ────────────────────────────────────────────────
  const offsets: number[] = [];
  for (const p of prepared) {
    offsets.push(at);
    u32(LOCAL_HEADER);
    u16(20);            // version needed: 2.0, which is what STORE requires
    u16(0);             // flags — no encryption, sizes known up front
    u16(0);             // method 0 = STORE
    u16(time); u16(date);
    u32(p.crc);
    u32(p.data.length); // compressed == uncompressed under STORE
    u32(p.data.length);
    u16(p.name.length);
    u16(0);             // extra field length
    bytes(p.name);
    bytes(p.data);
  }

  // ── Central directory ───────────────────────────────────────────────────
  const centralAt = at;
  prepared.forEach((p, i) => {
    u32(CENTRAL_HEADER);
    u16(20);            // version made by
    u16(20);            // version needed
    u16(0); u16(0);     // flags, method
    u16(time); u16(date);
    u32(p.crc);
    u32(p.data.length);
    u32(p.data.length);
    u16(p.name.length);
    u16(0); u16(0);     // extra, comment
    u16(0);             // disk number start
    u16(0);             // internal attributes
    u32(0);             // external attributes
    u32(offsets[i]);
    bytes(p.name);
  });

  // ── End of central directory ────────────────────────────────────────────
  // Measured BEFORE the record is written: `at` advances as this block goes
  // out, and reading it later reported a directory twelve bytes longer than
  // the one that is actually there.
  const centralBytes = at - centralAt;
  u32(END_OF_CENTRAL);
  u16(0); u16(0);       // this disk, disk with the central directory
  u16(prepared.length); u16(prepared.length);
  u32(centralBytes);
  u32(centralAt);
  u16(0);               // archive comment length

  return out;
}
