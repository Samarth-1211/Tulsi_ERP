import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { WhatsAppIntegrationService } from '../../src/modules/whatsapp-integration/services/whatsapp-integration.service';
import { makeIntegration } from './fakes';

type Row = Record<string, any>;

/** Only the Prisma calls WhatsAppIntegrationService.remove makes, in memory. */
function setup() {
  const db = {
    integrations: [makeIntegration(), makeIntegration({ id: 'int-2', orgId: 'org-2' })] as Row[],
    messages: [
      { id: 'm1', integrationId: 'int-1', mediaStorageKey: null },
      { id: 'm2', integrationId: 'int-1', mediaStorageKey: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg' },
      { id: 'm3', integrationId: 'int-2', mediaStorageKey: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg' },
    ] as Row[],
  };
  const deletedFiles: string[] = [];

  const prisma = {
    whatsAppIntegration: {
      findUnique: async ({ where }: { where: Row }) =>
        db.integrations.find((i) => i.orgId === where.orgId) ?? null,
      delete: async ({ where }: { where: Row }) => {
        db.integrations = db.integrations.filter((i) => i.id !== where.id);
      },
    },
    whatsAppMessage: {
      findMany: async ({ where }: { where: Row }) =>
        db.messages.filter((m) => m.integrationId === where.integrationId && m.mediaStorageKey !== null),
      deleteMany: async ({ where }: { where: Row }) => {
        db.messages = db.messages.filter((m) => m.integrationId !== where.integrationId);
      },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const mediaStorage = { delete: async (key: string) => void deletedFiles.push(key) };

  const service = new WhatsAppIntegrationService(
    prisma as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    mediaStorage as never,
  );
  return { db, deletedFiles, service };
}

describe('permanently removing a WhatsApp integration', () => {
  it("deletes the org's integration, its messages and their media files, leaving other orgs alone", async () => {
    const { db, deletedFiles, service } = setup();

    const result = await service.remove('org-1');

    assert.deepEqual(result, { success: true });
    assert.deepEqual(db.integrations.map((i) => i.id), ['int-2']);
    assert.deepEqual(db.messages.map((m) => m.id), ['m3']);
    assert.deepEqual(deletedFiles, ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg']);
  });

  it('answers 404 when the organization has nothing connected', async () => {
    const { db, service } = setup();

    await assert.rejects(service.remove('org-none'), NotFoundException);
    assert.equal(db.integrations.length, 2);
    assert.equal(db.messages.length, 3);
  });
});
