# Deployment Guide — Tulsi ERP Backend (VPS)

This document is written for the DevOps engineer deploying **`nestjs-crm-backend`** to a production VPS. It covers what to provision, what information/secrets you need up front, two deployment paths (Docker Compose — recommended, and bare-metal/systemd), the reverse-proxy/TLS setup, and the operational checklist.

> Companion doc: [README.md](README.md) describes what the system does and its API surface. This document only covers *how to run it*.

## Table of contents

1. [What you're deploying](#1-what-youre-deploying)
2. [Information you need before you start](#2-information-you-need-before-you-start)
3. [Server prerequisites](#3-server-prerequisites)
4. [Environment variables reference](#4-environment-variables-reference)
5. [Option A — Docker Compose deployment (recommended)](#5-option-a--docker-compose-deployment-recommended)
6. [Option B — Bare-metal / systemd deployment](#6-option-b--bare-metal--systemd-deployment)
7. [Reverse proxy & TLS (Nginx + Let's Encrypt)](#7-reverse-proxy--tls-nginx--lets-encrypt)
8. [Database migrations](#8-database-migrations)
9. [Post-deployment checklist](#9-post-deployment-checklist)
10. [Backups](#10-backups)
11. [Monitoring, logs & health](#11-monitoring-logs--health)
12. [Scaling notes — cron jobs & single-instance constraint](#12-scaling-notes--cron-jobs--single-instance-constraint)
13. [Updating / redeploying](#13-updating--redeploying)
14. [Known gaps to flag to the team](#14-known-gaps-to-flag-to-the-team)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What you're deploying

- A single NestJS (Node 20) HTTP API process, listening on port **3000** internally (`PORT` env var).
- Backed by a **PostgreSQL 16** database.
- This repo also contains a separate frontend app (`crm-frontend/`, a Vite/React static site) and a root-level `docker-compose.yml` that runs all three (`postgres`, `backend`, `frontend`) together — this guide focuses on the **backend**, but references the compose setup since it's the primary deployment path already defined in the repo.
- Two public-facing webhook endpoints must be reachable over **HTTPS** from the internet (third-party portals and Meta call these directly): `/webhooks/leads/:token` and `/webhooks/whatsapp/:slug`.

## 2. Information you need before you start

Gather/decide these **before** provisioning:

| Item | Notes |
|---|---|
| Domain name(s) | e.g. `api.yourcrm.com` for the backend, `app.yourcrm.com` for the frontend. DNS A/AAAA records must point at the VPS's public IP. |
| VPS access | SSH access with sudo, or a container-orchestration platform if not using a raw VPS. |
| PostgreSQL credentials | A strong DB user/password, or plan to run Postgres in Docker with generated credentials (see §5). |
| `JWT_ACCESS_SECRET` | A long random secret (e.g. `openssl rand -hex 32`). **Never reuse the dev default.** |
| `CREDENTIALS_ENCRYPTION_KEY` | A 32-byte key (hex or base64) for AES-256-GCM — the app **will not start** without a valid one. Generate with `openssl rand -hex 32`. |
| `CORS_ORIGINS` | The exact public origin(s) of the frontend, e.g. `https://app.yourcrm.com` (comma-separated if multiple). |
| `WEBHOOK_BASE_URL` | The public HTTPS URL of the backend, e.g. `https://api.yourcrm.com` — this is embedded into webhook URLs shown to org admins for 99acres/MagicBricks/etc. and into the WhatsApp webhook URL registered with Meta. |
| Meta/WhatsApp app credentials | If WhatsApp integration will be used: a Meta Business App with WhatsApp product enabled, phone number ID, and access token — configured per-organization *through the app itself* (`POST /integrations/whatsapp`), not via server env vars. |
| TLS certificate plan | Let's Encrypt via certbot (see §7) or an existing corporate cert. |
| Who owns the demo/seed credentials | Decide whether to run the seed script in production at all (see §9). |

## 3. Server prerequisites

Minimum recommended VPS spec for a small-to-mid deployment: **2 vCPU / 4 GB RAM / 40 GB SSD**, Ubuntu 22.04 LTS or newer.

Install on the VPS:

```bash
# Docker + Compose plugin (Option A)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out/in after this

# Nginx (reverse proxy, both options)
sudo apt update && sudo apt install -y nginx

# certbot for Let's Encrypt
sudo apt install -y certbot python3-certbot-nginx
```

If using **Option B (bare-metal)** instead of Docker, also install:

```bash
# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL 16
sudo apt install -y postgresql-16

# PM2 process manager
sudo npm install -g pm2
```

Open firewall ports (only 80/443 need to be public; never expose 3000 or 5432 to the internet):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 4. Environment variables reference

Create `nestjs-crm-backend/.env` on the server (never commit this file — it's already gitignored). There is no `.env.example` checked into the repo; use this table as the template.

| Variable | Required | Example (production) | Notes |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | `postgresql://crm_user:STRONG_PASSWORD@postgres:5432/crm_db?schema=public` | Use the Docker service name (`postgres`) as host under Compose, or `localhost`/an internal IP under bare-metal. |
| `JWT_ACCESS_SECRET` | **Yes** | 64-char hex from `openssl rand -hex 32` | Falls back to an insecure dev default if unset — **must** be overridden. |
| `JWT_ACCESS_EXPIRES_IN` | No | `15m` | Access token lifetime. |
| `JWT_REFRESH_SECRET` | Reserved | any value | Present in config for forward-compat; not currently read by the auth flow (refresh tokens are opaque, SHA-256-hashed random values, not JWTs). Set it anyway to a random value. |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Refresh token lifetime. |
| `PORT` | No | `3000` | Internal port the app listens on. |
| `NODE_ENV` | Recommended | `production` | |
| `CREDENTIALS_ENCRYPTION_KEY` | **Yes** | 64-char hex from `openssl rand -hex 32` | AES-256-GCM key used to encrypt WhatsApp access tokens at rest. **App throws at startup if missing or the wrong length** — generate and store it in your secrets manager; losing/rotating it will make previously-encrypted WhatsApp tokens undecryptable, forcing orgs to reconnect WhatsApp. |
| `WEBHOOK_BASE_URL` | **Yes** | `https://api.yourcrm.com` | Public HTTPS origin, no trailing slash. Used to build the webhook URLs shown to org admins. |
| `CORS_ORIGINS` | **Yes** | `https://app.yourcrm.com` | Comma-separated, no spaces, no trailing slash on each origin. |
| `META_GRAPH_API_VERSION` | No | `v20.0` | Meta Graph API version for WhatsApp Cloud API calls. |
| `UPLOADS_DIR` | No | `/app/uploads` | Where uploaded files are stored (WhatsApp media, lead sheets). Defaults to `./uploads` under the app's working directory — `/app/uploads` in Docker, where the root `docker-compose.yml` mounts the `backend_uploads` volume. Must be persistent storage: files written anywhere else are lost on redeploy. |

**Do not** commit real values. Store the production `.env` via your secrets manager (e.g. Vault, 1Password, or the VPS's restricted-permission file system with `chmod 600`).

## 5. Option A — Docker Compose deployment (recommended)

The repo root already ships a `docker-compose.yml` that builds and runs `postgres`, `backend`, and `frontend` together on one internal network. Postgres is **not** exposed to the host — only reachable from other containers.

### 5.1 Layout

```
<repo root>/
├── docker-compose.yml
├── .env                          # POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB (root-level, for the postgres container)
├── nestjs-crm-backend/
│   ├── Dockerfile
│   └── .env                      # backend app config (table in §4)
└── crm-frontend/
    └── Dockerfile
```

### 5.2 Root `.env` (feeds the `postgres` service)

```bash
# <repo root>/.env  — LOCAL/SERVER ONLY, never commit
POSTGRES_USER=crm_user
POSTGRES_PASSWORD=<strong-random-password>
POSTGRES_DB=crm_db
```

### 5.3 Backend `.env`

Create `nestjs-crm-backend/.env` using the table in §4. **Important:** whatever `DATABASE_URL` you put in this file is overridden at the Compose level anyway — `docker-compose.yml` rebuilds it from the root `.env`'s `POSTGRES_*` values pointed at the `postgres` service (`postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public`). Still set a placeholder value so the app doesn't fail to parse an empty string outside Compose.

### 5.4 Bring it up

```bash
cd /path/to/repo
docker compose up -d --build
docker compose ps                 # confirm postgres is healthy, backend is running
docker compose logs -f backend    # watch startup logs
```

On first boot, run migrations inside the running container (see §8):

```bash
docker compose exec backend npx prisma migrate deploy
```

Backend is now reachable at `http://127.0.0.1:3000` on the VPS (not yet public — see §7 for the reverse proxy). Frontend is at `http://127.0.0.1:5174`.

### 5.5 Known Dockerfile detail

`Dockerfile`'s `CMD` is `node dist/src/main` — `nest-cli.json` sets `sourceRoot: "src"`, so the compiled entry point is `dist/src/main.js`. Outside Docker, `npm run start:prod` runs the same file.

## 6. Option B — Bare-metal / systemd deployment

Use this if Docker isn't available on the target VPS.

```bash
# 1. Clone and install
git clone <repo-url> /opt/crm
cd /opt/crm/nestjs-crm-backend
npm ci                      # postinstall runs `prisma generate` automatically

# 2. Configure
sudo -u www-data tee .env > /dev/null <<'EOF'
DATABASE_URL=postgresql://crm_user:STRONG_PASSWORD@localhost:5432/crm_db?schema=public
JWT_ACCESS_SECRET=...
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_SECRET=...
JWT_REFRESH_EXPIRES_IN=7d
PORT=3000
NODE_ENV=production
CREDENTIALS_ENCRYPTION_KEY=...
WEBHOOK_BASE_URL=https://api.yourcrm.com
CORS_ORIGINS=https://app.yourcrm.com
META_GRAPH_API_VERSION=v20.0
EOF
sudo chmod 600 .env

# 3. Provision the database (once)
sudo -u postgres createuser crm_user --pwprompt
sudo -u postgres createdb crm_db --owner=crm_user

# 4. Build and migrate
npm run build
npx prisma migrate deploy

# 5. Run with PM2 (single instance — see §12 for why not to cluster)
pm2 start dist/src/main.js --name crm-backend
pm2 save
pm2 startup     # follow the printed command to enable boot-time start
```

`pm2 logs crm-backend` tails logs; `pm2 restart crm-backend` for redeploys.

## 7. Reverse proxy & TLS (Nginx + Let's Encrypt)

The repo has an empty `nginx/` placeholder directory — no config exists yet. Create one on the VPS (this is not baked into the Docker image; it runs as the host's Nginx, or as its own container if you prefer — the example below is host Nginx in front of the Dockerized/PM2'd backend on `127.0.0.1:3000`).

`/etc/nginx/sites-available/api.yourcrm.com`:

```nginx
server {
    listen 80;
    server_name api.yourcrm.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WhatsApp media and lead sheets (up to 10 MB) are uploaded through the API;
        # Nginx rejects bodies over 1 MB by default.
        client_max_body_size 60m;
    }

    # Optional: basic protection for the auth + webhook surface.
    # Consider adding rate limiting (limit_req) here — the app itself
    # has none (see §14).
}
```

```bash
sudo ln -s /etc/nginx/sites-available/api.yourcrm.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Issue and auto-install a TLS cert
sudo certbot --nginx -d api.yourcrm.com
```

Repeat for the frontend domain, pointing at `127.0.0.1:5174` (or wherever the built static site is served).

**Webhook reachability check** — once TLS is live, confirm both public webhook paths respond (they don't require auth headers, so a basic reachability check is enough):

```bash
curl -i https://api.yourcrm.com/webhooks/leads/any-token         # expect a JSON response, not a connection error
curl -i "https://api.yourcrm.com/webhooks/whatsapp/any-slug?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123"
```

## 8. Database migrations

Prisma migrations live in `nestjs-crm-backend/prisma/migrations/`. **Always use `migrate deploy` in production** — never `migrate dev` (which can create new migrations and prompt interactively):

```bash
# Docker Compose
docker compose exec backend npx prisma migrate deploy

# Bare-metal
cd /opt/crm/nestjs-crm-backend && npx prisma migrate deploy
```

Run this on every deploy that includes new migrations, **before** restarting the app with the new code (the Docker image already bundles `prisma/` for this purpose).

## 9. Post-deployment checklist

- [ ] `.env` files (root and `nestjs-crm-backend/`) exist on the server only, are `chmod 600`, and are excluded from any backup that leaves the server unencrypted.
- [ ] `JWT_ACCESS_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` are freshly generated, not copied from a dev environment.
- [ ] `CORS_ORIGINS` matches the real frontend origin exactly (scheme + host, no trailing slash).
- [ ] `WEBHOOK_BASE_URL` is the real public HTTPS domain — test by creating a platform integration in the app and confirming the returned webhook URL resolves.
- [ ] TLS certificates installed and auto-renewal verified (`sudo certbot renew --dry-run`).
- [ ] Database reachable only from the backend (not exposed publicly) — confirm port 5432 is not open in `ufw`/security group.
- [ ] Run `npx prisma migrate deploy` and confirm it reports "No pending migrations" or lists the ones just applied.
- [ ] Decide on the seed data (`prisma/seed.ts`): if run, it creates `superadmin@demorealty.com` / `SuperAdmin@123` and `admin@demorealty.com` / `Admin@123`. **Change these passwords immediately after first login in production**, or skip seeding and create the first `SUPER_ADMIN` via a one-off script/DB insert instead.
- [ ] Confirm Swagger docs are reachable at `https://api.yourcrm.com/api/docs` — decide whether to leave this public or restrict it (e.g. IP allowlist in Nginx) since it documents the entire API surface.
- [ ] Confirm only **one** instance of the backend process is running (see §12).
- [ ] Set up log retention/rotation (see §11) and a backup schedule (see §10).

## 10. Backups

- **Database**: schedule daily `pg_dump` (Docker: `docker compose exec postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > backup-$(date +%F).sql.gz`), retained off-server (S3-compatible storage or another host). Test restores periodically.
- **Uploaded files** (WhatsApp media, lead sheets): back up the `UPLOADS_DIR` folder alongside the database (Docker: the `backend_uploads` volume, e.g. `docker run --rm -v <project>_backend_uploads:/data -v $PWD:/backup alpine tar czf /backup/uploads-$(date +%F).tgz -C /data .`). The database only records which file belongs to which project.
- **`CREDENTIALS_ENCRYPTION_KEY`**: back this up separately and securely (secrets manager) — if it's lost, all encrypted WhatsApp access tokens in the database become permanently undecryptable and every org must reconnect WhatsApp.
- **`.env` files**: keep a secure copy outside the server (secrets manager), since a server rebuild otherwise loses all generated secrets.

## 11. Monitoring, logs & health

- **No `/health` endpoint currently exists** in the API. Before wiring this into a load balancer, uptime monitor, or orchestrator health check, either:
  - add a minimal health endpoint (e.g. via `@nestjs/terminus`, checking DB connectivity), or
  - use a basic TCP/HTTP check against `GET /` or any lightweight authenticated-but-cheap route, understanding it won't verify DB connectivity.
- **Logs**: the app uses Nest's built-in `Logger` only (stdout) — no file logging, no Winston/Pino. Under Docker, rely on `docker compose logs` / the Docker log driver (configure `json-file` with `max-size`/`max-file`, or ship to your log aggregator). Under PM2, `pm2 logs` and PM2's built-in log rotation module (`pm2 install pm2-logrotate`).
- **Uptime monitoring**: point an external uptime check (e.g. UptimeRobot, Better Uptime) at `https://api.yourcrm.com/api/docs` (200 response) until a real `/health` route exists.
- **Postgres**: the Compose file already defines a `pg_isready` healthcheck; alert on container restarts.

## 12. Scaling notes — cron jobs & single-instance constraint

Two `@nestjs/schedule` cron jobs run **in-process**:

| Job | Schedule | File |
|---|---|---|
| Auto-absent marking | `55 23 * * *` (Asia/Kolkata) | `src/modules/employee-management/services/attendance.service.ts` |
| Task reminder → notification | `*/5 * * * *` | `src/modules/notifications/services/notifications.service.ts` |

**Do not run more than one instance of this backend** (no PM2 cluster mode, no multiple Docker replicas) without first externalizing these jobs (e.g. moving them to a dedicated worker, or adding a distributed lock) — otherwise every instance fires both jobs independently, causing duplicate absentee-marking runs and duplicate notifications. If load requires horizontal scaling, treat this as a required refactor first, not an infrastructure-only change.

## 13. Updating / redeploying

**Docker Compose:**

```bash
cd /path/to/repo
git pull
docker compose build backend
docker compose exec backend npx prisma migrate deploy    # if new migrations exist, do this against the OLD container just before swapping, or immediately after the new one starts but before serving traffic
docker compose up -d backend
docker compose logs -f backend
```

**Bare-metal/PM2:**

```bash
cd /opt/crm/nestjs-crm-backend
git pull
npm ci
npx prisma migrate deploy
npm run build
pm2 restart crm-backend
```

There is no CI/CD pipeline in the repo (no `.github/workflows`) — deploys are manual unless your team sets one up.

## 14. Known gaps to flag to the team

These are current, real gaps in the codebase — not deployment mistakes — worth acknowledging up front so they aren't discovered as production incidents:

- No rate limiting (no `@nestjs/throttler`), no Helmet security headers, no CSRF protection at the application layer — mitigate at the Nginx/WAF layer (e.g. `limit_req` on `/auth/*` and the two `/webhooks/*` paths).
- No `/health` endpoint (see §11).
- No automated test suite — there is no CI gate to catch regressions before deploy.
- Webhook endpoints (`/webhooks/leads/:token`, `/webhooks/whatsapp/:slug`) rely on an unguessable URL rather than a signed-request scheme; treat the token/slug values as secrets and rotate them (via the app's "reveal secret" endpoints) if ever leaked in logs or screenshots.
- Background cron jobs are in-process (§12) — a hard blocker to naive horizontal scaling.

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App exits immediately on start with an encryption/key-length error | `CREDENTIALS_ENCRYPTION_KEY` missing or not exactly 32 bytes | Regenerate with `openssl rand -hex 32` and set it in `.env` |
| `MODULE_NOT_FOUND: dist/main` | Ran `node dist/main` directly | Use `npm run start:prod` or `node dist/src/main.js` (matches `nest-cli.json`'s `sourceRoot: "src"`) |
| Browser requests blocked by CORS | `CORS_ORIGINS` unset or doesn't match the frontend's exact origin | Set the exact scheme+host in `CORS_ORIGINS`, comma-separated for multiple, restart the app |
| Backend can't reach Postgres in Docker | `DATABASE_URL` in `nestjs-crm-backend/.env` still says `localhost` | Under Compose this is intentionally overridden — confirm `docker compose config` shows the `postgres` hostname; under bare-metal, point it at the real DB host |
| Portal/Meta webhook calls fail or 404 | `WEBHOOK_BASE_URL` wrong, or Nginx not proxying the exact path | Recreate the integration in-app to get the current expected URL; verify with `curl` from outside the VPS |
| Attendance/notification jobs firing multiple times a day/interval | More than one backend instance running the same cron | Reduce to a single instance (§12) |
| 401 on every authenticated request right after deploy | `JWT_ACCESS_SECRET` changed (e.g. rotated) | Expected — all existing access tokens are invalidated; users must log in again |
