-- Additive storage for resumable forms, real account transfers and recurring bills.
-- Existing entries and opening balances are preserved.
ALTER TABLE goals ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER goal_plan_version AFTER UPDATE OF name,target_minor,opening_minor,deadline,daily_minor,cap_minor ON goals BEGIN
 UPDATE goals SET version=version+1 WHERE id=NEW.id;
END;
CREATE TABLE saved_drafts (
 user_id INTEGER NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,request)
);
CREATE TABLE account_transfers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,
 from_account_id INTEGER NOT NULL REFERENCES accounts(id),to_account_id INTEGER NOT NULL REFERENCES accounts(id),
 amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor>0 AND amount_minor<=100000000000),
 transferred_on TEXT NOT NULL CHECK(length(transferred_on)=10 AND date(transferred_on)=transferred_on),
 note TEXT NOT NULL DEFAULT '',event_key TEXT NOT NULL UNIQUE,
 CHECK(from_account_id<>to_account_id)
);
CREATE INDEX transfers_by_date ON account_transfers(user_id,transferred_on);
CREATE TABLE recurring_bills (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,label TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor>0 AND amount_minor%100=0),
 account_id INTEGER NOT NULL REFERENCES accounts(id),category_id INTEGER REFERENCES categories(id),
 frequency TEXT NOT NULL CHECK(frequency IN ('weekly','monthly')),anchor_day INTEGER NOT NULL CHECK(anchor_day BETWEEN 1 AND 31),
 next_due TEXT NOT NULL,remind_time TEXT NOT NULL DEFAULT '09:00',enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1,event_key TEXT NOT NULL UNIQUE
);
CREATE TABLE bill_occurrences (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,rule_id INTEGER NOT NULL REFERENCES recurring_bills(id),
 rule_version INTEGER NOT NULL,due_on TEXT NOT NULL,label TEXT NOT NULL,amount_minor INTEGER NOT NULL,
 account_id INTEGER NOT NULL,category_id INTEGER,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','skipped','cancelled')),
 transaction_id INTEGER,UNIQUE(rule_id,due_on,rule_version)
);
CREATE INDEX bills_due ON recurring_bills(user_id,enabled,next_due);
DROP VIEW account_daily_balances;
CREATE VIEW account_daily_balances AS
WITH movements AS (
 SELECT id AS account_id,user_id,opening_on AS day,opening_minor AS amount FROM accounts
 UNION ALL SELECT i.account_id,i.user_id,i.received_on,i.amount_minor FROM income i JOIN accounts a ON a.id=i.account_id WHERE i.received_on>=a.opening_on
 UNION ALL SELECT t.account_id,t.user_id,t.spent_on,-t.amount*100 FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.spent_on>=a.opening_on
 UNION ALL SELECT s.account_id,s.user_id,s.saved_on,-s.amount_minor FROM savings s JOIN accounts a ON a.id=s.account_id WHERE s.saved_on>=a.opening_on
 UNION ALL SELECT t.from_account_id,t.user_id,t.transferred_on,-t.amount_minor FROM account_transfers t JOIN accounts a ON a.id=t.from_account_id WHERE t.transferred_on>=a.opening_on
 UNION ALL SELECT t.to_account_id,t.user_id,t.transferred_on,t.amount_minor FROM account_transfers t JOIN accounts a ON a.id=t.to_account_id WHERE t.transferred_on>=a.opening_on
), daily AS (SELECT account_id,user_id,day,SUM(amount) AS amount FROM movements GROUP BY account_id,user_id,day)
SELECT account_id,user_id,day,SUM(amount) OVER (PARTITION BY account_id ORDER BY day) AS balance_minor FROM daily;

CREATE TRIGGER transfers_owned_insert BEFORE INSERT ON account_transfers BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.from_account_id AND user_id=NEW.user_id AND archived=0 AND opening_on<=NEW.transferred_on)
 OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.to_account_id AND user_id=NEW.user_id AND archived=0 AND opening_on<=NEW.transferred_on)
 THEN RAISE(ABORT,'Choose two active accounts owned by you, on or after their opening dates.') END;
END;
CREATE TRIGGER transfers_owned_update BEFORE UPDATE ON account_transfers BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.from_account_id AND user_id=NEW.user_id AND archived=0 AND opening_on<=NEW.transferred_on)
 OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.to_account_id AND user_id=NEW.user_id AND archived=0 AND opening_on<=NEW.transferred_on)
 THEN RAISE(ABORT,'Choose two active accounts owned by you, on or after their opening dates.') END;
END;
CREATE TRIGGER transfers_opening_date BEFORE UPDATE OF opening_on ON accounts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM account_transfers WHERE (from_account_id=NEW.id OR to_account_id=NEW.id) AND transferred_on<NEW.opening_on)
 THEN RAISE(ABORT,'The opening date cannot be after an existing account transfer.') END;
