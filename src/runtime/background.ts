import type { BackgroundWork } from '../database';

export class BackgroundTasks implements BackgroundWork {
  private readonly pending = new Set<Promise<unknown>>();

  waitUntil(promise: Promise<unknown>): void {
    const tracked = promise.catch(error => {
      // Do not log request objects: Telegram URLs can contain the bot token.
      console.error('Background task failed:', error instanceof Error ? error.name : 'unknown error');
    });
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
