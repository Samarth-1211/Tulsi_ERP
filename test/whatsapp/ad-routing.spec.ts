import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAdReferral, referralAttribution } from '../../src/modules/whatsapp-integration/utils/whatsapp-payload.util';
import { FakePrisma, inboundTextPayload, makeIntegration, makeWebhookService, RoutingStubs } from './fakes';

const AD = {
  source_type: 'ad',
  source_id: '120210987654321',
  source_url: 'https://fb.me/abc',
  headline: 'Best plywood rates in Indore',
  body: 'BWP 18mm at dealer price',
  ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ',
  media_type: 'image',
  image_url: 'https://scontent.example/ad.jpg',
};

function setup(configure: (routing: RoutingStubs) => void = () => undefined) {
  const prisma = new FakePrisma();
  const integration = makeIntegration();
  prisma.integrations.push(integration);
  const routing = new RoutingStubs();
  configure(routing);
  return { prisma, integration, routing, service: makeWebhookService(prisma, {}, routing) };
}

describe('ad referral parsing', () => {
  it('reads the ad id and copy from a Click-to-WhatsApp referral', () => {
    const referral = extractAdReferral({ id: 'wamid.1', from: '1', type: 'text', referral: AD });
    assert.deepEqual(referral, {
      adId: '120210987654321',
      sourceType: 'ad',
      headline: 'Best plywood rates in Indore',
      body: 'BWP 18mm at dealer price',
      sourceUrl: 'https://fb.me/abc',
    });
  });

  it('is null for an ordinary message, and for a referral with no ad id', () => {
    assert.equal(extractAdReferral({ id: 'wamid.1', from: '1', type: 'text' }), null);
    assert.equal(extractAdReferral({ id: 'wamid.1', from: '1', type: 'text', referral: { headline: 'Hi' } }), null);
  });

  it('maps the referral to LeadAdAttribution fields, keeping ctwa_clid, media and the raw object', () => {
    const attribution = referralAttribution({ id: 'wamid.1', from: '1', type: 'text', referral: AD });
    assert.equal(attribution?.adId, AD.source_id);
    assert.equal(attribution?.ctwaClid, AD.ctwa_clid);
    assert.equal(attribution?.mediaType, 'image');
    assert.equal(attribution?.imageUrl, AD.image_url);
    assert.deepEqual(attribution?.raw, AD);
    assert.equal(referralAttribution({ id: 'wamid.1', from: '1', type: 'text' }), null);
  });
});

describe('a new WhatsApp contact goes through LeadIngestionService.ingest()', () => {
  it('sends an ordinary message as WHATSAPP_ORGANIC, keyed on its wamid', async () => {
    const { prisma, integration, routing, service } = setup();

    await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.A' }));

    assert.equal(routing.ingested.length, 1);
    const input = routing.ingested[0];
    assert.equal(input.source, 'WHATSAPP_ORGANIC');
    assert.equal(input.sourceLeadId, 'wamid.A');
    assert.equal(input.phone, '+919812345678');
    assert.equal(input.attribution, undefined);
    assert.equal(prisma.leads[0].assignedToId, 'user-1');
    assert.equal(prisma.messages[0].leadId, prisma.leads[0].id);
  });

  it('sends an ad click as WHATSAPP_CTWA with the ad attribution and the recorded ad source', async () => {
    const { prisma, integration, routing, service } = setup();

    await service.handleEvent(integration, inboundTextPayload({ referral: AD }));

    const input = routing.ingested[0];
    assert.equal(input.source, 'WHATSAPP_CTWA');
    assert.equal(input.attribution.adId, AD.source_id);
    assert.equal(input.attribution.ctwaClid, AD.ctwa_clid);
    assert.equal(input.adSourceId, 'ad-source-120210987654321');
    assert.equal(routing.recordedAds[0].headline, AD.headline);
    assert.equal(prisma.leads[0].adSourceId, 'ad-source-120210987654321');
  });

  it('leaves the lead unassigned when ingest finds nobody to allocate', async () => {
    const { prisma, integration, service } = setup((r) => {
      r.assigneeId = null;
    });

    await service.handleEvent(integration, inboundTextPayload());

    assert.equal(prisma.leads[0].assignedToId, null);
    assert.equal(prisma.leads[0].status, 'NEW');
  });
});

describe('a contact who messages again', () => {
  it('keeps later messages on the open lead with a thread, without calling ingest again', async () => {
    const { prisma, integration, routing, service } = setup();

    await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.A', referral: AD }));
    await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.B', text: 'What is the price?' }));

    assert.equal(prisma.leads.length, 1);
    assert.equal(routing.ingested.length, 1);
    assert.equal(prisma.messages[0].leadId, prisma.messages[1].leadId);
  });

  it('sends a fresh ad tap by someone already in the CRM to ingest, which records the re-enquiry', async () => {
    const { prisma, integration, routing, service } = setup();
    await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.A' }));

    await service.handleEvent(integration, inboundTextPayload({ wamid: 'wamid.B', referral: AD }));

    assert.equal(prisma.leads.length, 1);
    assert.equal(routing.ingested.length, 2);
    assert.equal(routing.ingested[1].source, 'WHATSAPP_CTWA');
    assert.equal(prisma.messages[1].leadId, prisma.leads[0].id);
  });
});
