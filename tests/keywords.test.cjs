const {test} = require('node:test');
const assert = require('node:assert/strict');
const {matches,subset,suggestions} = require('../assets/keywords.js');
const papers = [
  {id:'seed',title:'Starting paper'},
  {id:'a',title:'Photoredox catalysis',authors:'A. Smith',searchAuthors:'Alice Smith, José García',abstract:'Copper pathways'},
  {id:'b',title:'Copper electrodes',authors:'Jane Brown',abstract:'Visible light reactions'},
  {id:'c',title:'Unrelated work',authors:'Other',abstract:'No abstract available from OpenAlex.'}
];
test('field choices, phrases, accents and all/any keyword combinations',()=>{
  assert(matches(papers[1],{terms:['JOSE GARCIA'],fields:['authors']}));
  assert(!matches(papers[1],{terms:['copper'],fields:['title']}));
  assert(matches(papers[1],{terms:['copper'],fields:['abstract']}));
  assert(matches(papers[1],{terms:['photoredox','garcia'],fields:['title','authors'],mode:'all'}));
  assert(!matches(papers[1],{terms:['photoredox','brown'],fields:['title','authors'],mode:'all'}));
  assert(matches(papers[1],{terms:['photoredox','brown'],fields:['title','authors'],mode:'any'}));
  assert(!matches(papers[3],{terms:['abstract'],fields:['abstract']}));
  assert(!matches(papers[2],{terms:['light copper'],fields:['title','abstract']}));
  assert(matches({title:'Photoredox: catalysis'},{terms:['photoredox catalysis'],fields:['title']}));
});
test('rebuild keeps anchor, matching papers and only their connecting edges; reset is lossless',()=>{
  const net={seedId:'seed',papers,edges:[{s:'seed',t:'a'},{s:'a',t:'b'},{s:'b',t:'c'}]};
  const filtered=subset(net,{terms:['photoredox'],fields:['title']});
  assert.deepEqual(filtered.papers.map(p=>p.id),['seed','a']);
  assert.deepEqual(filtered.edges,[{s:'seed',t:'a'}]);
  assert.equal(net.papers.length,4);
  assert.deepEqual(subset(net,{terms:[]}).papers,papers);
  assert.deepEqual(subset(net,{terms:['no match'],fields:['title']}).papers.map(p=>p.id),['seed']);
});
test('suggestions use only selected fields, count papers once and exclude selected terms',()=>{
  const rows=suggestions(papers,['abstract'],'copper');
  assert(rows.some(r=>r.term==='copper' && r.count===1));
  assert(!suggestions(papers,['title']).some(r=>r.term==='Alice Smith'));
  assert(suggestions(papers,['authors']).some(r=>r.term==='José García'));
  assert(!suggestions(papers,['abstract'],'abstract').length);
  assert(!suggestions(papers,['title','abstract'],'electrodes visible').length);
  assert(!suggestions(papers,['title'],'copper',['copper']).some(r=>r.term==='copper'));
});
