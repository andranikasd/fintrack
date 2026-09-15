import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Uses isolated disposable volumes and dummy credentials. Never reads a real .env.
const project = `fintrack-smoke-${process.pid}`;
const env = {
  ...process.env,
  BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz',
  ALLOWED_USER_IDS: '123456789', DEFAULT_TZ: 'Asia/Yerevan', BACKUP_RETENTION_DAYS: '7',
};
const args = ['compose', '--env-file', '.env.example', '-p', project, '-f', 'compose.yaml', '-f', 'tests/docker/compose.smoke.yaml'];
const compose = (...commands) => execFileSync('docker', [...args, ...commands], { env, encoding: 'utf8', timeout: 70_000 });
const sql = query => JSON.parse(compose('exec', '-T', 'bot', 'sqlite3', '-json', '/data/fintrack.sqlite', query));
async function healthy() {
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    const id = compose('ps', '-q', 'bot').trim();
    if (id) {
      const status = execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', id], { encoding: 'utf8' }).trim();
      if (status === 'healthy') return;
    }
    await setTimeout(1000);
  }
  throw new Error('Container did not become healthy');
}
try {
  compose('up', '-d', '--no-build');
  await healthy();
  assert.equal(sql('SELECT SUM(amount) AS n FROM transactions')[0].n, 750);
  assert.equal(sql('SELECT target_minor AS n FROM goals')[0].n, 96038177);
  assert.equal(sql('SELECT SUM(amount_minor) AS n FROM savings')[0].n, 550000);
  const pdfSize = Number(compose('exec', '-T', 'bot', 'cat', '/data/smoke-pdf-size'));
  assert.ok(pdfSize > 1000, 'PDF generation and upload must complete');
  assert.equal(compose('exec', '-T', 'bot', 'id', '-u').trim(), '1000');
  compose('exec', '-T', 'bot', 'node', '-e', `
    (async()=>{
      const fs=require('node:fs');
      const link=new URL(fs.readFileSync('/data/smoke-dashboard-link','utf8'));
      const token=new URLSearchParams(link.hash.slice(1)).get('login');
      const origin='http://127.0.0.1:8080';
      const denied=await fetch(origin+'/api/dashboard');
      if(denied.status!==401)throw new Error('Unauthenticated dashboard exposed data');
      const login=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
      if(login.status!==200)throw new Error('Dashboard login failed');
      const cookie=login.headers.get('set-cookie').split(';')[0];
      const response=await fetch(origin+'/api/dashboard',{headers:{Cookie:cookie}});
      const data=await response.json();
      if(data.records.filter(r=>r.kind==='income').reduce((s,r)=>s+r.amountMinor,0)!==45000000)throw new Error('Dashboard income incorrect');
      const post=await fetch(origin+'/api/action',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'budget',amount:'150000',requestId:crypto.randomUUID()})});
      if(post.status!==200)throw new Error('Dashboard update failed');
      const account=data.accounts.find(a=>a.name==='Card');
      if(!account||account.balance_minor!==44375000)throw new Error('Account income balance incorrect');
      const passive=await fetch(origin+'/api/action',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'add-income',label:'Interest',accountId:account.id,passive:true,amount:'100.77',requestId:crypto.randomUUID()})});
      if(passive.status!==200)throw new Error('Passive income write failed');
      const refreshed=await (await fetch(origin+'/api/dashboard',{headers:{Cookie:cookie}})).json();
      if(refreshed.accounts.find(a=>a.id===account.id).balance_minor!==44385077||!refreshed.records.some(r=>r.passive&&r.accountId===account.id))throw new Error('Passive income balance incorrect');
      if(!refreshed.insights.review||!refreshed.insights.trendPeriods.length)throw new Error('Dashboard views missing');
      const action=async body=>{const r=await fetch(origin+'/api/action',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({...body,requestId:crypto.randomUUID()})});if(r.status!==200)throw new Error(await r.text());return r.json()};
      const interest=refreshed.records.find(r=>r.passive);
      await action({action:'edit',kind:'income',id:interest.id,accountId:account.id,label:'Interest corrected',amount:'200.77',day:interest.day,expected:{accountId:interest.accountId,passive:interest.passive,label:interest.label,amountMinor:interest.amountMinor,day:interest.day}});
      const history=await (await fetch(origin+'/api/history',{headers:{Cookie:cookie}})).json();
      const edit=history.rows.find(r=>r.entity==='income'&&r.operation==='update');if(!edit)throw new Error('Edit history missing');
      await action({action:'history-undo',id:edit.id});
      const file='%PDF-1.4 smoke receipt';
      const receipt=await fetch(origin+'/api/attachment',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'attachment-add',kind:'income',id:interest.id,name:'receipt.pdf',mime:'application/pdf',note:'Smoke receipt',data:Buffer.from(file).toString('base64'),requestId:crypto.randomUUID()})});
      if(receipt.status!==200)throw new Error('Receipt upload failed');
      const final=await (await fetch(origin+'/api/dashboard',{headers:{Cookie:cookie}})).json();
      if(final.accounts.find(a=>a.id===account.id).balance_minor!==44385077)throw new Error('Undo did not restore account balance');
      const download=await fetch(origin+'/api/attachment/'+final.workspace.attachments[0].id,{headers:{Cookie:cookie}});
      if(await download.text()!==file)throw new Error('Receipt download failed');
      if(!final.workspace.closing||!final.workspace.history.rows.length)throw new Error('Workspace missing');
      console.log('Live dashboard, accounts, passive income, history/undo, receipts and closing review passed.');
    })().catch(e=>{console.error(e.message);process.exit(1)});
  `);

  compose('exec', '-T', 'bot', 'node', 'dist/backup.mjs', '/backups/smoke.sqlite');
  assert.equal(compose('exec', '-T', 'bot', 'sqlite3', '/backups/smoke.sqlite', 'SELECT SUM(amount) FROM transactions;').trim(), '750');
  assert.equal(compose('exec', '-T', 'bot', 'sqlite3', '/backups/smoke.sqlite', 'SELECT COUNT(*) FROM entry_attachments;').trim(), '1');
  compose('restart', 'bot');
  await healthy();
  assert.equal(sql('SELECT SUM(amount) AS n FROM transactions')[0].n, 750);
  assert.equal(sql('SELECT COUNT(*) AS n FROM schema_migrations')[0].n, 7);
  const snapshot = execFileSync('docker', [...args, 'exec', '-T', 'bot', 'cat', '/backups/smoke.sqlite'], { env });
  sql("INSERT INTO transactions(user_id,amount,note,spent_on,account_id) VALUES(123456789,100,'after backup','2026-09-15',1) RETURNING id");
  compose('stop', 'bot');
  execFileSync('docker', [...args, 'run', '--rm', '-T', '--no-deps', 'bot', 'sh', '-ec', `
    cat > /data/restore.sqlite
    test "$(sqlite3 /data/restore.sqlite "PRAGMA integrity_check;")" = ok
    sqlite3 /data/fintrack.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
    mv /data/restore.sqlite /data/fintrack.sqlite
    rm -f /data/fintrack.sqlite-wal /data/fintrack.sqlite-shm
  `], { env, input: snapshot, timeout: 30000 });
  compose('up', '-d', '--no-build');
  await healthy();
  assert.equal(sql('SELECT SUM(amount) AS n FROM transactions')[0].n, 750);
  console.log('Docker smoke passed: non-root startup, migrations, channel ingestion, exact savings, PDF, live backup, health, graceful restart, persistence and restore.');
} catch (error) {
  try { console.error(compose('logs', '--no-color', '--tail', '80', 'bot')); } catch {}
  throw error;
} finally {
  compose('down', '--volumes', '--remove-orphans');
}
