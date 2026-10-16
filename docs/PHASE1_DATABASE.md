# Tulsi ERP — Phase 1 Database Specification

> **Audience:** Claude Code, building `tulsi-erp-backend` by modifying a local clone of the RCRM (real estate CRM) backend in place.
> **Place this file at:** `docs/PHASE1_DATABASE.md` in the Tulsi repo.
> **Status:** Source of truth for the Phase 1 Prisma schema and seed. If existing RCRM code disagrees with this file, adapt the code to this file, unless the note on a model says "copy from RCRM verbatim".

---

## 1. Scope of Phase 1

| Module | In Phase 1 | Notes |
|---|---|---|
| Organizations (multi-tenant) + Super Admin onboarding | Yes | Same pattern as RCRM: no public signup |
| Auth + RBAC (single `/auth/login`) | Yes | JWT + refresh tokens, same as RCRM |
| Employee management + attendance (check-in / check-out with summary) | Yes | Checkout requires a work summary |
| Lead ingestion: Click-to-WhatsApp, Meta Lead Forms, Manual | Yes | WhatsApp module copied from RCRM as-is |
| Lead allocation: round robin | Yes | Target role = MANAGER for now (configurable) |
| Lead management: CRUD, status, follow-ups, activity log | Yes | Role-scoped, same as RCRM |
| Inventory, customers, orders, dispatch, billing | **No (Phase 2)** | Do not create these tables yet |

`DELIVERY_PARTNER` and `WAREHOUSE_STAFF` exist as roles from day one so these users can be created, log in and mark attendance. Their module features arrive in Phase 2.

---

## 2. Design decisions (read before writing code)

1. **Every tenant-owned row has `orgId`.** Every query must be scoped by the caller's `orgId`. Use the same enforcement mechanism RCRM uses (guard / Prisma middleware / service base class).
2. **Roles stay an enum in Phase 1.** This lets the RCRM guards and decorators be reused unchanged. Moving roles to DB tables is a Phase 2 task.
3. **Role mapping from RCRM:**
   - `SUPER_ADMIN`, `ADMIN`, `MANAGER` → unchanged.
   - `PRESALES`, `POSTSALES`, `AGENT` → removed.
   - `CALLER`, `DELIVERY_PARTNER`, `WAREHOUSE_STAFF` → added.
4. **Lead statuses are unchanged from RCRM:** `NEW / ASSIGNED / IN_PROGRESS / CONVERTED / LOST`. The caller closes the deal and manually sets `CONVERTED`.
5. **Phone is the identity of a lead.**
   - Phone numbers are normalized to E.164 (`+91XXXXXXXXXX`) before saving.
   - If an open lead with the same `(orgId, phone)` exists (status not `CONVERTED`/`LOST`), the new enquiry is attached to it as a `RE_ENQUIRY` activity. No duplicate is created.
   - Otherwise a new lead is created, with `previousLeadId` pointing to the latest older lead for that phone (if any).
6. **Raw webhooks are stored first and processed second** (`WebhookEvent`).
   - `@@unique([source, externalId])` makes retries from Meta idempotent.
   - `externalId` is the Meta `leadgen_id` for forms, or the WhatsApp `wamid` for messages.
7. **Ad attribution lives in its own table** (`LeadAdAttribution`) for both Meta forms and Click-to-WhatsApp.
   - If RCRM already stores CTWA referral data in a different shape, keep RCRM's shape for WhatsApp and also write the normalized row here.
8. **Round robin:**
   - Pick the active user of `OrgSettings.allocationTargetRole` (default `MANAGER`) with the oldest `User.lastLeadAssignedAt` (nulls first).
   - Do this inside a transaction that locks that row, then set `lastLeadAssignedAt = now()`.
   - If RCRM already has a round-robin implementation, reuse it and only make the target role configurable.
9. **Soft delete** for `User` and `Lead` via `deletedAt`. Default queries exclude soft-deleted rows.
10. **Database:** PostgreSQL. **IDs:** `cuid()`. If RCRM uses `uuid()`, use the RCRM strategy everywhere instead.

---

## 3. Entity overview

