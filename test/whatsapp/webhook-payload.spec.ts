import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractContent,
  inboundMessageIds,
  mapMetaStatus,
  nextMessageStatus,
  summarizeWebhookPayload,
} from '../../src/modules/whatsapp-integration/utils/whatsapp-payload.util';
import { inboundTextPayload, statusPayload } from './fakes';

describe('payload parsing', () => {
  it('parses a text message', () => {
    const content = extractContent({ id: 'wamid.1', from: '919812345678', type: 'text', text: { body: 'Hello' } });
    assert.deepEqual(content, { messageType: 'text', textBody: 'Hello' });
  });

  it('parses an image message, keeping the media id, mime type and caption', () => {
    const content = extractContent({
      id: 'wamid.2',
      from: '919812345678',
      type: 'image',
      image: { id: 'media-123', mime_type: 'image/jpeg', caption: 'Site photo' },
    });
    assert.equal(content.messageType, 'image');
    assert.equal(content.mediaId, 'media-123');
    assert.equal(content.mediaMimeType, 'image/jpeg');
    assert.equal(content.textBody, 'Site photo');
  });

  it('keeps a document file name', () => {
    const content = extractContent({
      id: 'wamid.3',
      from: '1',
      type: 'document',
      document: { id: 'media-9', mime_type: 'application/pdf', filename: 'floor-plan.pdf' },
    });
    assert.equal(content.mediaFileName, 'floor-plan.pdf');
  });

  it('gives every other type readable text, unknown types included', () => {
    assert.match(extractContent({ id: 'a', from: '1', type: 'reaction', reaction: { emoji: '👍' } }).textBody!, /Reacted 👍/);
    assert.match(
      extractContent({ id: 'b', from: '1', type: 'location', location: { latitude: 19.07, longitude: 72.87 } }).textBody!,
      /19.07, 72.87/,
    );
    assert.equal(
      extractContent({ id: 'c', from: '1', type: 'interactive', interactive: { button_reply: { title: 'Book visit' } } }).textBody,
      'Book visit',
    );
    assert.match(
      extractContent({ id: 'd', from: '1', type: 'contacts', contacts: [{ name: { formatted_name: 'Ravi' }, phones: [{ phone: '+91 98' }] }] })
        .textBody!,
      /Ravi/,
    );
    assert.match(extractContent({ id: 'e', from: '1', type: 'order' }).textBody!, /unsupported message type: order/);
  });

  it('summarises a message payload and lists its wamids', () => {
    const payload = inboundTextPayload({ wamid: 'wamid.XYZ' });
    assert.deepEqual(summarizeWebhookPayload(payload), {
      object: 'whatsapp_business_account',
      phoneNumberId: '1111111111',
      eventType: 'messages',
      entryCount: 1,
    });
    assert.deepEqual(inboundMessageIds(payload), ['wamid.XYZ']);
  });

  it('summarises a status payload, and tolerates garbage', () => {
    assert.equal(summarizeWebhookPayload(statusPayload('wamid.1', 'read')).eventType, 'statuses');
    assert.equal(summarizeWebhookPayload({} as never).eventType, 'other');
    assert.equal(summarizeWebhookPayload(null as never).entryCount, 0);
  });
});

describe('status mapping', () => {
  it('maps Meta statuses', () => {
    assert.equal(mapMetaStatus('sent'), 'SENT');
    assert.equal(mapMetaStatus('delivered'), 'DELIVERED');
    assert.equal(mapMetaStatus('read'), 'READ');
    assert.equal(mapMetaStatus('failed'), 'FAILED');
  });

  it('never moves a status backwards, and FAILED always wins', () => {
    assert.equal(nextMessageStatus('SENT', 'DELIVERED'), 'DELIVERED');
    assert.equal(nextMessageStatus('READ', 'DELIVERED'), 'READ');
    assert.equal(nextMessageStatus('DELIVERED', 'SENT'), 'DELIVERED');
    assert.equal(nextMessageStatus('READ', 'FAILED'), 'FAILED');
  });
});
