import { forceSimulation, forceManyBody, forceLink, forceCollide, forceX, forceY } from 'd3-force';

// Shared by the worker and the time-sliced fallback. No DOM access here.
export async function layout({ nodes, edges, width, height, spacing = 1, anchored = false }, cancelled = () => false, yieldToUI = true) {
  const cx = width / 2, cy = height / 2;
  const sim = forceSimulation(nodes)
    .stop()
    .alphaDecay(0.035)
    .velocityDecay(0.35)
    .force('charge', forceManyBody().strength(-700 * spacing * spacing).theta(0.9))
    .force('links', forceLink(edges.map(e => ({ source: e.s, target: e.t })))
      .id(n => n.id).distance(e => e.source.role === 'seed' || e.target.role === 'seed' ? 185 * spacing : 145 * spacing).strength(0.09))
    .force('collision', forceCollide(n => (n.rad + 18 + Math.min(14, (n.labelWidth || 70) * .12)) * (n.localSpacing || spacing)).iterations(3))
    .force('x', forceX(n => n.anchorX ?? cx).strength(anchored ? .075 : .02))
    .force('y', forceY(n => n.anchorY ?? cy).strength(anchored ? .075 : .02));
  for (let i = 0; i < 200;) {
    if (cancelled()) return null;
    const end = yieldToUI ? performance.now() + 6 : Infinity;
    do { sim.tick(); i++; } while (i < 200 && performance.now() < end);
    // Yield even without workers: layout must never monopolize the UI thread.
    if (yieldToUI && i < 200) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return nodes.map(({ id, x, y }) => ({ id, x, y }));
}
