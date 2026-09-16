// Offline browser proof using generated synthetic data only.
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const html=readFileSync(process.argv[2]||'/tmp/fintrack-planner.html','utf8');
const directory=mkdtempSync(join(tmpdir(),'fintrack-planner-browser-'));
const checks=`<script>
(async()=>{
 const check=(ok,message)=>{if(!ok)throw new Error(message)},tick=()=>new Promise(resolve=>setTimeout(resolve,0));await tick();await document.fonts.ready;
 let requests=0;window.fetch=async()=>{requests++;throw new Error('A static scenario made a network request')};
 check(!document.getElementById('app').hidden,'Dashboard failed to initialize');
 check(document.querySelectorAll('.spotlight-goal').length===3,'Goal overview is missing');
 document.querySelector('.spotlight-link').click();
 check(!document.querySelector('[data-view=planner]').hidden,'Planner did not open');
 check(document.querySelectorAll('.goal-choice').length===3,'Goal selector is missing');
 check(document.querySelectorAll('#goal-trajectory path').length===5,'Recorded and projected chart paths are missing');
 check(document.querySelectorAll('.goal-weeks rect').length===16,'Weekly contribution chart is incomplete');
 check(document.querySelectorAll('.contribution-days span').length===28,'Contribution calendar is incomplete');
 check(document.querySelectorAll('.goal-suggestion').length>=3,'Goal suggestions are missing');
 const modelBefore=JSON.stringify(JSON.parse(document.getElementById('bootstrap').textContent).data);
 const initial=document.getElementById('scenario-result').textContent,initialDaily=document.getElementById('scenario-daily').value;
 const daily=document.getElementById('scenario-daily');daily.value='7500';daily.dispatchEvent(new Event('input'));
 check(document.getElementById('scenario-result').textContent!==initial,'Daily input does not change the projection');
 const boost=document.getElementById('scenario-boost');boost.value='100000';boost.dispatchEvent(new Event('input'));
 const accelerated=document.getElementById('scenario-result').textContent;
 const skip=document.getElementById('scenario-skip');skip.value='30';skip.dispatchEvent(new Event('change'));
 check(document.getElementById('scenario-result').textContent!==accelerated,'Pause does not change the projection');
 daily.value='-1';daily.dispatchEvent(new Event('input'));check(!document.getElementById('scenario-error').hidden,'Invalid amount has no guidance');
 daily.value='7500';daily.dispatchEvent(new Event('input'));
 const horizon=document.getElementById('planner-horizon');horizon.value='365';horizon.dispatchEvent(new Event('change'));
 const detail=document.querySelector('#goal-trajectory circle[tabindex]');detail.dispatchEvent(new Event('focus'));check(document.getElementById('goal-chart-detail').textContent.includes('Recorded'),'Chart focus details are missing');
 document.querySelectorAll('.goal-choice')[1].click();check(document.querySelector('.trajectory-head h2').textContent==='Summer in Italy','Changing goals failed');
 document.querySelectorAll('.goal-choice')[0].click();check(document.getElementById('scenario-daily').value==='7500','Goal switch lost the scenario');
 const scenario=document.getElementById('scenario-result').textContent;
 window.dispatchEvent(new Event('beforeprint'));check(!document.querySelector('[data-view=planner]').hidden,'Printing planner switched to overview');
 check(document.getElementById('print-summary').textContent.includes('Local scenario'),'Print has no scenario context');
 window.dispatchEvent(new Event('afterprint'));check(document.getElementById('scenario-result').textContent===scenario,'Printing lost the scenario');
 check(JSON.stringify(JSON.parse(document.getElementById('bootstrap').textContent).data)===modelBefore,'Scenario mutated the exported ledger');check(requests===0,'Scenario made a network request');
 check(document.documentElement.scrollWidth<=innerWidth+1,'Planner page overflows the viewport');
 document.querySelector('.scenario-reset').click();check(document.getElementById('scenario-daily').value===initialDaily,'Reset failed');
 const finalHorizon=document.getElementById('planner-horizon');finalHorizon.value='180';finalHorizon.dispatchEvent(new Event('change'));
 if(location.hash==='#scenario'){document.querySelector('.trajectory-panel').hidden=true;document.querySelector('.planner-intro').hidden=true;document.querySelector('.goal-choices').hidden=true;}window.scrollTo(0,0);
 await new Promise(resolve=>setTimeout(resolve,150));document.documentElement.dataset.plannerTest='passed';
})().catch(error=>document.documentElement.dataset.plannerTest='failed: '+error.message);
</script>`;
const path=join(directory,'planner.html');writeFileSync(path,html.replace('</body>',checks+'</body>'));
for(const [name,size,hash]of [['desktop','1500,1300',''],['mobile','390,1100',''],['mobile-scenario','390,1000','#scenario']]){
 const output=execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--run-all-compositor-stages-before-draw',`--user-data-dir=${join(directory,name)}`,`--window-size=${size}`,'--virtual-time-budget=3000',`--screenshot=/tmp/fintrack-planner-${name}.png`,'--dump-dom','file://'+path+hash],{encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','ignore']});
 const result=output.match(/data-planner-test="([^"]+)"/)?.[1];if(result!=='passed')throw new Error(name+': '+(result||'No test result'));
 console.log(name+': charts, scenarios, goal selection, keyboard details, print restoration and offline isolation passed.');
}
// Exercise print CSS and export the currently selected goal, rather than the overview.
execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu',`--user-data-dir=${join(directory,'print')}`,'--virtual-time-budget=3000','--no-pdf-header-footer','--print-to-pdf=/tmp/fintrack-planner-print.pdf','file://'+path],{stdio:'ignore'});
console.log('Goal planner print preview: /tmp/fintrack-planner-print.pdf');

