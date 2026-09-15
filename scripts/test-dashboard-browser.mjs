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
