import { Prisma } from '@prisma/client';

/** Adds a lead's city to the org's City list (the Leads filter dropdown); no-op when it's already there. */
export async function rememberCity(tx: Prisma.TransactionClient, orgId: string, city?: string | null): Promise<void> {
  const name = city?.trim();
  if (!name) return;
  await tx.city.createMany({ data: [{ orgId, name, key: name.toLowerCase() }], skipDuplicates: true });
}