| Model | Purpose | Key relations |
|---|---|---|
| Organization | Tenant (one wholesaler) | has Users, Leads, Integrations, Settings |
| OrgSettings | Per-org behavior (allocation, attendance rules) | 1:1 Organization |
| User | Login + employee (all roles) | belongs to Organization; self-relation `manager` ↔ `team` |
| RefreshToken | Auth sessions | belongs to User |
| Attendance | Daily check-in / check-out + summary | User × date (unique) |
| Integration | Connected lead source (WhatsApp, Meta Lead Form, generic webhook) | belongs to Organization |
| WebhookEvent | Raw inbound payload log | optional Integration, optional Lead |
| Lead | The enquiry | assignee, creator, integration, attribution |
| LeadAdAttribution | Campaign / ad set / ad / form / ctwa_clid | 1:1 Lead |
| LeadAssignment | Assignment history | Lead, from / to / by User |
| LeadActivityLog | Lead timeline | Lead, User |
| FollowUp | Caller follow-ups with next date | Lead, User |
| Notification | In-app notifications (manager → employee about a lead) | User, optional Lead |
| AuditLog | Who changed what | Organization, actor User |
| WhatsApp models | **Copy from RCRM verbatim** (see §4.2) | Organization, Lead |

---

## 4. Prisma schema

### 4.1 `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ───────────────────────── ENUMS ─────────────────────────

enum Role {
  SUPER_ADMIN
  ADMIN
  MANAGER
  CALLER
  DELIVERY_PARTNER
  WAREHOUSE_STAFF // reserved for Phase 2 features; can log in + attendance now
}

enum UserStatus {
  ACTIVE
  INACTIVE
}

enum LeadSource {
  WHATSAPP_CTWA    // first WhatsApp message carried a Meta ad referral
  WHATSAPP_ORGANIC // WhatsApp message without referral
  META_LEAD_FORM
  MANUAL
  WALK_IN
  REFERRAL
  CSV_IMPORT
  WEBSITE
  OTHER
}

enum LeadStatus {
  NEW
  ASSIGNED
  IN_PROGRESS
  CONVERTED
  LOST
}

enum CustomerType {
  DEALER
  RETAILER
  CONTRACTOR
  CARPENTER
  BUILDER
  INTERIOR_DESIGNER
  HOMEOWNER
  OTHER
}

enum IntegrationType {
  WHATSAPP
  META_LEAD_FORM
  WEBHOOK_GENERIC // common URL for n8n / Pabbly / Zapier / website forms
}

enum IntegrationStatus {
  ACTIVE
  INACTIVE
  ERROR
}

enum WebhookEventStatus {
  RECEIVED
  PROCESSED
  DUPLICATE
  FAILED
}

enum AllocationMode {
  ROUND_ROBIN
  MANUAL
}

enum AssignmentMethod {
  AUTO_ROUND_ROBIN
  MANUAL
  SELF // caller/manager created the lead for themselves
}

enum ActivityType {
  CREATED
  ASSIGNED
  REASSIGNED
  STATUS_CHANGED
  UPDATED
  NOTE
  CALL
  WHATSAPP
  FOLLOW_UP
  RE_ENQUIRY
  DELETED
}

enum FollowUpStatus {
  PENDING
  DONE
  MISSED
  CANCELLED
}

enum AttendanceStatus {
  CHECKED_IN
  CHECKED_OUT
  ABSENT
}

// ─────────────────── TENANCY & SETTINGS ───────────────────

model Organization {
  id           String   @id @default(cuid())
  name         String
  slug         String   @unique
  industryType String   @default("PLYWOOD_WHOLESALE")
  gstin        String?
  phone        String?
  email        String?
  address      String?
  city         String?
  state        String?
  isDemo       Boolean  @default(false)
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  settings      OrgSettings?
  users         User[]
  leads         Lead[]
  integrations  Integration[]
  webhookEvents WebhookEvent[]
  attendance    Attendance[]
  assignments   LeadAssignment[]
  activities    LeadActivityLog[]
  followUps     FollowUp[]
  notifications Notification[]
  auditLogs     AuditLog[]
}

model OrgSettings {
  id                       String         @id @default(cuid())
  orgId                    String         @unique
  allocationMode           AllocationMode @default(ROUND_ROBIN)
  allocationTargetRole     Role           @default(MANAGER) // switch to CALLER later
  allocateOnlyCheckedIn    Boolean        @default(false)   // only users checked in today
  checkoutSummaryMinLength Int            @default(20)
  timezone                 String         @default("Asia/Kolkata")
  createdAt                DateTime       @default(now())
  updatedAt                DateTime       @updatedAt

  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
}

// ─────────────────────── USERS & AUTH ───────────────────────

