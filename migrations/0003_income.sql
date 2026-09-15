-- Income is received money, distinct from expenses and savings transfers.
CREATE TABLE income (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  received_on TEXT NOT NULL,
  source_chat INTEGER,
  source_message INTEGER,
  event_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX income_user_date ON income(user_id, received_on);
CREATE INDEX income_post ON income(source_chat, source_message);
