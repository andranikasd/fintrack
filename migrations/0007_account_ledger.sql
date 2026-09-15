-- Savings transfers debit their source account; withdrawals credit it.
ALTER TABLE savings ADD COLUMN account_id INTEGER REFERENCES accounts(id);
CREATE INDEX savings_account ON savings(user_id,account_id,saved_on);
ALTER TABLE channel_posts ADD COLUMN bot_managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_posts ADD COLUMN content TEXT;

-- Preserve old amounts without guessing which real account funded them.
-- Reconcile these explicitly named historical accounts after upgrading.
INSERT INTO accounts(user_id,name,opening_minor,opening_on,event_key,archived)
SELECT id,'Legacy unassigned ' || lower(hex(randomblob(4))),0,'0001-01-01','migration:0007:' || id,1
FROM users WHERE id IN (
 SELECT user_id FROM transactions WHERE account_id IS NULL
 UNION SELECT user_id FROM income WHERE account_id IS NULL
 UNION SELECT user_id FROM savings WHERE account_id IS NULL
);
UPDATE transactions SET account_id=(SELECT id FROM accounts WHERE event_key='migration:0007:' || transactions.user_id) WHERE account_id IS NULL;
UPDATE income SET account_id=(SELECT id FROM accounts WHERE event_key='migration:0007:' || income.user_id) WHERE account_id IS NULL;
UPDATE savings SET account_id=(SELECT id FROM accounts WHERE event_key='migration:0007:' || savings.user_id) WHERE account_id IS NULL;
CREATE TRIGGER ledger_transactions_insert BEFORE INSERT ON transactions BEGIN
 SELECT CASE WHEN NEW.account_id IS NULL OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND user_id=NEW.user_id)
 THEN RAISE(ABORT,'An owned account is required for every financial entry.') END;
 SELECT CASE WHEN typeof(NEW.amount) != 'integer' OR NOT (NEW.amount > 0 AND NEW.amount <= 90071992547409)
 THEN RAISE(ABORT,'Invalid ledger amount.') END;
END;
CREATE TRIGGER ledger_transactions_update BEFORE UPDATE OF account_id,user_id,amount,spent_on ON transactions BEGIN
 SELECT CASE WHEN NEW.account_id IS NULL OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND user_id=NEW.user_id)
 THEN RAISE(ABORT,'An owned account is required for every financial entry.') END;
 SELECT CASE WHEN typeof(NEW.amount) != 'integer' OR NOT (NEW.amount > 0 AND NEW.amount <= 90071992547409)
 THEN RAISE(ABORT,'Invalid ledger amount.') END;
END;
CREATE TRIGGER ledger_income_insert BEFORE INSERT ON income BEGIN
 SELECT CASE WHEN NEW.account_id IS NULL OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND user_id=NEW.user_id)
 THEN RAISE(ABORT,'An owned account is required for every financial entry.') END;
 SELECT CASE WHEN typeof(NEW.amount_minor) != 'integer' OR NOT (NEW.amount_minor > 0 AND NEW.amount_minor <= 9007199254740991)
 THEN RAISE(ABORT,'Invalid ledger amount.') END;
END;
CREATE TRIGGER ledger_income_update BEFORE UPDATE OF account_id,user_id,amount_minor,received_on ON income BEGIN
 SELECT CASE WHEN NEW.account_id IS NULL OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND user_id=NEW.user_id)
 THEN RAISE(ABORT,'An owned account is required for every financial entry.') END;
 SELECT CASE WHEN typeof(NEW.amount_minor) != 'integer' OR NOT (NEW.amount_minor > 0 AND NEW.amount_minor <= 9007199254740991)
 THEN RAISE(ABORT,'Invalid ledger amount.') END;