model User {
  id                 String     @id @default(cuid())
  orgId              String? // null only for SUPER_ADMIN
  name               String
  email              String     @unique
  phone              String?
  passwordHash       String
  role               Role
  status             UserStatus @default(ACTIVE)
  employeeCode       String?
  managerId          String?
  createdById        String?
  lastLeadAssignedAt DateTime? // round-robin cursor
  lastLoginAt        DateTime?
  deletedAt          DateTime?
  createdAt          DateTime   @default(now())
  updatedAt          DateTime   @updatedAt

  org          Organization? @relation(fields: [orgId], references: [id])
  manager      User?         @relation("ManagerTeam", fields: [managerId], references: [id])
  team         User[]        @relation("ManagerTeam")
  createdBy    User?         @relation("UserCreatedBy", fields: [createdById], references: [id])
  createdUsers User[]        @relation("UserCreatedBy")

  refreshTokens   RefreshToken[]
  attendance      Attendance[]
  assignedLeads   Lead[]            @relation("LeadAssignee")
  createdLeads    Lead[]            @relation("LeadCreator")
  assignmentsFrom LeadAssignment[]  @relation("AssignmentFrom")
  assignmentsTo   LeadAssignment[]  @relation("AssignmentTo")
  assignmentsBy   LeadAssignment[]  @relation("AssignmentBy")
  activities      LeadActivityLog[]
  followUps       FollowUp[]
  notifications   Notification[]    @relation("NotificationRecipient")
  sentNotifs      Notification[]    @relation("NotificationSender")
  auditLogs       AuditLog[]

  @@unique([orgId, employeeCode])
  @@index([orgId, role, status])
  @@index([managerId])
}

