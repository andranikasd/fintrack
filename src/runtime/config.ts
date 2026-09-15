import { resolve } from 'node:path';

export function loadConfig(values: NodeJS.ProcessEnv) {
  const token = values.BOT_TOKEN?.trim() ?? '';
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token) || /replace|example/i.test(token)) {
    throw new Error('Set BOT_TOKEN to the token supplied by BotFather.');
  }
  const ids = values.ALLOWED_USER_IDS?.trim() ?? '';
  if (!/^\d+(\s*,\s*\d+)*$/.test(ids) || ids.split(',').some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new Error('Set ALLOWED_USER_IDS to your numeric Telegram user ID (comma-separated for several owners).');
  }
  const tz = values.DEFAULT_TZ?.trim() || 'Asia/Yerevan';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }).format(); }
  catch { throw new Error('DEFAULT_TZ must be an IANA timezone, e.g. Asia/Yerevan.'); }
  const retention = Number(values.BACKUP_RETENTION_DAYS || '7');
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
    throw new Error('BACKUP_RETENTION_DAYS must be an integer between 1 and 365.');
  }
  const dataDir = resolve(values.DATA_DIR || '/data');
  const backupDir = resolve(values.BACKUP_DIR || '/backups');
  return { token, ids, tz, dataDir, backupDir, retention };
}
