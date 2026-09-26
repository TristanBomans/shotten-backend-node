# shotten-backend-node

Background worker for the [Shotten App](https://github.com/TristanBomans/Shotten-App). It keeps the shared Supabase database up to date and sends match reminders; the PWA itself only reads and writes Supabase.

It is a single Node container that runs cron jobs. It has a small HTTP API for manual triggers, but nothing in the app depends on it being reachable from the internet.

## What it does

| Job | Schedule (Europe/Brussels) | Feature flag |
|-----|----------------------------|--------------|
| Scrape [LZV Cup](https://www.lzvcup.be/): teams, calendar, results, player stats, match lineups | Daily at 03:00 | `FEATURE_LZV_SCRAPE` |
| Sync your own matches from the LZV iCal feeds into `core_matches` | Every 4 hours (and on start) | `FEATURE_ICAL_SYNC` |
| Queue and send Web Push reminders (attendance 2 weeks / the evening before, match morning, 1 h before kickoff) | Every minute | `FEATURE_PUSH` |
| `pg_dump` the database to `BACKUP_DIR`, keep `BACKUP_RETENTION_DAYS` | Daily at 02:00 | `FEATURE_BACKUP` |
| Expose recent logs over HTTP | — | `FEATURE_LOGS` |

All flags default to `true`. A job whose settings are missing is skipped with a warning at startup instead of crashing the worker.

### How push works

The PWA stores each device's subscription in `push_subscriptions` (through its own `/api/push/*` routes). Every minute this worker works out which reminders are due, records them in `push_sent` so each one goes out only once, queues them in `push_outbox`, and sends them with the VAPID key pair. Subscriptions the push service reports as gone are deleted. Only endpoints of the browser push services (Google, Mozilla, Apple, Microsoft) are contacted.

## Running it for your own team

You need the Shotten PWA set up first, with its Supabase database (the PWA's setup wizard gives you the SQL to run).

1. **Configure** — copy `.env.example` to `.env` and fill it in:

   | Variable | Notes |
   |----------|-------|
   | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Required. The service key (Settings → API) bypasses RLS; keep it server-side. |
   | `SUPABASE_DB_*` | For backups. Use the **Session pooler** connection details (Settings → Database → Connect) if your host has no IPv6; the direct `db.<project>.supabase.co` host is IPv6-only. |
   | `ICAL_URL_TEMPLATE` | Default works for LZV: `{id}` is filled from `core_teams.lzv_external_id`. Or set fixed feeds with `ICAL_URL` / `ICAL_URLS`. |
   | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Generate once with `npx web-push generate-vapid-keys`. The public key must equal `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in the PWA. |
   | `PUSH_APP_ORIGIN` | Your PWA URL; reminder notifications deep-link into it. |
   | `TIMEZONE` | Used for the cron schedule and reminder timing. |

2. **Run** — the image is published to GHCR on every push to `main`:

   ```bash
   docker compose up -d
   docker compose logs -f
   ```

   Backups land in `./backups` and logs in `./logs`.

3. **Keep the HTTP API private.** Port 8094 has no authentication (it can trigger scrapes and backups and read logs). Expose it on your LAN only, never through a reverse proxy.

### Forking

The GitHub workflow builds `ghcr.io/<your-account>/<repo>` automatically in a fork. The deploy step at the end only runs in `TristanBomans/shotten-backend-node`; replace it with your own deploy (or just pull the new image) and update the `image:` in `docker-compose.yml`.

## HTTP API

| Method | Path | What |
|--------|------|------|
| `GET` | `/health` | Liveness check |
| `GET` | `/api/lzv/scrape/trigger` | Start a full LZV scrape |
| `POST` | `/api/lzv/link-matches` | Re-link core matches to scraped LZV matches |
| `POST` | `/api/lzv/scrape/reset-players` | Delete scraped player stats (`?deletePlayers=true` also deletes the players); the next scrape refills them |
| `POST` | `/api/ical/sync/trigger` | Run the iCal sync now |
| `POST` | `/api/backup/trigger` | Run a backup now |
| `GET` | `/api/backup/list`, `/api/backup/status` | Backup files, and whether the latest one is recent and succeeded |
| `GET` | `/api/logs` | Recent log lines |

## Development

Node 20+.

```bash
npm install
cp .env.example .env   # fill in, set FEATURE_* to false for jobs you don't want locally
npm run dev            # ts-node, runs the worker with cron + HTTP
npm run build          # compile to dist/
npm run scrape         # one-off full LZV scrape
```

Backups need `pg_dump` 17 on your PATH; the Docker image already includes it.

## Deployment (upstream)

Pushing to `main` runs `.github/workflows/container-deploy.yml`: it pushes the image to GHCR (`sha-<commit>`, `<package version>` and `latest`) and then triggers an HMAC-signed deploy webhook (secret `DEPLOY_WEBHOOK_SECRET`). Configuration and secrets live with the deployment, never in this repo.
