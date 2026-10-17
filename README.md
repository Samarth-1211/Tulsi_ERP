# Tulsi ERP — Backend

Backend for **Tulsi ERP**, a multi-tenant ERP/CRM for wholesalers. The first tenant is **Tulsi Plywood**, a plywood wholesaler in Indore.

Phase 1 covers the sales side of the business:

- capturing enquiries from WhatsApp ads, Facebook/Instagram lead forms, the website, walk-ins and spreadsheets
- handing them out to the sales team automatically
- tracking every lead until it is converted or lost
- running the team: accounts, roles, attendance, leave, targets and tasks

Built with **NestJS 10**, **Prisma 5** and **PostgreSQL** as a modular monolith. The API is documented in [`docs/API.md`](docs/API.md) and in Swagger at `/api/docs`.

---

## Contents

1. [Who uses it — roles](#1-who-uses-it--roles)
2. [Organizations and onboarding](#2-organizations-and-onboarding)
3. [Login and accounts](#3-login-and-accounts)
4. [Users and teams](#4-users-and-teams)
5. [Dashboard](#5-dashboard)
6. [Attendance](#6-attendance)
7. [Employee reports, activity log, leave and targets](#7-employee-reports-activity-log-leave-and-targets)
8. [Lead capture — every source, one pipeline](#8-lead-capture--every-source-one-pipeline)
9. [Lead allocation](#9-lead-allocation)
10. [Working a lead](#10-working-a-lead)
11. [WhatsApp inbox and messaging](#11-whatsapp-inbox-and-messaging)
12. [Tasks and reminders](#12-tasks-and-reminders)
13. [Notifications and push](#13-notifications-and-push)
14. [Security and data rules](#14-security-and-data-rules)
15. [Getting started](#15-getting-started)
16. [Configuration](#16-configuration)
17. [Project structure](#17-project-structure)
18. [Not in Phase 1](#18-not-in-phase-1)

---

## 1. Who uses it — roles

| Role | Who | What they can do |
|---|---|---|
| **Super Admin** | Platform owner | Onboards organizations and their first admin; suspends, reactivates or archives organizations. Belongs to no organization. |
| **Admin** | Business owner / office head | Runs one organization: creates staff, sees every lead, sets allocation rules, connects WhatsApp and lead sources, deletes leads. |
| **Manager** | Team lead | Creates and manages their own team, sees their own and their team's leads, reassigns within the team, follows team attendance and targets. |
| **Caller** | Sales / tele-caller | Works the leads assigned to them: calls, follow-ups, status updates, closing the deal. |
| **Delivery Partner** | Driver | Logs in and marks attendance. Delivery features arrive in Phase 2. |
| **Warehouse Staff** | Godown staff | Logs in and marks attendance. Warehouse features arrive in Phase 2. |

Who can create whom:

| Creator | Can create |
|---|---|
| Super Admin | An organization together with its Admin, and further Admins |
| Admin | Managers, Callers, Delivery Partners, Warehouse Staff |
| Manager | Callers, Delivery Partners, Warehouse Staff — always in their own team |

There is no public sign-up. Every account is created by someone above it.

---

## 2. Organizations and onboarding

Each wholesaler is an **organization** (tenant). All of its data is kept separate from every other organization's.

- **Create an organization** together with its first Admin in one step. The Admin gets a welcome email with a temporary password and a verification link. The organization stays "pending" until the Admin verifies.
- **Add more Admins** to an organization at any time.
- **Resend verification** to Admins who haven't verified yet.
- **Edit** the organization's details: name, contact email and phone, address, GSTIN, city and state.
- **Suspend** an organization. Its users are deactivated and can't log in. **Reactivate** it later.
- **Archive** an organization when it leaves the platform. The demo organization can't be archived.
- **Default settings** are created with every organization: allocation mode, round-robin role, check-out summary length and timezone.
- **Audit trail:** every organization action is recorded with who did it and why.

---

## 3. Login and accounts

- **Single login** (`/auth/login`) for every role. It returns a short-lived access token (JWT, 15 minutes by default) and a refresh token.
- **Staying logged in:** the refresh token rotates. Each use revokes the old token and issues a new pair. **Logout** revokes the session.
- **Email verification:** new accounts verify through an emailed link before their first login.
  - For testing without email, set `AUTO_VERIFY_NEW_USERS=true` and accounts are created already verified.
- **Forgot password:** a 6-digit code is emailed (with attempt limits and expiry). Resetting the password signs the user out of every device.
- **Temporary passwords:** accounts created by someone else are flagged until the user sets their own password.
- **My profile:** change your own phone, photo, login email (re-verified) and password (current password required).
- **Last login** is recorded for every user.

---

## 4. Users and teams

- **Create staff** with name, email, phone, role and reporting manager. Each new user gets an invite email.
- **Teams:** a Manager's team is everyone whose `manager` is that Manager. Managers have their own screens to:
  - create, list, edit and filter their team members by role and active status
  - resend invites
  - see the other Managers in the organization
- **Deactivate / reactivate** an account. A deactivated user can't log in and stops receiving leads.
- **Delete with handover:** before deleting a user, the system shows what they still hold (open leads, pending tasks, team members) and who can take it over.
  - The account is archived, not erased, so its history stays readable.
  - Its email and employee code are freed so the person can be re-added later.
- **Employee codes:** Admins, and Managers for their own team, can set a human-readable employee code.
- **Audit trail:** account creation, deactivation, reactivation, deletion and password resets are recorded.

---

## 5. Dashboard

`GET /dashboard/me` gives each person the numbers that matter to their role:

| Role | What they see |
|---|---|
| Admin | Total leads, unassigned leads, new today, leads by status and by source (WhatsApp ad, Meta form, walk-in…), active users by role, how many checked in today |
| Manager | Their team's leads by status, follow-ups due today, team size, and each team member's attendance today (checked in / out / absent) |
| Caller | Their leads by status, today's follow-up list, their own attendance |
| Delivery / Warehouse | Today's attendance and days present this month |
| Super Admin | Number of organizations, active organizations and users on the platform |

---

## 6. Attendance

Everyone except the Super Admin checks in and out each day.

- **Check in** once per day, with optional location (latitude/longitude). A second check-in the same day is refused. Check-in is also refused on an approved leave day.
- **Check out** with a **work summary of the day**, which is required. It must be at least the organization's minimum length (20 characters by default), otherwise check-out is refused. Optional location is recorded, and **worked minutes** are calculated automatically.
- **"Absent"** means no check-in on a day. It is worked out in reports, never stored, so nobody is wrongly marked absent mid-day.
- **Views:**
  - my own history
  - today's status
  - a Manager's team for any day
  - the whole organization for any day (Admin)
  - one employee's history
  - a filtered list by employee and date range (Admin: everyone; Manager: own team only)
- Days follow **Indian time (IST)**.

---

## 7. Employee reports, activity log, leave and targets

- **Employee summary:**
  - leads assigned, leads being worked, conversions and the full status breakdown for one employee
  - an **overview** page with profile, leads, leave history, this month's target, team members and tasks
- **Day / week / month report:** a day-by-day record for any date range (up to a year), with:
  - whether the employee was present
  - their check-in, check-out, worked minutes and summary
  - what they logged that day
  - totals of present and absent days
- **Team summaries for Managers:** each team member's active workload, plus a one-screen rollup of today's attendance, lead snapshot and target progress.
- **Activity log:** employees log what they did (call, WhatsApp, meeting, follow-up, travel, documentation…), optionally linked to a lead. Managers see their team's day; Admins see the whole organization's.
- **Leave:** apply for a date range. Managers approve or reject their team's requests, and Admins see all requests. Approved leave keeps the person out of lead allocation and blocks check-in on those days.
- **Targets:** Managers and Admins set monthly targets per employee (calls or conversions) and see target vs actual.

---

## 8. Lead capture — every source, one pipeline

Every enquiry, from any channel, goes through **one shared ingestion service**, so they're all handled the same way:

1. **Phone number cleanup:** the phone is converted to a standard international format (`+91…` by default). An unusable number is rejected.
2. **No duplicates:** if the same phone already has an open lead in the organization, a new lead is **not** created. The enquiry is added to the existing lead as a **re-enquiry** and its owner is notified. If the person's earlier leads are all converted or lost, a new lead is created and linked to the previous one.
3. **The lead is created** with its source, the customer's details and any ad or campaign information, and a "created" entry is added to its timeline.
4. **The lead is assigned** (see [§9](#9-lead-allocation)) and the right people are notified.

### Sources

| Source | How leads arrive |
|---|---|
| **WhatsApp — Click-to-WhatsApp ads** | A customer taps a Facebook/Instagram ad and messages on WhatsApp. The lead is created from the first message, with the ad details: ad id, click id (`ctwa_clid`), headline, body and image/video. |
| **WhatsApp — organic** | Someone messages the business number directly. A lead is created without ad details. |
| **Meta Lead Forms, via a relay** | n8n, Pabbly, Zapier or Make forwards each form lead to the organization's own webhook URL. Campaign, ad set, ad and form names are kept as attribution. |
| **Meta Lead Forms, direct** | Facebook calls the backend itself. The backend checks Meta's signature, finds the organization from the Facebook page, downloads the form answers, and maps them onto lead fields using the organization's field mapping. Answers that don't map to a field are kept as custom fields. |
| **Website / any form** | The same webhook URL accepts leads from the website or any other tool. |
| **Manual entry** | Admins, Managers and Callers add leads by hand, marked as manual, walk-in, referral or other. |
| **Excel / CSV upload** | Admins and Managers upload a spreadsheet; see below. |

### Webhook integrations

The Admin creates an **integration** (Meta Lead Form or generic webhook), and the system generates:

- a **private webhook URL** to paste into n8n, Zapier or the website
- the **exact sample payload** the sender should send
- for direct Meta connections, the **callback URL and verify token** to enter in Facebook

The Facebook page access token is stored encrypted and never shown again. Integrations can be paused, edited or re-shown later. Managers can see the integrations but not their URLs or tokens.

Every incoming webhook is **saved first and processed right after**, so the sender gets a fast reply and nothing is lost if processing fails. If Meta sends the same form lead twice, it is recorded as a duplicate and creates only one lead. Anything that couldn't be processed is retried automatically when the server restarts.

### Excel / CSV upload

- **Template:** download the ready-made template with columns: Customer Name, Mobile No. (a second number becomes the alternate phone), Email, City, Pincode, Address, Customer Type, Requirement, Estimated Value and Remarks. Common column names and spellings are recognised.
- **Preview** before uploading: how many rows become new leads, how many are already in the system, and how many can't be read.
- **Choose who gets the leads:**
  - every Manager's team
  - picked Managers only
  - picked Managers and their teams
  - a custom split ("Amit 50, Neha 30…")
  - Shares stay fair across uploads, and people on leave are skipped.
- **Background import** with a progress bar, then a per-row report of what was imported, skipped as a duplicate or rejected, and why.
- **Upload history:** Admins see every upload and can download the original file or remove all leads from one sheet.
- **Notifications:** each person gets one summary ("12 new leads assigned to you"), not one per lead.

---

## 9. Lead allocation

### Automatic: round robin

New leads are shared out in turn among the organization's active users of one role, **Managers** by default (switchable to **Callers**):

- The next lead goes to whoever has waited longest since their last lead.
- People who are deactivated, deleted or on approved leave today are skipped.
- **Optional "checked-in only" mode:** only people who have checked in today receive leads.
- Safe under load: two leads arriving at the same moment never go to the same "next" person.
- If nobody is available, the lead waits **unassigned** and the Admins get an "action needed" notification.

Who gets a new lead:

| Created by | Goes to |
|---|---|
| A Caller | Themselves |
| A Manager | Themselves, or someone in their team |
| An Admin | Anyone they pick, or round robin |
| Webhooks, WhatsApp, Meta forms | Round robin |

### Allocation settings (Admin)

`/settings/allocation` sets:

- round robin or manual mode
- which role receives new leads
- "checked-in only"
- auto-reassigning lost leads

### Manual reassignment

- **Reassign one lead** with an optional reason. Admins can give any lead to anyone; Managers can only move their own or their team's leads, and only within their team.
- **Bulk assign** many leads to one person. Leads that can't be moved are listed with the reason.
- **Lost-lead shuffle:** hand lost leads to someone else for a fresh attempt, never back to whoever lost them. Optionally this happens automatically the moment a lead is marked lost.
- Every assignment is kept in the lead's **assignment history**: who it moved from, who it went to, who did it, how and why. It also appears on the lead's timeline.

---

## 10. Working a lead

- **Lead list** with filters:
  - status, source, customer type, assigned person, city
  - date range
  - search by name or phone
  - paging
  - Each lead shows its source, assignee and ad/campaign summary.
- **Lead details:** customer info, assignee, who created it, the integration and ad it came from, full ad attribution, the upload it came from, any earlier lead from the same customer, recent follow-ups, and counts of WhatsApp messages and timeline entries.
- **Edit details:** name, phone (checked against other open leads), alternate phone, email, city, pincode, address, customer type (dealer, retailer, contractor, carpenter, builder, interior designer, homeowner…), requirement, estimated value. Every change is logged with before and after values, and Admins are notified.
- **Status flow:** New → Assigned → In Progress → **Converted** / **Lost**.
  - **Converting** requires a closing note and records when the deal was won. This is how a caller closes a deal.
  - **Losing** requires a reason.
  - Every change is logged on the timeline (from → to).
  - The first time the owner acts on a lead, the **first response time** is recorded.
- **Follow-ups:** log a call or visit with notes, an outcome and the next follow-up date. The lead's next follow-up updates automatically, and the first follow-up moves an assigned lead to In Progress.
- **Today's follow-ups:** one list of what's due today, with overdue items flagged. Callers see their own; Managers see their team's; Admins see everyone's.
- **Timeline:** everything that happened to a lead, in order:
  - created, assigned, reassigned
  - status changes, edits, notes, follow-ups
  - re-enquiries, deletion
- **Notes:** add a note to a lead. A note from a Manager or Admin also notifies the lead's owner, which is how managers pass instructions to their team.
- **Delete** (Admins only): leads are hidden, not erased, and the deletion is logged. Bulk delete is also available.
- **"New leads" dot:** shows how many leads arrived since you last opened the lead list.
- **Team performance:** per person, leads held, open, converted and lost, plus conversion rate, value converted and overdue follow-ups.

Who can do what with leads:

| Action | Admin | Manager | Caller | Delivery / Warehouse |
|---|---|---|---|---|
| See leads | All in the organization | Own + team's | Assigned to them | None |
| Create | ✔ | ✔ | ✔ | — |
| Edit / change status | All | Own + team's | Own | — |
| Assign / reassign | Anyone | Self / own team | — | — |
| Delete | ✔ | — | — | — |

---

## 11. WhatsApp inbox and messaging

- **Connect a WhatsApp Business number** (Meta Cloud API): Admins enter the account details once. Access tokens are stored encrypted, and a private webhook address with a verify token is generated.
- **Shared inbox:** WhatsApp conversations, each tied to its lead. Everyone sees only the chats of leads they're allowed to see, with unread markers per person.
- **Chat on the lead page:** read the full history and reply with text, images, PDFs or approved templates. Free-text replies respect WhatsApp's 24-hour window. Message delivery and read status are tracked.
- **Media:** incoming photos and documents are saved immediately, because Meta's download links expire within minutes.
- **Ad sources:** a list of the Click-to-WhatsApp ads leads have come from, with how many leads each brought.
- **Debug console** for Admins:
  - connection health check
  - app subscription
  - the raw webhook log, with signature check results
  - test messages and a simulated incoming message
  - Raw webhook logs are cleaned up after 14 days (configurable).

---

## 12. Tasks and reminders

- **Personal to-dos**, optionally linked to a lead, with a type (follow-up, call, meeting, site visit…), priority and due date.
- **Assign tasks:** Managers and Admins can assign tasks to their team and see what they have handed out.
- **Reminders** before the due time (1 day and 6 hours before by default, customisable). They're checked every 5 minutes and delivered as notifications.
- Complete, edit or delete tasks. Completing a task cancels its remaining reminders.

---

## 13. Notifications and push

- **In-app notification bell** with unread count, mark-as-read and mark-all-read.
- **Phone / desktop push notifications** (Web Push): users turn them on per device and can send themselves a test. Stale alerts aren't pushed late.
- **What triggers a notification:**
  - **New lead:** the organization's Admins and the Manager of the team it went to.
  - **Lead assigned or reassigned to you.**
  - **Lead edited or deleted:** Admins, the owner and their Manager, with exactly what changed.
  - **A lead you own enquired again.**
  - **A note from your Manager** on one of your leads.
  - **Bulk uploads:** one summary per person.
  - **Task reminders and task assignments.**
  - **Account events:** verified, password reset, work handed over after a colleague's account was deleted.
- **Emails:** organization and staff invites, verification reminders, email-change confirmation and password-reset codes.

---

## 14. Security and data rules

- **Tenant isolation:** every query is limited to the caller's own organization. One wholesaler can never see another's data.
- **Role checks** on every route, plus scope checks in the services. A Caller asking for someone else's lead gets "not found".
- **Passwords** are hashed with bcrypt. Refresh tokens and verification codes are stored only as hashes.
- **Credentials** (WhatsApp tokens, Facebook page tokens) are encrypted at rest (AES-256-GCM) and never returned by the API.
- **Webhooks:**
  - Meta calls are verified with the `X-Hub-Signature-256` signature.
  - Generic webhooks use an unguessable per-integration URL.
  - Every raw request is stored before processing.
- **Nothing important is hard-deleted:** users and leads are soft-deleted, so history, reports and audit trails stay intact.
- **Audit logs** for organization and user-account actions.

---

## 15. Getting started

Requirements: Node.js 20+, PostgreSQL 14+.

```bash
npm install                            # npm 12: bcrypt/prisma install scripts are pre-approved in package.json "allowScripts"
cp .env.example .env                   # set DATABASE_URL (a dedicated Tulsi database), JWT_ACCESS_SECRET, CREDENTIALS_ENCRYPTION_KEY
npx prisma migrate dev                 # create the tables
npm run build && npx prisma db seed    # demo data (safe to run again)
npm run start:dev                      # http://localhost:3000 — Swagger at /api/docs
```

Quality checks:

```bash
npx prisma validate      # schema
npx tsc --noEmit         # types
npm run build            # production build (start with: npm run start:prod)
npm run lint             # ESLint, check only (npm run lint:fix to fix)
npm test                 # unit tests, including the lead RBAC tests
```

### Demo accounts (from the seed)

Password: `Demo@1234`, or whatever `SEED_DEFAULT_PASSWORD` is set to.

| Role | Email |
|---|---|
| Super Admin | `superadmin@tulsi-erp.local` |
| Admin — Tulsi Plywood | `admin@tulsiplywood.local` |
| Admin — Demo Wholesale | `demo.admin@tulsi-erp.local` |
| Managers | `demo.manager1@tulsi-erp.local`, `demo.manager2@tulsi-erp.local` |
| Callers | `demo.caller1@tulsi-erp.local` … `demo.caller4@tulsi-erp.local` |
| Delivery Partners | `demo.driver1@tulsi-erp.local`, `demo.driver2@tulsi-erp.local` |

The demo organization also gets:

- 12 sample leads across sources and statuses, re-created on every seed run
- two inactive integrations
- yesterday's attendance for every caller
- today's check-in for two callers

---

## 16. Configuration

All keys are listed in [`.env.example`](.env.example). The important ones:

| Key | What it's for |
|---|---|
| `DATABASE_URL` | PostgreSQL connection — a dedicated Tulsi database |
| `JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES_IN` | Signing and lifetime of access tokens |
| `CREDENTIALS_ENCRYPTION_KEY` | 64-hex key that encrypts stored WhatsApp/Facebook tokens |
| `WEBHOOK_BASE_URL` | Public HTTPS address of the backend, used to build webhook URLs |
| `META_APP_SECRET`, `META_VERIFY_TOKEN` | Verifying Meta webhooks (WhatsApp and Lead Ads) |
| `META_GRAPH_API_VERSION` | Facebook Graph API version |
| `SMTP_*` | Email delivery (invites, verification, password reset) |
| `AUTO_VERIFY_NEW_USERS` | `true` while testing without email: new users and organizations start verified |
| `VAPID_*` | Web Push keys |
| `CORS_ORIGINS` | Allowed frontend origins; the last one is used in email links |
| `SEED_DEFAULT_PASSWORD` | Password for the demo accounts |

---

## 17. Project structure

```text
src/
  common/          guards, decorators, encryption, IST date helpers, lead-visibility rules, user deletion
  prisma/          database client
  modules/
    user-integration/       auth, organizations, users, admin → managers, manager → team
    dashboard/              GET /dashboard/me
    employee-management/    attendance, employee reports, activities, leave, targets
    lead-ingestion/         lead ingestion service, webhooks, allocation, assignment, leads, follow-ups, Excel import
    lead-allocation-admin/  /settings/allocation
    platform_IntegrationModule/  lead-source integrations (Meta forms, generic webhook)
    whatsapp-integration/   WhatsApp Cloud API: connection, webhook, inbox, messaging, ad sources, debug
    tasks/  notifications/  mail/  verification/
prisma/            schema, migrations, seed
test/              unit tests (node:test)
docs/              API reference, Phase 1 database spec, RCRM reuse map
```

More documentation:

- [`docs/API.md`](docs/API.md) — every endpoint, who can call it, request and response samples
- [`docs/PHASE1_DATABASE.md`](docs/PHASE1_DATABASE.md) — database design, lead ingestion rules, seed, checklist
- [`docs/REUSE_MAP.md`](docs/REUSE_MAP.md) — what was kept, changed or removed from the RCRM codebase this started from
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — deploying to a VPS with Docker
- [`CLAUDE.md`](CLAUDE.md) — project context for AI-assisted development

---

## 18. Not in Phase 1

Inventory, products, warehouses, customers, quotations, sales orders, dispatch and delivery, billing and GST invoices are planned for **Phase 2**. The Phase 1 design leaves room for them: every record belongs to an organization, lead capture works the same for any source, and Delivery Partner and Warehouse Staff accounts already exist.
