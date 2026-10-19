import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toErrorReply } from '../../src/common/filters/http-exception.filter';
import { STRONG_PASSWORD } from '../../src/common/validators/strong-password.decorator';
import { validateEnv } from '../../src/common/config/env.validation';

describe('toErrorReply', () => {
  it('passes HttpExceptions through', () => {
    const r = toErrorReply(new BadRequestException(['name should not be empty']));
    assert.equal(r.status, 400);
    assert.deepEqual(r.message, ['name should not be empty']);
  });

  it('maps a unique-constraint violation to 409 naming the field, not the table', () => {
    const e = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: 'x', meta: { target: ['orgId', 'sku'] },
    });
    const r = toErrorReply(e);
    assert.equal(r.status, 409);
    assert.equal(r.message, 'A record with this SKU already exists.');
  });

  it('maps numeric overflow to 400', () => {
    const e = new Prisma.PrismaClientUnknownRequestError('ConnectorError … code: "22003" numeric field overflow', { clientVersion: 'x' });
    assert.equal(toErrorReply(e).status, 400);
  });

  it('keeps body-parser 4xx errors (413 too large)', () => {
    const e = Object.assign(new Error('request entity too large'), { status: 413, statusCode: 413, expose: true, name: 'PayloadTooLargeError' });
    const r = toErrorReply(e);
    assert.equal(r.status, 413);
    assert.equal(r.message, 'The request is too large.');
  });

  it('never leaks internal messages on a 500', () => {
    const r = toErrorReply(new Error('Invalid `prisma.lead.create()` invocation in D:\\app\\dist\\leads.service.js'));
    assert.equal(r.status, 500);
    assert.doesNotMatch(String(r.message), /prisma|dist|\\/i);
  });
});

describe('STRONG_PASSWORD', () => {
  for (const ok of ['Tulsi2026', 'abcdefg1', 'पासवर्ड1234a']) it(`accepts ${ok}`, () => assert.match(ok, STRONG_PASSWORD));
  for (const bad of ['12345678', 'password', 'Ab1', 'abcdefgh']) it(`rejects ${bad}`, () => assert.doesNotMatch(bad, STRONG_PASSWORD));
});

describe('validateEnv', () => {
  const base = { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'dev' };

  it('allows a short secret outside production', () => {
    assert.doesNotThrow(() => validateEnv({ ...base }));
  });

  it('requires DATABASE_URL and JWT_ACCESS_SECRET everywhere', () => {
    assert.throws(() => validateEnv({}), /DATABASE_URL[\s\S]*JWT_ACCESS_SECRET/);
  });

  it('rejects weak production settings', () => {
    assert.throws(
      () => validateEnv({ ...base, NODE_ENV: 'production' }),
      /JWT_ACCESS_SECRET must be[\s\S]*CORS_ORIGINS[\s\S]*CREDENTIALS_ENCRYPTION_KEY/,
    );
  });

  it('accepts a complete production config', () => {
    assert.doesNotThrow(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'x'.repeat(48),
        CORS_ORIGINS: 'https://app.example.com',
        CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
      }),
    );
  });
});
