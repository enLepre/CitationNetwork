const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
const server = http.createServer((req,res)=>{
  const file = path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)) {res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const paper=(id,title)=>({id:'https://openalex.org/'+id,display_name:title,publication_year:2024,cited_by_count:15,authorships:[{author:{display_name:'Jane Researcher'}}],primary_location:{source:{display_name:'Journal of Catalysis'}},doi:'https://doi.org/10.1000/'+id});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}}), page=await context.newPage();
    const errors=[],urls=[];page.on('pageerror',e=>errors.push(e.message));
    let fail=false;
    await page.route('https://api.openalex.org/**',async route=>{
      const u=new URL(route.request().url());urls.push(u);const query=u.searchParams.get('search')||u.searchParams.get('search.title')||'';
      if(fail) return route.fulfill({status:500,body:'{}'});
      if(query==='slow old') await new Promise(r=>setTimeout(r,800));
      let data;
      if(u.pathname==='/authors') data={meta:{count:1},results:[{id:'https://openalex.org/A1',display_name:'Jane Researcher',works_count:26,last_known_institutions:[{display_name:'University of Science'}]}]};
      else if((u.searchParams.get('filter')||'').includes('authorships.author.id:')) data={meta:{count:1},results:[paper('Wauthor','Selected author’s publication')]};
      else if(query==='sorting') data={meta:{count:3},results:[{...paper('Wold','Sorting old'),publication_year:1999,cited_by_count:500},{...paper('Wnew','Sorting new'),publication_year:2025,cited_by_count:10},{...paper('Wmid','Sorting middle'),publication_year:2015,cited_by_count:100}]};
      else if(u.searchParams.get('page')==='2') data={meta:{count:26},results:[paper('W26','Catalysis: additional result')]};
      else if(query==='catalyssi') data={results:[]};
      else if(query.includes('~1')) data={results:[paper('Wtypo','Catalysis')]};
      else if(query==='catalysis') {
        if(u.searchParams.has('search')) await new Promise(r=>setTimeout(r,400));
        data={meta:{count:26},results:Array.from({length:25},(_,i)=>paper('W'+i,i?'Catalysis research '+i:'Catalysis'))};
      } else data={meta:{count:1},results:[paper('W'+query,query)]};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(()=>{window.entryFrames=[];const end=performance.now()+400;function frame(){entryFrames.push(document.querySelector('#big-input').getBoundingClientRect().y);if(performance.now()<end)requestAnimationFrame(frame);}requestAnimationFrame(frame);});
    await page.focus('#big-input');await page.waitForTimeout(420);
    const jump=await page.evaluate(()=>Math.max(...entryFrames.slice(1).map((y,i)=>Math.abs(y-entryFrames[i]))));
    assert(jump<100,`Search entry must ease into place, largest step was ${jump}px`);
    await page.fill('#big-input','catalysis');await page.click('#big-go');
    await page.waitForFunction(()=>document.querySelectorAll('.presult').length===25);
    await page.evaluate(()=>window.firstSearchRow=document.querySelector('.presult'));
    assert.equal(await page.locator('#picker').count(),0);
    assert((await page.locator('.result-authors').first().textContent()).includes('Jane Researcher'));
    await page.waitForFunction(()=>document.querySelector('#search-results').getAttribute('aria-busy')==='false');
    assert(await page.evaluate(()=>firstSearchRow===document.querySelector('.presult')),'Progressive updates preserve row identity');
    await page.click('#search-more');await page.waitForFunction(()=>document.querySelectorAll('.presult').length===26);
    assert.equal(await page.locator('#search-more').isVisible(),false);
    await page.locator('#big-input').focus();await page.keyboard.press('ArrowDown');assert.equal(await page.locator('.presult').first().evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#big-input').evaluate(el=>el===document.activeElement),true);
    await page.screenshot({path:path.join(root,'test-results/search-results.png')});
    await page.fill('#big-input','slow old');await page.click('#big-go');assert.equal(await page.locator('.presult').count(),26,'Keep previous results while loading');
    await page.fill('#big-input','fresh');await page.click('#big-go');await page.waitForFunction(()=>document.querySelector('.pt')?.textContent==='fresh');
    await page.waitForTimeout(900);assert.equal(await page.locator('.pt').first().textContent(),'fresh');
    fail=true;await page.fill('#big-input','failure');await page.click('#big-go');await page.waitForSelector('#search-retry:visible');assert.equal(await page.locator('.pt').first().textContent(),'fresh');
    fail=false;await page.click('#search-retry');await page.waitForFunction(()=>document.querySelector('.pt')?.textContent==='failure');
    await page.fill('#big-input','catalyssi');await page.click('#big-go');await page.waitForFunction(()=>document.querySelector('#search-status').textContent.includes('spelling alternatives'));assert.equal(await page.locator('.pt').first().textContent(),'Catalysis');
    await page.fill('#big-input','Jane Researcher');await page.selectOption('#search-mode','authors');await page.waitForSelector('.author-result');
    assert((await page.locator('.author-result').textContent()).includes('University of Science'));
    await page.click('.author-result');await page.waitForFunction(()=>document.querySelector('.pt')?.textContent==='Selected author’s publication');
    await page.selectOption('#search-sort','citations');
    await page.waitForFunction(()=>document.querySelector('#search-results').getAttribute('aria-busy')==='false');
    assert(urls.some(u=>(u.searchParams.get('filter')||'')==='authorships.author.id:A1'&&u.searchParams.get('sort')==='cited_by_count:desc'));
    await page.click('#author-back');await page.waitForSelector('.author-result');
    await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>!document.querySelector('#search-results').getAnimations({subtree:true}).length);await page.screenshot({path:path.join(root,'test-results/search-mobile.png')});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await page.locator('#search-from, #search-to, #search-hint').count(),0);
    assert(await page.locator('#search-sort').isDisabled());
    const anchor=await page.locator('#big-input').boundingBox();
    await page.fill('#big-input','');assert.equal(await page.locator('.presult').count(),0);
    assert.equal((await page.locator('#big-input').boundingBox()).y,anchor.y,'Clearing search retains its position');
    await page.selectOption('#search-mode','papers');await page.fill('#big-input','sorting');await page.click('#big-go');
    for(const [sort,id,api] of [['newest','Wnew','publication_date:desc'],['oldest','Wold','publication_date:asc'],['citations','Wold','cited_by_count:desc']]) {
      await page.selectOption('#search-sort',sort);await page.waitForFunction(()=>document.querySelector('#search-results').getAttribute('aria-busy')==='false');
      assert.equal(await page.locator('.presult').first().getAttribute('data-id'),id);
      assert(urls.some(u=>u.searchParams.get('sort')===api));
    }
    await page.reload();assert.equal(await page.locator('#search-sort').inputValue(),'citations');assert.equal(await page.locator('.presult').first().getAttribute('data-id'),'Wold');
    assert.deepEqual(errors,[]);
    console.log('Search entry maximum frame step: '+jump.toFixed(1)+'px (previous audit: 273.5px).');
    console.log('PASS: inline results, metadata, pagination, keyboard, stale-request cancellation, retained results, retry, typo recovery, author identity, sorting and mobile layout');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
