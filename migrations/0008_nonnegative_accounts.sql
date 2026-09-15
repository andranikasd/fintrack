-- Validate daily running balances, including backdated changes. Existing records
-- remain untouched; reconcile historical deficits before changing those accounts.
CREATE VIEW account_daily_balances AS
WITH movements AS (
 SELECT id AS account_id,user_id,opening_on AS day,opening_minor AS amount FROM accounts
 UNION ALL SELECT i.account_id,i.user_id,i.received_on,i.amount_minor FROM income i JOIN accounts a ON a.id=i.account_id WHERE i.received_on>=a.opening_on
 UNION ALL SELECT t.account_id,t.user_id,t.spent_on,-t.amount*100 FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.spent_on>=a.opening_on
 UNION ALL SELECT s.account_id,s.user_id,s.saved_on,-s.amount_minor FROM savings s JOIN accounts a ON a.id=s.account_id WHERE s.saved_on>=a.opening_on
), daily AS (SELECT account_id,user_id,day,SUM(amount) AS amount FROM movements GROUP BY account_id,user_id,day)
SELECT account_id,user_id,day,SUM(amount) OVER (PARTITION BY account_id ORDER BY day) AS balance_minor FROM daily;

-- Channel replacements validate their final state in the same atomic batch.
CREATE TABLE account_balance_batches(user_id INTEGER PRIMARY KEY);
CREATE TABLE account_balance_dirty(user_id INTEGER NOT NULL,account_id INTEGER NOT NULL,PRIMARY KEY(user_id,account_id));
CREATE TRIGGER account_balance_batch_finish BEFORE DELETE ON account_balance_batches BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM account_daily_balances b JOIN account_balance_dirty d ON d.account_id=b.account_id WHERE d.user_id=OLD.user_id AND b.balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
 DELETE FROM account_balance_dirty WHERE user_id=OLD.user_id;
END;
CREATE TRIGGER balance_transactions_insert AFTER INSERT ON transactions BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_transactions_update AFTER UPDATE OF account_id,user_id,amount,spent_on ON transactions BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_transactions_delete AFTER DELETE ON transactions BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_income_insert AFTER INSERT ON income BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_income_update AFTER UPDATE OF account_id,user_id,amount_minor,received_on ON income BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_income_delete AFTER DELETE ON income BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_savings_insert AFTER INSERT ON savings BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_savings_update AFTER UPDATE OF account_id,user_id,amount_minor,saved_on ON savings BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_savings_delete AFTER DELETE ON savings BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
END;
CREATE TRIGGER balance_accounts_insert AFTER INSERT ON accounts BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
 SELECT CASE WHEN NEW.opening_minor<0 THEN RAISE(ABORT,'Account opening balance cannot be negative.') END;
END;
CREATE TRIGGER balance_accounts_update AFTER UPDATE OF opening_minor,opening_on ON accounts BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative. Check /accounts and correct the amount, date or funding.') END;
 SELECT CASE WHEN NEW.opening_minor<0 THEN RAISE(ABORT,'Account opening balance cannot be negative.') END;
END;