END;
CREATE TRIGGER ledger_savings_insert BEFORE INSERT ON savings BEGIN
 SELECT CASE WHEN NEW.account_id IS NULL OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND user_id=NEW.user_id)
 THEN RAISE(ABORT,'An owned account is required for every financial entry.') END;
 SELECT CASE WHEN typeof(NEW.amount_minor) != 'integer' OR NOT (NEW.amount_minor != 0 AND abs(NEW.amount_minor) <= 9007199254740991)
 THEN RAISE(ABORT,'Invalid ledger amount.') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM goals WHERE id=NEW.goal_id AND user_id=NEW.user_id) THEN RAISE(ABORT,'Savings goal belongs to another user.') END;
END;
CREATE TRIGGER ledger_savings_update BEFORE UPDATE OF account_id,user_id,amount_minor,saved_on,goal_id ON savings BEGIN
 SELECT CASE WHEN NEW.account_id IS NULL OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND user_id=NEW.user_id)
 THEN RAISE(ABORT,'An owned account is required for every financial entry.') END;
 SELECT CASE WHEN typeof(NEW.amount_minor) != 'integer' OR NOT (NEW.amount_minor != 0 AND abs(NEW.amount_minor) <= 9007199254740991)
 THEN RAISE(ABORT,'Invalid ledger amount.') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM goals WHERE id=NEW.goal_id AND user_id=NEW.user_id) THEN RAISE(ABORT,'Savings goal belongs to another user.') END;
END;

DROP TRIGGER history_savings_insert;
DROP TRIGGER history_savings_update;
DROP TRIGGER history_savings_delete;
CREATE TRIGGER history_savings_insert AFTER INSERT ON savings BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'savings',NEW.id,'insert',NULL,json_object('id',NEW.id,'user_id',NEW.user_id,'goal_id',NEW.goal_id,'amount_minor',NEW.amount_minor,'saved_on',NEW.saved_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'event_key',NEW.event_key,'account_id',NEW.account_id));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN (NEW.saved_on);
END;
CREATE TRIGGER history_savings_update AFTER UPDATE ON savings WHEN json_object('id',OLD.id,'user_id',OLD.user_id,'goal_id',OLD.goal_id,'amount_minor',OLD.amount_minor,'saved_on',OLD.saved_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'event_key',OLD.event_key,'account_id',OLD.account_id) IS NOT json_object('id',NEW.id,'user_id',NEW.user_id,'goal_id',NEW.goal_id,'amount_minor',NEW.amount_minor,'saved_on',NEW.saved_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'event_key',NEW.event_key,'account_id',NEW.account_id) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'savings',NEW.id,'update',json_object('id',OLD.id,'user_id',OLD.user_id,'goal_id',OLD.goal_id,'amount_minor',OLD.amount_minor,'saved_on',OLD.saved_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'event_key',OLD.event_key,'account_id',OLD.account_id),json_object('id',NEW.id,'user_id',NEW.user_id,'goal_id',NEW.goal_id,'amount_minor',NEW.amount_minor,'saved_on',NEW.saved_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'event_key',NEW.event_key,'account_id',NEW.account_id));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN (OLD.saved_on,NEW.saved_on);
END;
CREATE TRIGGER history_savings_delete AFTER DELETE ON savings BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'savings',OLD.id,'delete',json_object('id',OLD.id,'user_id',OLD.user_id,'goal_id',OLD.goal_id,'amount_minor',OLD.amount_minor,'saved_on',OLD.saved_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'event_key',OLD.event_key,'account_id',OLD.account_id),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN (OLD.saved_on);
END;

-- A Telegram request can be retried; sending it twice would duplicate spending.
CREATE TABLE channel_add_requests (
 event_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','done','uncertain')),
 started_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX channel_add_in_progress ON channel_add_requests(chat_id) WHERE status='pending';

CREATE TRIGGER ledger_category_insert BEFORE INSERT ON transactions
WHEN NEW.category_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM categories WHERE id=NEW.category_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'Choose a category owned by you.'); END;
CREATE TRIGGER ledger_category_update BEFORE UPDATE OF category_id,user_id ON transactions
WHEN NEW.category_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM categories WHERE id=NEW.category_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'Choose a category owned by you.'); END;
