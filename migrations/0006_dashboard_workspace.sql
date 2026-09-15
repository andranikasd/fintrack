CREATE TABLE finance_revisions(user_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO finance_revisions(user_id) SELECT id FROM users;
CREATE TABLE mutation_guards(id TEXT PRIMARY KEY, expected INTEGER NOT NULL, actual INTEGER NOT NULL, CHECK(expected=actual));
CREATE TABLE change_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,entity TEXT NOT NULL,record_id INTEGER NOT NULL,
 operation TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),undone_at TEXT
);
CREATE INDEX history_user ON change_history(user_id,id DESC);
CREATE TABLE saved_views(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,name TEXT NOT NULL COLLATE NOCASE,settings TEXT NOT NULL,UNIQUE(user_id,name));
CREATE TABLE logging_days(user_id INTEGER NOT NULL,day TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('complete','no-spend')),PRIMARY KEY(user_id,day));
CREATE TABLE month_reviews(user_id INTEGER NOT NULL,period TEXT NOT NULL,fingerprint TEXT NOT NULL,reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,period));
CREATE TABLE balance_checks(user_id INTEGER NOT NULL,period TEXT NOT NULL,account_id INTEGER NOT NULL REFERENCES accounts(id),actual_minor INTEGER NOT NULL,PRIMARY KEY(user_id,period,account_id));
CREATE TABLE entry_attachments(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,entry_key TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,data TEXT,note TEXT NOT NULL DEFAULT '',event_key TEXT UNIQUE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX attachments_user ON entry_attachments(user_id,entry_key);
CREATE TRIGGER history_transactions_insert AFTER INSERT ON transactions BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'transactions',NEW.id,'insert',NULL,json_object('id',NEW.id,'user_id',NEW.user_id,'category_id',NEW.category_id,'amount',NEW.amount,'note',NEW.note,'spent_on',NEW.spent_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'account_id',NEW.account_id,'dashboard_event',NEW.dashboard_event,'created_at',NEW.created_at));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN (NEW.spent_on);
END;
CREATE TRIGGER history_transactions_update AFTER UPDATE ON transactions WHEN json_object('id',OLD.id,'user_id',OLD.user_id,'category_id',OLD.category_id,'amount',OLD.amount,'note',OLD.note,'spent_on',OLD.spent_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'account_id',OLD.account_id,'dashboard_event',OLD.dashboard_event,'created_at',OLD.created_at) IS NOT json_object('id',NEW.id,'user_id',NEW.user_id,'category_id',NEW.category_id,'amount',NEW.amount,'note',NEW.note,'spent_on',NEW.spent_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'account_id',NEW.account_id,'dashboard_event',NEW.dashboard_event,'created_at',NEW.created_at) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'transactions',NEW.id,'update',json_object('id',OLD.id,'user_id',OLD.user_id,'category_id',OLD.category_id,'amount',OLD.amount,'note',OLD.note,'spent_on',OLD.spent_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'account_id',OLD.account_id,'dashboard_event',OLD.dashboard_event,'created_at',OLD.created_at),json_object('id',NEW.id,'user_id',NEW.user_id,'category_id',NEW.category_id,'amount',NEW.amount,'note',NEW.note,'spent_on',NEW.spent_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'account_id',NEW.account_id,'dashboard_event',NEW.dashboard_event,'created_at',NEW.created_at));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN (OLD.spent_on,NEW.spent_on);
END;
CREATE TRIGGER history_transactions_delete AFTER DELETE ON transactions BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'transactions',OLD.id,'delete',json_object('id',OLD.id,'user_id',OLD.user_id,'category_id',OLD.category_id,'amount',OLD.amount,'note',OLD.note,'spent_on',OLD.spent_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'account_id',OLD.account_id,'dashboard_event',OLD.dashboard_event,'created_at',OLD.created_at),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN (OLD.spent_on);
END;
CREATE TRIGGER history_income_insert AFTER INSERT ON income BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'income',NEW.id,'insert',NULL,json_object('id',NEW.id,'user_id',NEW.user_id,'source',NEW.source,'amount_minor',NEW.amount_minor,'received_on',NEW.received_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'account_id',NEW.account_id,'passive',NEW.passive,'event_key',NEW.event_key,'created_at',NEW.created_at));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN (NEW.received_on);
END;
CREATE TRIGGER history_income_update AFTER UPDATE ON income WHEN json_object('id',OLD.id,'user_id',OLD.user_id,'source',OLD.source,'amount_minor',OLD.amount_minor,'received_on',OLD.received_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'account_id',OLD.account_id,'passive',OLD.passive,'event_key',OLD.event_key,'created_at',OLD.created_at) IS NOT json_object('id',NEW.id,'user_id',NEW.user_id,'source',NEW.source,'amount_minor',NEW.amount_minor,'received_on',NEW.received_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'account_id',NEW.account_id,'passive',NEW.passive,'event_key',NEW.event_key,'created_at',NEW.created_at) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'income',NEW.id,'update',json_object('id',OLD.id,'user_id',OLD.user_id,'source',OLD.source,'amount_minor',OLD.amount_minor,'received_on',OLD.received_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'account_id',OLD.account_id,'passive',OLD.passive,'event_key',OLD.event_key,'created_at',OLD.created_at),json_object('id',NEW.id,'user_id',NEW.user_id,'source',NEW.source,'amount_minor',NEW.amount_minor,'received_on',NEW.received_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'account_id',NEW.account_id,'passive',NEW.passive,'event_key',NEW.event_key,'created_at',NEW.created_at));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN (OLD.received_on,NEW.received_on);
END;
CREATE TRIGGER history_income_delete AFTER DELETE ON income BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'income',OLD.id,'delete',json_object('id',OLD.id,'user_id',OLD.user_id,'source',OLD.source,'amount_minor',OLD.amount_minor,'received_on',OLD.received_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'account_id',OLD.account_id,'passive',OLD.passive,'event_key',OLD.event_key,'created_at',OLD.created_at),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN (OLD.received_on);
END;
CREATE TRIGGER history_savings_insert AFTER INSERT ON savings BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'savings',NEW.id,'insert',NULL,json_object('id',NEW.id,'user_id',NEW.user_id,'goal_id',NEW.goal_id,'amount_minor',NEW.amount_minor,'saved_on',NEW.saved_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'event_key',NEW.event_key));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN (NEW.saved_on);
END;
CREATE TRIGGER history_savings_update AFTER UPDATE ON savings WHEN json_object('id',OLD.id,'user_id',OLD.user_id,'goal_id',OLD.goal_id,'amount_minor',OLD.amount_minor,'saved_on',OLD.saved_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'event_key',OLD.event_key) IS NOT json_object('id',NEW.id,'user_id',NEW.user_id,'goal_id',NEW.goal_id,'amount_minor',NEW.amount_minor,'saved_on',NEW.saved_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'event_key',NEW.event_key) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'savings',NEW.id,'update',json_object('id',OLD.id,'user_id',OLD.user_id,'goal_id',OLD.goal_id,'amount_minor',OLD.amount_minor,'saved_on',OLD.saved_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'event_key',OLD.event_key),json_object('id',NEW.id,'user_id',NEW.user_id,'goal_id',NEW.goal_id,'amount_minor',NEW.amount_minor,'saved_on',NEW.saved_on,'source_chat',NEW.source_chat,'source_message',NEW.source_message,'event_key',NEW.event_key));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN (OLD.saved_on,NEW.saved_on);
END;
CREATE TRIGGER history_savings_delete AFTER DELETE ON savings BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'savings',OLD.id,'delete',json_object('id',OLD.id,'user_id',OLD.user_id,'goal_id',OLD.goal_id,'amount_minor',OLD.amount_minor,'saved_on',OLD.saved_on,'source_chat',OLD.source_chat,'source_message',OLD.source_message,'event_key',OLD.event_key),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN (OLD.saved_on);
END;
CREATE TRIGGER history_accounts_insert AFTER INSERT ON accounts BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'accounts',NEW.id,'insert',NULL,json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'opening_minor',NEW.opening_minor,'opening_on',NEW.opening_on,'passive_income',NEW.passive_income,'archived',NEW.archived,'version',NEW.version,'event_key',NEW.event_key));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_accounts_update AFTER UPDATE ON accounts WHEN json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'opening_minor',OLD.opening_minor,'opening_on',OLD.opening_on,'passive_income',OLD.passive_income,'archived',OLD.archived,'version',OLD.version,'event_key',OLD.event_key) IS NOT json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'opening_minor',NEW.opening_minor,'opening_on',NEW.opening_on,'passive_income',NEW.passive_income,'archived',NEW.archived,'version',NEW.version,'event_key',NEW.event_key) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'accounts',NEW.id,'update',json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'opening_minor',OLD.opening_minor,'opening_on',OLD.opening_on,'passive_income',OLD.passive_income,'archived',OLD.archived,'version',OLD.version,'event_key',OLD.event_key),json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'opening_minor',NEW.opening_minor,'opening_on',NEW.opening_on,'passive_income',NEW.passive_income,'archived',NEW.archived,'version',NEW.version,'event_key',NEW.event_key));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_accounts_delete AFTER DELETE ON accounts BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'accounts',OLD.id,'delete',json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'opening_minor',OLD.opening_minor,'opening_on',OLD.opening_on,'passive_income',OLD.passive_income,'archived',OLD.archived,'version',OLD.version,'event_key',OLD.event_key),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_goals_insert AFTER INSERT ON goals BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'goals',NEW.id,'insert',NULL,json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'target_minor',NEW.target_minor,'opening_minor',NEW.opening_minor,'deadline',NEW.deadline,'daily_minor',NEW.daily_minor,'cap_minor',NEW.cap_minor));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_goals_update AFTER UPDATE ON goals WHEN json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'target_minor',OLD.target_minor,'opening_minor',OLD.opening_minor,'deadline',OLD.deadline,'daily_minor',OLD.daily_minor,'cap_minor',OLD.cap_minor) IS NOT json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'target_minor',NEW.target_minor,'opening_minor',NEW.opening_minor,'deadline',NEW.deadline,'daily_minor',NEW.daily_minor,'cap_minor',NEW.cap_minor) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'goals',NEW.id,'update',json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'target_minor',OLD.target_minor,'opening_minor',OLD.opening_minor,'deadline',OLD.deadline,'daily_minor',OLD.daily_minor,'cap_minor',OLD.cap_minor),json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'target_minor',NEW.target_minor,'opening_minor',NEW.opening_minor,'deadline',NEW.deadline,'daily_minor',NEW.daily_minor,'cap_minor',NEW.cap_minor));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_goals_delete AFTER DELETE ON goals BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'goals',OLD.id,'delete',json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'target_minor',OLD.target_minor,'opening_minor',OLD.opening_minor,'deadline',OLD.deadline,'daily_minor',OLD.daily_minor,'cap_minor',OLD.cap_minor),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_aliases_insert AFTER INSERT ON aliases BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'aliases',NEW.category_id,'insert',NULL,json_object('user_id',NEW.user_id,'label',NEW.label,'category_id',NEW.category_id));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_aliases_update AFTER UPDATE ON aliases WHEN json_object('user_id',OLD.user_id,'label',OLD.label,'category_id',OLD.category_id) IS NOT json_object('user_id',NEW.user_id,'label',NEW.label,'category_id',NEW.category_id) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'aliases',NEW.category_id,'update',json_object('user_id',OLD.user_id,'label',OLD.label,'category_id',OLD.category_id),json_object('user_id',NEW.user_id,'label',NEW.label,'category_id',NEW.category_id));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_aliases_delete AFTER DELETE ON aliases BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'aliases',OLD.category_id,'delete',json_object('user_id',OLD.user_id,'label',OLD.label,'category_id',OLD.category_id),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_budgets_insert AFTER INSERT ON budgets BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'budgets',NEW.category_id,'insert',NULL,json_object('user_id',NEW.user_id,'category_id',NEW.category_id,'amount',NEW.amount));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_budgets_update AFTER UPDATE ON budgets WHEN json_object('user_id',OLD.user_id,'category_id',OLD.category_id,'amount',OLD.amount) IS NOT json_object('user_id',NEW.user_id,'category_id',NEW.category_id,'amount',NEW.amount) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'budgets',NEW.category_id,'update',json_object('user_id',OLD.user_id,'category_id',OLD.category_id,'amount',OLD.amount),json_object('user_id',NEW.user_id,'category_id',NEW.category_id,'amount',NEW.amount));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_budgets_delete AFTER DELETE ON budgets BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'budgets',OLD.category_id,'delete',json_object('user_id',OLD.user_id,'category_id',OLD.category_id,'amount',OLD.amount),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_categories_insert AFTER INSERT ON categories BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'categories',NEW.id,'insert',NULL,json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'emoji',NEW.emoji,'archived',NEW.archived,'sort',NEW.sort));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_categories_update AFTER UPDATE ON categories WHEN json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'emoji',OLD.emoji,'archived',OLD.archived,'sort',OLD.sort) IS NOT json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'emoji',NEW.emoji,'archived',NEW.archived,'sort',NEW.sort) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'categories',NEW.id,'update',json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'emoji',OLD.emoji,'archived',OLD.archived,'sort',OLD.sort),json_object('id',NEW.id,'user_id',NEW.user_id,'name',NEW.name,'emoji',NEW.emoji,'archived',NEW.archived,'sort',NEW.sort));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_categories_delete AFTER DELETE ON categories BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'categories',OLD.id,'delete',json_object('id',OLD.id,'user_id',OLD.user_id,'name',OLD.name,'emoji',OLD.emoji,'archived',OLD.archived,'sort',OLD.sort),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_finance_preferences_insert AFTER INSERT ON finance_preferences BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'finance_preferences',NEW.user_id,'insert',NULL,json_object('user_id',NEW.user_id,'funding',NEW.funding,'reserve_minor',NEW.reserve_minor,'reminder_time',NEW.reminder_time,'summary_time',NEW.summary_time));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_finance_preferences_update AFTER UPDATE ON finance_preferences WHEN json_object('user_id',OLD.user_id,'funding',OLD.funding,'reserve_minor',OLD.reserve_minor,'reminder_time',OLD.reminder_time,'summary_time',OLD.summary_time) IS NOT json_object('user_id',NEW.user_id,'funding',NEW.funding,'reserve_minor',NEW.reserve_minor,'reminder_time',NEW.reminder_time,'summary_time',NEW.summary_time) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'finance_preferences',NEW.user_id,'update',json_object('user_id',OLD.user_id,'funding',OLD.funding,'reserve_minor',OLD.reserve_minor,'reminder_time',OLD.reminder_time,'summary_time',OLD.summary_time),json_object('user_id',NEW.user_id,'funding',NEW.funding,'reserve_minor',NEW.reserve_minor,'reminder_time',NEW.reminder_time,'summary_time',NEW.summary_time));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_finance_preferences_delete AFTER DELETE ON finance_preferences BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'finance_preferences',OLD.user_id,'delete',json_object('user_id',OLD.user_id,'funding',OLD.funding,'reserve_minor',OLD.reserve_minor,'reminder_time',OLD.reminder_time,'summary_time',OLD.summary_time),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_channel_posts_insert AFTER INSERT ON channel_posts BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'channel_posts',NEW.message_id,'insert',NULL,json_object('chat_id',NEW.chat_id,'message_id',NEW.message_id,'user_id',NEW.user_id,'version',NEW.version,'update_id',NEW.update_id,'spent_on',NEW.spent_on,'error',NEW.error));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_channel_posts_update AFTER UPDATE ON channel_posts WHEN json_object('chat_id',OLD.chat_id,'message_id',OLD.message_id,'user_id',OLD.user_id,'version',OLD.version,'update_id',OLD.update_id,'spent_on',OLD.spent_on,'error',OLD.error) IS NOT json_object('chat_id',NEW.chat_id,'message_id',NEW.message_id,'user_id',NEW.user_id,'version',NEW.version,'update_id',NEW.update_id,'spent_on',NEW.spent_on,'error',NEW.error) BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(NEW.user_id,'channel_posts',NEW.message_id,'update',json_object('chat_id',OLD.chat_id,'message_id',OLD.message_id,'user_id',OLD.user_id,'version',OLD.version,'update_id',OLD.update_id,'spent_on',OLD.spent_on,'error',OLD.error),json_object('chat_id',NEW.chat_id,'message_id',NEW.message_id,'user_id',NEW.user_id,'version',NEW.version,'update_id',NEW.update_id,'spent_on',NEW.spent_on,'error',NEW.error));
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=NEW.user_id AND day IN ('no-date');
END;
CREATE TRIGGER history_channel_posts_delete AFTER DELETE ON channel_posts BEGIN
 INSERT INTO change_history(user_id,entity,record_id,operation,before_json,after_json) VALUES(OLD.user_id,'channel_posts',OLD.message_id,'delete',json_object('chat_id',OLD.chat_id,'message_id',OLD.message_id,'user_id',OLD.user_id,'version',OLD.version,'update_id',OLD.update_id,'spent_on',OLD.spent_on,'error',OLD.error),NULL);
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
 DELETE FROM logging_days WHERE user_id=OLD.user_id AND day IN ('no-date');
END;
CREATE TRIGGER revision_logging_days_insert AFTER INSERT ON logging_days BEGIN
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER revision_logging_days_update AFTER UPDATE ON logging_days BEGIN
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER revision_logging_days_delete AFTER DELETE ON logging_days BEGIN
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER revision_balance_checks_insert AFTER INSERT ON balance_checks BEGIN
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER revision_balance_checks_update AFTER UPDATE ON balance_checks BEGIN
 INSERT INTO finance_revisions(user_id,revision) VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER revision_balance_checks_delete AFTER DELETE ON balance_checks BEGIN
 INSERT INTO finance_revisions(user_id,revision) VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
