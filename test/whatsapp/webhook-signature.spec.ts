import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidWebhookSignature, signWebhookBody } from '../../src/modules/whatsapp-integration/utils/whatsapp-signature.util';

const SECRET = '0123456789abcdef0123456789abcdef';
// Meta escapes non-ASCII as \uXXXX — exactly the kind of detail re-serialising would lose.
const RAW = '{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"text":"\\u0928\\u092e\\u0938\\u094d\\u0924\\u0947"}}]}]}';

describe('X-Hub-Signature-256 validation', () => {
  it('accepts the HMAC-SHA256 of the raw body', () => {
    assert.equal(isValidWebhookSignature(Buffer.from(RAW), signWebhookBody(RAW, SECRET), SECRET), true);
  });

  it('rejects a signature made with a different secret', () => {
    assert.equal(isValidWebhookSignature(Buffer.from(RAW), signWebhookBody(RAW, 'f'.repeat(32)), SECRET), false);
  });

  it('rejects a tampered body', () => {
    const signature = signWebhookBody(RAW, SECRET);
    assert.equal(isValidWebhookSignature(Buffer.from(RAW.replace('1', '2')), signature, SECRET), false);
  });

  it('rejects the signature of the re-serialised JSON when it differs from the raw bytes', () => {
    const reserialised = JSON.stringify(JSON.parse(RAW)); // \u escapes become literal characters
    assert.notEqual(reserialised, RAW);
    assert.equal(isValidWebhookSignature(Buffer.from(RAW), signWebhookBody(reserialised, SECRET), SECRET), false);
  });

  it('rejects a missing, empty or malformed header and a missing body', () => {
    const good = signWebhookBody(RAW, SECRET);
    assert.equal(isValidWebhookSignature(Buffer.from(RAW), undefined, SECRET), false);
    assert.equal(isValidWebhookSignature(Buffer.from(RAW), '', SECRET), false);
    assert.equal(isValidWebhookSignature(Buffer.from(RAW), good.replace('sha256=', 'sha1='), SECRET), false);
    assert.equal(isValidWebhookSignature(Buffer.from(RAW), good.slice(0, -2), SECRET), false);
    assert.equal(isValidWebhookSignature(undefined, good, SECRET), false);
  });
});
