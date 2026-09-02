import type { Context } from 'grammy';
import type { Db } from './db';
import type { Env } from './types';

export interface AppContext extends Context {
  env: Env;
  db: Db;
  /** The user's timezone, resolved once per update. */
  tz: string;
  /** Currency sign used in chat messages. */
  sign: string;
  /** Worker execution context, for work that outlives the webhook response. */
  exec: ExecutionContext;
  userId: number;
}
