-- Migration number: 0001 	 fintrack initial schema

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,                       -- telegram user id
  tz          TEXT    NOT NULL DEFAULT 'Asia/Yerevan',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  emoji       TEXT    NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name
  ON categories(user_id, lower(name));

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  category_id INTEGER,                                   -- NULL = uncategorised
  amount      INTEGER NOT NULL,                          -- whole drams
  note        TEXT    NOT NULL DEFAULT '',
  spent_on    TEXT    NOT NULL,                          -- YYYY-MM-DD, user local
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS transactions_user_date
  ON transactions(user_id, spent_on);

-- category_id 0 means "whole month", so the primary key stays NULL-free.
CREATE TABLE IF NOT EXISTS budgets (
  user_id     INTEGER NOT NULL,
  category_id INTEGER NOT NULL DEFAULT 0,
  amount      INTEGER NOT NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, category_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  user_id     INTEGER NOT NULL,
  period      TEXT    NOT NULL,                          -- YYYY-MM
  category_id INTEGER NOT NULL DEFAULT 0,
  threshold   INTEGER NOT NULL,                          -- percent
  sent_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, period, category_id, threshold)
);

CREATE TABLE IF NOT EXISTS sessions (
  user_id     INTEGER PRIMARY KEY,
  state       TEXT    NOT NULL,
  payload     TEXT    NOT NULL DEFAULT '{}',
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
