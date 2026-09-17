// Local synthetic data only. No bot token, server, or financial account connection.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const directory=mkdtempSync(join(tmpdir(),'fintrack-analytics-'));
const html=readFileSync(process.argv[2]||'/tmp/fintrack-analytics.html','utf8');
const checks=`<script>
(async()=>{
 const check=(v,m)=>{if(!v)throw new Error(m)};await document.fonts.ready;
 let requests=0;window.fetch=()=>{requests++;throw new Error('Offline report made a request')};
 const bootstrap=document.getElementById('bootstrap').textContent;
 document.querySelector('[data-open-view=monthly]').click();
 check(document.querySelectorAll('#monthly-content .report-chart').length===4,'Financial charts missing');
 check(document.querySelector('#monthly-content .report-flow').textContent.includes('Cash wallet'),'Account reconciliation missing');
 const chart=document.querySelector('#monthly-content .report-chart'),svg=chart.querySelector('svg'),from=chart.dataset.visibleFrom;
 chart.querySelector('[aria-label="Zoom in"]').click();check(chart.dataset.visibleFrom!==from,'Zoom in did not narrow dates');
 chart.querySelector('[aria-label="Reset chart zoom"]').click();check(chart.dataset.visibleFrom===from,'Reset did not restore dates');
 const rectForDrag=svg.getBoundingClientRect(),capture=svg.setPointerCapture;svg.setPointerCapture=()=>{};
 svg.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,clientX:rectForDrag.left+rectForDrag.width*.3,clientY:rectForDrag.top+100,bubbles:true}));
 svg.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:1,clientX:rectForDrag.left+rectForDrag.width*.7,clientY:rectForDrag.top+100,bubbles:true}));svg.setPointerCapture=capture;
 check(chart.dataset.visibleFrom!==from,'Drag selection did not zoom');chart.querySelector('[aria-label="Reset chart zoom"]').click();
 const fit=chart.querySelector('[aria-label="Fit vertical axis to visible values"]');fit.click();check(fit.getAttribute('aria-pressed')==='true','Vertical axis fitting failed');fit.click();
 const legend=chart.querySelector('.plot-legend button');legend.click();check(legend.getAttribute('aria-pressed')==='false','Legend failed to hide series');check(!chart.querySelector('.plot-detail').textContent.includes('Total account funds'),'Hidden series still inspected');legend.click();
 svg.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));check(chart.querySelector('.plot-detail strong').textContent==='2026-09-01','Keyboard inspection failed');
 svg.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));check(chart.querySelector('.plot-detail strong').textContent==='2026-09-02','Keyboard date movement failed');
 const rect=svg.getBoundingClientRect();svg.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+rect.width*.4,clientY:rect.top+100,bubbles:true}));check(chart.querySelector('.plot-crosshair'),'Hover crosshair missing');
 chart.querySelector('[aria-label="Expand chart"]').click();check(chart.classList.contains('expanded'),'Expand failed');svg.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check(!chart.classList.contains('expanded'),'Escape did not close chart');
 const pace=document.querySelector('#monthly-content .pace-section');pace.querySelector('[data-mode=daily]').click();check(pace.querySelectorAll('svg rect').length>0,'Daily spending view failed');pace.querySelector('[data-mode=cumulative]').click();check(pace.querySelectorAll('svg path').length>=3,'Cumulative spending series missing');
 const fundsCard=document.querySelector('#monthly-content .report-card');fundsCard.querySelector('[data-mode=monthly]').click();check(fundsCard.querySelector('.report-chart').getAttribute('aria-label')==='Monthly account balances','Month-end balance trend failed');check(fundsCard.querySelectorAll('.plot-table tbody tr').length===12,'Monthly balances missing history');fundsCard.querySelector('[data-mode=daily]').click();
 const month=document.getElementById('report-month');month.value='2026-08';month.dispatchEvent(new Event('change'));check(!document.querySelector('#monthly-content .report-flow').textContent.includes('Cash wallet'),'Account appears before opening');
 const account=document.getElementById('month-account');account.value='3';account.dispatchEvent(new Event('change'));check(document.querySelector('#monthly-content .report-metrics').textContent.includes('2,100.55'),'Account-specific income incorrect');
 document.querySelector('[data-open-view=accounts]').click();check(document.getElementById('report-account').value==='3','Account selection did not persist');
 document.querySelector('[data-open-view=monthly]').click();
 window.dispatchEvent(new Event('beforeprint'));check(!document.querySelector('[data-view=monthly]').hidden,'Print changed the selected report');check(document.getElementById('print-summary').textContent.includes('2026-08'),'Print omitted selected month');window.dispatchEvent(new Event('afterprint'));check(document.getElementById('month-account').value==='3','Print lost selection');
 document.getElementById('month-account').value='all';document.getElementById('month-account').dispatchEvent(new Event('change'));document.getElementById('report-month').value='2026-09';document.getElementById('report-month').dispatchEvent(new Event('change'));
 check(requests===0,'Report requested data');check(document.getElementById('bootstrap').textContent===bootstrap,'Interaction changed source data');
 check(document.documentElement.scrollWidth<=innerWidth+1,'Report overflows viewport');
 if(location.hash==='#pace'){const content=document.getElementById('monthly-content');for(const child of [...content.children])if(!child.classList.contains('report-grid'))child.hidden=true;for(const card of content.querySelector('.report-grid').children)if(!card.querySelector('.pace-section'))card.hidden=true;}
 window.scrollTo(0,0);document.documentElement.dataset.analyticsTest='passed';
})().catch(e=>document.documentElement.dataset.analyticsTest='failed: '+e.message);
</script>`;
const path=join(directory,'analytics.html');writeFileSync(path,html.replace('</body>',checks+'</body>'));
for(const [name,size,hash]of [['desktop','1500,1350',''],['mobile','390,1100',''],['pace-desktop','1500,1100','#pace'],['pace-mobile','390,1100','#pace']]){
 const out=execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(directory,name)}`,`--window-size=${size}`,'--virtual-time-budget=3000',`--screenshot=/tmp/fintrack-analytics-${name}.png`,'--dump-dom','file://'+path+hash],{encoding:'utf8',maxBuffer:12*1024*1024,stdio:['ignore','pipe','ignore']});
 const result=out.match(/data-analytics-test="([^"]+)"/)?.[1];if(result!=='passed')throw new Error(name+': '+(result||'No test result'));console.log(name+': month/account filters, zoom, hover, keyboard, legends, expand, printing and offline isolation passed.');
}
execFileSync('chromium',['--headless','--no-sandbox','--disable-gpu',`--user-data-dir=${join(directory,'print')}`,'--virtual-time-budget=3000','--no-pdf-header-footer','--print-to-pdf=/tmp/fintrack-analytics-print.pdf','file://'+path],{stdio:'ignore'});
console.log('Month-end PDF preview: /tmp/fintrack-analytics-print.pdf');
