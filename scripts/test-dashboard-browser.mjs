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
  await tick();
  check(!document.getElementById('app').hidden,'Dashboard did not render');
  check(document.documentElement.scrollWidth<=window.innerWidth+1,'Page overflows viewport');
  const search=document.getElementById('search');search.value='metro';search.dispatchEvent(new Event('input'));
  check(document.getElementById('total-expense').textContent.startsWith('9,000'),'Search did not filter totals');
  document.getElementById('reset').click();
  const kind=document.getElementById('kind');kind.value='income';kind.dispatchEvent(new Event('change'));
  check(document.getElementById('total-expense').textContent.startsWith('0'),'Type filter failed');
  document.getElementById('reset').click();
  const group=document.getElementById('group');group.value='month';group.dispatchEvent(new Event('change'));
  document.querySelector('#activity rect[tabindex]').click?.();
  document.querySelector('#activity rect[tabindex]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
  await tick();
  check(document.getElementById('to').value.endsWith('-31'),'Chart drill-down did not change dates');
  document.querySelector('[data-days="30"]').click();await tick();
  group.value='day';group.dispatchEvent(new Event('change'));
  for(const name of ['today','monthly','calendar','trends','planner','review','accounts']){
    document.querySelector('[data-open-view="'+name+'"]').click();
    check(!document.querySelector('[data-view="'+name+'"]').hidden,'View did not open: '+name);
    check(document.getElementById(name+'-content').textContent.length>20,'Empty view: '+name);
    check(document.documentElement.scrollWidth<=window.innerWidth+1,'View overflows: '+name);
  }
  document.querySelector('[data-open-view="calendar"]').click();
  const day=document.querySelector('.calendar-day:not(:disabled)');day.click();await tick();
  check(document.getElementById('from').value===document.getElementById('to').value,'Calendar drill-down failed');
  document.querySelector('[data-open-view="today"]').click();
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
const mock=`<script>window.savedActions=[];window.fetch=async(path,options)=>{if(path==='/api/action'){window.savedActions.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})}}return {ok:true,json:async()=>JSON.parse(document.getElementById('bootstrap').textContent).data}};</script>`;
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
 document.documentElement.dataset.browserTest='passed';
})().catch(error=>document.documentElement.dataset.browserTest='failed: '+error.message);</script>`;
const livePath=join(directory,'live.html');writeFileSync(livePath,html.replace('"live":false','"live":true').replace("<script>\n'use strict';",mock+"<script>\n'use strict';").replace('</body>',liveChecks+'</body>'));
const liveOutput=execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu',`--user-data-dir=${join(directory,'profile-live')}`,'--window-size=390,844','--virtual-time-budget=3000','--dump-dom','file://'+livePath],{encoding:'utf8',maxBuffer:5*1024*1024,stdio:['ignore','pipe','ignore']});
const liveResult=liveOutput.match(/data-browser-test="([^"]+)"/)?.[1];if(liveResult!=='passed')throw new Error('Live editors: '+liveResult);
console.log('Live income/account/passive-income and goal editor interactions passed.');
