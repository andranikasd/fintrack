// Isolated headless rendering and interaction checks; uses only synthetic fixture data.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const input=process.argv[2]||'/tmp/fintrack-dashboard.html';
const directory=mkdtempSync(join(tmpdir(),'fintrack-browser-'));
const html=readFileSync(input,'utf8');
const checks=`<script>
(async()=>{
  const check=(ok,message)=>{if(!ok)throw new Error(message)};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  await tick();await document.fonts.ready;
  check(!document.getElementById('app').hidden,'Dashboard did not render');
  check(document.documentElement.scrollWidth<=window.innerWidth+1,'Page overflows viewport: '+[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(n=>n.tagName+'.'+n.className+':'+Math.round(n.getBoundingClientRect().right)).join(', '));
  const search=document.getElementById('search');search.value='metro';search.dispatchEvent(new Event('input'));
  check(document.getElementById('total-expense').textContent.startsWith('9,000'),'Search did not filter totals');
  document.getElementById('reset').click();
  const kind=document.getElementById('kind');kind.value='income';kind.dispatchEvent(new Event('change'));
  check(document.getElementById('total-expense').textContent.startsWith('0'),'Type filter failed');
  document.getElementById('reset').click();
  check(document.querySelectorAll('#period-details .detail-stat').length===4,'Period statistics missing');
  check(document.getElementById('largest-purchases').textContent.includes('1,020'),'Largest purchase incorrect');
  check(document.getElementById('repeat-spending').textContent.includes('9,000'),'Repeated item totals incorrect');
  check(document.querySelectorAll('#weekday-spending .weekday-bar').length===7,'Weekday chart missing');
  check(document.querySelector('#breakdown .share-chart'),'Category share chart missing');
  document.querySelector('[data-focus-series="all"]').click();
  const mode=document.getElementById('chart-mode');mode.value='lines';mode.dispatchEvent(new Event('change'));
  check(document.querySelectorAll('#activity path').length>=3,'Line series missing');
  const point=document.querySelector('#activity circle');point.dispatchEvent(new Event('focus'));
  check(document.getElementById('chart-detail').textContent.includes('Open period'),'Point details missing');
  mode.value='cumulative';mode.dispatchEvent(new Event('change'));
  const incomePoints=[...document.querySelectorAll('#activity circle')].filter(n=>n.getAttribute('aria-label').includes('Income'));
  check(incomePoints.at(-1).getAttribute('aria-label').includes(document.getElementById('total-income').textContent),'Running income total incorrect');
  mode.value='bars';mode.dispatchEvent(new Event('change'));
  const group=document.getElementById('group');group.value='month';group.dispatchEvent(new Event('change'));
  document.querySelector('#activity rect[tabindex]').click?.();
  document.querySelector('#activity rect[tabindex]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
  await tick();
  check(document.getElementById('to').value.endsWith('-31'),'Chart drill-down did not change dates');
  document.querySelector('[data-days="30"]').click();await tick();
  group.value='day';group.dispatchEvent(new Event('change'));
  for(const name of ['today','monthly','calendar','trends','planner','review','accounts','saved','rules','history','closing','receipts']){
    document.querySelector('[data-open-view="'+name+'"]').click();
    check(!document.querySelector('[data-view="'+name+'"]').hidden,'View did not open: '+name);
    check(document.getElementById(name+'-content').textContent.length>20,'Empty view: '+name);
    check(document.documentElement.scrollWidth<=window.innerWidth+1,'View overflows: '+name);
  }
  document.querySelector('[data-open-view="calendar"]').click();
  const day=document.querySelector('.calendar-day:not(:disabled)');day.click();await tick();
  check(document.getElementById('from').value===document.getElementById('to').value,'Calendar drill-down failed');
  document.querySelector('[data-days="30"]').click();await tick();
  document.querySelector('[data-open-view="monthly"]').click();
  check(document.querySelector('#monthly-content .pace-section svg'),'Monthly pace chart missing');
  document.querySelector('[data-open-view="overview"]').click();
  document.querySelector('[data-focus-series="expense"]').click();
  document.documentElement.dataset.browserTest='passed';
  document.title='Dashboard browser checks passed';
})().catch(error=>{document.documentElement.dataset.browserTest='failed: '+error.message;document.title=error.message});
</script>`;
const path=join(directory,'index.html');writeFileSync(path,html.replace('</body>',checks+'</body>'));
for(const [name,size] of [['desktop','1440,1100'],['mobile','390,844']]){
  const output=execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(directory,'profile-'+name)}`,`--window-size=${size}`,'--virtual-time-budget=3000',`--screenshot=/tmp/fintrack-${name}.png`,'--dump-dom','file://'+path],{encoding:'utf8',maxBuffer:5*1024*1024,stdio:['ignore','pipe','ignore']});
  const result=output.match(/data-browser-test="([^"]+)"/)?.[1];
  if(result!=='passed')throw new Error(name+': '+(result||'No browser test result'));
  console.log(`${name}: rendered without page overflow; search, type filtering, chart grouping, drill-down and date presets passed.`);
}

// Exercise live editor controls with synthetic API responses. Backend mutation semantics
// are covered against SQLite in accounts-views.test.ts and by the Docker smoke test.
const mock=`<script>window.savedActions=[];window.fetch=async(path,options)=>{if(path==='/api/action'||path==='/api/attachment'){const body=JSON.parse(options.body);window.savedActions.push(body);return {ok:true,json:async()=>body.action==='rule-preview'?{ok:true,result:{revision:5,fingerprint:'synthetic-preview',count:15,total:9000,examples:[]}}:{ok:true}}}return {ok:true,json:async()=>JSON.parse(document.getElementById('bootstrap').textContent).data}};</script>`;
const liveChecks=`<script>(async()=>{
 const check=(value,message)=>{if(!value)throw new Error(message)},tick=()=>new Promise(r=>setTimeout(r,0));await tick();
 check(!document.getElementById('app').hidden,'Live dashboard failed');
 document.getElementById('add-income').click();
 const form=document.getElementById('edit-form');form.elements.label.value='Interest';form.elements.amount.value='250.77';form.elements.accountId.value='1';form.elements.passive.checked=true;
 form.requestSubmit();await tick();await tick();
 check(window.savedActions[0]?.accountId===1&&window.savedActions[0]?.passive===true,'Income account or passive flag missing');
 document.querySelector('[data-open-view="accounts"]').click();document.querySelector('#accounts-content button').click();
 form.elements.label.value='Savings';form.elements.opening.value='1000.77';form.elements.passive.checked=true;form.requestSubmit();await tick();await tick();
 check(window.savedActions[1]?.action==='account-create'&&window.savedActions[1]?.opening==='1000.77','Account editor failed');
 document.querySelector('[data-open-view="planner"]').click();document.querySelector('#planner-content button').click();
 form.elements.label.value='Laptop 2';form.elements.target.value='960381.77';form.elements.daily.value='3000';form.requestSubmit();await tick();await tick();
 check(window.savedActions[2]?.action==='goal-plan','Goal editor failed');
 document.querySelector('[data-open-view="saved"]').click();document.querySelector('#saved-content button').click();form.elements.label.value='My spending';form.elements.rangeMode.value='month';form.requestSubmit();await tick();await tick();
 check(window.savedActions.at(-1)?.action==='view-save'&&window.savedActions.at(-1)?.settings.rangeMode==='month','Saved view payload missing');
 document.querySelector('[data-open-view="rules"]').click();document.querySelector('#rules-content button').click();form.elements.labels.value='metro';form.elements.categoryId.value='1';
 check(document.getElementById('save-edit').disabled,'Rules should require a preview');
 document.querySelector('#editor-fields button').click();await tick();await tick();check(!document.getElementById('save-edit').disabled,'Preview did not enable save');
 form.elements.labels.value='metro\\nmetor';form.elements.labels.dispatchEvent(new Event('input'));check(document.getElementById('save-edit').disabled,'Changed rule retained old preview');
 document.querySelector('#editor-fields button').click();await tick();await tick();form.requestSubmit();await tick();await tick();
 check(window.savedActions.at(-1)?.action==='rule-save'&&window.savedActions.at(-1)?.fingerprint==='synthetic-preview','Rule preview not bound to save');
 document.querySelector('[data-open-view="overview"]').click();[...document.querySelectorAll('#rows button')].find(b=>b.textContent==='Receipt / note').click();form.elements.note.value='Warranty details';form.requestSubmit();await tick();await tick();
 check(window.savedActions.at(-1)?.action==='attachment-add'&&window.savedActions.at(-1)?.note==='Warranty details','Receipt note payload missing');
 document.querySelector('[data-open-view="closing"]').click();[...document.querySelectorAll('#closing-content button')].find(b=>b.textContent==='Confirm all remaining days').click();form.requestSubmit();await tick();await tick();
 check(window.savedActions.at(-1)?.action==='logging-month'&&window.savedActions.at(-1)?.period,'Month confirmation payload missing');

 document.documentElement.dataset.browserTest='passed';
})().catch(error=>document.documentElement.dataset.browserTest='failed: '+error.message);</script>`;
const livePath=join(directory,'live.html');writeFileSync(livePath,html.replace('"live":false','"live":true').replace("<script>\n'use strict';",mock+"<script>\n'use strict';").replace('</body>',liveChecks+'</body>'));
const liveOutput=execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu',`--user-data-dir=${join(directory,'profile-live')}`,'--window-size=390,844','--virtual-time-budget=3000','--dump-dom','file://'+livePath],{encoding:'utf8',maxBuffer:5*1024*1024,stdio:['ignore','pipe','ignore']});
const liveResult=liveOutput.match(/data-browser-test="([^"]+)"/)?.[1];if(liveResult!=='passed')throw new Error('Live editors: '+liveResult);
console.log('Live income/account/passive-income and goal editor interactions passed.');
