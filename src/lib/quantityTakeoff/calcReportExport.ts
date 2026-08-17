/**
 * calcReportExport.ts — Export al memoriului de calcul al cantităților ca raport
 * HTML self-contained (fără resurse externe): antet, grupare capitol → etaj →
 * articol, fișe CalcPad (formulă → substituit → rezultat) + mini-graf de calcul SVG.
 *
 * Cifrele provin din `computeTakeoffTraced` (identice cu F3).
 */
import type { BubbleGraphNode, BubbleGraphEdge } from '@/store';
import { getActiveCatalog } from '@/lib/norms';
import { unitLabel, type CalcTrace } from './calcTrace';
import { buildCalc2DModel } from './calc2DModel';
import { aggregateCalcGroups } from './calcAggregate';
import { exportPrices, CURRENCY } from '@/store/priceStore';

function esc(s: string | number): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

const NUM = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Mini-graf de calcul SVG inline: intrări → operație → rezultat. */
function calcGraphSvg(trace: CalcTrace, articleSymbol: string): string {
  const u = unitLabel(trace.unit);
  const inputs = trace.inputs;
  const rowH = 46;
  const boxW = 150;
  const height = Math.max(rowH * inputs.length + 10, 80);
  const midY = height / 2;
  const colIn = 4, colOp = 190, colRes = 400;

  const box = (x: number, y: number, w: number, lines: string[], fill: string, stroke: string) => {
    const h = 34;
    const texts = lines
      .map((ln, i) => `<text x="${x + w / 2}" y="${y + 13 + i * 12}" text-anchor="middle" font-size="${i === 0 ? 11 : 9}" font-family="monospace" fill="${i === 0 ? '#0f172a' : '#64748b'}">${esc(ln)}</text>`)
      .join('');
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}"/>${texts}`;
  };

  let svg = `<svg width="560" height="${height}" viewBox="0 0 560 ${height}" xmlns="http://www.w3.org/2000/svg">`;
  // muchii
  inputs.forEach((_, i) => {
    const y = i * rowH + 22;
    svg += `<line x1="${colIn + boxW}" y1="${y}" x2="${colOp}" y2="${midY}" stroke="#cbd5e1"/>`;
  });
  svg += `<line x1="${colOp + boxW + 20}" y1="${midY}" x2="${colRes}" y2="${midY}" stroke="#94a3b8"/>`;
  // noduri intrare
  inputs.forEach((inp, i) => {
    const y = i * rowH + 5;
    svg += box(colIn, y, boxW, [inp.symbol, `${NUM(inp.value)} ${inp.unit}`], '#f8fafc', '#cbd5e1');
  });
  // operație
  svg += box(colOp, midY - 17, boxW + 20, [trace.symbolic.replace(/^Q = /, ''), trace.substituted.replace(/^Q = /, '')], '#eff6ff', '#93c5fd');
  // rezultat
  svg += box(colRes, midY - 17, boxW, [articleSymbol, `${NUM(trace.result)} ${u}`], '#eef2ff', '#818cf8');
  svg += `</svg>`;
  return svg;
}

// Context = albastru, focus = roșu.
const C_FOCUS = '#dc2626', C_FOCUS_DARK = '#991b1b', C_CTX = '#60a5fa', C_CTX_LIGHT = '#bfdbfe';

