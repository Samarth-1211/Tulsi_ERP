# RCRM → Tulsi reuse map

Base: RCRM `main` @ b270923. Target schema: `docs/PHASE1_DATABASE.md` §4.1.
Models for kept RCRM-only features (tasks, leave, targets, activities, Excel import, verification, push) are added back to the Phase 1 schema.

| Path | Verdict | What changes |
|---|---|---|
| `src/main.ts` | KEEP+MODIFY | Swagger title "Real Estate CRM API" → Tulsi ERP |
| `src/common/crypto` | KEEP | — |
| `src/common/decorators`, `guards`, `filters` | KEEP | role lists only (via `Role` enum) |
| `src/common/utils/business-date.util.ts` | KEEP | org-local day for attendance |
| `src/common/utils/lead-scope.util.ts` | KEEP+MODIFY | ADMIN / MANAGER(team) / CALLER(self) scoping |
| `src/common/utils/upload.util.ts` | KEEP | used by WhatsApp media |
| `src/common/services/user-deletion.*` | KEEP+MODIFY | drop project/task/call refs; soft delete per new User |
| `src/prisma` | KEEP | — |
| `src/modules/mail` | KEEP | only used by verification/password reset |
| `src/modules/verification` | KEEP | re-add VerificationToken / PasswordResetOtp |
| `user-integration/SuperAdmin` (auth, JWT, refresh, users, organizations) | KEEP+MODIFY | auth unchanged; roles → SUPER_ADMIN/ADMIN/MANAGER/CALLER/DELIVERY_PARTNER/WAREHOUSE_STAFF; org audit → `AuditLog` |
| `user-integration/Manager` | KEEP+MODIFY | team = CALLER/DELIVERY_PARTNER; drop `assign-to-project` |
| `user-integration/org_specific_admin` managers.* | KEEP+MODIFY | ADMIN creates MANAGER/CALLER/DELIVERY/WAREHOUSE |
| `user-integration/org_specific_admin` projects.*, public-brochures.*, brochure-storage.* | REMOVE | real-estate projects + brochures |
| `lead-ingestion` leads.controller/service | KEEP+MODIFY | new Lead fields, statuses, RBAC, follow-ups, activities |
| `lead-ingestion` leads-webhook.* (`POST /webhooks/leads/:token`) | KEEP+MODIFY | generic/relay payload → `LeadIngestionService.ingest()` + WebhookEvent |
| `lead-ingestion` lead-allocation.service | KEEP+MODIFY | round robin on `lastLeadAssignedAt` + FOR UPDATE; target role from OrgSettings |
| `lead-ingestion` lead-dedup.service | KEEP+MODIFY | duplicate phone → re-enquiry |
| `lead-ingestion` lead-notifications.service | KEEP | — |
| `lead-ingestion` lead-project-matcher.service | REMOVE | project routing |
| `lead-ingestion` portal-ingest.dto + 99acres/Housing/NoBroker branches | REMOVE | property portals (no credential-login module exists; portals came in via webhook) |
| `lead-ingestion` lead-import.* (Excel bulk upload) | KEEP+MODIFY | re-add LeadImportBatch/Collaborator; rows go through `ingest()` (source CSV) |
| `platform_IntegrationModule` | KEEP+MODIFY | PlatformIntegration → `Integration` (META_LEAD_FORM / GENERIC_WEBHOOK); URL + sample payload; duplicate leads.service merged |
| `lead-allocation-admin` | KEEP+MODIFY | → `GET/PATCH /settings/allocation` on OrgSettings |
| `employee-management` employees.*, attendance.* | KEEP+MODIFY | reports + check-in/out per Phase D |
| `employee-management` leave.*, targets.*, activities.* | KEEP+MODIFY | re-add LeaveRequest / Target / EmployeeActivity; role lists only |
| `whatsapp-integration` | KEEP | only new-lead creation → `ingest()`; link lead + assignee |
| `whatsapp-integration` ad-source.* (ad → project routing) | KEEP+MODIFY | drop projectId routing; keep referral capture |
| `notifications` (+ push.service / web-push) | KEEP | re-add PushSubscription |
| `src/modules/dashboard` | NEW | `GET /dashboard/me` role-specific stats |
| `tasks` | KEEP+MODIFY | re-add Task/TaskReminder; drop project refs |
| `call-tracking` | REMOVE | per decision |
| Real-time gateway (sockets) | n/a | **does not exist in RCRM** (no websockets dependency) |
| Audit logs module | n/a | no module; inline UserAuditLog/OrganizationAuditLog writes → `AuditLog` |
| `prisma/schema.prisma` | REPLACE | §4.1 + RCRM WhatsApp models (§4.2) |
| `prisma/migrations` (32) | REMOVE | fresh `phase1_init` in Phase H |
| `prisma/seed.ts` | REPLACE | §6.2, RCRM bcrypt helper |
| `test/whatsapp` | KEEP | — |
| `test/lead-ingestion` | KEEP+MODIFY | project routing → role-based allocation |
| `test/call-tracking` | REMOVE | per decision |
| `docs/user-integration.md`, `employee-management.md` | REMOVE | format reused for `docs/API.md`, which replaces them |
| `trace.txt`, `check-tokens.tmp.js` | REMOVE | debug leftovers |
| `Dockerfile`, `.github`, `DEPLOYMENT.md`, `README.md` | KEEP+MODIFY | rebrand |
