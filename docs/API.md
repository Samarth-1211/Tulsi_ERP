# Tulsi ERP — API Reference (Phase 1)

## 1. Purpose

REST API of `tulsi-erp-backend`, the multi-tenant ERP/CRM backend for wholesalers (first tenant: Tulsi Plywood). Phase 1 covers organizations and users, authentication and RBAC, employee management and attendance, lead ingestion (Click-to-WhatsApp, Meta Lead Forms, generic webhook, manual entry, Excel), round-robin allocation and lead management.

- Base URL: `http://localhost:3000` (no global prefix).
- Swagger UI: `/api/docs` (every route below is also described there, with request schemas).
- Database contract: `docs/PHASE1_DATABASE.md`.
- All IDs are UUIDs. All timestamps are ISO-8601 UTC. "Today" means the org-local day in India (IST).

## 2. Authentication

Every endpoint except `/auth/*` and `/webhooks/*` needs `Authorization: Bearer <accessToken>`.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/login` | Public | Single login for every role; returns an access + refresh token pair |
| `POST` | `/auth/refresh` | Refresh token | Rotates the refresh token and issues a new pair |
| `POST` | `/auth/logout` | Refresh token | Revokes the refresh token |
| `POST` | `/auth/verify-email` | Public | Consumes an emailed verification token |
| `POST` | `/auth/forgot-password` | Public | Emails a 6-digit OTP |
| `POST` | `/auth/reset-password` | Public | Resets the password with the OTP (revokes every session) |
| `POST` | `/auth/super-admin/login` | Public | Legacy RCRM portal login (SUPER_ADMIN only); `/auth/login` also accepts SUPER_ADMIN |

#### `POST /auth/login`

```json
{ "email": "demo.caller1@tulsi-erp.local", "password": "Demo@1234" }
```

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<base64url-user-id>.<random>",
  "expiresIn": "15m",
  "user": { "id": "…", "email": "demo.caller1@tulsi-erp.local", "name": "Amit Caller", "role": "CALLER", "orgId": "…" }
}
```

The JWT carries `sub`, `email`, `role`, `orgId` (`null` for SUPER_ADMIN). Only `ACTIVE`, non-deleted, verified users can log in; wrong email and wrong password return the same `401`. `lastLoginAt` is stamped on success.

#### `POST /auth/refresh` / `POST /auth/logout`

```json
{ "refreshToken": "<opaque-refresh-token>" }
```

Refresh returns `{ accessToken, refreshToken, expiresIn }`; the used token is revoked (`revokedAt`). Logout returns `{ "success": true }`.

## 3. Roles and access

| Role | Purpose |
|---|---|
| `SUPER_ADMIN` | Platform owner: creates organizations and their ADMIN. Has no org. |
| `ADMIN` | Runs one organization. |
| `MANAGER` | Leads a team of callers / delivery partners / warehouse staff. |
| `CALLER` | Works assigned leads. |
| `DELIVERY_PARTNER` | Logs in and marks attendance (Phase 2 features). |
| `WAREHOUSE_STAFF` | Logs in and marks attendance (Phase 2 features). |

### 3.1 Who creates whom

| Creator | Can create | Endpoint |
|---|---|---|
| `SUPER_ADMIN` | Organization + its `ADMIN` | `POST /organizations`, `POST /organizations/:id/admin` |
| `ADMIN` | `MANAGER`, `CALLER`, `DELIVERY_PARTNER`, `WAREHOUSE_STAFF` (own org) | `POST /users` (any of these), `POST /managers` (managers) |
| `MANAGER` | `CALLER`, `DELIVERY_PARTNER`, `WAREHOUSE_STAFF` with `managerId = self` | `POST /users`, `POST /manager/team-members` |

Every created user gets an invite email with a verification link. With `AUTO_VERIFY_NEW_USERS=true` (testing without SMTP) users and orgs are created already verified; the email is still attempted and the response carries `emailDelivery: { sent, error? }`.

### 3.2 Lead RBAC

| Action | ADMIN | MANAGER | CALLER | DELIVERY / WAREHOUSE |
|---|---|---|---|---|
| List / view | all in org | own + team's | assigned to self | no access (403) |
| Create | yes | yes | yes | no |
| Update fields | all | own + team's | own | no |
| Change status | all | own + team's | own | no |
| Assign / reassign | anyone | self / own team | no | no |
| Delete (soft) | yes | no | no | no |

