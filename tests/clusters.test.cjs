const {test}=require('node:test');
const assert=require('node:assert/strict');
const {detect}=require('../assets/clusters.js');
const papers=[{id:'seed',title:'Central paper'},...Array.from({length:6},(_,i)=>({id:'a'+i,title:'Photoredox catalysis mechanisms '+i,refs:['seed','ra','rb'],authors:'Alice Smith'})),...Array.from({length:6},(_,i)=>({id:'b'+i,title:'Protein folding dynamics '+i,refs:['seed','rc','rd'],authors:'Bob Chen'}))];
test('shared references identify separate topics without seed bias',()=>{
 const groups=detect(papers,papers.slice(1).map(p=>({s:p.id,t:'seed'})),'seed');
 assert.equal(groups.length,2);
 assert(groups.every(g=>g.ids.length===6));
 assert(groups.some(g=>g.label.includes('photoredox')||g.label.includes('catalysis')));
 assert(groups.some(g=>g.label.includes('protein')||g.label.includes('folding')));
 assert(groups.some(g=>g.authors.includes('Alice Smith')));
});
test('seed-only neighborhoods and tiny groups produce no flags',()=>{
 const nodes=papers.map(p=>({...p,refs:['seed']}));
 assert.equal(detect(nodes,nodes.slice(1).map(p=>({s:p.id,t:'seed'})),'seed').length,0);
 assert.equal(detect(papers.slice(0,4),[],'seed').length,0);
});
test('membership is deterministic and independent of positions and input order',()=>{
 const first=detect(papers,[],'seed');
 assert.deepEqual(detect(papers.slice().reverse().map(p=>({...p,x:Math.random()*100,y:30})),[],'seed'),first);
});
test('direct links form groups without reference metadata',()=>{
 const nodes=papers.map(p=>({...p,refs:[]}));
 const edges=[];for(const prefix of ['a','b'])for(let i=0;i<6;i++)for(let j=i+1;j<6;j++)edges.push({s:prefix+i,t:prefix+j});
 assert.equal(detect(nodes,edges,'seed').length,2);
});
test('missing metadata and hostile titles stay plain data',()=>{
 const nodes=Array.from({length:5},(_,i)=>({id:'x'+i,title:'<script> malicious title </script>',refs:['r']}));
 assert.doesNotThrow(()=>detect(nodes,[],'seed'));
 assert.deepEqual(detect([],[],'seed'),[]);
});

function cliques(specs, bridges=[]) {
 const nodes=[{id:'seed'}], edges=[];
 for(const [prefix,count,title] of specs){
  for(let i=0;i<count;i++)nodes.push({id:prefix+i,title:typeof title==='function'?title(i):title});
  for(let i=0;i<count;i++)for(let j=i+1;j<count;j++)edges.push({s:prefix+i,t:prefix+j});
 }
 edges.push(...bridges);return detect(nodes,edges,'seed');
}
test('large graphs suppress small groups and unsupported topic labels',()=>{
 const result=cliques([['a',140,'Protein folding dynamics'],['b',140,'Photoredox catalysis mechanisms'],['c',5,'Carbon nitride synthesis'],['d',20,i=>'Study using new approach '+i]]);
 assert.equal(result.length,2);
 assert(result.every(c=>c.ids.length>=c.minimum && c.minimum>=10));
});
test('similar topics merge only with substantial cross-group links',()=>{
 const specs=[['a',6,'Carbon nitride synthesis'],['b',6,'Carbon nitride synthesis'],['c',6,'Protein folding dynamics']];
 const linked=cliques(specs,Array.from({length:6},(_,i)=>({s:'a'+i,t:'b'+i})));
 assert(linked.some(c=>c.ids.length===12 && c.label.includes('carbon')));
 const unlinked=cliques(specs);
 assert(!unlinked.some(c=>c.ids.includes('a0')&&c.ids.includes('b0')));
 assert.equal(new Set(unlinked.map(c=>c.label)).size,unlinked.length);
});
test('repeated broad labels get evidence-based qualifiers',()=>{
 const result=cliques([
  ['a',14,i=>'Carbon nitride '+(i<4?'hydrogen evolution':'')],
  ['b',14,i=>'Carbon nitride '+(i<4?'oxygen reduction':'')],
  ['c',24,'Protein folding dynamics']
 ]);
 const a=result.find(c=>c.ids.includes('a0')),b=result.find(c=>c.ids.includes('b0'));
 assert(a && b);
 assert.notEqual(a.label,b.label);
 assert.match(a.label,/hydrogen/);assert.match(b.label,/oxygen/);
 assert.match(a.label,/carbon nitride/);assert.match(b.label,/carbon nitride/);
});
test('strong cross-links alone do not merge unrelated topics',()=>{
 const result=cliques([['a',6,'Carbon nitride synthesis'],['b',6,'Protein folding dynamics']],Array.from({length:6},(_,i)=>({s:'a'+i,t:'b'+i})));
 assert.equal(result.length,2);
 assert(result.every(c=>c.ids.length===6));
});
