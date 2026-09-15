import type { Database } from '../database';

async function digest(token: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
}
export class DashboardAuth {
  constructor(private readonly db: Database) {}
  async issue(user: number, purpose: 'login' | 'session', now = Date.now()): Promise<string> {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
    await this.db.prepare('DELETE FROM dashboard_tokens WHERE expires_at<=?').bind(now).run();
    await this.db.prepare('INSERT INTO dashboard_tokens(digest,user_id,purpose,expires_at) VALUES(?,?,?,?)')
      .bind(await digest(token),user,purpose,now+(purpose==='login'?10*60000:24*3600000)).run();
    return token;
  }
  async consumeLogin(token: string, now = Date.now()): Promise<number | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return (await this.db.prepare("DELETE FROM dashboard_tokens WHERE digest=? AND purpose='login' AND expires_at>? RETURNING user_id")
      .bind(await digest(token),now).first<{user_id:number}>())?.user_id ?? null;
  }
  async session(token: string, now = Date.now()): Promise<number | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return (await this.db.prepare("SELECT user_id FROM dashboard_tokens WHERE digest=? AND purpose='session' AND expires_at>?")
      .bind(await digest(token),now).first<{user_id:number}>())?.user_id ?? null;
  }
  async revoke(token: string) { await this.db.prepare('DELETE FROM dashboard_tokens WHERE digest=?').bind(await digest(token)).run(); }
}