Every query is scoped by the caller's `orgId`; soft-deleted users and leads are excluded. A lead outside the caller's scope returns `404`, a role not allowed on the route returns `403`.

## 4. Conventions

- Validation errors: `400` with `{ "statusCode": 400, "message": ["…"], "error": "Bad Request" }`. Unknown body fields are rejected (`whitelist` + `forbidNonWhitelisted`), except on webhooks.
- Pagination (lists that page): `?page=1&pageSize=25` → `{ items, total, page, pageSize }`.
- Delete endpoints from RCRM require the typed confirmation body `{ "confirmation": "delete" }`.

## 5. Dashboard

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `GET` | `/dashboard/me` | All | Role-specific stats |

Response by role:

- `ADMIN`: `{ role, leads: { total, unassigned, newToday, byStatus, bySource }, users: { MANAGER: 2, CALLER: 4, … }, attendance: { checkedInToday } }`
- `MANAGER`: `{ role, leads: { total, followUpsToday, byStatus }, team: { size, checkedInToday, members: [{ id, name, role, attendance, checkInAt, checkOutAt }] }, attendance }`
- `CALLER`: `{ role, leads: { total, byStatus }, followUpsToday: [{ id, name, phone, status, nextFollowUpAt }], attendance }`
- `DELIVERY_PARTNER` / `WAREHOUSE_STAFF`: `{ role, attendance: { today, presentThisMonth } }`
- `SUPER_ADMIN`: `{ role, organizations, activeOrganizations, users }`

## 6. Organizations and users

### 6.1 Organizations (SUPER_ADMIN)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/organizations` | Create an org with its first ADMIN (also creates its `OrgSettings`) |
| `GET` | `/organizations?status=ACTIVE\|SUSPENDED\|ARCHIVED&search=` | List |
| `GET` | `/organizations/:id` | One org |
| `PATCH` | `/organizations/:id` | Update name / contact / address |
| `POST` | `/organizations/:id/admin` | Add another ADMIN |
| `POST` | `/organizations/:id/resend-verification` | Re-send unverified admins' links |
| `PATCH` | `/organizations/:id/suspend` | `isActive=false`, users deactivated |
| `PATCH` | `/organizations/:id/reactivate` | `isActive=true` |
| `DELETE` | `/organizations/:id` | Archive (`archivedAt`), users deactivated |

#### `POST /organizations`

```json
{
  "name": "Tulsi Plywood",
  "email": "contact@tulsiplywood.com",
  "phone": "+91 98765 43210",
  "address": "Siyaganj, Indore",
  "gstin": "23AAAAA0000A1Z5",
  "city": "Indore",
  "state": "Madhya Pradesh",
  "admin": { "adminEmail": "owner@tulsiplywood.com", "adminPassword": "Temp@12345", "adminName": "Ramesh Kumar" }
}
```

### 6.2 Users

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `POST` | `/users` | ADMIN, MANAGER | Create a user per §3.1 |
| `GET` | `/users?deleted=true` | ADMIN, MANAGER | Org users (Manager: own team); `deleted` = archive (Admin) |
| `GET` | `/users/:id` | Authenticated, scoped | One user |
| `PATCH` | `/users/:id/deactivate` · `/reactivate` | ADMIN | `status` INACTIVE / ACTIVE |
| `GET` | `/users/:id/deletion-impact` | ADMIN | Open leads/tasks + who can take them |
| `DELETE` | `/users/:id` | ADMIN | Archive the account, hand over leads/tasks/team |

#### `POST /users`

```json
{
  "email": "neha@tulsiplywood.com",
  "password": "Temp@12345",
  "name": "Neha Sharma",
  "phone": "+919812345678",
  "role": "CALLER",
  "managerId": "<manager-user-id>"
}
```

`managerId` must be a MANAGER in the org (ignored when a Manager creates the user — always self). Response: the user without `passwordHash`, plus `emailDelivery`.

### 6.3 Managers (ADMIN) and manager team (MANAGER)

