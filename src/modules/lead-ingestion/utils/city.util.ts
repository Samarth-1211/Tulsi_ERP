import { Prisma } from '@prisma/client';

/**
 * Adds a lead's city to the org's City list (the Leads filter dropdown and the
 * trip planner); no-op when it's already there — also as a corrected spelling
 * (an alias), whose leads CityGeocodingService renames on its next pass.
 */
export async function rememberCity(tx: Prisma.TransactionClient, orgId: string, city?: string | null): Promise<void> {
  const name = city?.trim();
  if (!name) return;
  const key = name.toLowerCase();
  const known = await tx.city.findFirst({ where: { orgId, OR: [{ key }, { aliases: { has: key } }] }, select: { id: true } });
  if (known) return;
  await tx.city.createMany({ data: [{ orgId, name, key }], skipDuplicates: true });
}