for(const variant of ['empty','no-history','completed']){
 const boot=JSON.parse(html.match(/id="bootstrap">([\s\S]*?)<\/script>/)[1]);
 if(variant==='empty'){boot.data.status.plans=[];boot.data.status.goals=[]}
 if(variant==='no-history'){
  boot.data.goalHistory.daily=[];boot.data.goalHistory.balances=boot.data.status.plans.map(p=>({goal_id:p.goal.id,balance:0,firstEntry:null}));
  boot.data.status.plans[0].goal.name='A long savings goal with <script>untrusted text</script> that should wrap safely on a phone';
 }
 if(variant==='completed')for(const p of boot.data.status.plans)p.goal.target_minor=1;
 const assertion=variant==='empty'?"check(document.querySelector('.planner-empty')?.textContent.includes('/goal'),'Empty goals need setup guidance');check(!document.getElementById('scenario-daily'),'Empty goals displayed a fictitious scenario');":variant==='completed'?"check(document.querySelector('.pace-badge')?.textContent==='Target reached','Completed goal status incorrect');check(document.getElementById('scenario-result').textContent.includes('already cover'),'Completed goal forecast incorrect');":"check(document.querySelector('.goal-suggestions').textContent.includes('Build a clearer baseline'),'Missing history produced an unsupported forecast');check(document.querySelector('.trajectory-head h2').textContent.includes('<script>'),'Goal label not preserved as text');";
 const variantCheck=`<script>(async()=>{await new Promise(r=>setTimeout(r,0));const check=(ok,message)=>{if(!ok)throw new Error(message)};document.querySelector('[data-open-view=planner]').click();${assertion}check(document.documentElement.scrollWidth<=innerWidth+1,'Edge case overflows on mobile');document.documentElement.dataset.edgeTest='passed'})().catch(e=>document.documentElement.dataset.edgeTest=e.message);</script>`;
 const file=join(directory,variant+'.html'),json=JSON.stringify(boot).replaceAll('<','\\u003c');
 writeFileSync(file,html.replace(/(id="bootstrap">)[\s\S]*?(<\/script>)/,()=> 'id="bootstrap">'+json+'</script>').replace('</body>',variantCheck+'</body>'));
 const output=execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu',`--user-data-dir=${join(directory,'profile-'+variant)}`,'--window-size=390,1000','--virtual-time-budget=1500','--dump-dom','file://'+file],{encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','ignore']});
 const result=output.match(/data-edge-test="([^"]+)"/)?.[1];if(result!=='passed')throw new Error(variant+': '+result);console.log(variant+': mobile edge case passed.');
}