| Method | Endpoint | Description |
|---|---|---|
| `POST/GET` | `/managers`, `/managers/:id` | Admin creates / lists managers (invite email) |
| `PATCH` | `/managers/:id`, `/managers/:id/deactivate`, `/managers/:id/reactivate` | Update / status |
| `DELETE` | `/managers/:id` | Delete with handover |
| `POST/GET` | `/manager/team-members` | Manager creates / lists own CALLER, DELIVERY_PARTNER, WAREHOUSE_STAFF (`?role=&isActive=&page=&pageSize=`) |
| `GET/PATCH/DELETE` | `/manager/team-members/:id` | One member (name, phone, `isActive`) |
| `PATCH` | `/manager/leads/:leadId/assign` | Assign a lead to an own team member (`{ "userId": "…" }`) |
| `GET` | `/manager/peers` | Other active managers (names) |

## 7. Employee management and attendance

### 7.1 Attendance

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `POST` | `/attendance/check-in` | All except SUPER_ADMIN | Once per org-local day; second → `409` |
| `POST` | `/attendance/check-out` | All except SUPER_ADMIN | Requires a summary (min length from `OrgSettings.checkoutSummaryMinLength`, default 20) → else `400`; computes `workedMinutes` |
| `GET` | `/attendance/me?from&to` | Authenticated | Own rows (default: this month) |
| `GET` | `/attendance/today` | Authenticated | Own row for today, or `null` |
| `GET` | `/attendance?userId&from&to` | ADMIN (org), MANAGER (self + team) | Rows with `user { id, name, role, managerId }` |
| `GET` | `/attendance/team?date=` | MANAGER | Team for one day; no row = `ABSENT` (or `null` today) |
| `GET` | `/attendance/org?date=` | ADMIN | Every active user for one day |
| `GET` | `/attendance/:employeeId?from&to` | Self, their manager, ADMIN | One employee's rows |

```json
POST /attendance/check-in
{ "lat": 22.7196, "lng": 75.8577 }
```

```json
POST /attendance/check-out
{ "summary": "Called 12 leads, shared rate list on WhatsApp, 3 follow-ups booked.", "lat": 22.72, "lng": 75.86 }
```

Check-out response: the attendance row with `status: "CHECKED_OUT"`, `checkOutAt`, `workedMinutes`, `summary`. Check-in is refused (`400`) on an approved leave day. "Absent" is never stored — it is a day without a row.

### 7.2 Employees, reports, leave, targets, activities (RCRM, kept)

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `GET` | `/employees/:id/summary` | Self, their manager, ADMIN | `leadsAssigned`, `activeWorkload`, `totalConversions`, `statusBreakdown` |
| `GET` | `/employees/:id/profile` · `/overview` | Same | Profile; overview with leads, leave, target, team, tasks |
| `GET` | `/employees/team-summary` · `/team-rollup` | MANAGER | Team workload; today's attendance + lead snapshot + target |
| `PATCH` | `/employees/me/profile` · `/me/email` · `/me/password` | Self | Own profile |
| `PATCH` | `/employees/:id/employee-code` | MANAGER (team), ADMIN | Set employee code |
| `GET` | `/activities/report?employeeId&from&to` | Self, their manager, ADMIN | Day-by-day `{ present, attendance, activities }` + `summary { totalDays, presentDays, absentDays }` (weekly/monthly views roll up these days) |
| `POST/GET` | `/activities`, `/activities/me`, `/activities/team`, `/activities/org` | Various | Employee activity log |
| `POST/GET/PATCH` | `/leave/apply`, `/leave/me`, `/leave/team/pending`, `/leave/org`, `/leave/:id/approve`, `/leave/:id/reject` | Various | Leave requests |
| `PUT/GET` | `/targets`, `/targets/me`, `/targets/team` | Various | Monthly targets (CALLS / CONVERSIONS) |

