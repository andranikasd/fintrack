# FinTrack

A personal spending tracker that lives in Telegram. Production can run entirely
on your VPS using Docker Compose, Node.js and SQLite. Cloudflare Workers/D1 remains
an alternative deployment. Expense amounts are whole Armenian drams (֏); savings
support exact hundredths of a dram.

## Production on your VPS

```bash
cp .env.example .env
# Set BOT_TOKEN and ALLOWED_USER_IDS in .env
docker compose up -d
```

The container includes all runtime dependencies, persistent SQLite storage,
automatic migrations, scheduled reminders, PDF reports, health checks and daily
backups. No Cloudflare account, domain or inbound port is required.

See [VPS setup, updates and recovery](docs/vps.md) for the production guide.

- **Logging an expense is one message**: `1500 cafe latte`
- **Categories** you create, rename, archive or delete from the chat
- **Monthly budgets**, overall and per category, with alerts at 80 / 100 / 120 / 150 / 200 %
- **PDF reports** with a donut chart, daily columns, a cumulative-vs-budget line,
  a six-month trend, a category table and the full expense list — plus CSV

## Talking to the bot

| You type | What happens |
| --- | --- |
| `1500 cafe latte` | 1,500 ֏ in Cafe, note "latte", today |
| `cafe 1500` | same — amount first or last, both work |
| `2.5k transport` | `k` = thousand, `m` = million |
| `yesterday 12,000 groceries` | dated yesterday |
| `03.09 45000 rent` | dated 3 September (a future day/month means last year) |
| `1800 pharmacy` | no category matches → the bot offers a one-tap picker |

Category names match exactly first (longest first, so `fast food` beats `food`),
then by unique prefix (`tra` → Transport).

Commands: `/month` `/stats` `/last` `/cats` `/budget` `/export` `/undo` `/tz` `/cleanup` `/help`.

## Cloudflare deployment (alternative)

