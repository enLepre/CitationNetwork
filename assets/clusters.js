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
    const minimum = Math.max(4, Math.min(20, Math.ceil(Math.sqrt(nodes.length) * .65)));
    const countTerms = ids => {
      const counts = new Map();
      for (const i of ids) for (const term of docs[i]) counts.set(term, (counts.get(term) || 0) + 1);
      return counts;
    };
    // Merge only when both topic similarity and cross-group connection strength agree.
    const communities = [...buckets.values()].filter(ids=>ids.length>=3).map(ids => ({ids, counts:countTerms(ids)}));
    const similarity = (a,b) => {
      let dot=0, aa=0, bb=0;
      const weight = t => Math.log(1 + nodes.length / (frequency.get(t) || 1));
      for (const [t,n] of a.counts) { const v=n/a.ids.length*weight(t); aa+=v*v; dot+=v*(b.counts.get(t)||0)/b.ids.length*weight(t); }
      for (const [t,n] of b.counts) { const v=n/b.ids.length*weight(t); bb+=v*v; }
      return aa && bb ? dot/Math.sqrt(aa*bb) : 0;
    };
    for (;;) {
      let pair=null, best=0;
      for (let a=0;a<communities.length;a++) for(let b=a+1;b<communities.length;b++) {
        const left=communities[a], right=communities[b];
        if(left.ids.length<3 || right.ids.length<3)continue;
        const semantic=similarity(left,right);if(semantic<.7)continue;
        const rightIds=new Set(right.ids);
        let crossing=0;for(const i of left.ids)for(const [j,w] of adj[i])if(rightIds.has(j))crossing+=w;
        const smaller=Math.min(left.ids.reduce((sum,i)=>sum+degree[i],0),right.ids.reduce((sum,i)=>sum+degree[i],0));
        const connection=smaller?crossing/smaller:0;
        if(connection>=.15 && semantic*connection>best) {best=semantic*connection;pair=[a,b];}
      }
      if(!pair)break;
      const [a,b]=pair, ids=communities[a].ids.concat(communities[b].ids).sort((a,b)=>a-b);
      communities[a]={ids,counts:countTerms(ids)};communities.splice(b,1);
    }
    const candidates=communities.filter(c=>c.ids.length>=minimum).sort((a,b)=>b.ids.length-a.ids.length||a.ids[0]-b.ids[0]).map(c=>{
      const support=Math.max(3,Math.ceil(c.ids.length*.15));
      const ranked=[...c.counts].filter(([t,n])=>n>=support && (frequency.get(t)||0)<nodes.length*.8).map(([t,n])=>{
        const outside=((frequency.get(t)||0)-n+1)/(Math.max(0,nodes.length-c.ids.length)+2);
        const lift=(n/c.ids.length)/outside;
        return {t,n,lift,score:n*Math.log(1+nodes.length/(frequency.get(t)||1))*Math.min(3,lift)*(t.includes(' ')?1.8:1)};
      }).filter(t=>t.lift>=1.2).sort((a,b)=>b.score-a.score||a.t.localeCompare(b.t));
      return {...c,ranked};
    }).filter(c=>c.ranked.length);
    const usedLabels=new Set(), output=[];
    for(const c of candidates) {
      const primary=c.ranked[0].t;
      const peers=candidates.filter(other=>other!==c && other.ranked[0].t===primary);
      let label=primary;
      if(peers.length) {
        // A qualifier must be supported within this group and stronger than in its peers.
        const qualifier=c.ranked.find(({t,n})=>!primary.includes(t)&&!t.includes(primary)&&peers.every(p=>n/c.ids.length >= 1.5*((p.counts.get(t)||0)+1)/(p.ids.length+2)));
        if(!qualifier)continue;
        label=primary+' · '+qualifier.t;
      }
      if(usedLabels.has(label))continue;
      usedLabels.add(label);
      const authors=new Map(), phrases=[];
      for(const {t} of c.ranked) if(!phrases.some(p=>p.includes(t)||t.includes(p))){phrases.push(t);if(phrases.length===3)break;}
      for(const i of c.ids)for(const name of new Set(String(nodes[i].searchAuthors||nodes[i].authors||'').split(',').map(s=>s.trim()).filter(s=>s&&!/et al|Unknown/i.test(s))))authors.set(name,(authors.get(name)||0)+1);
      output.push({id:nodes[c.ids[0]].id,ids:c.ids.map(i=>nodes[i].id),label,phrases,minimum,authors:[...authors].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,3).map(([name])=>name)});
      if(output.length===8)break;
    }
    return output;
  }
  if(typeof module!=='undefined')module.exports={detect}; else root.CitationClusters={detect};
})(typeof window!=='undefined'?window:globalThis);