## 8. Leads

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `POST` | `/leads` | ADMIN, MANAGER, CALLER | Manual entry through the ingestion service |
| `GET` | `/leads` | ADMIN, MANAGER, CALLER | Filtered, paginated list |
| `GET` | `/leads/:id` | ADMIN, MANAGER, CALLER | One lead |
| `PATCH` | `/leads/:id` | ADMIN, MANAGER, CALLER | Edit fields |
| `PATCH` | `/leads/:id/status` | ADMIN, MANAGER, CALLER | Status change |
| `PATCH` | `/leads/:id/assign` | ADMIN, MANAGER | Manual (re)assign |
| `POST` | `/leads/:id/follow-ups` | ADMIN, MANAGER, CALLER | Log a follow-up |
| `POST` | `/leads/:id/notes` | ADMIN, MANAGER, CALLER | Timeline note (notifies the assignee) |
| `GET` | `/leads/:id/activities` | ADMIN, MANAGER, CALLER | Timeline |
| `DELETE` | `/leads/:id` | ADMIN | Soft delete |
| `GET` | `/follow-ups/today` | ADMIN, MANAGER, CALLER | Follow-ups due today |
| `POST` | `/leads/bulk-assign` | ADMIN, MANAGER | Assign many to one person |
| `POST` | `/leads/bulk-delete` | ADMIN | Soft-delete many |
| `POST` | `/leads/lost/shuffle` | ADMIN, MANAGER | Hand LOST leads to someone else |
| `GET` | `/leads/team-performance` | ADMIN, MANAGER | Per-caller totals and conversion % |
| `GET` · `PATCH` | `/leads/unseen-count` · `/leads/seen` | ADMIN, MANAGER, CALLER | "New leads" dot |
| `POST` | `/leads/import/preview` · `/leads/import` | ADMIN, MANAGER | Excel/CSV upload (multipart `file`) |
| `GET` | `/leads/import/template` | ADMIN, MANAGER | Download the .xlsx template |
| `GET` | `/leads/imports`, `/leads/imports/:id`, `/leads/imports/:id/file` | ADMIN (Manager: own upload) | Upload history / progress / original file |
| `DELETE` | `/leads/imports/:id/leads` | ADMIN | Soft-delete one upload's leads |

### 8.1 `POST /leads`

```json
{
  "name": "Sharma Hardware",
  "phone": "9812345678",
  "source": "WALK_IN",
  "altPhone": "9812300000",
  "email": "sharma@example.com",
  "city": "Indore",
  "pincode": "452001",
  "address": "Siyaganj, Indore",
  "customerType": "DEALER",
  "requirementNotes": "18mm BWP 8x4, 50 sheets",
  "estimatedValue": 85000,
  "assignToId": "<user-id>"
}
```

- `source`: `MANUAL` (default) | `WALK_IN` | `REFERRAL` | `OTHER`. Phone in any format → stored as E.164 (`+919812345678`).
- Allocation: ADMIN → `assignToId` (any active user) else round robin; MANAGER → `assignToId` self/team else SELF; CALLER → always SELF (`assignToId` → `403`).
- If the phone already has an open lead, no lead is created: a `RE_ENQUIRY` activity is added to the existing one and it is returned with `"deduplicated": true`.

Response `201`: the lead + `deduplicated`.

### 8.2 `GET /leads`

Query: `status`, `source`, `customerType`, `assignedToId`, `city`, `from`, `to` (created date, inclusive days), `search` (name or phone), `page`, `pageSize` (≤ 200).

```json
{
  "items": [
    {
      "id": "…", "name": "Sharma Hardware", "phone": "+919000000010", "source": "WHATSAPP_CTWA",
      "status": "ASSIGNED", "customerType": "DEALER", "city": "Indore", "requirementNotes": "18mm BWP 8x4, 50 sheets",
      "assignedTo": { "id": "…", "name": "Rahul Manager", "email": "…", "role": "MANAGER", "managerId": null },
      "attribution": { "campaignName": null, "adName": null, "adId": "120200000000000", "formName": null, "ctwaClid": "seed_ctwa_0" },
      "nextFollowUpAt": null, "lastActivityAt": "…", "createdAt": "…"
    }
  ],
  "total": 12, "page": 1, "pageSize": 25
}
```

`GET /leads/:id` adds `createdBy`, `integration`, full `attribution`, `importBatch`, `adSource`, `previousLead`, the last 10 `followUps`, and `_count { whatsappMessages, followUps, activities }`.

### 8.3 `PATCH /leads/:id/status`

```json
{ "status": "CONVERTED", "note": "40 sheets BWP, advance paid" }
```

```json
{ "status": "LOST", "lostReason": "Price too high" }
```

- `CONVERTED` requires `note` and sets `convertedAt` (how a caller closes a deal).
- `LOST` requires `lostReason`. With `OrgSettings.autoReallocateLostLeads` the lead is immediately handed to someone else of the same role.
- Each change writes a `STATUS_CHANGED` activity with `meta { from, to }`. The assignee's first status change or activity sets `firstResponseAt`.

### 8.4 `PATCH /leads/:id/assign`

