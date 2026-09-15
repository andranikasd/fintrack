# Production VPS deployment

FinTrack runs as one Node.js 24 container with local SQLite in WAL mode. The same
expense, channel-table, savings, report and reminder handlers run directly on the
VPS. Cloudflare, a separate database server, a domain and inbound HTTP ports are
not required. Telegram long polling waits for updates and handles them immediately;
it does not check for expenses only once a minute. The minute timer is only for
scheduled reminders, summaries and backups.

## Start

Install Docker Engine with the Compose plugin on the VPS, then clone this repo:

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Set these two values:

```dotenv
BOT_TOKEN=your-real-token-from-BotFather
ALLOWED_USER_IDS=your-numeric-telegram-user-id
```

`ALLOWED_USER_IDS` identifies your personal Telegram account, not the bot or channel.
More than one account can be listed, comma-separated.
The service refuses to start with a missing owner allowlist or a placeholder token.

Optional settings:

```dotenv
DEFAULT_TZ=Asia/Yerevan
BACKUP_RETENTION_DAYS=7
```

Start everything:

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=100 -f bot
```

Compose builds the image on the first run. The image contains the compiled bot,
PDF libraries and fonts, database migrations, Node's SQLite runtime, the SQLite
command-line tool and backup tools. Startup creates the database, applies pending
migrations, registers bot commands, enables long polling and starts scheduled jobs.
No npm, Node, Python, database installation or cron configuration is needed on the
host. First startup requires outbound access to Docker Hub, the npm registry and
Debian package mirrors; normal operation requires outbound HTTPS to Telegram.

Docker Compose V2/V5 uses `docker compose`. If your installation exposes the
compatible `docker-compose` command, `docker-compose up -d` does the same thing.

Only run one deployment for a bot token. Startup removes its existing webhook
while preserving pending updates. Stop any previous Worker/polling deployment
first. Existing Cloudflare data is **not** automatically copied into the new
SQLite volume.

## Connect Telegram

Open a private chat with the bot, send `/start`, add it to your channel as an
administrator, then use `/linkchannel @channelname` or `/linkchannel CHANNEL_ID`.
Forward a private channel post to the bot to find the numeric channel ID.

Configure your budget and goal in Telegram; these are examples:

```text
/budget 150000
/goal laptop | 960,381.77 | daily:3000 | 0
/funding shared 20000
/remind 20:00
/summary 21:00
```

See the [channel and savings guide](../README.md#channel-diary-and-savings-goals)
for editing tables and recording transfers.

## What runs in production

- **Persistent data:** the `fintrack_data` named volume stores the SQLite database,
  WAL files and lock. Container recreation and reboot retain it.
- **Backups:** `fintrack_backups` stores one online snapshot per UTC day, retaining
  seven days by default. Manual and pre-migration snapshots are kept until removed.
- **Fast startup:** code is compiled during image build; the runtime installs
  nothing on startup. SQLite queries run locally and batch writes are atomic.
- **Scheduled jobs:** a minute tick sends due reminders/summaries with the existing
  delivery deduplication. Missed notifications are checked again on startup.
- **Health:** Docker checks polling progress, scheduler progress, backups and
  database availability through a container-local endpoint. No host port is exposed.
- **Process supervision:** `restart: unless-stopped`, signal handling and a
  60-second shutdown window. Background PDF/report tasks are drained before closing
  the database. A file lock prevents two processes using the same data volume.
- **Limits:** one CPU, 768 MiB memory and rotated logs (three 10 MiB files). These
  are intended for a personal bot; adjust `compose.yaml` for a larger workload.
- **Permissions:** non-root UID 1000, read-only container filesystem, dropped Linux
  capabilities; writes go to data/backups volumes and a bounded temporary directory.

A healthy service appears as `Up ... (healthy)` after startup. An extended Telegram
outage can mark it unhealthy; Docker health status is diagnostic, while the restart
policy restarts exited processes. Polling retries network failures automatically.

## Update

```bash
git pull
docker compose up -d --build
docker compose logs --tail=100 bot
```

Existing data stays in its named volume. Pending migrations run atomically. On
an established database a pre-migration snapshot is taken first. Applied migration
files are checksum-checked: add a new migration instead of changing an applied one.
Do not run multiple replicas against one SQLite volume or one bot token.

## Back up and restore

A daily snapshot is automatic. To take an immediate consistent snapshot while the
bot is running and copy it off the VPS:

```bash
docker compose exec bot node dist/backup.mjs /backups/manual-export.sqlite
docker compose cp bot:/backups/manual-export.sqlite ./fintrack-backup.sqlite
```

Choose a new name if `manual-export.sqlite` already exists. Copy snapshots to a
separate machine or storage service; another volume on the same VPS does not
protect against loss of that VPS. Do not copy the live `.sqlite` file by itself:
committed data may still be in the WAL file.

To restore `./fintrack-backup.sqlite`, stop the bot first:

```bash
docker compose stop bot
docker compose run --rm -T --no-deps bot sh -ec '
  cat > /data/restore.sqlite
  test "$(sqlite3 /data/restore.sqlite "PRAGMA integrity_check;")" = ok
  sqlite3 /data/fintrack.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
  mv /data/restore.sqlite /data/fintrack.sqlite
  rm -f /data/fintrack.sqlite-wal /data/fintrack.sqlite-shm
