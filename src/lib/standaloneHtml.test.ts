/**
 * What has to hold for a file that opens anywhere.
 *
 * The property that matters is self-containment: nothing in the page may
 * reach outside it. After that, the payload has to survive the trip — a
 * `</script>` inside a room's note must not end the data block early — and
 * the data the viewer gets must be what the graph said.
 */
import { describe, expect, it } from 'vitest';
import type { BubbleGraphNode } from '@/store';
import {
  assembleStandaloneHtml, bytesToBase64, elementInfo, jsonForScript, scriptForInline, storeyInfo,
} from './standaloneHtml';
import type { StandaloneData } from './standaloneTypes';

const node = (id: string, type: string, parentId: string | null, properties: Record<string, unknown> = {}, name = id): BubbleGraphNode =>
  ({ id, type, name, x: 0, y: 0, z: 0, parentId, properties } as BubbleGraphNode);

const nodes: BubbleGraphNode[] = [
  node('s2', 'storey', null, { bottomElevation: 3000, topElevation: 6000 }, 'Etaj 1'),
  node('s1', 'storey', null, { bottomElevation: 0, topElevation: 3000 }, 'Parter'),
  node('A', 'ax', 's1', { gridX: 0, gridY: 0 }),
  node('w1', 'wall', 's1', { wall_type: 'W25', height: 3000, _cache: 'no', note: 'x'.repeat(400), plan: { a: 1 }, tags: [1, 2] }, 'Perete sud'),
  node('win1', 'window', 'w1', { width: 1200, glazed: true }, 'F1'),
  node('sec', 'section', null, { plan_cut: { x1: 0, y1: 0, x2: 1, y2: 1 } }, 'A-A'),
];

const data: StandaloneData = {
  projectName: 'Casa <Popescu> & fii',
  exportedAt: '2026-09-21T10:00:00.000Z',
  generator: 'BubbleBIM',
  storeys: storeyInfo(nodes),
  elements: { ...elementInfo(nodes), evil: { name: 'note', type: 'wall', props: { text: '</script><img src=x>' } } },
  drawings: [{ id: 'd', title: 'Fațada nord', kind: 'elevation', svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }],
};

/** The text of the `<script id=…>` tag. */
function tagText(html: string, id: string): string | null {
  const m = html.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  return m ? m[1] : null;
}

describe('storeyInfo / elementInfo', () => {
  it('lists storeys by elevation', () => {
    expect(storeyInfo(nodes).map((s) => s.name)).toEqual(['Parter', 'Etaj 1']);
    expect(storeyInfo(nodes)[1]).toEqual({ id: 's2', name: 'Etaj 1', bottomMm: 3000, topMm: 6000 });
  });

  it('keeps building elements with primitive properties, resolved to their storey', () => {
    const els = elementInfo(nodes);
    expect(Object.keys(els).sort()).toEqual(['w1', 'win1']);   // no storey, ax, section
    expect(els.w1.storeyId).toBe('s1');
    expect(els.win1.storeyId).toBe('s1');                       // through the wall
    expect(els.w1.props.wall_type).toBe('W25');
    expect(els.w1.props.height).toBe(3000);
    expect(els.win1.props.glazed).toBe(true);
    expect(els.w1.props).not.toHaveProperty('_cache');
    expect(els.w1.props).not.toHaveProperty('plan');
    expect(els.w1.props).not.toHaveProperty('tags');
    expect(String(els.w1.props.note).length).toBeLessThan(400);
    expect(String(els.w1.props.note).endsWith('…')).toBe(true);
  });
});

describe('jsonForScript', () => {
  it('cannot close the tag it sits in, and parses back to the same value', () => {
    const v = { s: '</script><b>', n: 1 };
    const text = jsonForScript(v);
    expect(text).not.toContain('</script');
    expect(JSON.parse(text)).toEqual(v);
  });
});

describe('scriptForInline', () => {
  it('escapes a closing tag inside a string literal and leaves code alone', () => {
    const js = 'var a = "</script>"; var b = 1 < 2;';
    const out = scriptForInline(js);
    expect(out).not.toContain('</script');
    expect(new Function(out)).toBeTypeOf('function');
  });
});

describe('assembleStandaloneHtml', () => {
  const viewerJs = 'var BubbleBIMViewer = { boot: function () { var x = "</script>"; } };';
  const html = assembleStandaloneHtml({ data, viewerJs, glbBase64: 'AAECAw==', projectJson: JSON.stringify({ model: { note: '</script>' } }) });

  it('references nothing outside the file', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/\bimport\s*\(/);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toContain('cdn.');
  });

  it('balances its script tags — no payload closes one early', () => {
    const opens = (html.match(/<script[\s>]/g) ?? []).length;
    const closes = (html.match(/<\/script>/g) ?? []).length;
    expect(opens).toBe(5);
    expect(closes).toBe(5);
  });

  it('carries the data, the model and the project back out intact', () => {
    expect(JSON.parse(tagText(html, 'bbim-data')!)).toEqual(data);
    expect(tagText(html, 'bbim-glb')).toBe('AAECAw==');
    expect(JSON.parse(tagText(html, 'bbim-project')!)).toEqual({ model: { note: '</script>' } });
  });

  it('escapes the title and boots the viewer last', () => {
    expect(html).toContain('<title>Casa &lt;Popescu&gt; &amp; fii — BubbleBIM</title>');
    expect(html.lastIndexOf('BubbleBIMViewer.boot()')).toBeGreaterThan(html.lastIndexOf(viewerJs.slice(0, 20)));
  });

  it('leaves the project tag out when there is no project', () => {
    const bare = assembleStandaloneHtml({ data, viewerJs, glbBase64: 'AA==' });
    expect(tagText(bare, 'bbim-project')).toBeNull();
    expect(tagText(bare, 'bbim-data')).not.toBeNull();
  });
});

describe('bytesToBase64', () => {
  it('matches Buffer across the chunk boundary', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(bytesToBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