```json
{ "toUserId": "<user-id>", "reason": "Customer asked for a Hindi-speaking caller" }
```

ADMIN → anyone active in the org; MANAGER → only own/team leads, to self or own team (`403` otherwise). Writes a `LeadAssignment` (`MANUAL`), a `REASSIGNED` activity (`ASSIGNED` for an unowned lead) and notifies the new assignee. A `NEW` or `LOST` lead becomes `ASSIGNED`.

### 8.5 Follow-ups

```json
POST /leads/:id/follow-ups
{ "note": "Called, shared BWP rate list.", "outcome": "INTERESTED", "nextFollowUpAt": "2026-10-20T11:00:00+05:30" }
```

Closes earlier pending follow-ups of the lead, sets `lead.nextFollowUpAt` and `lastActivityAt`, writes a `FOLLOW_UP` activity, and moves an `ASSIGNED` lead to `IN_PROGRESS`.

`GET /follow-ups/today` → pending follow-ups due by the end of today (overdue included, flagged `overdue: true`) on open leads: Caller — own leads, Manager — own + team, Admin — org.

```json
[{ "id": "…", "note": "…", "nextFollowUpAt": "…", "overdue": false,
   "lead": { "id": "…", "name": "Raju Carpenter", "phone": "+91…", "status": "IN_PROGRESS", "city": "Dewas", "assignedTo": { "id": "…", "name": "…" } },
   "user": { "id": "…", "name": "…" } }]
```

### 8.6 Timeline and notes

`GET /leads/:id/activities` → `[{ id, type, message, meta, createdAt, user: { id, name, role } | null }]`, newest first. Types: `CREATED, ASSIGNED, REASSIGNED, STATUS_CHANGED, UPDATED, NOTE, CALL, WHATSAPP, FOLLOW_UP, RE_ENQUIRY, DELETED`.

`POST /leads/:id/notes` `{ "note": "Offer the Century rate." }` → `NOTE` activity; when written by someone other than the assignee (e.g. their manager) the assignee gets a notification.

### 8.7 Excel / CSV import

Template columns: Customer Name*, Mobile No.* (comma-separated → main + alternate), Email, City, Pincode, Address, Customer Type, Requirement, Estimated Value (₹), Remarks. Rows go through the ingestion service with source `CSV_IMPORT`; the uploader picks the split (`allocationMode`: `ALL_TEAMS`, `MANAGERS_AND_TEAMS`, `MANAGERS_ONLY`, `CUSTOM`). A phone with an open lead becomes a re-enquiry (counted as a duplicate in the report).

## 9. Allocation settings

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `GET` | `/settings/allocation` | ADMIN | Current settings |
| `PATCH` | `/settings/allocation` | ADMIN | Update |

```json
{ "allocationMode": "ROUND_ROBIN", "allocationTargetRole": "MANAGER", "allocateOnlyCheckedIn": false, "autoReallocateLostLeads": false }
```

Round robin: active, non-deleted users of `allocationTargetRole` (`MANAGER` or `CALLER`) in the org, not on approved leave (and, with `allocateOnlyCheckedIn`, with a `CHECKED_IN` attendance row today); the one with the oldest `lastLeadAssignedAt` (never-assigned first) wins, picked under a row lock so parallel webhooks never double-assign. No candidate → the lead stays `NEW` and the org's Admins get an "Action needed" notification. `MANUAL` mode leaves new leads unassigned.

## 10. Lead sources and webhooks

Every source calls `LeadIngestionService.ingest()` (DB doc §5): phone normalized to E.164 (default +91; invalid → rejected), open lead with the same phone → `RE_ENQUIRY`, else create lead + attribution + `CREATED` activity, then allocate (explicit → `MANUAL`, Caller/Manager creator → `SELF`, else round robin) and notify.

### 10.1 Integrations (ADMIN; MANAGER read-only without credentials)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/platform-integrations` | Create; returns `webhookUrl`, `samplePayload` (and `metaWebhook` for Meta) |
| `GET` | `/platform-integrations`, `/platform-integrations/:id` | List / one |
| `POST` | `/platform-integrations/:id/reveal-secret` | Re-show URL, sample payload, verify token |
| `PATCH` | `/platform-integrations/:id` | Update name, status, page id, page token, form ids, field mapping |
| `DELETE` | `/platform-integrations/:id` | Set `INACTIVE` |