' < ./fintrack-backup.sqlite
docker compose up -d
```

This replaces the current database with the snapshot. Take a fresh backup before
restoring if you might need to return to the current data. The container checks and
applies any pending migrations when it starts again.

`docker compose down` keeps the named volumes. `docker compose down -v` deletes
both your live data and backups; use it only when intentionally erasing the bot.

## Development verification

```bash
npm ci
npm test
npm run typecheck
npm run build:node
docker build -t fintrack:verify .
npm run test:docker
```

The Docker smoke test uses isolated disposable volumes and an in-process Telegram
mock with dummy credentials. It checks migrations, channel ingestion, goal precision,
PDF generation/upload, live backup, non-root execution, health, graceful restart and
persistence. It never loads the real `.env` or contacts your Telegram bot.

## Interactive charts, income and the live dashboard

After updating with `docker compose up -d --build`, `/chart 30` sends an interactive
HTML report if no dashboard URL is configured. Open the file in a browser; it
includes its own charts, styling and data, so it works offline without a chart
service or CDN. Choose dates within the snapshot, toggle chart series, group by
day/week/month, click bars to explore a period, filter categories and sources,
search the ledger, and download the filtered rows as CSV.

`/dashboard html` always generates an offline snapshot of the last 90 days.
`/chartpdf 30` keeps the previous downloadable PDF chart. Evening summaries now
attach an interactive seven-day HTML report.

### Income

Record money when you receive it:

```text
/income Salary @ Card 450000
/income Freelance @ Card 25000.50 2026-09-15
```

Or add income alongside expenses in your daily channel table:

```text
Item | price
income:Salary @ Card | 450000
metro | 150
save:laptop | 5500.77
```

Income rows participate in the same atomic post-edit syncing as expenses and
savings. They never increase expense totals. `/income` shows this month's sources
and removal buttons for manually recorded income. Correct a channel income by
editing its source table; correct a manual one in the live dashboard or remove it
and record the replacement. Income supports two decimal places.

The dashboard shows income received, spending, savings deposits, withdrawals and
**net cash flow after savings**. This is a period's recorded movement, not your
bank balance: no opening cash balance or bank connection is assumed. The chosen
spending budget stays unchanged when income is recorded.

### Live dashboard with automatic HTTPS

For a dashboard that can change saved records, point a DNS name at the VPS and set:

```dotenv
DASHBOARD_HOST=fintrack.your-domain.com
```

Then enable the included Caddy reverse proxy:

```bash
docker compose -f compose.yaml -f compose.dashboard.yaml up -d --build
```

Allow inbound TCP ports 80 and 443. Caddy obtains and renews the HTTPS certificate;
its certificate data is stored in named volumes. Send `/dashboard` or `/chart 30`
to your bot to receive a private sign-in link. The link is single-use and expires
in 10 minutes; the browser session expires after 24 hours. Only accounts in
`ALLOWED_USER_IDS` can sign in, and each sees their own records. Use **Sign out** to
revoke the current session. The bot token is never sent to the browser.

Use the same two `-f` options for future updates, logs and shutdown commands so the
HTTPS proxy remains part of the deployment.

If you already have an HTTPS reverse proxy on the VPS, set
`DASHBOARD_URL=https://fintrack.your-domain.com` instead and publish only a loopback
port with:

```bash
docker compose -f compose.yaml -f compose.dashboard-local.yaml up -d --build
```

Proxy that hostname to `http://127.0.0.1:8080`. Set `DASHBOARD_PORT` if port 8080 is
already used. Plain HTTP dashboard URLs are accepted only for `localhost` and
`127.0.0.1`, for local testing or SSH tunnels. The base Compose file still publishes
no host ports.

### Changes you can make in the browser

- Add income or expenses, and edit/remove manually entered income and expenses.
- Assign categories to imported items; matching channel names are remembered.
- Create a category, set the monthly budget, and confirm a savings contribution.
- Navigate charts and filter/export the ledger without changing recorded data.

Channel amounts/dates remain controlled by the original daily table. Keeping that
single source prevents the next table edit from silently undoing a browser change.
Goal setup, category rename/archive, reminder preferences, and savings withdrawals
remain available through the Telegram commands. The offline HTML snapshot offers
filtering and navigation; it cannot write to the database.

