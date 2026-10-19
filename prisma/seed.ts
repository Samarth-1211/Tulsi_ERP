/**
 * Seed — creates (or updates) ONLY the Super Admin. Every organization, admin,
 * manager and team member is created by the Super Admin from the portal.
 *
 *   npm run prisma:seed        (builds, then runs dist/prisma/seed.js)
 *   npx prisma db seed         (runs dist/prisma/seed.js — build first)
 *
 * The password must come from SUPERADMIN_PASSWORD (there is no default).
 * Re-running the seed resets it to that value, which doubles as recovery.
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt'; // same helper and cost as RCRM's services

const prisma = new PrismaClient();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || 'superadmin@tulsi-erp.local').trim().toLowerCase();
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD?.trim() ?? '';
const MIN_PASSWORD_LENGTH = IS_PRODUCTION ? 12 : 8;
const SALT_ROUNDS = 12;

async function main() {
  if (SUPERADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`SUPERADMIN_PASSWORD must be set to a strong password (${MIN_PASSWORD_LENGTH}+ characters).`);
  }

  const passwordHash = await bcrypt.hash(SUPERADMIN_PASSWORD, SALT_ROUNDS);
  await prisma.user.upsert({
    where: { email: SUPERADMIN_EMAIL },
    update: { name: 'Super Admin', role: Role.SUPER_ADMIN, orgId: null, managerId: null, passwordHash },
    create: { email: SUPERADMIN_EMAIL, name: 'Super Admin', role: Role.SUPER_ADMIN, passwordHash },
  });

  console.log(`Seed complete: Super Admin ${SUPERADMIN_EMAIL} (password from SUPERADMIN_PASSWORD).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
