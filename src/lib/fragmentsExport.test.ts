import { describe, expect, it, vi } from 'vitest';
import type { FragmentsModel } from '@thatopen/fragments';
import { exportFragmentsModel, formatBytes, fragFileName, fragmentsBytes, toFragBytes } from './fragmentsExport';

/** Just enough of a FragmentsModel to answer `getBuffer`. */
const fakeModel = (buffer: unknown, spy?: (raw: boolean) => void) => ({
  getBuffer: async (raw = false) => { spy?.(raw); return buffer; },
} as unknown as FragmentsModel);

describe('fragFileName', () => {
  it('replaces the .ifc extension rather than appending to it', () => {
    expect(fragFileName('Cladire.ifc')).toBe('Cladire.frag');
    expect(fragFileName('Cladire.IFC')).toBe('Cladire.frag');
    expect(fragFileName('model.ifczip')).toBe('model.frag');
  });

  it('keeps a name that never had one', () => {
    expect(fragFileName('Structura')).toBe('Structura.frag');
  });

  it('survives what a real file name contains', () => {
    expect(fragFileName('Casă Popescu — rev 2.ifc')).toBe('Casa-Popescu-rev-2.frag');
    // The viewer suffixes a repeated load; dots inside the name stay.
    expect(fragFileName('plan (2).ifc')).toBe('plan-2.frag');
  });

  it('never produces a bare extension', () => {
    expect(fragFileName('')).toBe('model.frag');
    expect(fragFileName('.ifc')).toBe('model.frag');
    expect(fragFileName('!!!')).toBe('model.frag');
  });
});

describe('toFragBytes', () => {
  it('takes an ArrayBuffer, which is what the worker returns', () => {
    const src = new Uint8Array([1, 2, 3]);
    expect(toFragBytes(src.buffer)).toEqual(src);
  });

  it('takes a typed array unchanged', () => {
    const src = new Uint8Array([9, 8]);
    expect(toFragBytes(src)).toBe(src);
  });

  it('respects a view\'s offset instead of copying the whole backing buffer', () => {
    const big = new Uint8Array([0, 0, 7, 7, 0]);
    const view = new Uint8Array(big.buffer, 2, 2);
    expect(Array.from(toFragBytes(view))).toEqual([7, 7]);
  });

  it('names the problem rather than writing an empty file', () => {
    expect(() => toFragBytes(null)).toThrow(/unexpected type/);
    expect(() => toFragBytes('frag')).toThrow(/unexpected type/);
  });
});

describe('fragmentsBytes', () => {
  it('asks for the compressed buffer by default — that is what a .frag file is', async () => {
    const seen: boolean[] = [];
    await fragmentsBytes(fakeModel(new Uint8Array([1]).buffer, (raw) => seen.push(raw)));
    expect(seen).toEqual([false]);
  });

  it('can be asked for the raw FlatBuffer', async () => {
    const seen: boolean[] = [];
    await fragmentsBytes(fakeModel(new Uint8Array([1]).buffer, (raw) => seen.push(raw)), true);
    expect(seen).toEqual([true]);
  });

  it('refuses an empty buffer — a 0-byte .frag would only fail later, elsewhere', async () => {
    await expect(fragmentsBytes(fakeModel(new ArrayBuffer(0)))).rejects.toThrow(/empty buffer/);
  });
});

describe('exportFragmentsModel', () => {
  it('hands the bytes to the browser and reports the size', async () => {
    const clicks: { name: string; size: number; type: string }[] = [];
    let lastBlob: Blob | null = null;
    const anchor: { href: string; download: string; click: () => void } = {
      href: '', download: '',
      click: () => clicks.push({ name: anchor.download, size: lastBlob!.size, type: lastBlob!.type }),
    };
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => { lastBlob = b; return 'blob:test'; },
      revokeObjectURL: () => {},
    });
    vi.stubGlobal('document', { createElement: () => anchor });

    const size = await exportFragmentsModel(fakeModel(new Uint8Array([1, 2, 3, 4]).buffer), 'Casa.frag');

    expect(size).toBe(4);
    expect(clicks).toEqual([{ name: 'Casa.frag', size: 4, type: 'application/octet-stream' }]);
    vi.unstubAllGlobals();
  });

  it('a failed export throws instead of downloading nothing', async () => {
    await expect(exportFragmentsModel(fakeModel(new ArrayBuffer(0)), 'x.frag')).rejects.toThrow();
  });
});

describe('formatBytes', () => {
  it('reads like a file size', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