Migrations `0003_income.sql` and `0004_dashboard.sql` are additive and run at startup.
Daily backups include income and dashboard sessions. Restoring a recent backup can
restore sessions that were valid at that snapshot; to revoke every dashboard link
and session after a restore:

```bash
docker compose exec bot sqlite3 /data/fintrack.sqlite 'DELETE FROM dashboard_tokens;'
```


## Dashboard views and accounts

### Adding spending from the bot

Use `/add item amount @ Account` to keep the linked channel table up to date:

```text
/add metro 150 @ Card
/add yesterday groceries 4500 @ Cash
```

Direct private-chat entries also ask for the paying account once accounts have
been created. Include it immediately, for example `1500 cafe @ Card`, or send
`1500 cafe` and choose the account button. Direct entries update the ledger;
use `/add` when the channel table should also be updated.

The bot asks you to choose an account when the account suffix is missing, and
asks you to create one when no accounts exist. It then edits the latest table
for that day in place. If no table exists for that day, it creates a new plain
text table in the linked channel. The bot needs administrator permission to
post and edit channel messages. The generated table keeps the date, expense
rows, income/savings rows already synced from that post, and a recalculated
expense total. Telegram may deliver the resulting channel update shortly after
the command; `/syncstatus` shows any delayed or invalid sync.

Channel rows with an account suffix are required once at least one account has
been created. For example, `metro @ Card | 150`. A missing or unknown account
keeps the last valid source version and asks you to correct the row. Expenses
added with `/add` therefore use the same source-of-truth path as hand-edited
channel tables.

You can create an account in the channel with `account:Card | 100000`. This row
is setup data: it creates the account with that opening balance on the table's
date and is excluded from spending totals. Use the live Accounts view or
`/account` to change its opening date, archive it, or mark it as a passive-income
account.

Use the view buttons at the top of `/dashboard`:

- **Today:** today's confirmed spending/income, daily allowance from the monthly
  budget after reserve (and savings when funding is shared), and suggested savings.
- **Monthly overview:** income, expenses, net savings rate, current budget limits,
  category budgets and comparison with the same days of the previous month.
  Full historical months compare with full previous months. Change months with
  the arrows above the view. Budget history is not stored; limits are current settings.
- **Spending calendar:** spending intensity by day; click a day to open its records.
- **Category trends:** six months of category totals with proportional bars; click
  a total to explore that category and month. The current month is incomplete.
- **Goal planner:** create/edit a target, deadline, daily amount and cap, record
  actual deposits, and try a daily contribution to estimate a finish date. Estimates
  do not record money. A deadline takes precedence over a daily amount when both exist.
- **Review inbox:** uncategorized items, failed channel syncs, possible duplicate
  expenses/income, and unassigned income across your history. Duplicate detection
  flags matching day/name/amount/account; it never removes records automatically.
- **Accounts:** create, rename, edit opening balances/dates, archive, and mark
  accounts that earn passive income. Old account names remain reserved so existing
  channel rows keep syncing after a rename. Archived accounts preserve history.

### Record an account and actual income

```text
/account Card 100000 2026-09-01
/income Salary @ Card 450000
/income Interest @ Card [passive] 1500.77
/accounts
```

The opening balance is **before the opening day's activity**. The recorded balance
is opening balance + assigned income − assigned expenses, counting entries from
that date onward. Correct the opening amount/date in the live Accounts view if
needed. Entries before that date remain in reports but do not change the balance.
Unassigned historical records do not affect any account.

Income has no fixed schedule or automatic credits. Every new receipt requires a
receiving account. Marking an account as earning passive income is descriptive;
mark the actual receipt as passive when recording it. Filter the ledger/charts
by account or passive income. CSV export includes these fields.

Channel examples (create the named account first):

```text
2026-09-15
Item | price
income:Salary @ Card | 450000
income:Interest @ Card [passive] | 1500.77
metro @ Card | 150
coffee @ Card | 1200
Total: 1350
```

An expense account is optional; income needs one. An unknown receiving account
causes a sync error and preserves the last valid version of that post. Correct
its account name or create the account, then edit the post to retry. Edit source
channel rows to change their account assignment, amount or date. Manual entries
can be edited in the dashboard. Savings goals remain separate from account balances;
recording a goal deposit does not debit an account. There are no account transfers.

Standalone HTML reports include the views and local navigation but cannot save
changes. Calendar drill-down is limited to the snapshot's records. Monthly totals
are labeled partial when the snapshot does not cover the full comparison period.
Use the live dashboard for account, plan and budget editing.

### Upgrade

```bash
docker compose up -d --build
```

If using the HTTPS dashboard override, retain it:

```bash
docker compose -f compose.yaml -f compose.dashboard.yaml up -d --build
```

