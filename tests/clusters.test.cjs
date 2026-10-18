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
