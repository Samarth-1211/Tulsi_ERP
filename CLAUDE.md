# tulsi-erp-backend

Multi-tenant ERP/CRM backend for wholesalers. First tenant: Tulsi Plywood.
Built by converting the RCRM (real-estate CRM) backend in place.

## Stack
NestJS 10 · Prisma 5 · PostgreSQL · TypeScript · JWT (passport-jwt) + hashed refresh tokens · bcrypt · Swagger · web-push · nodemailer.
Modular monolith, MVC per module folder (`controllers/ dto/ services/`).

## Source of truth
- DB + seed + ingestion contract: `docs/PHASE1_DATABASE.md` (§4.1 schema, §5 ingest, §6 seed, §7 checklist).
- Endpoints + roles: `docs/API.md`. What was kept/removed from RCRM: `docs/REUSE_MAP.md`.
- IDs are `uuid()` (RCRM strategy). Deviations from the spec are listed at the top of `prisma/schema.prisma`.

## Modules (`src/modules`)
- `user-integration` — auth (`/auth/login`, refresh), SuperAdmin (orgs + org admins), `org_specific_admin` (admin creates staff), `Manager` (team).
- `lead-ingestion` — leads CRUD, allocation (round robin), dedup, generic webhook `/webhooks/leads/:token`, Excel import.
- `platform_IntegrationModule` — Integration CRUD (generated webhook URL + sample payload).
- `whatsapp-integration` — Cloud API webhook, inbox, CTWA referral capture (keep behavior identical to RCRM).
- `lead-allocation-admin` — allocation settings. `employee-management` — employees, attendance, leave, targets, activities.
- `dashboard` (`GET /dashboard/me`), `tasks`, `notifications` (in-app + web push, no sockets), `mail`, `verification`. Shared: `src/common`, `src/prisma`.

## Roles (enum `Role`)
SUPER_ADMIN, ADMIN, MANAGER, CALLER, DELIVERY_PARTNER, WAREHOUSE_STAFF.
SUPER_ADMIN → creates Organization + its ADMIN. ADMIN → MANAGER/CALLER/DELIVERY_PARTNER/WAREHOUSE_STAFF in own org.
MANAGER → CALLER/DELIVERY_PARTNER/WAREHOUSE_STAFF with managerId = self. No public signup.
Every created user gets an invite email. `AUTO_VERIFY_NEW_USERS=true` (testing, no SMTP) creates users/orgs already verified.

## Org-scoping rule
Every tenant-owned row has `orgId`. Every query is scoped by the caller's `orgId` from the JWT user
(`@CurrentUser()`); lead visibility goes through `src/common/utils/lead-scope.util.ts`
(ADMIN: org, MANAGER: own + team, CALLER: own). Soft-deleted rows (`deletedAt`) are excluded by default.
Phase 2 (inventory, customers, orders, dispatch, billing) is out of scope — never block it: keep `orgId` everywhere, keep ingestion source-agnostic.

## Token-economy rules
- Code already exists — never re-type it. Change only what must change; remove modules with `git rm -r`.
- Minimal diffs with Edit on exact lines; never rewrite a whole file for a few lines.
- Read only files you are about to edit, only the relevant part.
- Find rename sites with `grep -rn`; careful `sed` for mechanical renames; report counts before/after.
- Verify with tools (validate, tsc, build, lint, tests), not by re-reading. Pipe long output through `| tail -40`.
- Work phase by phase; short report (≤15 lines) at the end of each phase; wait for "go".
- Ask, don't guess, when RCRM differs from the plan.

## Git
`origin` = new Tulsi repo (not yet added). `rcrm-upstream` = RCRM, push URL DISABLED — never push there.
Do not commit or push unless the user says so.

## Commands
```bash
npx prisma validate            # schema check
npx prisma generate            # client
npx prisma migrate dev --name <name>
npx prisma db seed             # runs dist/prisma/seed.js — build first (npm run prisma:seed does both); idempotent
npx tsc --noEmit
npm run build
npm run lint                   # check only (lint:fix to fix)
npm test                       # node:test specs in test/**
npm run start:dev
```
DB: local PostgreSQL `wholeseler_erp` (see `.env`; `.env` is git-ignored, keys in `.env.example`).
