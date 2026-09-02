# FinTrack

A personal spending tracker that lives entirely in a Telegram chat and runs on a
single Cloudflare Worker. Amounts are Armenian drams (֏), stored as whole
numbers in D1.

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

Commands: `/month` `/stats` `/last` `/cats` `/budget` `/export` `/undo` `/tz` `/help`.

## Deploying

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
