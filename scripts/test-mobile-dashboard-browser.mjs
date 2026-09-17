// Real mobile viewport/touch emulation against local, synthetic report fixtures.
import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const directory=await mkdtemp(join(tmpdir(),'fintrack-mobile-'));
const browser=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=0',`--user-data-dir=${directory}`,'about:blank'],{stdio:'ignore'});
let socket;
try{
 let endpoint;for(let i=0;i<100;i++){try{const [port,path]=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).trim().split('\n');endpoint=`ws://127.0.0.1:${port}${path}`;break;}catch{await delay(50)}}if(!endpoint)throw new Error('Chromium did not start');
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 let sequence=0;const pending=new Map();socket.onmessage=({data})=>{const value=JSON.parse(data),p=pending.get(value.id);if(p){pending.delete(value.id);value.error?p.reject(new Error(value.error.message)):p.resolve(value.result)}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
 const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 const send=(method,params={})=>call(method,params,sessionId);
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const check=async expression=>evaluate(`(()=>{const check=(v,m)=>{if(!v)throw new Error(m)};${expression}})()`);
 await send('Page.enable');await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
 async function load(file,width,height){await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,isMobile:true,mobile:true});await send('Page.navigate',{url:'file://'+file});for(let i=0;i<100;i++){if(await evaluate(`document.readyState==='complete'&&!!document.querySelector('#rows tr')`))break;await delay(50)}await evaluate('document.fonts.ready.then(()=>true)');}
 const screenshot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile('/tmp/fintrack-mobile-'+name+'.png',Buffer.from(r.data,'base64'))};
 for(const [width,height]of [[320,740],[390,844],[430,932],[768,1024],[844,390]]){
  await load('/tmp/fintrack-analytics.html',width,height);
  await check(`check(innerWidth===${width},'Wrong viewport');check(parseFloat(getComputedStyle(document.getElementById('mobile-view')).fontSize)>=16,'Mobile select triggers input zoom');`);
  for(const name of ['overview','monthly','accounts','compare','calendar','trends','planner','today','review','saved','rules','history','closing','receipts']){
   await evaluate(`showView('${name}');new Promise(r=>setTimeout(r,80))`);
   await check(`check(document.documentElement.scrollWidth<=innerWidth+1,'Page overflow in ${name} at ${width}px');const root=document.querySelector('[data-view=${name}]');const small=[...root.querySelectorAll('button,a,input[type=checkbox]')].filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&!n.disabled&&!n.closest('svg')&&getComputedStyle(n).visibility!=='hidden'&&r.height<43&&!(n.matches('input[type=checkbox]')&&n.closest('label')?.getBoundingClientRect().height>=43)});check(!small.length,'Small touch target in ${name}: '+small.slice(0,4).map(n=>n.textContent||n.type));`);
  }
  if(width<=430){
   await evaluate(`showView('overview');document.getElementById('records').scrollIntoView();new Promise(r=>setTimeout(r,50))`);
   await check(`check(getComputedStyle(document.querySelector('#rows tr')).display==='grid','Ledger does not use mobile cards');check(document.querySelector('#records .tablewrap').scrollWidth<=document.querySelector('#records .tablewrap').clientWidth+1,'Record card requires horizontal scrolling');check(document.querySelector('.mobile-view').getBoundingClientRect().top<2,'Section navigation does not stay visible');`);
   await screenshot(width+'-records');
   await evaluate(`showView('monthly');document.querySelector('.pace-section').scrollIntoView();window.scrollBy(0,-75);new Promise(r=>setTimeout(r,50))`);
   await screenshot(width+'-pace');
   await check(`const root=document.querySelector('#monthly-content .report-flow');check(getComputedStyle(root.querySelector('tbody tr')).display==='grid','Reconciliation does not use account cards');`);
   // Tap a plot, then swipe vertically across it. Scrolling must not zoom the time range.
   const rect=await evaluate(`(()=>{const s=document.querySelector('#monthly-content .pace-section svg');s.scrollIntoView({block:'center'});const r=s.getBoundingClientRect();return {x:r.left+r.width*.6,y:r.top+r.height*.65}})()`);
   const from=await evaluate(`document.querySelector('#monthly-content .pace-section .report-chart').dataset.visibleFrom`);
   await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x,y:rect.y}]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await check(`check(document.querySelector('#monthly-content .pace-section .plot-crosshair'),'Touch inspection failed')`);
   const scroll=await evaluate('scrollY');
   await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x,y:rect.y}]});for(let step=1;step<=5;step++){await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rect.x,y:rect.y-step*22}]});await delay(20)}await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(100);
   await check(`check(scrollY>${scroll}+20,'Chart prevents vertical touch scrolling');check(document.querySelector('#monthly-content .pace-section .report-chart').dataset.visibleFrom===${JSON.stringify(from)},'Scrolling unexpectedly zoomed the chart');`);
   await evaluate(`document.querySelector('#monthly-content .pace-section [aria-label="Expand chart"]').click();new Promise(r=>setTimeout(r,50))`);
   await check(`const chart=document.querySelector('.report-chart.expanded');check(chart.getBoundingClientRect().right<=innerWidth,'Expanded chart overflows');check(chart.querySelector('[aria-label="Close expanded chart"]').getBoundingClientRect().top>=0,'Expanded close control inaccessible');`);
   await screenshot(width+'-expanded');await evaluate(`document.querySelector('.expanded [aria-label="Close expanded chart"]').click()`);
   // Reflow an existing chart without rebuilding it or losing its zoom/series selection.
   await evaluate(`document.querySelector('#monthly-content .pace-section [aria-label="Zoom in"]').click();document.querySelector('#monthly-content .pace-section .plot-legend button').click()`);
   const before=await evaluate(`document.querySelector('#monthly-content .pace-section .report-chart').dataset.visibleFrom`);
   await send('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true});await delay(200);
   await check(`const root=document.querySelector('#monthly-content .pace-section .report-chart'),svg=root.querySelector('svg');check(root.dataset.visibleFrom===${JSON.stringify(before)},'Rotation lost chart zoom');check(root.querySelector('.plot-legend button').getAttribute('aria-pressed')==='false','Rotation lost series choice');check(Math.abs(svg.viewBox.baseVal.width-svg.clientWidth)<3,'Chart did not resize on rotation');`);
  }
  console.log(`${width}×${height}: all views, touch targets, navigation and layout passed.`);
 }
 await load('/tmp/fintrack-comparison.html',390,844);await evaluate(`showView('compare');new Promise(r=>setTimeout(r,50))`);
 await check(`const wrap=document.querySelector('#comparison-table').closest('.tablewrap');check(wrap.tabIndex===0,'Wide table is not keyboard scrollable');check(wrap.getAttribute('aria-label'),'Wide table has no accessible label');check(document.documentElement.scrollWidth<=innerWidth+1,'Comparison overflows page');`);
 await load('/tmp/fintrack-planner.html',390,844);await evaluate(`showView('planner');document.getElementById('scenario-daily').value='7500';document.getElementById('scenario-daily').dispatchEvent(new Event('input'));new Promise(r=>setTimeout(r,50))`);
 await send('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true});await delay(200);
 await check(`check(document.getElementById('scenario-daily').value==='7500','Rotation lost goal scenario');check(document.documentElement.scrollWidth<=innerWidth+1,'Planner overflows after rotation')`);
 console.log('Touch gestures, rotation, chart state, comparison tables and goal scenarios passed.');
}finally{socket?.close();browser.kill('SIGTERM')}
