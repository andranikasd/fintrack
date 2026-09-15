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
