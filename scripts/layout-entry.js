import { forceSimulation, forceManyBody, forceLink, forceCollide, forceX, forceY } from 'd3-force';

// Independent forces, shared by the initial layout and interactive simulation.
export function configure(sim, { spacing = 1, bondStrength = 1, linkDistance = 145, centerForce = 1 }) {
  sim.force('charge').strength(-700 * spacing);
  sim.force('links').distance(linkDistance).strength(.09 * bondStrength);
  sim.force('x').strength(.02 * centerForce);
  sim.force('y').strength(.02 * centerForce);
  return sim;
}
export function createSimulation(input) {
  const {nodes,edges,width,height,anchored=false}=input;
  const cx=input.centerX ?? width/2,cy=input.centerY ?? height/2;
  const sim=forceSimulation(nodes).stop().alphaDecay(.035).velocityDecay(.38)
    .force('charge',forceManyBody().theta(.9))
    .force('links',forceLink(edges.map(e=>({source:e.s,target:e.t}))).id(n=>n.id))
    .force('collision',forceCollide(n=>(n.rad+12)*(n.localSpacing||1)).iterations(2))
    .force('x',forceX(n=>anchored ? n.anchorX ?? cx : cx))
    .force('y',forceY(n=>anchored ? n.anchorY ?? cy : cy));
  configure(sim,input);
  if(anchored) {sim.force('x').strength(.075);sim.force('y').strength(.075);}
  return sim;
}
export async function layout(input, cancelled = () => false, yieldToUI = true) {
  const {nodes,anchored=false}=input;
  const sim=createSimulation(input);
  const maxTicks = anchored ? 110 : 180;
  let quietTicks = 0;
  for (let i = 0; i < maxTicks;) {
    if (cancelled()) return null;
    const end = yieldToUI ? performance.now() + 6 : Infinity;
    do {
      sim.tick(); i++;
      if (i > 40 && nodes.every(n => n.fx != null || Math.hypot(n.vx,n.vy) < .08)) quietTicks++; else quietTicks=0;
      if (quietTicks >= 6) { i=maxTicks; break; }
    } while (i < maxTicks && performance.now() < end);
    // Yield even without workers: layout must never monopolize the UI thread.
    if (yieldToUI && i < maxTicks) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return nodes.map(({ id, x, y }) => ({ id, x, y }));
}
