import 'reflect-metadata';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'crypto';
import { GoogleSheetsApiService, SheetAccessDeniedError } from '../../src/modules/lead-ingestion/services/google-sheets-api.service';
import { googleServiceAccount, valuesToCsv } from '../../src/modules/lead-ingestion/utils/google-sheet.util';
import { validateEnv } from '../../src/common/config/env.validation';
import { stripMoneyFields } from '../../src/common/interceptors/money-fields.interceptor';

const BOT = 'tulsi-crm@project.iam.gserviceaccount.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
// As it sits in .env: the JSON key file's private_key, newlines written as \n.
const ENV_KEY = privateKey.replace(/\n/g, '\\n');

function service(env: Record<string, string> = { GOOGLE_SERVICE_ACCOUNT_EMAIL: BOT, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: ENV_KEY }) {
  return new GoogleSheetsApiService({ get: (key: string) => env[key] } as never);
}

type Route = (url: string, init?: RequestInit) => Response | undefined;
const calls: { url: string; init?: RequestInit }[] = [];
let routes: Route[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  for (const route of routes) {
    const res = route(url, init);
    if (res) return res;
  }
  throw new Error(`Unexpected fetch ${url}`);
}) as typeof fetch;
process.on('exit', () => (globalThis.fetch = realFetch));
afterEach(() => {
  calls.length = 0;
  routes = [];
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokenRoute: Route = (url) => (url === 'https://oauth2.googleapis.com/token' ? json({ access_token: 'tok-1', expires_in: 3600 }) : undefined);
const metaRoute: Route = (url) =>
  url.includes('?fields=sheets.properties') ? json({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }, { properties: { sheetId: 77, title: "Form's leads" } }] }) : undefined;
const valuesRoute: Route = (url) =>
  url.includes('/values/') ? json({ values: [['Name', 'Phone', 'Requirement'], ['Sharma, Indore', '9812345678', '18mm "BWP"']] }) : undefined;

describe('GoogleSheetsApiService', () => {
  it('is off without a service account', () => {
    assert.equal(service({}).serviceAccountEmail, null);
    assert.equal(service().serviceAccountEmail, BOT);
  });

  it('signs in with a JWT Google can verify and reads the tab as CSV', async () => {
    routes = [tokenRoute, metaRoute, valuesRoute];
    const csv = await service().fetchCsv('SHEET', '77', 5000);
    assert.equal(csv.toString('utf8'), 'Name,Phone,Requirement\r\n"Sharma, Indore",9812345678,"18mm ""BWP"""\r\n');

    const tokenCall = calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'))!;
    const form = new URLSearchParams(String(tokenCall.init?.body));
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.');
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url'));
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(payload.iss, BOT);
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
    assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');

    // The tab is picked by gid and its name quoted for A1 notation.
    const valuesCall = calls.find((c) => c.url.includes('/values/'))!;
    assert.ok(valuesCall.url.includes(encodeURIComponent("'Form''s leads'")));
    assert.equal((valuesCall.init?.headers as Record<string, string>).Authorization, 'Bearer tok-1');
  });

  it('reuses the access token until it is about to expire', async () => {
    routes = [tokenRoute, metaRoute, valuesRoute];
    const api = service();
    await api.fetchCsv('SHEET', '0', 5000);
    await api.fetchCsv('SHEET', '0', 5000);
    assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1);
  });

  it('flags a sheet the service account may not open, so the public link can be tried', async () => {
    routes = [tokenRoute, (url) => (url.includes('sheets.googleapis.com') ? json({ error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }, 403) : undefined)];
    await assert.rejects(service().fetchCsv('SHEET', '0', 5000), SheetAccessDeniedError);
  });

  it('explains a disabled Sheets API instead of treating it as "not shared"', async () => {
    routes = [
      tokenRoute,
      (url) =>
        url.includes('sheets.googleapis.com')
          ? json({ error: { message: 'Google Sheets API has not been used in project 123 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }, 403)
          : undefined,
    ];
    await assert.rejects(service().fetchCsv('SHEET', '0', 5000), (e: Error) => !(e instanceof SheetAccessDeniedError) && /not enabled/.test(e.message));
  });

  it('explains a rejected sign-in', async () => {
    routes = [(url) => (url.includes('oauth2') ? json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400) : undefined)];
    await assert.rejects(service().fetchCsv('SHEET', '0', 5000), /couldn’t sign in \(Invalid JWT Signature\.\)/);
  });

  it('reports a tab that no longer exists', async () => {
    routes = [tokenRoute, metaRoute];
    await assert.rejects(service().fetchCsv('SHEET', '999', 5000), /tab in the link no longer exists/);
  });
});

describe('google sheet utils', () => {
  it('turns pasted \\n back into newlines and strips surrounding quotes', () => {
    assert.equal(googleServiceAccount((k) => ({ GOOGLE_SERVICE_ACCOUNT_EMAIL: BOT, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: `"${ENV_KEY}"` })[k])?.privateKey, privateKey);
    assert.equal(googleServiceAccount(() => undefined), null);
  });

  it('writes CSV that survives commas, quotes, newlines and blanks', () => {
    assert.equal(valuesToCsv([['a', 'b,c'], ['line\nbreak', null, 'say "hi"']]), 'a,"b,c"\r\n"line\nbreak",,"say ""hi"""\r\n');
  });
});

describe('env validation — Google service account', () => {
  const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'secret' };

  it('accepts neither or both', () => {
    assert.doesNotThrow(() => validateEnv(base));
    assert.doesNotThrow(() => validateEnv({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: BOT, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: ENV_KEY }));
  });

  it('rejects only one of the two', () => {
    assert.throws(() => validateEnv({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: BOT }), /Set both GOOGLE_SERVICE_ACCOUNT_EMAIL/);
  });

  it('rejects a key that is not a private key', () => {
    assert.throws(
      () => validateEnv({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: BOT, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'not-a-key' }),
      /not a valid private key/,
    );
  });
});

describe('money fields never leave the API', () => {
  it('strips lead value, product prices and the minimum-value setting at any depth', () => {
    const when = new Date('2026-10-01T00:00:00Z');
    const body = {
      items: [{ id: 'l1', name: 'Sharma', estimatedValue: 85000, attribution: { adId: '1' }, createdAt: when }],
      product: { name: 'BWP 18mm', price: 3650, costPrice: 3100, stock: 4 },
      settings: { autoAllotMinValue: 500, autoAllotBatchSize: 15 },
      total: 1,
    };
    assert.deepEqual(stripMoneyFields(body), {
      items: [{ id: 'l1', name: 'Sharma', attribution: { adId: '1' }, createdAt: when }],
      product: { name: 'BWP 18mm', stock: 4 },
      settings: { autoAllotBatchSize: 15 },
      total: 1,
    });
    assert.equal(stripMoneyFields(body).items[0].createdAt, when); // dates pass through untouched
  });
});
