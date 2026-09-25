/**
 * Which side of the baseline a dimension line lands on.
 *
 * The bug this guards against is not a crash and not a wrong number — the
 * dimension reads the right length, it just sits on the opposite side of the
 * wall from where it was placed. That survives a screenshot, so it is worth a
 * test that states the round trip: measure an offset the way placement does,
 * render it the way the layer does, and land on the side that was clicked.
 */
import { describe, expect, it } from 'vitest';
import { offsetNormalSvg, type Pt2 } from './annotationGeometry';

/** What every drawing viewer here does: shift, scale and flip Y. */
const flipY = (scale = 1, height = 1000) => (x: number, y: number): Pt2 => ({
  x: x * scale,
  y: height - y * scale,
});

/** A transform that does NOT flip — the case that used to work by accident. */
const plain = (scale = 1) => (x: number, y: number): Pt2 => ({ x: x * scale, y: y * scale });

/** The offset a click at `pt` records, measured in logical space as placement does. */
function measure(p1: Pt2, p2: Pt2, pt: Pt2): number {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  return (pt.x - mx) * nx + (pt.y - my) * ny;
}

/** Where the dimension line's midpoint ends up, in SVG, for a given host. */
function renderedMid(
  p1: Pt2, p2: Pt2, pt: Pt2, toSvg: (x: number, y: number) => Pt2, scale: number,
): Pt2 {
  const offsetDir = measure(p1, p2, pt);
  const n = offsetNormalSvg(p1, p2, toSvg)!;
  const s1 = toSvg(p1.x, p1.y), s2 = toSvg(p2.x, p2.y);
  const off = offsetDir * scale;         // svgPerLog, as the layer computes it
  return {
    x: (s1.x + s2.x) / 2 + n.x * off,
    y: (s1.y + s2.y) / 2 + n.y * off,
  };
}

describe('offsetNormalSvg', () => {
  it('is a unit vector perpendicular to the baseline on screen', () => {
    const n = offsetNormalSvg({ x: 0, y: 0 }, { x: 0, y: 10 }, flipY())!;
    expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 9);
    expect(n.x * 0 + n.y * -10).toBeCloseTo(0, 9);   // ⟂ to the baseline's SVG direction
  });

  it('points the opposite way to a normal rebuilt from the flipped endpoints', () => {
    // This IS the bug: the renderer used to take perp(s2 − s1) in SVG space.
    const p1 = { x: 0, y: 0 }, p2 = { x: 0, y: 10 };
    const toSvg = flipY();
    const s1 = toSvg(p1.x, p1.y), s2 = toSvg(p2.x, p2.y);
    const len = Math.hypot(s2.x - s1.x, s2.y - s1.y);
    const naive = { x: -(s2.y - s1.y) / len, y: (s2.x - s1.x) / len };
    const good = offsetNormalSvg(p1, p2, toSvg)!;
    expect(good.x).toBeCloseTo(-naive.x, 9);
    expect(good.y).toBeCloseTo(-naive.y, 9);
  });

  it('puts the dimension on the side that was clicked — a vertical baseline', () => {
    const p1 = { x: 1000, y: 0 }, p2 = { x: 1000, y: 10_000 };
    const toSvg = flipY(0.08, 1000);
    // Clicked to the LEFT of the wall, in model coordinates.
    const mid = renderedMid(p1, p2, { x: 200, y: 5000 }, toSvg, 0.08);
    expect(mid.x).toBeLessThan(toSvg(1000, 5000).x);
  });

  it('puts it on the right when the click is on the right', () => {
    const p1 = { x: 1000, y: 0 }, p2 = { x: 1000, y: 10_000 };
    const toSvg = flipY(0.08, 1000);
    const mid = renderedMid(p1, p2, { x: 2600, y: 5000 }, toSvg, 0.08);
    expect(mid.x).toBeGreaterThan(toSvg(1000, 5000).x);
  });

  it('puts it ABOVE on screen when the click is above in the model', () => {
    // The flip's own axis — the one a mirrored normal gets wrong most visibly.
    const p1 = { x: 0, y: 2000 }, p2 = { x: 8000, y: 2000 };
    const toSvg = flipY(0.08, 1000);
    const mid = renderedMid(p1, p2, { x: 4000, y: 3500 }, toSvg, 0.08);
    // Higher in the model ⇒ SMALLER SVG y.
    expect(mid.y).toBeLessThan(toSvg(4000, 2000).y);
  });

  it('lands the line through the clicked point, not merely on its side', () => {
    const p1 = { x: 0, y: 0 }, p2 = { x: 0, y: 10_000 };
    const toSvg = flipY(0.5, 5000);
    const click = { x: -1800, y: 5000 };
    const mid = renderedMid(p1, p2, click, toSvg, 0.5);
    const want = toSvg(click.x, click.y);
    expect(mid.x).toBeCloseTo(want.x, 6);
    expect(mid.y).toBeCloseTo(want.y, 6);
  });

  it('still works for a host that does not flip', () => {
    const p1 = { x: 0, y: 0 }, p2 = { x: 0, y: 10 };
    const n = offsetNormalSvg(p1, p2, plain(2))!;
    // No flip: the mapped logical normal keeps its own direction.
    expect(n.x).toBeCloseTo(-1, 9);
    expect(n.y).toBeCloseTo(0, 9);
  });

  it('survives a rotated transform, where perp-of-projection has no hope', () => {
    const rot = (x: number, y: number): Pt2 => ({
      x: x * Math.cos(0.7) - y * Math.sin(0.7),
      y: x * Math.sin(0.7) + y * Math.cos(0.7),
    });
    const n = offsetNormalSvg({ x: 0, y: 0 }, { x: 0, y: 10 }, rot)!;
    expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 9);
    // The logical normal (−1, 0) carried through the same rotation.
    expect(n.x).toBeCloseTo(-Math.cos(0.7), 9);
    expect(n.y).toBeCloseTo(-Math.sin(0.7), 9);
  });

  it('declines a degenerate baseline instead of emitting NaN', () => {
    expect(offsetNormalSvg({ x: 5, y: 5 }, { x: 5, y: 5 }, flipY())).toBeNull();
  });

  it('declines a transform that collapses the drawing to a point', () => {
    expect(offsetNormalSvg({ x: 0, y: 0 }, { x: 0, y: 10 }, () => ({ x: 0, y: 0 }))).toBeNull();
  });
});
