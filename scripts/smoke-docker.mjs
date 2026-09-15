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
  compose('exec', '-T', 'bot', 'node', 'dist/backup.mjs', '/backups/smoke.sqlite');
  assert.equal(compose('exec', '-T', 'bot', 'sqlite3', '/backups/smoke.sqlite', 'SELECT SUM(amount) FROM transactions;').trim(), '750');
  compose('restart', 'bot');
  await healthy();
  assert.equal(sql('SELECT SUM(amount) AS n FROM transactions')[0].n, 750);
  assert.equal(sql('SELECT COUNT(*) AS n FROM schema_migrations')[0].n, 2);
  const snapshot = execFileSync('docker', [...args, 'exec', '-T', 'bot', 'cat', '/backups/smoke.sqlite'], { env });
  sql("INSERT INTO transactions(user_id,amount,note,spent_on) VALUES(123456789,100,'after backup','2026-09-15') RETURNING id");
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
