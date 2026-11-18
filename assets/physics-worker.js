/* Interactive simulation lives off the UI thread and sleeps when settled. */
importScripts('layout.js?v=performance-43');
let sim=null,nodes=[],timer=null,ticks=0,revision=0;
function wake() {
  ticks=0; sim.alpha(Math.max(sim.alpha(),.3));
  if(timer==null) timer=setTimeout(step,0);
}
function step() {
  timer=null;if(!sim)return;
  const start=performance.now();
  do {sim.tick();ticks++;} while(ticks%2 && performance.now()-start<5);
  const done=sim.alpha()<.004 || ticks>=180;
  self.postMessage({revision,done,positions:nodes.map(({id,x,y})=>({id,x,y}))});
  if(!done) timer=setTimeout(step,Math.max(0,16-(performance.now()-start)));
}
self.onmessage=({data})=>{
  try {
    revision=data.revision;
    if(data.type==='init') {clearTimeout(timer);timer=null;nodes=data.input.nodes;sim=CitationLayout.createSimulation(data.input);sim.alpha(.3);wake();}
    else if(data.type==='settings'&&sim) {CitationLayout.configure(sim,data.settings);wake();}
    else if(data.type==='pin'&&sim) {const n=nodes.find(n=>n.id===data.id);if(n){n.fx=n.x=data.x;n.fy=n.y=data.y;n.vx=n.vy=0;}wake();}
    else if(data.type==='release'&&sim) {const n=nodes.find(n=>n.id===data.id);if(n){n.x=data.x;n.y=data.y;n.fx=n.fy=null;n.vx=n.vy=0;}wake();}
  }catch(error){self.postMessage({revision,error:error.message});}
};