END;
CREATE TRIGGER balance_transfers_insert AFTER INSERT ON account_transfers BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.from_account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.from_account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.to_account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.to_account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative.') END;
END;
CREATE TRIGGER history_transfers_insert AFTER INSERT ON account_transfers BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'transfer',NEW.id,'insert',NULL,json_object('id',NEW.id,'from_account_id',NEW.from_account_id,'to_account_id',NEW.to_account_id,'amount_minor',NEW.amount_minor,'transferred_on',NEW.transferred_on,'note',NEW.note));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day=NEW.transferred_on;
 DELETE FROM month_reviews WHERE user_id=NEW.user_id AND period=substr(NEW.transferred_on,1,7);
END;
CREATE TRIGGER balance_transfers_update AFTER UPDATE ON account_transfers BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.from_account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.from_account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.to_account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.to_account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.from_account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.from_account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT NEW.user_id,NEW.to_account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=NEW.to_account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative.') END;
END;
CREATE TRIGGER history_transfers_update AFTER UPDATE ON account_transfers BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'transfer',NEW.id,'update',json_object('id',OLD.id,'from_account_id',OLD.from_account_id,'to_account_id',OLD.to_account_id,'amount_minor',OLD.amount_minor,'transferred_on',OLD.transferred_on,'note',OLD.note),json_object('id',NEW.id,'from_account_id',NEW.from_account_id,'to_account_id',NEW.to_account_id,'amount_minor',NEW.amount_minor,'transferred_on',NEW.transferred_on,'note',NEW.note));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day=NEW.transferred_on;
 DELETE FROM month_reviews WHERE user_id=NEW.user_id AND period=substr(NEW.transferred_on,1,7);
END;
CREATE TRIGGER balance_transfers_delete AFTER DELETE ON account_transfers BEGIN
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.from_account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.from_account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative.') END;
 INSERT OR IGNORE INTO account_balance_dirty(user_id,account_id) SELECT OLD.user_id,OLD.to_account_id WHERE EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id);
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM account_daily_balances WHERE account_id=OLD.to_account_id AND balance_minor<0)
 THEN RAISE(ABORT,'Insufficient funds: this change would make an account balance negative.') END;
END;
CREATE TRIGGER history_transfers_delete AFTER DELETE ON account_transfers BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'transfer',OLD.id,'delete',json_object('id',OLD.id,'from_account_id',OLD.from_account_id,'to_account_id',OLD.to_account_id,'amount_minor',OLD.amount_minor,'transferred_on',OLD.transferred_on,'note',OLD.note),NULL);
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day=OLD.transferred_on;
 DELETE FROM month_reviews WHERE user_id=OLD.user_id AND period=substr(OLD.transferred_on,1,7);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER goal_balance_savings_insert AFTER INSERT ON savings BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM goals WHERE id=NEW.goal_id AND opening_minor+COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=goals.id),0)<0)
 THEN RAISE(ABORT,'This change exceeds the saved balance in the goal.') END;
END;
CREATE TRIGGER goal_balance_savings_update AFTER UPDATE ON savings BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM goals WHERE id=OLD.goal_id AND opening_minor+COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=goals.id),0)<0)
 THEN RAISE(ABORT,'This change exceeds the saved balance in the goal.') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=NEW.user_id) AND EXISTS(SELECT 1 FROM goals WHERE id=NEW.goal_id AND opening_minor+COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=goals.id),0)<0)
 THEN RAISE(ABORT,'This change exceeds the saved balance in the goal.') END;
END;
CREATE TRIGGER goal_balance_savings_delete AFTER DELETE ON savings BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_balance_batches WHERE user_id=OLD.user_id) AND EXISTS(SELECT 1 FROM goals WHERE id=OLD.goal_id AND opening_minor+COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=goals.id),0)<0)
 THEN RAISE(ABORT,'This change exceeds the saved balance in the goal.') END;
END;
CREATE TRIGGER goal_balance_batch_finish BEFORE DELETE ON account_balance_batches BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM goals WHERE user_id=OLD.user_id AND opening_minor+COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=goals.id),0)<0)
 THEN RAISE(ABORT,'This change exceeds the saved balance in the goal.') END;
END;
CREATE TRIGGER goal_balance_opening AFTER UPDATE OF opening_minor ON goals BEGIN
 SELECT CASE WHEN NEW.opening_minor+COALESCE((SELECT SUM(amount_minor) FROM savings WHERE goal_id=NEW.id),0)<0
 THEN RAISE(ABORT,'This change exceeds the saved balance in the goal.') END;
END;