model RefreshToken {
  id        String    @id @default(cuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  userAgent String?
  ip        String?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

// ─────────────────────── ATTENDANCE ───────────────────────

model Attendance {
  id            String           @id @default(cuid())
  orgId         String
  userId        String
  date          DateTime         @db.Date // org-local calendar day
  checkInAt     DateTime
  checkInLat    Float?
  checkInLng    Float?
  checkOutAt    DateTime?
  checkOutLat   Float?
  checkOutLng   Float?
  summary       String? // REQUIRED by the service at checkout (min length from OrgSettings)
  workedMinutes Int?
  status        AttendanceStatus @default(CHECKED_IN)
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt

  org  Organization @relation(fields: [orgId], references: [id])
  user User         @relation(fields: [userId], references: [id])

  @@unique([userId, date])
  @@index([orgId, date])
}

// ─────────────────── INTEGRATIONS & WEBHOOKS ───────────────────

model Integration {
  id                String            @id @default(cuid())
  orgId             String
  type              IntegrationType
  name              String
  status            IntegrationStatus @default(ACTIVE)
  webhookToken      String            @unique // used in common URL: /webhooks/leads/:webhookToken
  verifyToken       String? // Meta hub.verify_token (native webhooks)
  externalAccountId String? // Meta page_id (forms) or WhatsApp phone_number_id — used to route native webhooks to an org
  config            Json? // { formIds: [], wabaId, displayPhone, fieldMapping: {...} }
  encryptedSecrets  String? // page access token / WABA token, encrypted with RCRM's crypto util
  lastEventAt       DateTime?
  createdById       String?
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  org           Organization   @relation(fields: [orgId], references: [id])
  leads         Lead[]
  webhookEvents WebhookEvent[]

  @@index([orgId, type])
  @@index([type, externalAccountId])
}

model WebhookEvent {
  id            String             @id @default(cuid())
  orgId         String?
  integrationId String?
  source        IntegrationType
  externalId    String? // leadgen_id | wamid | payload id
  payload       Json
  status        WebhookEventStatus @default(RECEIVED)
  error         String?
  leadId        String?
  receivedAt    DateTime           @default(now())
  processedAt   DateTime?

  org         Organization? @relation(fields: [orgId], references: [id])
  integration Integration?  @relation(fields: [integrationId], references: [id])
  lead        Lead?         @relation(fields: [leadId], references: [id])

  @@unique([source, externalId])
  @@index([orgId, status])
}

// ─────────────────────────── LEADS ───────────────────────────

model Lead {
  id               String        @id @default(cuid())
  orgId            String
  name             String?
  phone            String // E.164
  altPhone         String?
  email            String?
  city             String?
  pincode          String?
  address          String?
  customerType     CustomerType?
  requirementNotes String? // e.g. "18mm BWP 8x4, 40 sheets" — structured requirements come in Phase 2
  estimatedValue   Decimal?      @db.Decimal(12, 2)
  source           LeadSource
  integrationId    String?
  sourceLeadId     String? // Meta leadgen_id or first wamid
  status           LeadStatus    @default(NEW)
  assignedToId     String?
  assignedAt       DateTime?
  createdById      String?
  lostReason       String?
  convertedAt      DateTime?
  firstResponseAt  DateTime?
  lastActivityAt   DateTime?
  nextFollowUpAt   DateTime?
  customFields     Json? // extra form answers
  rawPayload       Json?
  previousLeadId   String?
  deletedAt        DateTime?
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt

  org          Organization @relation(fields: [orgId], references: [id])
  integration  Integration? @relation(fields: [integrationId], references: [id])
  assignedTo   User?        @relation("LeadAssignee", fields: [assignedToId], references: [id])
  createdBy    User?        @relation("LeadCreator", fields: [createdById], references: [id])
  previousLead Lead?        @relation("LeadHistory", fields: [previousLeadId], references: [id])
  laterLeads   Lead[]       @relation("LeadHistory")

  attribution   LeadAdAttribution?
  assignments   LeadAssignment[]
  activities    LeadActivityLog[]
  followUps     FollowUp[]
  webhookEvents WebhookEvent[]
  notifications Notification[]

  @@unique([orgId, source, sourceLeadId])
  @@index([orgId, status])
  @@index([orgId, assignedToId])
  @@index([orgId, phone])
  @@index([orgId, createdAt])
}

model LeadAdAttribution {
  id           String   @id @default(cuid())
  leadId       String   @unique
  platform     String   @default("META")
  campaignId   String?
  campaignName String?
  adsetId      String?
  adsetName    String?
  adId         String? // CTWA: referral.source_id
  adName       String?
  formId       String?
  formName     String?
  pageId       String?
  ctwaClid     String? // CTWA click id — absent for WhatsApp Status ads
  sourceType   String? // "ad" | "post"
  sourceUrl    String?
  headline     String?
  body         String?
  mediaType    String? // image | video
  imageUrl     String?
  videoUrl     String?
  thumbnailUrl String?
  raw          Json?
  createdAt    DateTime @default(now())

  lead Lead @relation(fields: [leadId], references: [id], onDelete: Cascade)

  @@index([adId])
  @@index([campaignId])
}

model LeadAssignment {
  id           String           @id @default(cuid())
  orgId        String
  leadId       String
  fromUserId   String?
  toUserId     String
  method       AssignmentMethod
  assignedById String? // null when system
  reason       String?
  createdAt    DateTime         @default(now())

  org        Organization @relation(fields: [orgId], references: [id])
  lead       Lead         @relation(fields: [leadId], references: [id], onDelete: Cascade)
  fromUser   User?        @relation("AssignmentFrom", fields: [fromUserId], references: [id])
  toUser     User         @relation("AssignmentTo", fields: [toUserId], references: [id])
  assignedBy User?        @relation("AssignmentBy", fields: [assignedById], references: [id])

  @@index([leadId])
  @@index([orgId, toUserId, createdAt])
}

model LeadActivityLog {
  id        String       @id @default(cuid())
  orgId     String
  leadId    String
  userId    String? // null = system
  type      ActivityType
  message   String?
  meta      Json? // { from: "NEW", to: "ASSIGNED" } etc.
  createdAt DateTime     @default(now())

  org  Organization @relation(fields: [orgId], references: [id])
  lead Lead         @relation(fields: [leadId], references: [id], onDelete: Cascade)
  user User?        @relation(fields: [userId], references: [id])

  @@index([leadId, createdAt])
}

model FollowUp {
  id             String         @id @default(cuid())
  orgId          String
  leadId         String
  userId         String
  note           String
  outcome        String?
  nextFollowUpAt DateTime?
  status         FollowUpStatus @default(PENDING)
  completedAt    DateTime?
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  org  Organization @relation(fields: [orgId], references: [id])
  lead Lead         @relation(fields: [leadId], references: [id], onDelete: Cascade)
  user User         @relation(fields: [userId], references: [id])

  @@index([orgId, userId, nextFollowUpAt])
  @@index([leadId])
}

// ─────────────────── NOTIFICATIONS & AUDIT ───────────────────
// If RCRM already has equivalents, keep RCRM's models and field names instead.

model Notification {
  id          String    @id @default(cuid())
  orgId       String
  recipientId String
  senderId    String?
  leadId      String?
  type        String // LEAD_ASSIGNED | LEAD_NOTE | FOLLOW_UP_DUE | SYSTEM
  title       String
  body        String?
  readAt      DateTime?
  createdAt   DateTime  @default(now())

  org       Organization @relation(fields: [orgId], references: [id])
  recipient User         @relation("NotificationRecipient", fields: [recipientId], references: [id])
  sender    User?        @relation("NotificationSender", fields: [senderId], references: [id])
  lead      Lead?        @relation(fields: [leadId], references: [id])

  @@index([recipientId, readAt])
}

model AuditLog {
  id        String   @id @default(cuid())
  orgId     String?
  actorId   String?
  action    String // CREATE | UPDATE | DELETE | LOGIN | ...
  entity    String // "Lead" | "User" | ...
  entityId  String?
  before    Json?
  after     Json?
  ip        String?
  createdAt DateTime @default(now())

  org   Organization? @relation(fields: [orgId], references: [id])
  actor User?         @relation(fields: [actorId], references: [id])

  @@index([orgId, entity, createdAt])
}

// ─────────────────── WHATSAPP (copy from RCRM) ───────────────────
// >>> Paste RCRM's WhatsApp models here VERBATIM (account / conversation / message / template, whatever RCRM has).
// >>> Then only:
//     1. ensure each has orgId + relation to Organization (add back-relations on Organization),
//     2. ensure the conversation can link to Lead (leadId) and has assignedToId -> User,
//     3. ensure the inbound message keeps the raw `referral` object (Json) for CTWA.
// >>> Minimum fields that must exist after pasting (add only what is missing):
//     Account:      orgId, wabaId, phoneNumberId (unique), displayPhone, encrypted access token
//     Conversation: orgId, waId (customer number), leadId?, assignedToId?, lastMessageAt, windowExpiresAt?
//     Message:      conversationId, wamid (unique), direction, type, body?, mediaUrl?, status, timestamp, referral Json?
```

### 4.2 WhatsApp models — rules

- Copy RCRM's WhatsApp Prisma models **unchanged**. The Tulsi WhatsApp inbox, webhook handling, CTWA referral capture (ad ID etc.) and auto-lead creation must behave exactly like RCRM.
- Allowed changes are limited to the three points in the schema comment above.
- After the first inbound message from a new `waId`, the WhatsApp service must call the shared **Lead Ingestion service** (§5). Do not create leads directly from inside the WhatsApp module.
  - Referral present → `source = WHATSAPP_CTWA`, plus a `LeadAdAttribution` row.
  - No referral → `WHATSAPP_ORGANIC`.

---

## 5. Lead ingestion contract (shared by all sources)

Implement one service, `LeadIngestionService.ingest(input)`. WhatsApp, Meta forms, generic webhook, manual entry and CSV all call it.

```ts
type IngestInput = {
  orgId: string;
  source: LeadSource;
  integrationId?: string;
  sourceLeadId?: string;   // leadgen_id / wamid
  name?: string;
  phone: string;           // any format → normalize to E.164 (default country IN)
  email?: string;
  city?: string;
  pincode?: string;
  customerType?: CustomerType;
  requirementNotes?: string;
  customFields?: Record<string, unknown>;
  attribution?: Partial<LeadAdAttribution>;
  rawPayload?: unknown;
  createdById?: string;    // manual entry
  assignToId?: string;     // manual entry with explicit assignee
};
```

Steps (single transaction):

1. Normalize the phone number. Reject the lead if it's invalid; mark the `WebhookEvent` `FAILED` with the error.
2. **Duplicate check** on `(orgId, phone)` per §2.5. If it's a duplicate, add a `RE_ENQUIRY` activity, notify the assignee, mark the webhook event `DUPLICATE`, and return the existing lead.
3. Create the `Lead`, plus the `LeadAdAttribution` if present, plus a `CREATED` activity.
4. **Allocate:**
   - `assignToId` given → `MANUAL`.
   - Creator is a CALLER or MANAGER and no assignee is given → `SELF`.
   - Else if `allocationMode = ROUND_ROBIN` → round robin per §2.8.
   - Else leave it `NEW` and unassigned.
5. On assignment: set `status = ASSIGNED` and `assignedAt`, write a `LeadAssignment` row and an `ASSIGNED` activity, and send a `Notification` to the assignee.
6. Emit the real-time event (reuse the RCRM socket/gateway): `lead.created` to the org admins and the assignee.

---

## 6. Seed specification (`prisma/seed.ts`)

**Goals:** idempotent (safe to run repeatedly), uses upserts, and creates one demo tenant with every role so the frontend can be demoed.

### 6.1 Records

| Org | Role | Name | Email | Reports to |
|---|---|---|---|---|
| — | SUPER_ADMIN | Super Admin | `superadmin@tulsi-erp.local` | — |
| Tulsi Plywood (`tulsi-plywood`) | ADMIN | Tulsi Admin | `admin@tulsiplywood.local` | — |
| Demo Wholesale (`demo-wholesale`, isDemo) | ADMIN | Demo Admin | `demo.admin@tulsi-erp.local` | — |
| Demo Wholesale | MANAGER | Rahul Manager | `demo.manager1@tulsi-erp.local` | — |
| Demo Wholesale | MANAGER | Priya Manager | `demo.manager2@tulsi-erp.local` | — |
| Demo Wholesale | CALLER | Amit Caller | `demo.caller1@tulsi-erp.local` | manager1 |
| Demo Wholesale | CALLER | Neha Caller | `demo.caller2@tulsi-erp.local` | manager1 |
| Demo Wholesale | CALLER | Vikas Caller | `demo.caller3@tulsi-erp.local` | manager2 |
| Demo Wholesale | CALLER | Sana Caller | `demo.caller4@tulsi-erp.local` | manager2 |
| Demo Wholesale | DELIVERY_PARTNER | Ramesh Driver | `demo.driver1@tulsi-erp.local` | manager1 |
| Demo Wholesale | DELIVERY_PARTNER | Suresh Driver | `demo.driver2@tulsi-erp.local` | manager2 |

- **Passwords:** all accounts use `process.env.SEED_DEFAULT_PASSWORD`, falling back to `Demo@1234`. Hash with **the same helper RCRM uses** (bcrypt/argon2); swap the import in the seed if it differs.
- **OrgSettings for both orgs:** `ROUND_ROBIN`, target role `MANAGER`.
- **Integrations (demo org):** one `WHATSAPP` integration and one `META_LEAD_FORM` integration, both `INACTIVE`, each with a random `webhookToken`.
- **Leads (demo org only; wiped and re-created on each run):** 12 leads across sources, statuses and customer types, assigned round-robin to the two managers, some with `LeadAdAttribution`.
- **Attendance (demo org):** yesterday fully checked out with a summary for every caller, and today checked in for caller1 and caller2.

### 6.2 `prisma/seed.ts`

```ts
import {
  PrismaClient, Role, LeadSource, LeadStatus, CustomerType,
  IntegrationType, IntegrationStatus, AllocationMode, AssignmentMethod,
  ActivityType, AttendanceStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt'; // replace with RCRM's hashing helper if different
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();
const PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? 'Demo@1234';
const token = () => randomBytes(24).toString('hex');
const dayOnly = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function upsertOrg(slug: string, name: string, isDemo = false) {
  const org = await prisma.organization.upsert({
    where: { slug },
    update: { name, isDemo },
    create: { slug, name, isDemo, city: 'Indore', state: 'Madhya Pradesh' },
  });
  await prisma.orgSettings.upsert({
    where: { orgId: org.id },
    update: {},
    create: { orgId: org.id, allocationMode: AllocationMode.ROUND_ROBIN, allocationTargetRole: Role.MANAGER },
  });
  return org;
}

async function upsertUser(p: {
  email: string; name: string; role: Role; orgId?: string; managerId?: string; createdById?: string; code?: string;
}, passwordHash: string) {
  return prisma.user.upsert({
    where: { email: p.email },
    update: { name: p.name, role: p.role, orgId: p.orgId ?? null, managerId: p.managerId ?? null },
    create: {
      email: p.email, name: p.name, role: p.role, orgId: p.orgId, managerId: p.managerId,
      createdById: p.createdById, employeeCode: p.code, passwordHash,
    },
  });
}

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // ── Super Admin
  const superAdmin = await upsertUser({ email: 'superadmin@tulsi-erp.local', name: 'Super Admin', role: Role.SUPER_ADMIN }, passwordHash);

  // ── Real tenant: Tulsi Plywood (admin only)
  const tulsi = await upsertOrg('tulsi-plywood', 'Tulsi Plywood');
  await upsertUser({ email: 'admin@tulsiplywood.local', name: 'Tulsi Admin', role: Role.ADMIN, orgId: tulsi.id, createdById: superAdmin.id, code: 'TP-ADM-01' }, passwordHash);

  // ── Demo tenant with every role
  const demo = await upsertOrg('demo-wholesale', 'Demo Wholesale', true);
  const admin = await upsertUser({ email: 'demo.admin@tulsi-erp.local', name: 'Demo Admin', role: Role.ADMIN, orgId: demo.id, createdById: superAdmin.id, code: 'ADM-01' }, passwordHash);
  const m1 = await upsertUser({ email: 'demo.manager1@tulsi-erp.local', name: 'Rahul Manager', role: Role.MANAGER, orgId: demo.id, createdById: admin.id, code: 'MGR-01' }, passwordHash);
  const m2 = await upsertUser({ email: 'demo.manager2@tulsi-erp.local', name: 'Priya Manager', role: Role.MANAGER, orgId: demo.id, createdById: admin.id, code: 'MGR-02' }, passwordHash);

  const callers = await Promise.all([
    upsertUser({ email: 'demo.caller1@tulsi-erp.local', name: 'Amit Caller', role: Role.CALLER, orgId: demo.id, managerId: m1.id, createdById: m1.id, code: 'CLR-01' }, passwordHash),
    upsertUser({ email: 'demo.caller2@tulsi-erp.local', name: 'Neha Caller', role: Role.CALLER, orgId: demo.id, managerId: m1.id, createdById: m1.id, code: 'CLR-02' }, passwordHash),
    upsertUser({ email: 'demo.caller3@tulsi-erp.local', name: 'Vikas Caller', role: Role.CALLER, orgId: demo.id, managerId: m2.id, createdById: m2.id, code: 'CLR-03' }, passwordHash),
    upsertUser({ email: 'demo.caller4@tulsi-erp.local', name: 'Sana Caller', role: Role.CALLER, orgId: demo.id, managerId: m2.id, createdById: m2.id, code: 'CLR-04' }, passwordHash),
  ]);
  await upsertUser({ email: 'demo.driver1@tulsi-erp.local', name: 'Ramesh Driver', role: Role.DELIVERY_PARTNER, orgId: demo.id, managerId: m1.id, createdById: admin.id, code: 'DLV-01' }, passwordHash);
  await upsertUser({ email: 'demo.driver2@tulsi-erp.local', name: 'Suresh Driver', role: Role.DELIVERY_PARTNER, orgId: demo.id, managerId: m2.id, createdById: admin.id, code: 'DLV-02' }, passwordHash);

  // ── Integrations (inactive placeholders)
  const existing = await prisma.integration.findMany({ where: { orgId: demo.id } });
  if (existing.length === 0) {
    await prisma.integration.createMany({
      data: [
        { orgId: demo.id, type: IntegrationType.WHATSAPP, name: 'WhatsApp Business', status: IntegrationStatus.INACTIVE, webhookToken: token(), createdById: admin.id },
        { orgId: demo.id, type: IntegrationType.META_LEAD_FORM, name: 'Meta Lead Forms', status: IntegrationStatus.INACTIVE, webhookToken: token(), verifyToken: token(), createdById: admin.id },
      ],
    });
  }

  // ── Reset demo leads (demo org only)
  const demoLeadIds = (await prisma.lead.findMany({ where: { orgId: demo.id }, select: { id: true } })).map(l => l.id);
  if (demoLeadIds.length) {
    await prisma.notification.deleteMany({ where: { leadId: { in: demoLeadIds } } });
    await prisma.webhookEvent.deleteMany({ where: { leadId: { in: demoLeadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: demoLeadIds } } }); // cascades attribution/assignments/activities/follow-ups
  }

  const samples: Array<{ name: string; city: string; ct: CustomerType; src: LeadSource; st: LeadStatus; req: string; ad?: boolean }> = [
    { name: 'Sharma Hardware',      city: 'Indore', ct: CustomerType.DEALER,            src: LeadSource.WHATSAPP_CTWA,    st: LeadStatus.ASSIGNED,    req: '18mm BWP 8x4, 50 sheets', ad: true },
    { name: 'Raju Carpenter',       city: 'Dewas',  ct: CustomerType.CARPENTER,         src: LeadSource.META_LEAD_FORM,   st: LeadStatus.IN_PROGRESS, req: '12mm MR + laminates', ad: true },
    { name: 'Gupta Interiors',      city: 'Indore', ct: CustomerType.INTERIOR_DESIGNER, src: LeadSource.META_LEAD_FORM,   st: LeadStatus.CONVERTED,   req: 'Marine ply 19mm, 30 sheets', ad: true },
    { name: 'Verma Builders',       city: 'Ujjain', ct: CustomerType.BUILDER,           src: LeadSource.MANUAL,           st: LeadStatus.ASSIGNED,    req: 'Shuttering ply bulk' },
    { name: 'Anil Contractor',      city: 'Indore', ct: CustomerType.CONTRACTOR,        src: LeadSource.WHATSAPP_ORGANIC, st: LeadStatus.LOST,        req: 'Blockboard 25mm' },
    { name: 'Mehta Residence',      city: 'Indore', ct: CustomerType.HOMEOWNER,         src: LeadSource.WHATSAPP_CTWA,    st: LeadStatus.IN_PROGRESS, req: 'Kitchen: BWP + 1mm laminate', ad: true },
    { name: 'Jain Ply Centre',      city: 'Mhow',   ct: CustomerType.RETAILER,          src: LeadSource.WALK_IN,          st: LeadStatus.ASSIGNED,    req: 'Mixed MR stock' },
    { name: 'Khan Furniture Works', city: 'Pithampur', ct: CustomerType.CARPENTER,      src: LeadSource.META_LEAD_FORM,   st: LeadStatus.ASSIGNED,    req: '6mm + 9mm MR', ad: true },
    { name: 'Patel Traders',        city: 'Dhar',   ct: CustomerType.DEALER,            src: LeadSource.REFERRAL,         st: LeadStatus.CONVERTED,   req: 'Monthly dealer order' },
    { name: 'Singh Modular',        city: 'Indore', ct: CustomerType.INTERIOR_DESIGNER, src: LeadSource.WHATSAPP_CTWA,    st: LeadStatus.ASSIGNED,    req: 'HDHMR + edge band', ad: true },
    { name: 'Yadav Homes',          city: 'Sanwer', ct: CustomerType.HOMEOWNER,         src: LeadSource.MANUAL,           st: LeadStatus.NEW,         req: 'Wardrobe ply' },
    { name: 'Rathore Constructions',city: 'Indore', ct: CustomerType.BUILDER,           src: LeadSource.META_LEAD_FORM,   st: LeadStatus.IN_PROGRESS, req: 'Flush doors 30 nos', ad: true },
  ];

  const managers = [m1, m2];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const assignee = s.st === LeadStatus.NEW ? null : managers[i % 2];
    const created = daysAgo(12 - i);
    const lead = await prisma.lead.create({
      data: {
        orgId: demo.id,
        name: s.name,
        phone: `+9190000000${String(i + 10).padStart(2, '0')}`,
        city: s.city,
        customerType: s.ct,
        requirementNotes: s.req,
        source: s.src,
        sourceLeadId: s.ad ? `seed-${i}` : null,
        status: s.st,
        assignedToId: assignee?.id,
        assignedAt: assignee ? created : null,
        convertedAt: s.st === LeadStatus.CONVERTED ? daysAgo(1) : null,
        lostReason: s.st === LeadStatus.LOST ? 'Price too high' : null,
        createdById: s.src === LeadSource.MANUAL ? admin.id : null,
        createdAt: created,
        attribution: s.ad ? {
          create: s.src === LeadSource.WHATSAPP_CTWA
            ? { adId: `12020000000000${i}`, sourceType: 'ad', ctwaClid: `seed_ctwa_${i}`, headline: 'Best plywood rates in Indore', mediaType: 'image' }
            : { campaignId: 'cmp_seed_1', campaignName: 'Plywood Leads Oct', adsetId: 'as_seed_1', adId: `ad_seed_${i}`, formId: 'form_seed_1', formName: 'Bulk Enquiry Form' },
        } : undefined,
        activities: { create: [{ orgId: demo.id, type: ActivityType.CREATED, message: 'Lead created (seed)' }] },
      },
    });
    if (assignee) {
      await prisma.leadAssignment.create({
        data: { orgId: demo.id, leadId: lead.id, toUserId: assignee.id, method: AssignmentMethod.AUTO_ROUND_ROBIN, createdAt: created },
      });
      await prisma.user.update({ where: { id: assignee.id }, data: { lastLeadAssignedAt: created } });
    }
  }

  // ── Attendance
  const yesterday = dayOnly(daysAgo(1));
  const today = dayOnly(new Date());
  for (const c of callers) {
    await prisma.attendance.upsert({
      where: { userId_date: { userId: c.id, date: yesterday } },
      update: {},
      create: {
        orgId: demo.id, userId: c.id, date: yesterday,
        checkInAt: new Date(yesterday.getTime() + 4.5 * 3_600_000), // ~10:00 IST
        checkOutAt: new Date(yesterday.getTime() + 13 * 3_600_000), // ~18:30 IST
        workedMinutes: 510, status: AttendanceStatus.CHECKED_OUT,
        summary: 'Called assigned leads, shared rate list on WhatsApp, 2 follow-ups scheduled.',
      },
    });
  }
  for (const c of callers.slice(0, 2)) {
    await prisma.attendance.upsert({
      where: { userId_date: { userId: c.id, date: today } },
      update: {},
      create: { orgId: demo.id, userId: c.id, date: today, checkInAt: new Date(), status: AttendanceStatus.CHECKED_IN },
    });
  }

  console.log('Seed complete. Default password:', PASSWORD === 'Demo@1234' ? 'Demo@1234' : '(from SEED_DEFAULT_PASSWORD)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

`package.json`: `"prisma": { "seed": "ts-node prisma/seed.ts" }`. Use whatever runner RCRM already uses (ts-node / tsx).

---

## 7. Verification checklist

- [ ] `npx prisma validate` passes.
- [ ] `npx prisma migrate dev --name phase1_init` runs on an empty DB.
- [ ] `npx prisma db seed` runs twice in a row without errors.
- [ ] Logging in as every seeded role works.
- [ ] Posting the same Meta `leadgen_id` twice creates one lead and one `DUPLICATE` webhook event.
- [ ] A new WhatsApp number with a referral creates a `WHATSAPP_CTWA` lead with `LeadAdAttribution.adId` set.
- [ ] Checkout without a summary (or one shorter than the minimum length) is rejected with 400.