/** Plan 2D SVG inline: tot planul (albastru) cu elementele din calcul evidențiate (roșu). */
function calc2DSvg(nodes: BubbleGraphNode[], edges: BubbleGraphEdge[], nodeIds: string[]): string {
  const m = buildCalc2DModel(nodes, edges, nodeIds, { fullContext: true });
  if (!m) return '';
  const X = (x: number) => (x - m.minX).toFixed(0);
  const Y = (y: number) => (m.maxY - y).toFixed(0);
  const gStroke = m.span * 0.004;
  const nodeR = m.span * 0.014;
  const parts: string[] = [];
  // Context întâi, focus deasupra.
  const walls = [...m.walls].sort((a, b) => Number(a.focus) - Number(b.focus));
  const cols = [...m.cols].sort((a, b) => Number(a.focus) - Number(b.focus));
  const gnodes = [...m.graphNodes].sort((a, b) => Number(a.focus) - Number(b.focus));
  for (const wl of walls) {
    parts.push(`<line x1="${X(wl.a.x)}" y1="${Y(wl.a.y)}" x2="${X(wl.b.x)}" y2="${Y(wl.b.y)}" stroke="${wl.focus ? C_FOCUS : C_CTX}" stroke-width="${Math.max(wl.thick, m.span * 0.008).toFixed(0)}" stroke-linecap="round" opacity="${wl.focus ? 1 : 0.55}"/>`);
  }
  for (const c of cols) {
    parts.push(`<rect x="${(c.c.x - m.minX - c.w / 2).toFixed(0)}" y="${(m.maxY - c.c.y - c.d / 2).toFixed(0)}" width="${c.w.toFixed(0)}" height="${c.d.toFixed(0)}" fill="${c.focus ? C_FOCUS : C_CTX}" stroke="${c.focus ? C_FOCUS_DARK : C_CTX}" stroke-width="${(m.span * 0.003).toFixed(0)}" opacity="${c.focus ? 1 : 0.55}"/>`);
  }
  for (const e of m.graphEdges) {
    parts.push(`<line x1="${X(e.a.x)}" y1="${Y(e.a.y)}" x2="${X(e.b.x)}" y2="${Y(e.b.y)}" stroke="#6366f1" stroke-width="${gStroke.toFixed(0)}" stroke-dasharray="${(gStroke * 2).toFixed(0)} ${(gStroke * 2).toFixed(0)}" opacity="0.4"/>`);
  }
  for (const g of gnodes) {
    parts.push(`<circle cx="${X(g.p.x)}" cy="${Y(g.p.y)}" r="${(g.focus ? nodeR * 1.15 : nodeR).toFixed(0)}" fill="${g.focus ? C_FOCUS : C_CTX_LIGHT}" stroke="#fff" stroke-width="${(nodeR * 0.25).toFixed(0)}"/>`);
  }
  for (const mk of m.markers) {
    parts.push(`<circle cx="${X(mk.p.x)}" cy="${Y(mk.p.y)}" r="${(nodeR * 0.9).toFixed(0)}" fill="${mk.focus ? C_FOCUS : C_CTX_LIGHT}" stroke="#fff" stroke-width="${(nodeR * 0.2).toFixed(0)}"/>`);
  }
  return `<svg width="100%" height="220" viewBox="0 0 ${m.w.toFixed(0)} ${m.h.toFixed(0)}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="background:#f8fafc;border-radius:6px">${parts.join('')}</svg>`;
}

export interface CalcReportMeta {
  projectName: string;
  exportedAt: string;
  catalogVersion: string;
}