Prerequisites: a Cloudflare account, `npm`, and a bot token from
[@BotFather](https://t.me/BotFather).

```bash
npm install

# 1. Create the database and paste the printed id into wrangler.toml
npx wrangler d1 create fintrack

# 2. Create the schema
npm run db:migrate

# 3. Secrets (never in wrangler.toml)
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET     # any long random string

# 4. Ship it
npm run deploy

# 5. Point Telegram at the Worker and publish the command menu
BOT_TOKEN=... WORKER_URL=https://fintrack.<subdomain>.workers.dev \
WEBHOOK_SECRET=... npm run webhook:set
```

`npm run webhook:info` shows what Telegram thinks the webhook is;
`npm run webhook:delete` unhooks it.

To keep the bot to yourself, set `ALLOWED_USER_IDS` in `wrangler.toml` to your
numeric Telegram id (comma-separated for several people) and redeploy.

### Plan note

PDF rendering costs real CPU. The free plan caps a request at 10 ms of CPU, which
is not enough; on the Workers Paid plan `[limits] cpu_ms = 30000` in
`wrangler.toml` gives the report room to build. Everything else — logging,
budgets, alerts, CSV — runs comfortably on the free plan.

## Local development

```bash
cp .dev.vars.example .dev.vars     # fill in BOT_TOKEN and WEBHOOK_SECRET
npm run db:migrate:local
npm run dev
```

`wrangler dev` serves the Worker locally; expose it with a tunnel if you want
Telegram to reach it, or drive it with hand-made POSTs to
`/telegram/webhook` carrying the `X-Telegram-Bot-Api-Secret-Token` header.

```bash
npm test          # parser, date and PDF-rendering tests
npm run typecheck
WRITE_PDF=/tmp/report.pdf npm test   # writes a sample report to look at
```

## How it fits together

```
src/index.ts        Worker entry: webhook route, /healthz, daily cron
src/bot.ts          grammY bot, middleware, handler order
src/db.ts           every D1 query
src/handlers/       entry, categories, budget, stats, export, menu, states
src/lib/            amount + date parsing, formatting, keyboards, alerts
src/pdf/            report layout, vector charts, font subset
assets/*.ttf        DejaVu Sans subset (Latin + Cyrillic + Armenian)
migrations/         D1 schema
```

Points worth knowing before changing things:

- **Workers keep nothing in memory**, so multi-step flows ("send me the new
  name") store their state in the `sessions` table, not in a session object.
- **Alerts are de-duplicated in the `alerts` table** on
  `(user, month, scope, threshold)`, so a crossing is announced once per month
  even though every expense re-checks the budget.
- **`budgets.category_id = 0`** means the whole-month limit; SQLite would treat
  NULLs in that primary key as distinct.
- **Charts are drawn as PDF vectors** — a Worker has no canvas and no image
  encoder. Pie slices are polygons; the SVG path helper flips the y axis because
  pdf-lib anchors paths from the top.
- **The bundled font is a subset** (Latin, Cyrillic, Armenian, punctuation), so
  `sanitize()` strips anything else — emoji above all — before pdf-lib tries to
  encode it. The dram sign is missing from every embeddable font tried, so the
  PDF writes `AMD` while chat messages use ֏.
- **PDF building runs in `waitUntil`** after the webhook has already answered:
  Telegram retries an update that takes too long.

## Channel diary and savings goals

### Connect your daily table

1. Open a private chat with the bot and send `/start`.
2. Add the bot to your expense channel as an administrator.
3. In the private bot chat, use `/linkchannel @channelname` or
   `/linkchannel -1001234567890`. Both you and the bot must be channel admins. Give the bot permission to post and edit messages.
   Forward a channel post to the bot to discover a private channel's ID.
4. Create or edit a channel post. Native Telegram two-column tables and plain
   text/Markdown tables are supported:

```text
Sep 15
Item | price
metro | 150
redline | 600
duet | 150
900
```

Each edit replaces the records belonging to that post, including removed rows,
changed amounts and corrected dates. Retries and older revisions cannot double
count or overwrite a newer revision. Multiple posts per day are added together.
An empty table with its header removes all rows. An unreadable edit preserves the
last valid records, notifies you privately, and appears in `/syncstatus`.
Manual totals are checked against expense rows but never counted as expenses.
Unknown items remain uncategorized. `/today`, `/yesterday` and automatic daily
summaries show **Categorize item** buttons for each distinct unknown label. Tap
one to pick an existing category or create a new one. Matching channel entries
are updated and future imports remember the choice. Run the report again to see
the new breakdown. `/uncategorized` reviews all outstanding items; optionally
append a date such as `/uncategorized 2026-09-15`.

`/alias metro | Transport` teaches a category
and updates matching imported items; category picks on imported rows also teach
an alias. Add several spelling variations at once with `/alias chatgpt, cigarret,
coffee | Personal`. Commands and reports are used in the private bot chat.

The date heading accepts `Sep 15`, `September 15 2026`, `2026-09-15`, `15.09`,
`today`, or `yesterday`. Without a heading, the original post date in your timezone
is used, even on later edits. Use a year for unambiguous historical dates.
Expense values remain whole AMD; fractional expense rows are rejected rather than
rounded. Savings values support two decimal places.

**History and deletion:** channel history is not automatically fetched. Edit old
posts after linking to import them. Deleting a channel message does not deliver a
regular Bot API deletion update: use `/forgetpost CHANNEL_ID MESSAGE_ID` to remove
its records. Edit the source table to delete individual imported expenses;
`/undo` and transaction delete buttons cannot remove those rows independently.
`/unlinkchannel ID` stops syncing and preserves recorded history. Editing a
forgotten post again imports it again. Photos/screenshots and merged cells are
not parsed; use the actual text/table message.

### Budget and laptop goal

These are example settings; choose your own amounts and deadline:

```text
/budget 150000
/goal laptop | 960,381.77 | 2027-03-15 | 0 | 6000
/funding shared 20000
/remind 20:00
/summary 21:00
```

Goal fields are `name | target | deadline OR daily:AMOUNT | already saved | optional daily cap`.
Names may contain letters, numbers, spaces, underscores and hyphens. Repeating
`/goal` with the same name updates the target and plan, preserving the original
opening balance and contribution history. `/goalhelp` lists all examples.

- A deadline calculates the required daily contribution, including today.
- `daily:3000` estimates a completion date from your preferred daily contribution.
- A daily cap and shared-budget headroom can lower the suggestion. Reports show
  the required amount separately and flag a capped or overdue plan.
- `/funding shared 20000` reserves 20,000 AMD for bills and subtracts confirmed net
  savings from the monthly budget. Remaining headroom is spread over the remaining
  calendar days and allocated proportionally across goals.
- `/funding separate` (default) leaves savings outside the spending budget. Without
  a shared budget, suggestions are goal-based arithmetic, not an affordability assessment.
- The reserve is money for upcoming costs, not already recorded expenses. Adjust
  it when those bills are paid to avoid reserving the same money twice.
- Opening savings are a starting balance, not a deposit on the setup date.

Record actual transfers with `/save laptop 5500 @ Card` and `/withdraw laptop 2000 @ Card`.
For past transfers, put `YYYY-MM-DD` before `@ Card`. Or include rows in the daily
channel table:

```text
save:laptop @ Card | 5500.77
withdraw:laptop @ Card | 500
```

Savings rows sync on edits just like expenses. They are excluded from expense
sums. Withdrawals and table edits that would make a goal's total balance negative
are refused. Correct mistakes with source-table edits, or a compensating
`/save`/`/withdraw` entry for a manually recorded transfer.

Reminders offer **Saved it**, **Different amount**, and **Skip today**. Only
confirmation books a transfer, and repeated taps cannot duplicate it. If the
same day's savings change after a reminder was created, its confirmation is
refused; use `/goal` for the refreshed plan and `/save` for any additional transfer.
Record each transfer using one route: table, command, or reminder confirmation.
Skipping changes no savings balance; the next day's plan recalculates.
Notifications are opt-in: `/remind off` and `/summary off` disable them. Delivery
uses your `/tz` timezone, normally within five minutes of the configured time.
A failed notification is retried; an ambiguous network failure can resend a
notification, but cannot duplicate a confirmed contribution.

### Daily reports

- `/today`, `/yesterday`: expenses, category totals, deposits and withdrawals.
  Today also shows budget availability and goal progress.
- `/week`: seven days of spending and savings bars.
- `/compare`: the last seven completed days versus the preceding seven, excluding today.
- `/chart 30`: interactive HTML charts for income, expenses, savings and categories; 1–366 days.
- `/dashboard`: live dashboard when configured; otherwise a 90-day HTML snapshot.
- `/chartpdf 30`: the previous PDF chart, for 1–90 days.
- `/add metro 150 @ Card`: add spending to the linked channel table, creating or editing that day.
- `/income Salary @ Card 450000`: record income; `/income` shows monthly income by source.
- `/month`: spending, net savings and budget availability.
- `/summary 21:00`: daily private report plus a seven-day interactive HTML chart.
- `/export`: existing expense PDF/CSV reports; these exports remain expense-only.

Today is labeled incomplete. Empty dates mean no records, not confirmed zero
spending. Charts exclude the opening savings balance.

### Upgrade an existing Cloudflare installation

Apply the additive database migration **before** deploying the new Worker:

```bash
npm run db:migrate
npm run deploy
npm run webhook:set
```

The webhook setup now enables `channel_post` and `edited_channel_post`, publishes
the new command menu, and preserves pending updates. The Worker cron runs every
five minutes; delivery records prevent repeated daily/monthly messages.
Set the real D1 database ID and secrets as described above; the checked-in config
contains a placeholder database ID. No remote database or bot settings are changed
by running the tests. Rolling back the Worker code leaves old expense data usable;
keep the additive schema and savings tables when rolling back.

Development tests require Node 24 for the built-in SQLite
adapter. They apply all migrations to an in-memory database and exercise native
channel payloads, edit ordering, rollback, exact savings, reminders and reports.
`WRITE_DAILY_PDF=/tmp/daily.pdf npm test` writes a sample chart for visual review.

See [interactive charts and live dashboard setup](docs/vps.md#interactive-charts-income-and-the-live-dashboard) for income table rows, HTTPS setup and browser editing.

## Account balances and cleanup

Create an account before logging activity, for example `/account Card 100000`.
Every expense, income receipt, savings deposit and withdrawal belongs to an owned
account. Private expense entry and reminders offer an account picker. Savings
commands and channel rows can omit `@ Account` only when one active account makes
the choice unambiguous. Dashboard forms always require an account.

An account's recorded balance is its opening balance plus income, minus expenses
and savings deposits, plus savings withdrawals, from its opening date onward.
The opening balance is before that day's activity. Older activity is already
represented by the opening balance and is not counted twice. Opening goal savings
represent money saved before tracking began, not a new transfer. These are recorded
balances; the bot does not move money at a bank. Negative account balances remain
visible so missing income or real overdrafts can be reconciled.

Migration `0007_account_ledger.sql` adds account ownership to savings and database
checks for financial entries. Historical unassigned records are preserved in
archived accounts named `Legacy unassigned ...`, with zero opening balances.
Reconcile these accounts and records against your real accounts after upgrading;
the migration does not guess their original funding source. Apply migrations
before deploying the Worker. The Docker runtime applies them automatically and
backs up an existing database before migrating.

`/add` appends to the latest valid table for that day in the connected channel,
including human-written posts. It preserves native table styles, existing rows,
rich text, captions and Telegram text entities, and updates the written expense
total. For posts imported before this upgrade, edit the original once so its full
formatting can be captured. Keep one channel linked when using `/add`. The returned
Telegram message is imported immediately. Repeated delivery of the same request
cannot add another expense; ambiguous failures appear in `/syncstatus` for review.
`/syncstatus` also checks channel administrator, posting and editing permissions.

Send `/cleanup` and tap **Erase all my data** within five minutes to permanently
erase your FinTrack database records: accounts, transactions, savings, income,
categories, goals, budgets, settings, reminders, channel links, attachments, history
and dashboard access tokens. The wipe is atomic and affects only your user.
Other users, Telegram messages and existing backup files are preserved. Old channel
posts can be imported again only after reconnecting and editing them. Send `/start`
to begin again. This action has no in-bot undo; use `/cancel` or the Cancel button
to abandon the confirmation.
