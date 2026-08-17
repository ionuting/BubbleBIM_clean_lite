/**
 * Verifies self-contained HTML report generation from the calculation memo.
 */
import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { buildCalcReportHtml } from './calcReportExport';
import { aggregateCalcGroups } from './calcAggregate';

describe('buildCalcReportHtml', () => {
  it('produces self-contained HTML from the example project', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const bbimPath = path.resolve(process.cwd(), 'public/example-project.bbim');
    const data = JSON.parse(fs.readFileSync(bbimPath, 'utf-8')) as {
      model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] };
    };
    const html = buildCalcReportHtml(data.model.nodes, data.model.edges, {
      projectName: 'Test',
      exportedAt: '2026-07-14 12:00:00',
      catalogVersion: 'deviz-zidarie-confinata-1',
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Calculation memo');
    expect(html).toContain('class="calc"');
    // Contains inline SVG mini-graph, 2D plan with graph overlay, and a result.
    expect(html).toContain('<svg');
    expect(html).toContain('2D plan + graph');
    expect(html).toContain('Calc graph');
    expect(html).toMatch(/Q = \d+\.\d{2}/);
    // No external resources (self-contained) — SVG xmlns is allowed.
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:\/\//);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/url\(\s*https?:/);
  });

  it('includes price columns and grand total = Σ (qty × unit price)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const data = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'public/example-project.bbim'), 'utf-8'),
    ) as { model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } };
    const { nodes, edges } = data.model;

    // Price 100 for every article used.
    const groups = aggregateCalcGroups(nodes, edges);
    const prices: Record<string, number> = {};
    let expectedTotal = 0;
    for (const cap of groups)
      for (const s of cap.storeys)
        for (const ag of s.articles) {
          prices[ag.normId] = 100;
          expectedTotal += ag.total * 100;
        }

    const html = buildCalcReportHtml(
      nodes, edges,
      { projectName: 'Test', exportedAt: '2026-07-14', catalogVersion: 'deviz-zidarie-confinata-1' },
      prices,
    );

    expect(html).toContain('Unit price');
    expect(html).toContain('Total price');
    expect(html).toContain('Grand total');
    // Grand total formatted en-US must appear in the report.
    const formatted = expectedTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(html).toContain(formatted);
    expect(expectedTotal).toBeGreaterThan(0);
  });
});