const MONEY = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Construiește raportul HTML self-contained. */
export function buildCalcReportHtml(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  meta: CalcReportMeta,
  prices: Record<string, number> = {},
): string {
  const capitole = aggregateCalcGroups(nodes, edges);
  let grandTotal = 0;

  const blocks: string[] = [];
  for (const cap of capitole) {
    let capTotal = 0;
    const capBlocks: string[] = [];
    for (const sg of cap.storeys) {
      capBlocks.push(`<h3>${esc(sg.storeyName)}</h3>`);
      for (const ag of sg.articles) {
        const u = unitLabel(ag.unit);
        const n = ag.elements.length;
        const nodeIds = ag.elements.map((e) => e.nodeId);
        const unitPrice = prices[ag.normId] ?? 0;
        const totalPrice = ag.total * unitPrice;
        capTotal += totalPrice;
        // Reprezentativ pentru graful de calcul (formula e aceeași pe elementele grupului).
        const rep = ag.elements[0]?.trace;
        const sumExpr = ag.elements.map((e) => NUM(e.quantity)).join(' + ');
        const rows = ag.elements
          .map((e) => `<tr><td>${esc(e.nodeName)}</td><td class="muted">${esc(e.elementTypeId)}</td><td class="val">${NUM(e.quantity)} ${esc(u)}</td></tr>`)
          .join('');
        capBlocks.push(`
          <div class="calc">
            <div class="calc-head">
              <span class="sym">${esc(ag.article.symbol)}</span> ${esc(ag.article.denumire)}
              <span class="node">${n} ${n === 1 ? 'element' : 'elements'}</span>
            </div>
            <div class="formula muted">Q = Σ Qᵢ (n = ${n})</div>
            ${n > 1 ? `<div class="formula">Q = ${esc(sumExpr)}</div>` : ''}
            <div class="result">Q = ${NUM(ag.total)} ${esc(u)}</div>
            <table class="price"><tbody>
              <tr><td>Unit price</td><td class="val">${MONEY(unitPrice)} ${CURRENCY}/${esc(u)}</td></tr>
              <tr class="ptotal"><td>Total price = ${NUM(ag.total)} × ${MONEY(unitPrice)}</td><td class="val">${MONEY(totalPrice)} ${CURRENCY}</td></tr>
            </tbody></table>
            <table class="inputs breakdown"><thead><tr><th>Element</th><th>Type</th><th class="val">Quantity</th></tr></thead><tbody>${rows}</tbody></table>
            <div class="twocol">
              <div class="plan"><div class="cap">2D plan + graph (all elements)</div>${calc2DSvg(nodes, edges, nodeIds)}</div>
              ${rep ? `<div class="graph"><div class="cap">Calc graph (per element)</div>${calcGraphSvg(rep, ag.article.symbol)}</div>` : ''}
            </div>
          </div>`);
      }
    }
    grandTotal += capTotal;
    blocks.push(`<h2>${esc(cap.capitol)} <span class="captotal">${MONEY(capTotal)} ${CURRENCY}</span></h2>`);
    blocks.push(...capBlocks);
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calculation memo — ${esc(meta.projectName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; color: #0f172a; max-width: 820px; margin: 24px auto; padding: 0 16px; }
  header { border-bottom: 2px solid #1d4ed8; padding-bottom: 8px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; }
  .meta { font-size: 12px; color: #64748b; margin-top: 4px; }
  h2 { font-size: 16px; margin: 24px 0 6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .4px; color: #64748b; margin: 12px 0 6px; }
  .calc { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; background: #fff; page-break-inside: avoid; }
  .calc-head { font-size: 13px; margin-bottom: 6px; }
  .calc-head .sym { font-family: monospace; font-weight: 700; color: #1d4ed8; }
  .calc-head .node { float: right; font-size: 11px; color: #64748b; font-family: monospace; }
  .formula { font-family: ui-monospace, monospace; line-height: 1.7; }
  .muted { color: #64748b; }
  .result { font-family: ui-monospace, monospace; font-weight: 700; font-size: 14px; margin-top: 2px; }
  .grand { margin-top: 6px; font-size: 16px; font-weight: 800; color: #1d4ed8; }
  h2 .captotal { float: right; font-size: 13px; color: #1d4ed8; font-weight: 700; }
  table.price { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 12px; }
  table.price td { padding: 2px 0; }
  table.price td.val { text-align: right; font-variant-numeric: tabular-nums; }
  table.price tr.ptotal td { font-weight: 700; color: #1d4ed8; border-top: 1px solid #e2e8f0; padding-top: 4px; }
  table.inputs { margin-top: 8px; border-collapse: collapse; font-size: 11px; color: #64748b; }
  table.inputs td { padding: 1px 8px 1px 0; }
  table.inputs td.sym { font-family: monospace; }
  table.inputs td.val, table.inputs th.val { text-align: right; font-variant-numeric: tabular-nums; }
  table.breakdown { width: 100%; margin-top: 8px; }
  table.breakdown th { text-align: left; color: #94a3b8; font-weight: 600; font-size: 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 2px; }
  .twocol { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
  .twocol > div { flex: 1 1 260px; min-width: 240px; overflow-x: auto; }
  .cap { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: #94a3b8; margin-bottom: 3px; }
  .graph { overflow-x: auto; }
  .source { margin-top: 6px; font-size: 10px; color: #94a3b8; font-style: italic; }
  @media print { body { margin: 0; } .calc { border-color: #cbd5e1; } }
</style></head>
<body>
  <header>
    <h1>Quantity calculation memo</h1>
    <div class="meta">Project: ${esc(meta.projectName)} · Export: ${esc(meta.exportedAt)} · Catalog: ${esc(meta.catalogVersion)} · ${capitole.reduce((n, c) => n + c.articleCount, 0)} articles</div>
    <div class="grand">Grand total: ${MONEY(grandTotal)} ${CURRENCY}</div>
  </header>
  ${blocks.join('\n')}
</body></html>`;
}

/** Declanșează download-ul raportului HTML. */
export function downloadCalcReportHtml(
  nodes: BubbleGraphNode[],
  edges: BubbleGraphEdge[],
  projectName: string,
): void {
  const meta: CalcReportMeta = {
    projectName,
    exportedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    catalogVersion: getActiveCatalog().version,
  };
  const html = buildCalcReportHtml(nodes, edges, meta, exportPrices().prices);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName || 'proiect'}_memoriu_calcul.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
