CREATE TABLE dashboard_tokens (
  digest TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('login','session')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX dashboard_tokens_expiry ON dashboard_tokens(expires_at);
ALTER TABLE transactions ADD COLUMN dashboard_event TEXT;
CREATE UNIQUE INDEX transactions_dashboard_event ON transactions(dashboard_event);
