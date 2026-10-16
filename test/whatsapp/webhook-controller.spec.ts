import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppWebhookController } from '../../src/modules/whatsapp-integration/controllers/whatsapp-webhook.controller';
import { signWebhookBody } from '../../src/modules/whatsapp-integration/utils/whatsapp-signature.util';
import { APP_SECRET, FakePrisma, inboundTextPayload, makeIntegration, makeWebhookService } from './fakes';

/** Minimal Express Response double that records what the handler sent. */
function mockResponse() {
  const res = {
    statusCode: 0,
    contentType: '',
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(type: string) {
      res.contentType = type;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
    json(body: unknown) {
      res.contentType = 'application/json';
      res.body = body;
      return res;
    },
  };
  return res;
}

function setup() {
  const prisma = new FakePrisma();
  const integration = makeIntegration({ status: 'PENDING', verifiedAt: null });
  prisma.integrations.push(integration);
  const service = makeWebhookService(prisma);
  const controller = new WhatsAppWebhookController(service);
  return { prisma, integration, service, controller };
}

describe('GET /webhooks/whatsapp/:slug (verification handshake)', () => {
  it('echoes hub.challenge as plain text and marks the integration CONNECTED', async () => {
    const { prisma, controller } = setup();
    const res = mockResponse();

    await controller.verify('slug-abcdef', 'subscribe', 'verify-token-123', '1158201444', res as never);

    assert.equal(res.statusCode, 200);
    assert.equal(res.contentType, 'text/plain');
    assert.equal(res.body, '1158201444');
    assert.equal(prisma.integrations[0].status, 'CONNECTED');
  });

  it('answers 403 for a wrong verify token', async () => {
    const { prisma, controller } = setup();
    const res = mockResponse();

    await controller.verify('slug-abcdef', 'subscribe', 'wrong-token', '42', res as never);

    assert.equal(res.statusCode, 403);
    assert.notEqual(res.body, '42');
    assert.equal(prisma.integrations[0].status, 'PENDING');
  });

  it('answers 403 when hub.mode is not "subscribe" or the slug is unknown', async () => {
    const { controller } = setup();
    const wrongMode = mockResponse();
    const unknownSlug = mockResponse();

    await controller.verify('slug-abcdef', 'unsubscribe', 'verify-token-123', '42', wrongMode as never);
    await controller.verify('nope', 'subscribe', 'verify-token-123', '42', unknownSlug as never);

    assert.equal(wrongMode.statusCode, 403);
    assert.equal(unknownSlug.statusCode, 403);
  });
});

describe('POST /webhooks/whatsapp/:slug (signature check)', () => {
  it('accepts a correctly signed body with 200 and stores the raw event', async () => {
    const { prisma, service, controller } = setup();
    const payload = inboundTextPayload();
    const raw = Buffer.from(JSON.stringify(payload));
    const res = mockResponse();

    await controller.receive('slug-abcdef', payload, signWebhookBody(raw, APP_SECRET), { rawBody: raw } as never, res as never);
    await service.drain();

    assert.equal(res.statusCode, 200);
    assert.equal(prisma.events.length, 1);
    assert.equal(prisma.events[0].signatureValid, true);
    assert.equal(prisma.events[0].eventType, 'messages');
    assert.equal(prisma.events[0].processingStatus, 'PROCESSED');
    assert.equal(prisma.messages.length, 1);
  });

  it('rejects a bad signature with 401 and processes nothing', async () => {
    const { prisma, service, controller } = setup();
    const payload = inboundTextPayload();
    const raw = Buffer.from(JSON.stringify(payload));
    const res = mockResponse();

    await controller.receive('slug-abcdef', payload, signWebhookBody(raw, 'not-the-app-secret'), { rawBody: raw } as never, res as never);
    await service.drain();

    assert.equal(res.statusCode, 401);
    assert.equal(prisma.events[0].signatureValid, false);
    assert.equal(prisma.events[0].processingStatus, 'IGNORED');
    assert.equal(prisma.messages.length, 0);
  });

  it('rejects a missing signature header with 401', async () => {
    const { controller } = setup();
    const payload = inboundTextPayload();
    const res = mockResponse();

    await controller.receive('slug-abcdef', payload, undefined, { rawBody: Buffer.from(JSON.stringify(payload)) } as never, res as never);

    assert.equal(res.statusCode, 401);
  });

  it('answers 200 for an unknown slug without storing anything', async () => {
    const { prisma, controller } = setup();
    const res = mockResponse();

    await controller.receive('unknown', inboundTextPayload(), undefined, { rawBody: Buffer.from('{}') } as never, res as never);

    assert.equal(res.statusCode, 200);
    assert.equal(prisma.events.length, 0);
  });
});