Migration `0005_accounts.sql` runs automatically. Existing amounts and savings
history stay intact; existing income/expenses start without an account assignment.

### Exploring the charts

The Explore view supports bars, lines and running totals, grouped by day, week
or month. Running totals start at the beginning of the selected range and follow
all active filters; they are not bank balances. Focus or select a line point to
read every visible series and open its period. Use **Back to previous range** to
return after drilling into a chart or calendar day.

Filters sit above the charts. Category/source shares, largest purchases, repeat
spending, weekday averages and income/account coverage all follow that selection.
Repeated spending groups exact item names ignoring case and surrounding spaces;
it does not identify subscriptions automatically. Calendar-day and weekday averages
include days without recorded expenses, so incomplete logging can lower them.

The monthly spending-pace chart compares cumulative recorded expenses with an
even distribution of your current budget. Its month-end estimate extrapolates
spending per elapsed calendar day; it does not predict unrecorded future bills.
Historical months display their actual total. An offline snapshot needs complete
month-to-date coverage to show this chart.

## Saved views, rules, history and monthly closing

Migration `0006_dashboard_workspace.sql` adds these features automatically when
rebuilding/restarting with your existing Compose files. SQLite backups include
history, saved views, logging confirmations, reviews, receipt files and notes.
No extra service or environment variable is required.

### Saved views and comparisons

Save the current filters, chart style, visible series and grouping with **Save
current filters**. Choose current month, last N days, or fixed dates. Saved views
are private to your user and work across devices; saving the same name replaces
its settings. The Saved views screen can open or delete them.

The monthly view explains spending changes by category, comparing equivalent
periods. The goal planner compares the chosen daily contribution with 25% less
and 25% more and lets you enter planned skipped days. These scenarios do not
record deposits; estimates exclude budget/cap constraints and future price changes.

### Category rules

Open **Category rules**, create/edit a rule, put spelling variations on separate
lines, and select a category. **Preview affected entries** shows the number,
combined amount and first 25 examples of matching existing expenses. Save either
for future matching only or apply to existing matching entries as well.
Matching trims surrounding whitespace and ignores case; it does not use fuzzy
matching or rewrite product names. A stale preview is rejected if records or
rule inputs changed. Removing a rule affects future matching, not existing rows.
Channel matching continues using the bot's learned aliases and category matching.

### Change history and undo

History starts when this migration is installed; it cannot reconstruct earlier
edits. It records inserts, edits and deletions for expenses, income, savings,
accounts, goals, categories, budgets, rules, preferences and channel sync status.
Channel row replacements appear as removed and added entries. Open an event to
see its changed fields. The live history pages through older events.

Undo is available for the **latest manual expense/income edit or deletion**,
including corrections made in Telegram. It restores exact amounts, dates, labels,
categories and account assignment. It rejects already undone events, newer changes,
and cross-user records. Undo itself is logged. Channel history is read-only:
correct the original post so Telegram remains the source of truth. Account, goal,
rule and settings history is informational; edit those through their normal controls.

### Logging status and monthly closing

Confirm a day as **All entries recorded** or **Confirmed no spending** from Today,
the calendar or Monthly closing. A day with expenses cannot be marked no-spend.
Any later expense/income/savings change on that date clears its confirmation.
A blank calendar day therefore remains distinct from verified zero spending.

For a completed month, Monthly closing checks:

- Missing categories and account assignments.
- Unconfirmed days and channel sync errors.
- Each recorded account balance against the actual month-end balance you enter.

Checking a balance does not create income, expenses or balance adjustments.
Resolve differences by correcting the underlying records/opening balance.
**Confirm all remaining days** is an explicit confirmation that logging is complete
for every elapsed day; it does not infer completeness from missing entries.
A month can be marked reviewed only after it ends and all checks pass. Reviewing
is not a lock: later record changes flag the month for review again. Reopen it
manually when needed. The offline file contains a read-only closing checklist for
the report's ending month; use the live dashboard to review another month's checklist.

### Receipts and notes

Use **Receipt / note** on an expense or income row. Upload a JPEG, PNG or PDF up to
750 KB, add a note up to 2,000 characters, or save a note alone. Receipt downloads
require the owner's dashboard session and are sent as downloads. Receipts are
private database content; they are included in backups. The dashboard embeds only
receipt metadata/notes, never receipt bytes, in offline HTML snapshots.

Manual receipts stay linked when their record is edited, deleted, or restored.
Channel receipts use the post, entry type and normalized item name as their link,
so an amount edit preserves attachments. Identical item names within the same
post share attachments. Renaming a source item leaves its previous attachments
in Receipts & notes under the original key; they are not silently reassigned.
The dashboard lists the latest 500 attachments; older files remain stored.
Removing an attachment permanently deletes that attachment and note. Restore a
backup if recovery is needed. No OCR or automatic transaction entry is performed.
