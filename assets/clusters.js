/* Deterministic weighted communities; seed links never define a group. */
(function(root) {
  const stop = new Set('a an the and or of in on for to with by from at as is are was were be this that these those using use used study studies analysis approach based new results effect effects research paper unknown untitled'.split(' '));
  function terms(p) {
    const words = String(p.title || '').toLowerCase().match(/[\p{L}][\p{L}-]{2,}/gu) || [];
    const result = new Set(words.filter(w => !stop.has(w)));
    for(let i=1;i<words.length;i++) if(!stop.has(words[i-1]) && !stop.has(words[i])) result.add(words[i-1]+' '+words[i]);
    return result;
  }
  function detect(papers, edges, seedId) {
    const nodes=papers.filter(p=>p.id!==seedId).slice().sort((a,b)=>a.id.localeCompare(b.id));
    const index=new Map(nodes.map((p,i)=>[p.id,i])), adj=nodes.map(()=>new Map()), refs=new Map();
    const add=(a,b,w)=>{if(a===b)return;adj[a].set(b,(adj[a].get(b)||0)+w);adj[b].set(a,(adj[b].get(a)||0)+w);};
    const seen=new Set();
    for(const e of edges) if(index.has(e.s)&&index.has(e.t)) {const a=index.get(e.s),b=index.get(e.t),key=[Math.min(a,b),Math.max(a,b)].join(':');if(!seen.has(key)){seen.add(key);add(a,b,1);}}
    nodes.forEach((p,i)=>{for(const ref of new Set(p.refs||[])) if(ref!==seedId){if(!refs.has(ref))refs.set(ref,[]);refs.get(ref).push(i);}});
    // Bound pair generation and exclude ubiquitous references.
    for(const list of refs.values()) if(list.length>=2 && list.length<=Math.min(80,Math.max(12,nodes.length*.25))) {
      const weight=1/(list.length-1);
      for(let a=0;a<list.length;a++)for(let b=a+1;b<list.length;b++)add(list[a],list[b],weight);
    }
    const degree=adj.map(m=>[...m.values()].reduce((a,b)=>a+b,0)), total=degree.reduce((a,b)=>a+b,0);
    if(!total)return [];
    const group=nodes.map((_,i)=>i), volume=degree.slice();
    for(let round=0;round<12;round++) {
      let moved=0;
      for(let i=0;i<nodes.length;i++) {
        if(!degree[i])continue;
        const old=group[i], weights=new Map();
        for(const [j,w] of adj[i])weights.set(group[j],(weights.get(group[j])||0)+w);
        volume[old]-=degree[i];
        const score=g=>(weights.get(g)||0)-degree[i]*volume[g]/total;
        let best=old, gain=score(old);
        for(const g of [...weights.keys()].sort((a,b)=>a-b)) {const next=score(g);if(next>gain+1e-9){best=g;gain=next;}}
        group[i]=best;volume[best]+=degree[i];if(best!==old)moved++;
      }
      if(!moved)break;
    }
    const docs=nodes.map(terms), frequency=new Map(), buckets=new Map();
    docs.forEach(set=>set.forEach(t=>frequency.set(t,(frequency.get(t)||0)+1)));
    group.forEach((g,i)=>{if(!buckets.has(g))buckets.set(g,[]);buckets.get(g).push(i);});
    return [...buckets.values()].filter(ids=>ids.length>=4).sort((a,b)=>b.length-a.length||a[0]-b[0]).slice(0,12).map((ids,k)=>{
      const counts=new Map(), authors=new Map();
      for(const i of ids){docs[i].forEach(t=>counts.set(t,(counts.get(t)||0)+1));for(const name of new Set(String(nodes[i].searchAuthors||nodes[i].authors||'').split(',').map(s=>s.trim()).filter(s=>s&&!/et al|Unknown/i.test(s))))authors.set(name,(authors.get(name)||0)+1);}
      const ranked=[...counts].filter(([t,n])=>n>=2 && (frequency.get(t)||0)<nodes.length*.8).map(([t,n])=>({t,score:n*Math.log(1+nodes.length/(frequency.get(t)||1))*(t.includes(' ')?1.6:1)})).sort((a,b)=>b.score-a.score||a.t.localeCompare(b.t));
      const phrases=[];for(const {t} of ranked)if(!phrases.some(p=>p.includes(t)||t.includes(p))){phrases.push(t);if(phrases.length===3)break;}
      return {id:ids.map(i=>nodes[i].id).sort()[0],ids:ids.map(i=>nodes[i].id),label:phrases[0]||'Connected group '+(k+1),phrases,authors:[...authors].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([name])=>name)};
    });
  }
  if(typeof module!=='undefined')module.exports={detect}; else root.CitationClusters={detect};
})(typeof window!=='undefined'?window:globalThis);
