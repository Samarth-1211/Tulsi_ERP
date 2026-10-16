import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakePrisma, inboundTextPayload, makeIntegration, makeWebhookService, statusPayload } from './fakes';

function setup() {
  const prisma = new FakePrisma();
  const integration = makeIntegration();
  prisma.integrations.push(integration);
  return { prisma, integration, service: makeWebhookService(prisma) };
}

describe('inbound message processing', () => {
  it('creates a lead and stores the message with E.164 phone, phone_number_id and raw payload', async () => {
    const { prisma, integration, service } = setup();

    const result = await service.handleEvent(integration, inboundTextPayload({ from: '919812345678' }));

    assert.deepEqual(result.failures, []);
    assert.equal(prisma.leads.length, 1);
    assert.equal(prisma.leads[0].name, 'Asha Verma');
    assert.equal(prisma.leads[0].phone, '+919812345678');
    assert.equal(prisma.messages.length, 1);
    const message = prisma.messages[0];
    assert.equal(message.direction, 'INBOUND');
    assert.equal(message.fromPhone, '+919812345678');
    assert.equal(message.textBody, 'Is the 3BHK still available?');
    assert.equal(message.phoneNumberId, '1111111111');
    assert.equal(message.rawPayload.message.id, 'wamid.TEST1');
  });

  it('dedupes a webhook retry of the same wamid', async () => {
    const { prisma, integration, service } = setup();

    await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.DUP' }));
    const retry = await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.DUP' }));

    assert.equal(prisma.messages.length, 1);
    assert.deepEqual(retry.failures, []);
    assert.match(retry.notes.join(), /Duplicate message wamid.DUP/);
  });

  it('treats a unique-constraint race on wamid as a duplicate, not a failure', async () => {
    const { prisma, integration, service } = setup();
    prisma.failNextMessageCreateWithP2002 = true;

    const result = await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.RACE' }));

    assert.deepEqual(result.failures, []);
    assert.equal(prisma.messages.length, 0);
  });

  it('puts a second message from the same number on the same lead', async () => {
    const { prisma, integration, service } = setup();

    await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.A' }));
    await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.B', text: 'Also, what is the price?' }));

    assert.equal(prisma.leads.length, 1);
    assert.equal(prisma.messages.length, 2);
    assert.equal(prisma.messages[0].leadId, prisma.messages[1].leadId);
  });

  it('skips a change for a different business phone_number_id', async () => {
    const { prisma, integration, service } = setup();

    const result = await service.handleEvent(integration, inboundTextPayload({ phoneNumberId: '9999999999' }));

    assert.equal(prisma.messages.length, 0);
    assert.match(result.failures.join(), /phone_number_id 9999999999/);
  });

  it('ignores unknown payload shapes without throwing', async () => {
    const { integration, service } = setup();

    const result = await service.handleEvent(integration, {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'account_update', value: {} as never }] }],
    });

    assert.deepEqual(result.failures, []);
    assert.match(result.notes.join(), /account_update/);
  });
});

describe('status updates', () => {
  function withOutbound(prisma: FakePrisma, status = 'SENT') {
    prisma.messages.push({
      id: 'msg-1',
      integrationId: 'int-1',
      waMessageId: 'wamid.OUT',
      direction: 'OUTBOUND',
      status,
      errorCode: null,
      errorMessage: null,
    });
    return prisma.messages[0];
  }

  it('advances sent -> delivered -> read', async () => {
    const { prisma, integration, service } = setup();
    const message = withOutbound(prisma);

    await service.handleEvent(integration, statusPayload('wamid.OUT', 'delivered'));
    assert.equal(message.status, 'DELIVERED');
    await service.handleEvent(integration, statusPayload('wamid.OUT', 'read'));
    assert.equal(message.status, 'READ');
  });

  it('does not downgrade read when a late "delivered" arrives', async () => {
    const { prisma, integration, service } = setup();
    const message = withOutbound(prisma, 'READ');

    await service.handleEvent(integration, statusPayload('wamid.OUT', 'delivered'));

    assert.equal(message.status, 'READ');
  });

  it('stores the error code and title of a failed status', async () => {
    const { prisma, integration, service } = setup();
    const message = withOutbound(prisma);

    await service.handleEvent(
      integration,
      statusPayload('wamid.OUT', 'failed', [
        { code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed' } },
      ]),
    );

    assert.equal(message.status, 'FAILED');
    assert.equal(message.errorCode, '131047');
    assert.equal(message.errorMessage, 'Re-engagement message — More than 24 hours have passed');
  });

  it('notes, but does not fail on, a status for a message we never stored', async () => {
    const { integration, service } = setup();

    const result = await service.handleEvent(integration, statusPayload('wamid.UNKNOWN', 'delivered'));

    assert.deepEqual(result.failures, []);
    assert.match(result.notes.join(), /unknown message wamid.UNKNOWN/);
  });
});
