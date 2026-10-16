# Tulsi ERP — Backend

A multi-tenant ERP/CRM backend for wholesalers (first tenant: Tulsi Plywood), built with **NestJS 10**, **Prisma 5** and **PostgreSQL** as a modular monolith. It started as a clone of the RCRM backend and keeps RCRM's auth, RBAC, WhatsApp, notification and employee features.

## What Phase 1 does

- **Organizations & users** — Super Admin onboards an organization with its Admin; Admins and Managers create staff (`ADMIN`, `MANAGER`, `CALLER`, `DELIVERY_PARTNER`, `WAREHOUSE_STAFF`). Single `/auth/login`, JWT + rotating refresh tokens, invite/verification emails.
- **Employee management** — daily check-in / check-out with a required work summary, attendance reports (absent = no row), leave, targets, activity log, per-employee lead reports.
- **Lead ingestion** — one `LeadIngestionService.ingest()` for Click-to-WhatsApp (with ad attribution), WhatsApp organic, Meta Lead Forms (relay URL and native webhook), website/generic webhooks, manual entry and Excel import. Phone (E.164) is the lead's identity: a repeat enquiry on an open lead becomes a `RE_ENQUIRY`, not a duplicate.
- **Allocation** — round robin to `OrgSettings.allocationTargetRole` (default `MANAGER`) with a row lock, optional "checked-in only", manual reassignment with history.
- **Lead management** — role-scoped list/view/edit, status rules (`CONVERTED` needs a note, `LOST` a reason), follow-ups, timeline, notes, soft delete, notifications + web push.

Out of scope for Phase 1: inventory, products, warehouses, customers, quotations, orders, dispatch, billing, GST invoices.

## Docs

| File | Contents |
|---|---|
| [`docs/API.md`](docs/API.md) | Endpoints, roles, request/response samples |
| [`docs/PHASE1_DATABASE.md`](docs/PHASE1_DATABASE.md) | Schema, ingestion contract, seed, verification checklist |
| [`docs/REUSE_MAP.md`](docs/REUSE_MAP.md) | What was kept / changed / removed from RCRM |
| [`CLAUDE.md`](CLAUDE.md) | Project context and working rules for AI-assisted sessions |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | VPS deployment |

Swagger UI is served at `/api/docs`.

## Local development

```bash
npm install                      # npm 12: bcrypt/prisma install scripts are approved in package.json "allowScripts"
cp .env.example .env             # set DATABASE_URL to a dedicated Tulsi database, JWT_ACCESS_SECRET, CREDENTIALS_ENCRYPTION_KEY
npx prisma migrate dev           # apply migrations (prisma/migrations)
npm run build && npx prisma db seed   # seed runs dist/prisma/seed.js (or: npm run prisma:seed)
npm run start:dev                # http://localhost:3000, Swagger at /api/docs
```

Checks:

```bash
npx prisma validate
npx tsc --noEmit
npm run build
npm run lint                     # check only; npm run lint:fix to auto-fix
npm test                         # node:test specs in test/**
```

Testing without SMTP: set `AUTO_VERIFY_NEW_USERS=true` so new users and orgs are created already verified.

## Seeded accounts

All use `SEED_DEFAULT_PASSWORD` (default `Demo@1234`): `superadmin@tulsi-erp.local`, `admin@tulsiplywood.local`, and the Demo Wholesale org — `demo.admin@`, `demo.manager1@`/`2@`, `demo.caller1@`…`4@`, `demo.driver1@`/`2@` (all `@tulsi-erp.local`). See `docs/API.md` §12.

## Environment

See `.env.example` for every key. Lead webhooks need `WEBHOOK_BASE_URL` (public HTTPS origin); the native Meta Lead Ads webhook needs `META_APP_SECRET` and `META_VERIFY_TOKEN`; WhatsApp and stored page tokens need `CREDENTIALS_ENCRYPTION_KEY`.
