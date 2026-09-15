CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL COLLATE NOCASE,
  opening_minor INTEGER NOT NULL DEFAULT 0,
  opening_on TEXT NOT NULL,
  passive_income INTEGER NOT NULL DEFAULT 0 CHECK(passive_income IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  event_key TEXT UNIQUE,
  UNIQUE(user_id,name)
);
ALTER TABLE income ADD COLUMN account_id INTEGER REFERENCES accounts(id);
ALTER TABLE income ADD COLUMN passive INTEGER NOT NULL DEFAULT 0 CHECK(passive IN (0,1));
ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id);
CREATE INDEX income_account ON income(user_id,account_id,received_on);
CREATE INDEX transactions_account ON transactions(user_id,account_id,spent_on);
-- Keep old names resolving in channel tables after an account is renamed.
CREATE TABLE account_names (
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL COLLATE NOCASE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  PRIMARY KEY(user_id,name)
);
