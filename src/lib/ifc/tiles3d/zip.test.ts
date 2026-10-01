/**
 * A ZIP writer is only worth anything if real unzippers accept what it emits,
 * and the way to check that without one is to read the bytes back the way the
 * spec says they must be laid out. These tests parse the archive rather than
 * comparing it to a fixture, so a change that still produces a VALID archive
 * is allowed to pass.
 */
import { describe, expect, it } from 'vitest';
import { buildZip, crc32, dosDateTime, normaliseZipPath, type ZipEntry } from './zip';

const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Read an archive back through its central directory, as an unzipper does. */
function readZip(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is the last 22 bytes when there is no comment.
  const eocd = zip.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralAt = view.getUint32(eocd + 16, true);
  expect(centralAt + centralSize).toBe(eocd);

  const files: { path: string; data: Uint8Array; crc: number; localAt: number }[] = [];
  let at = centralAt;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    expect(method).toBe(0);               // STORE
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const path = decode(zip.subarray(at + 46, at + 46 + nameLen));

    // Follow the offset into the local header and take the data from there.
    expect(view.getUint32(localAt, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localAt + 26, true);
    const extraLen = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localNameLen + extraLen;
    files.push({ path, data: zip.subarray(dataAt, dataAt + size), crc, localAt });
    at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  expect(at).toBe(eocd);
  return files;
}

describe('crc32', () => {
  it('matches the values the standard is checked against', () => {
    expect(crc32(text(''))).toBe(0);
    expect(crc32(text('a'))).toBe(0xe8b7be43);
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(text('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('handles bytes above 127, which a signed shift would corrupt', () => {
    expect(crc32(new Uint8Array([0xff, 0x80, 0x00]))).toBeGreaterThan(0);
    expect(crc32(new Uint8Array([0xff]))).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('normaliseZipPath', () => {
  it('uses forward slashes and no leading slash', () => {
    expect(normaliseZipPath('\\tiles\\0_0.glb')).toBe('tiles/0_0.glb');
    expect(normaliseZipPath('/tileset.json')).toBe('tileset.json');
  });

  it('refuses a path that climbs out of the archive', () => {
    expect(() => normaliseZipPath('../etc/passwd')).toThrow(/nepermis/);
    expect(() => normaliseZipPath('tiles/../../x')).toThrow(/nepermis/);
  });

  it('refuses an empty name', () => {
    expect(() => normaliseZipPath('/')).toThrow();
  });
});

describe('dosDateTime', () => {
  it('encodes the date the way MS-DOS does', () => {
    const { time, date } = dosDateTime(new Date(2026, 8, 17, 14, 30, 20));
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0xf).toBe(9);
    expect(date & 0x1f).toBe(17);
    expect(time >> 11).toBe(14);
    expect((time >> 5) & 0x3f).toBe(30);
    expect((time & 0x1f) * 2).toBe(20);   // two-second resolution
  });

  it('clamps a date before the 1980 epoch instead of writing a negative year', () => {
    expect((dosDateTime(new Date(1970, 0, 1)).date >> 9) + 1980).toBe(1980);
  });
});

describe('buildZip', () => {
  const entries: ZipEntry[] = [
    { path: 'tileset.json', data: text('{"asset":{"version":"1.1"}}') },
    { path: 'tiles/0_0.glb', data: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 1, 2, 3]) },
    { path: 'tiles/1_0.glb', data: new Uint8Array(100).fill(0xab) },
  ];

  it('round-trips every file, byte for byte', () => {
    const files = readZip(buildZip(entries));
    expect(files.map((f) => f.path)).toEqual(['tileset.json', 'tiles/0_0.glb', 'tiles/1_0.glb']);
    expect(decode(files[0].data)).toBe('{"asset":{"version":"1.1"}}');
    expect(Array.from(files[1].data)).toEqual([0x67, 0x6c, 0x54, 0x46, 0, 1, 2, 3]);
    expect(files[2].data.length).toBe(100);
    expect(files[2].data.every((b) => b === 0xab)).toBe(true);
  });

  it('writes a checksum an unzipper will verify against', () => {
    const files = readZip(buildZip(entries));
    for (let i = 0; i < files.length; i++) {
      expect(files[i].crc, files[i].path).toBe(crc32(entries[i].data));
    }
  });

  it('the local and central headers agree, or the archive is unreadable', () => {
    const zip = buildZip(entries);
    const view = new DataView(zip.buffer);
    for (const f of readZip(zip)) {
      const nameLen = view.getUint16(f.localAt + 26, true);
      expect(decode(zip.subarray(f.localAt + 30, f.localAt + 30 + nameLen))).toBe(f.path);
      expect(view.getUint32(f.localAt + 14, true)).toBe(f.crc);
    }
  });

  it('an archive with no files is still a valid archive', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it('keeps a zero-length file rather than dropping it', () => {
    const files = readZip(buildZip([{ path: 'empty.txt', data: new Uint8Array(0) }]));
    expect(files).toHaveLength(1);
    expect(files[0].data.length).toBe(0);
    expect(files[0].crc).toBe(0);
  });

  it('refuses two files at the same path — an unzipper would keep one at random', () => {
    expect(() => buildZip([
      { path: 'a.glb', data: text('1') },
      { path: '/a.glb', data: text('2') },
    ])).toThrow(/aceeași cale/);
  });

  it('survives a non-ASCII name, which is UTF-8 in the header', () => {
    const files = readZip(buildZip([{ path: 'Clădire/fațadă.glb', data: text('x') }]));
    expect(files[0].path).toBe('Clădire/fațadă.glb');
  });
});