```json
POST /platform-integrations
{
  "type": "META_LEAD_FORM",
  "name": "Meta Lead Forms — Tulsi page",
  "externalAccountId": "<facebook-page-id>",
  "pageAccessToken": "<page-access-token>",
  "formIds": ["120200000000004"],
  "fieldMapping": { "full_name": "name", "phone_number": "phone", "which_product_do_you_need": "requirementNotes" }
}
```

```json
{
  "id": "…", "type": "META_LEAD_FORM", "name": "…", "status": "ACTIVE", "externalAccountId": "…", "hasPageAccessToken": true,
  "webhookUrl": "https://api.example.com/webhooks/leads/<webhookToken>",
  "samplePayload": { "name": "Sharma Hardware", "phone": "+919812345678", "…": "…" },
  "metaWebhook": { "callbackUrl": "https://api.example.com/webhooks/meta/leadgen", "verifyToken": "<token>", "note": "…" }
}
```

`type`: `META_LEAD_FORM` or `WEBHOOK_GENERIC`. The page token is encrypted at rest and never returned.

### 10.2 Common lead URL — `POST /webhooks/leads/:webhookToken` (public)

For n8n / Pabbly / Zapier / Make relaying Meta form leads, and website forms. Only `name` and `phone` are required; unknown fields are ignored.

```json
{
  "name": "Sharma Hardware", "phone": "+919812345678", "email": "sharma@example.com",
  "city": "Indore", "pincode": "452001", "customerType": "DEALER", "requirement": "18mm BWP 8x4, 50 sheets",
  "campaign_id": "…", "campaign_name": "Plywood Leads Oct", "adset_id": "…", "adset_name": "…",
  "ad_id": "…", "ad_name": "…", "form_id": "…", "form_name": "Bulk Enquiry Form",
  "leadgen_id": "120200000000005",
  "extra": { "preferred_brand": "Century" }
}
```

| Response | Meaning |
|---|---|
| `200 { "status": "received", "eventId" }` | Stored as a `WebhookEvent`, processed right after the response |
| `200 { "status": "duplicate", "eventId" }` | Same `leadgen_id` already received — stored as a `DUPLICATE` event, no new lead |
| `400 { "message": [...], "eventId" }` | Invalid payload (event kept as `FAILED`) |
| `404` | Unknown or inactive token |

Source: `META_LEAD_FORM` for a Meta-form integration or when form/ad/leadgen ids are present, otherwise `WEBSITE`. `extra` → `customFields`; campaign/ad/form fields → `LeadAdAttribution`.

### 10.3 Native Meta Lead Ads — `/webhooks/meta/leadgen` (public)

