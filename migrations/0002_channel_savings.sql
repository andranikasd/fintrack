-- Existing expenses/budgets remain whole AMD; savings use integer hundredths of AMD.
ALTER TABLE transactions ADD COLUMN source_chat INTEGER;
ALTER TABLE transactions ADD COLUMN source_message INTEGER;
CREATE INDEX transactions_source ON transactions(source_chat, source_message);
CREATE TABLE channels (
  chat_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL
);
CREATE TABLE channel_posts (
  chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  version INTEGER NOT NULL, update_id INTEGER NOT NULL, nonce TEXT NOT NULL,
  spent_on TEXT, error TEXT, PRIMARY KEY(chat_id, message_id)
);
CREATE TABLE finance_preferences (
  user_id INTEGER PRIMARY KEY, funding TEXT NOT NULL DEFAULT 'separate' CHECK(funding IN ('shared','separate')),
  reserve_minor INTEGER NOT NULL DEFAULT 0 CHECK(reserve_minor >= 0),
  reminder_time TEXT, summary_time TEXT
);
CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE, target_minor INTEGER NOT NULL CHECK(target_minor > 0),
  opening_minor INTEGER NOT NULL DEFAULT 0 CHECK(opening_minor >= 0),
  deadline TEXT, daily_minor INTEGER, cap_minor INTEGER,
  UNIQUE(user_id, name), CHECK(deadline IS NOT NULL OR daily_minor > 0)
);
CREATE TABLE savings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, goal_id INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor != 0), saved_on TEXT NOT NULL,
  source_chat INTEGER, source_message INTEGER, event_key TEXT UNIQUE,
  FOREIGN KEY(goal_id) REFERENCES goals(id)
);
CREATE INDEX savings_date ON savings(user_id, saved_on);
CREATE INDEX savings_source ON savings(source_chat, source_message);
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, goal_id INTEGER NOT NULL,
  day TEXT NOT NULL, amount_minor INTEGER NOT NULL, baseline_minor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(user_id, goal_id, day)
);
CREATE TABLE deliveries (
  user_id INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, day, kind)
);
CREATE TABLE aliases (
  user_id INTEGER NOT NULL, label TEXT NOT NULL COLLATE NOCASE, category_id INTEGER NOT NULL,
  PRIMARY KEY(user_id,label)
);
