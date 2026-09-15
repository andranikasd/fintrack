import type { Database } from './database';
export interface Env {
  DB: Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  DEFAULT_TZ: string;
  CURRENCY: string;
  CURRENCY_SIGN: string;
  ALLOWED_USER_IDS: string;
  BOT_INFO?: string;
  DASHBOARD_URL?: string;
}

export interface Category {
  id: number;
  user_id: number;
  name: string;
  emoji: string;
  archived: number;
  sort: number;
}

export interface Transaction {
  account_id?: number | null;
  source_chat?: number | null;
  source_message?: number | null;
  id: number;
  user_id: number;
  category_id: number | null;
  amount: number;
  note: string;
  spent_on: string;
  created_at: string;
}

export interface TxWithCategory extends Transaction {
  category_name: string | null;
  category_emoji: string | null;
}

export interface CategoryTotal {
  category_id: number | null;
  name: string;
  emoji: string;
  total: number;
  count: number;
}

export interface Budget {
  category_id: number;
  amount: number;
}
