/**
 * Verificare NUMERICĂ a randării donut-ului (substitut pentru „look at it", fără browser):
 * etichetele nu ies din viewBox și nu se suprapun vertical.
 */
import { describe, it, expect } from 'vitest';
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { layoutDonut, DONUT_GEOM, type DonutInput } from './donutLayout';
import { costByCategory, topNWithOther } from './costByCategory';
import { preturiDefaultTotale } from '@/lib/norms';

function checkLayout(slices: DonutInput[]) {
  const { arcs, labels } = layoutDonut(slices);

  // Arcele acoperă exact cercul complet.
  const sweep = arcs.reduce((a, x) => a + (x.a1 - x.a0), 0);
  expect(sweep).toBeCloseTo(Math.PI * 2, 6);

  // Fără overflow orizontal sau vertical în viewBox.
  for (const l of labels) {
    expect(l.x0, `overflow stânga: "${l.text}" x0=${l.x0.toFixed(1)}`).toBeGreaterThanOrEqual(0);
    expect(l.x1, `overflow dreapta: "${l.text}" x1=${l.x1.toFixed(1)}`).toBeLessThanOrEqual(DONUT_GEOM.W);
    expect(l.y).toBeGreaterThanOrEqual(0);
    expect(l.y).toBeLessThanOrEqual(DONUT_GEOM.H);
  }

  // Fără coliziuni verticale pe aceeași parte.
  for (const anchor of ['start', 'end'] as const) {
    const side = labels.filter((l) => l.anchor === anchor).sort((a, b) => a.y - b.y);
    for (let i = 1; i < side.length; i++) {
      expect(
        side[i].y - side[i - 1].y,
        `coliziune: "${side[i - 1].text}" ↔ "${side[i].text}"`,
      ).toBeGreaterThanOrEqual(DONUT_GEOM.minGap - 1e-6);
    }
  }
  return labels;
}

describe('layoutDonut — geometrie fără overflow/coliziuni', () => {
  it('date reale (proiectul exemplu, top 3 + Alte)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const data = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'public/example-project.bbim'), 'utf-8'),
    ) as { model: { nodes: BubbleGraphNode[]; edges: BubbleGraphEdge[] } };
    const costs = costByCategory(data.model.nodes, data.model.edges, preturiDefaultTotale());
    const slices = topNWithOther(costs, 3);
    expect(slices.length).toBeLessThanOrEqual(4); // paleta validează maxim 4 all-pairs
    checkLayout(slices);
  });

  it('cazul degenerat: 4 felii egale (etichete la 4 puncte cardinale)', () => {
    checkLayout([
      { categorie: 'Zidarie', share: 0.25, total: 25 },
      { categorie: 'Invelitoare', share: 0.25, total: 25 },
      { categorie: 'Termoizolatie', share: 0.25, total: 25 },
      { categorie: 'Alte', share: 0.25, total: 25 },
    ]);
  });

  it('cazul greu: 3 felii minuscule alăturate + una dominantă → forțează de-coliziunea', () => {
    checkLayout([
      { categorie: 'Zidarie structurala', share: 0.94, total: 94 },
      { categorie: 'Tencuiala', share: 0.02, total: 2 },
      { categorie: 'Vopsitorii', share: 0.02, total: 2 },
      { categorie: 'Alte', share: 0.02, total: 2 },
    ]);
  });

  it('o singură felie', () => {
    checkLayout([{ categorie: 'Zidarie', share: 1, total: 100 }]);
  });
});