- `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` → echoes the challenge when the token is `META_VERIFY_TOKEN` or an integration's `verifyToken`; else `403`.
- `POST` — must carry `X-Hub-Signature-256` signed with `META_APP_SECRET` (else `401`). Each `leadgen` change is routed by `page_id` → `Integration.externalAccountId`, stored as a `WebhookEvent` (`externalId = leadgen_id`), answered `200 { status, received, duplicates, unrouted }`, then processed: the lead's `field_data` is fetched from the Graph API with the integration's page token and mapped through `config.fieldMapping` (then Meta's standard keys); unmapped answers go to `customFields`.

### 10.4 WhatsApp Cloud API (RCRM module, unchanged)

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `GET` · `POST` | `/webhooks/whatsapp/:slug` | Public (Meta) | Verification handshake · signed message/status webhook |
| `POST/GET/PATCH/DELETE` | `/integrations/whatsapp` (+ `/enable`, `/reveal-verify-token`, `/permanent`) | ADMIN | Connect the WABA number |
| `GET` | `/whatsapp/inbox`, `/whatsapp/templates` | Lead-scoped | Inbox (chats of the leads the caller can see), approved templates |
| `GET` | `/leads/:leadId/whatsapp/messages`, `/leads/:leadId/whatsapp/messages/:messageId/media` | Lead-scoped | Chat history, media download |
| `POST` | `/leads/:leadId/whatsapp/messages`, `/media`, `/template`, `/read` | Lead-scoped | Send text / media / template, mark read |
| `GET` | `/whatsapp/ad-sources` | ADMIN | Click-to-WhatsApp ads seen so far |
| — | `/whatsapp/debug/*` | ADMIN | Debug console |

A first message from a new number (or a fresh ad tap) goes through `ingest()`: with a `referral` → `WHATSAPP_CTWA` + `LeadAdAttribution` (ad id, `ctwa_clid`, headline, body, media, raw referral); without → `WHATSAPP_ORGANIC`. The conversation is the lead (messages carry `leadId`), so its assignee is the lead's assignee. Later messages from an open lead with a thread stay on that lead.

## 11. Notifications and tasks (RCRM, kept)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/notifications`, `/notifications/unread-count` | Bell |
| `PATCH` | `/notifications/:id/read`, `/notifications/read-all` | Mark read |
| `GET/POST` | `/notifications/push/public-key`, `/push/subscribe`, `/push/unsubscribe`, `/push/test` | Web push |
| `POST/GET/PATCH/DELETE` | `/tasks`, `/tasks/me`, `/tasks/assigned-by-me`, `/tasks/:id`, `/tasks/:id/complete` | Personal / assigned tasks with reminders |

Lead events are delivered the RCRM way — notification rows (bell) + web push, no socket: new lead → org Admins + the assignee's Manager (`LEAD_CAPTURED`) and the assignee (`LEAD_ASSIGNED`); reassignment → new assignee; field edits → Admins + assignee + their Manager (`LEAD_UPDATED`); re-enquiry and manager notes → assignee.

## 12. Inventory (products + stock)

Tables `products` and `stock_movements` (migration `inventory_products`). Read: every org role. Write: ADMIN, MANAGER, WAREHOUSE_STAFF. Delete: ADMIN, MANAGER.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/inventory/products?search&category&lowStock=true&page&pageSize` | List, paginated `{ items, total, page, pageSize }` |
| `GET` | `/inventory/summary` | `{ totalProducts, totalUnits, stockValue, lowStock, outOfStock, byCategory }` |
| `GET` | `/inventory/products/:id` | One product + last 20 stock movements |
| `POST` | `/inventory/products` | Create (optional opening `stock` → `CREATED` movement) |
| `PATCH` | `/inventory/products/:id` | Edit details (not stock) |
| `PATCH` | `/inventory/products/:id/stock` | `{ change: ±n, reason: RECEIVED\|SOLD\|RETURNED\|DAMAGED\|CORRECTION, note? }` — stock never goes below 0 |
| `DELETE` | `/inventory/products/:id` | Soft delete, body `{ "confirmation": "delete" }` (frees the SKU) |
| `GET` | `/inventory/import/template` | Excel template |
| `POST` | `/inventory/import` | Multipart `file` (.xlsx/.csv, ≤ 5 MB) → `{ totalRows, created, updated, failed, issues[] }` — matched by SKU: new SKUs are created, existing ones updated |

```json
POST /inventory/products
{ "name": "Century Club Prime BWP 18mm", "sku": "CEN-BWP-18", "category": "PLYWOOD", "brand": "Century", "grade": "BWP",
  "thickness": "18mm", "size": "8x4 ft", "unit": "SHEET", "price": 3650, "costPrice": 3100, "stock": 120, "reorderLevel": 20 }
```

`category`: PLYWOOD, LAMINATE, BLOCKBOARD, MDF, HDHMR, VENEER, DOOR, HARDWARE, OTHER · `unit`: SHEET, PIECE, BOX, SQFT, KG.

## 13. Seeded accounts (`npx prisma db seed`)

Password: `SEED_DEFAULT_PASSWORD` or `Demo@1234`.

| Org | Role | Email |
|---|---|---|
| — | SUPER_ADMIN | `superadmin@tulsi-erp.local` |
| Tulsi Plywood | ADMIN | `admin@tulsiplywood.local` |
| Demo Wholesale | ADMIN | `demo.admin@tulsi-erp.local` |
| Demo Wholesale | MANAGER | `demo.manager1@tulsi-erp.local`, `demo.manager2@tulsi-erp.local` |
| Demo Wholesale | CALLER | `demo.caller1..4@tulsi-erp.local` (1–2 → manager1, 3–4 → manager2) |
| Demo Wholesale | DELIVERY_PARTNER | `demo.driver1@tulsi-erp.local`, `demo.driver2@tulsi-erp.local` |

The demo org also gets 12 leads across sources/statuses (re-created on every seed run), two inactive integrations, yesterday's attendance for every caller and today's check-in for callers 1–2.
