/**
 * calcAggregate.ts — grupează calculele pe capitol → etaj → articol de normă,
 * ÎNSUMÂND elementele de același tip (ca Lista F3), în loc de un calcul per element.
 *
 * Fiecare grup păstrează defalcarea pe elemente (pentru detaliu opțional), dar
 * afișează cantitatea TOTALĂ. Cifrele sunt identice cu F3 (aceeași sursă:
 * `computeTakeoffTraced`, sumă rotunjită la 2 zecimale ca `aggregateF3`).
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { getActiveCatalog, type NormArticle, type NormUnit } from '@/lib/norms';
import { computeTakeoffTraced } from './takeoffEngine';
import type { CalcTrace } from './calcTrace';

export interface CalcElement {
  nodeId: string;
  nodeName: string;
  elementTypeId: string;
  quantity: number;
  trace: CalcTrace;
}

export interface ArticleGroup {
  normId: string;
  article: NormArticle;
  unit: NormUnit;
  storeyId: string;
  storeyName: string;
  total: number;
  elements: CalcElement[];
}

export interface StoreyGroup {
  storeyId: string;
  storeyName: string;
  articles: ArticleGroup[];
}

export interface CapitolGroup {
  capitol: string;
  storeys: StoreyGroup[];
  /** Număr total de articole (grupuri) din capitol. */
  articleCount: number;
}

const R = (n: number) => Math.round(n * 100) / 100;

export function aggregateCalcGroups(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
): CapitolGroup[] {
  const catalog = getActiveCatalog();
  const traced = computeTakeoffTraced(nodes, edges);

  // capitol -> storeyId -> normId -> ArticleGroup
  const byCapitol = new Map<string, Map<string, Map<string, ArticleGroup>>>();

  for (const line of traced) {
    const article = catalog.map.get(line.normId);
    if (!article) continue;

    let storeys = byCapitol.get(article.capitol);
    if (!storeys) { storeys = new Map(); byCapitol.set(article.capitol, storeys); }

    let articles = storeys.get(line.storeyId);
    if (!articles) { articles = new Map(); storeys.set(line.storeyId, articles); }

    let ag = articles.get(line.normId);
    if (!ag) {
      ag = {
        normId: line.normId,
        article,
        unit: line.unit,
        storeyId: line.storeyId,
        storeyName: line.storeyName,
        total: 0,
        elements: [],
      };
      articles.set(line.normId, ag);
    }
    ag.total = R(ag.total + line.quantity);
    ag.elements.push({
      nodeId: line.nodeId,
      nodeName: line.nodeName,
      elementTypeId: line.elementTypeId,
      quantity: line.quantity,
      trace: line.trace,
    });
  }

  return [...byCapitol.entries()]
    .map(([capitol, storeys]) => {
      const storeyGroups: StoreyGroup[] = [...storeys.entries()]
        .map(([storeyId, articles]) => {
          const list = [...articles.values()].sort((a, b) => a.article.symbol.localeCompare(b.article.symbol, 'ro'));
          return { storeyId, storeyName: list[0]?.storeyName ?? storeyId, articles: list };
        })
        .sort((a, b) => a.storeyName.localeCompare(b.storeyName, 'ro'));
      const articleCount = storeyGroups.reduce((n, s) => n + s.articles.length, 0);
      return { capitol, storeys: storeyGroups, articleCount };
    })
    .sort((a, b) => a.capitol.localeCompare(b.capitol, 'ro'));
}
