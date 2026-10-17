/**
 * Phase 1 seed — docs/PHASE1_DATABASE.md §6. Idempotent (upserts); demo
 * leads are wiped and re-created on every run.
 *
 *   npm run prisma:seed        (builds, then runs dist/prisma/seed.js)
 *   npx prisma db seed         (runs dist/prisma/seed.js — build first)
 */
import {
  PrismaClient, Role, LeadSource, LeadStatus, CustomerType,
  IntegrationType, IntegrationStatus, AllocationMode, AssignmentMethod,
  ActivityType, AttendanceStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt'; // same helper and cost as RCRM's services
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();
const PASSWORD = process.env.SEED_DEFAULT_PASSWORD || 'Demo@1234';
const SALT_ROUNDS = 12;
const token = () => randomBytes(24).toString('hex');
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** UTC midnight of the India (IST) calendar day `d` falls on — how @db.Date attendance days are stored. */
const istDay = (d: Date) => {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
};

async function upsertOrg(slug: string, name: string, isDemo = false) {
  const org = await prisma.organization.upsert({
    where: { slug },
    update: { name, isDemo },
    // Seeded orgs are verified (there is no admin email flow for them).
    create: { slug, name, isDemo, city: 'Indore', state: 'Madhya Pradesh', isVerified: true, verifiedAt: new Date() },
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
  const passwordHash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);

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
    await prisma.whatsAppMessage.deleteMany({ where: { leadId: { in: demoLeadIds } } });
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
    await prisma.city.createMany({ data: [{ orgId: demo.id, name: s.city, key: s.city.toLowerCase() }], skipDuplicates: true });
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
        lastActivityAt: created,
        createdAt: created,
        attribution: s.ad ? {
          create: s.src === LeadSource.WHATSAPP_CTWA
            ? { adId: `12020000000000${i}`, sourceType: 'ad', ctwaClid: `seed_ctwa_${i}`, headline: 'Best plywood rates in Indore', mediaType: 'image' }
            : { campaignId: 'cmp_seed_1', campaignName: 'Plywood Leads Oct', adsetId: 'as_seed_1', adId: `ad_seed_${i}`, formId: 'form_seed_1', formName: 'Bulk Enquiry Form' },
        } : undefined,
        activities: {
          create: [
            { orgId: demo.id, type: ActivityType.CREATED, message: 'Lead created (seed)', createdAt: created },
            ...(assignee
              ? [{ orgId: demo.id, type: ActivityType.ASSIGNED, message: 'Auto-assigned (round robin, seed)', meta: { method: AssignmentMethod.AUTO_ROUND_ROBIN, toUserId: assignee.id }, createdAt: created }]
              : []),
          ],
        },
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
  const yesterday = istDay(daysAgo(1));
  const today = istDay(new Date());
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
