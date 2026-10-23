import 'reflect-metadata';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationStatus, IntegrationType, WebhookEventStatus } from '@prisma/client';
import { GoogleSheetSyncService } from '../../src/modules/lead-ingestion/services/google-sheet-sync.service';
import { LeadImportService } from '../../src/modules/lead-ingestion/services/lead-import.service';
import { SheetAccessDeniedError } from '../../src/modules/lead-ingestion/services/google-sheets-api.service';
import { IngestInput } from '../../src/modules/lead-ingestion/services/lead-ingestion.service';
import { googleSheetCsvUrl, parseGoogleSheetUrl } from '../../src/modules/lead-ingestion/utils/google-sheet.util';

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('parseGoogleSheetUrl', () => {
  it('reads the spreadsheet id and the tab from #gid', () => {
    assert.deepEqual(parseGoogleSheetUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=123456`), {
      spreadsheetId: SHEET_ID,
      gid: '123456',
    });
    assert.deepEqual(parseGoogleSheetUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=42#gid=42`)?.gid, '42');
  });

  it('defaults to the first tab', () => {
    assert.equal(parseGoogleSheetUrl(`  https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing `)?.gid, '0');
  });

  it('rejects anything that is not a Google Sheets link', () => {
    assert.equal(parseGoogleSheetUrl('not a url'), null);
    assert.equal(parseGoogleSheetUrl(`https://evil.example.com/spreadsheets/d/${SHEET_ID}/edit`), null);
    assert.equal(parseGoogleSheetUrl('https://docs.google.com/document/d/abc/edit'), null);
  });

  it('builds the CSV export URL', () => {
    assert.equal(
      googleSheetCsvUrl({ spreadsheetId: SHEET_ID, gid: '7' }),
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=7`,
    );
  });
});

// --- GoogleSheetSyncService against an in-memory Prisma and a stubbed fetch ---

interface FakeEvent {
  id: string;
  externalId: string | null;
  status: WebhookEventStatus;
  error?: string | null;
}

/** The CRM's service account: absent by default, or answering fetchCsv like the Sheets API would. */
interface FakeSheetsApi {
  serviceAccountEmail: string | null;
  fetchCsv?: () => Promise<Buffer>;
}

function setup(initialStatus: IntegrationStatus = IntegrationStatus.ACTIVE, sheetsApi: FakeSheetsApi = { serviceAccountEmail: null }) {
  const integration = {
    id: 'int-1',
    orgId: 'org-1',
    type: IntegrationType.GOOGLE_SHEET,
    name: 'Leads sheet',
    status: initialStatus as IntegrationStatus,
    config: { sheetUrl: 'x', spreadsheetId: SHEET_ID, gid: '0' } as Record<string, unknown>,
    lastEventAt: null as Date | null,
  };
  const events: FakeEvent[] = [];
  const ingested: { input: IngestInput; silent?: boolean }[] = [];
  const openPhones = new Set<string>();

  const prisma = {
    integration: {
      findFirst: async () => integration,
      findUnique: async () => integration,
      findMany: async () => [integration],
      update: async ({ data }: { data: Partial<typeof integration> }) => Object.assign(integration, data),
    },
    webhookEvent: {
      findMany: async ({ where }: { where: { externalId: { in: string[] } } }) =>
        events.filter((e) => e.externalId && where.externalId.in.includes(e.externalId)),
      findUnique: async ({ where }: { where: { id: string } }) => events.find((e) => e.id === where.id) ?? null,
      create: async ({ data }: { data: { externalId: string } }) => {
        const event = { id: `ev-${events.length + 1}`, externalId: data.externalId, status: WebhookEventStatus.RECEIVED };
        events.push(event);
        return event;
      },
    },
  };

  const markEvent = async (id: string, status: WebhookEventStatus, _leadId: string | null, error?: string) => {
    Object.assign(events.find((e) => e.id === id)!, { status, error });
  };
  const ingestion = {
    markEvent,
    ingest: async (input: IngestInput, options: { webhookEventId: string; silent?: boolean }) => {
      ingested.push({ input, silent: options.silent });
      const outcome = openPhones.has(input.phone) ? 'RE_ENQUIRY' : 'CREATED';
      openPhones.add(input.phone);
      await markEvent(options.webhookEventId, outcome === 'CREATED' ? WebhookEventStatus.PROCESSED : WebhookEventStatus.DUPLICATE, 'lead');
      // Round robin between two people, by order of arrival.
      return { outcome, lead: { assignedToId: ingested.length % 2 ? 'rahul' : 'priya' } };
    },
  };
  const summaries: { created: (string | null)[]; reEnquired: (string | null)[]; sheetName: string }[] = [];
  const leadNotifications = { notifyBulkSheetSync: async (s: (typeof summaries)[0]) => void summaries.push(s) };

  // parseFile / toLeadFields use none of the injected services.
  const importService = new LeadImportService(...(Array(6).fill(null) as ConstructorParameters<typeof LeadImportService>));
  const service = new GoogleSheetSyncService(prisma as never, importService, ingestion as never, sheetsApi as never, leadNotifications as never);
  return { service, integration, events, ingested, summaries };
}

let sheet = '';
let response: () => Response = () => new Response(sheet, { headers: { 'content-type': 'text/csv' } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => response()) as typeof fetch;
afterEach(() => {
  response = () => new Response(sheet, { headers: { 'content-type': 'text/csv' } });
});
process.on('exit', () => (globalThis.fetch = realFetch));

describe('GoogleSheetSyncService', () => {
  it('imports every existing row on the first sync, then only new rows', async () => {
    const { service, ingested, integration } = setup();
    sheet = 'Timestamp,Name,Phone Number,City\n2026-10-01 10:00,Sharma Hardware,9812345678,Indore\n2026-10-01 11:00,Gupta Ply,+91 91234 56789,Bhopal\n';

    const first = await service.syncNow('int-1', 'org-1');
    assert.deepEqual(first, { rows: 2, newRows: 2, created: 2, reEnquiries: 0, failed: 0 });
    assert.equal(ingested[0].input.name, 'Sharma Hardware');
    assert.equal(ingested[0].input.city, 'Indore');
    assert.equal(ingested[0].input.source, 'GOOGLE_SHEET');
    assert.equal(ingested[0].input.integrationId, 'int-1');
    assert.equal((integration.config as { rowCount: number }).rowCount, 2);

    sheet += '2026-10-02 09:00,Verma Traders,9988776655,Ujjain\n';
    const second = await service.syncNow('int-1', 'org-1');
    assert.equal(second.newRows, 1);
    assert.equal(ingested.length, 3);
    assert.equal(ingested[2].input.name, 'Verma Traders');
  });

  it('does not re-import a row when its other cells are edited or the sheet is re-sorted', async () => {
    const { service, ingested } = setup();
    sheet = 'Name,Mobile No.,City\nSharma Hardware,9812345678,\nGupta Ply,9123456789,Bhopal\n';
    await service.syncNow('int-1', 'org-1');

    sheet = 'Name,Mobile No.,City,Called?\nGupta Ply,9123456789,Bhopal,yes\nSharma Hardware & Sons,9812345678,Indore,no\n';
    const again = await service.syncNow('int-1', 'org-1');
    assert.equal(again.newRows, 0);
    assert.equal(ingested.length, 2);
  });

  it('treats a second form submission by the same number as a re-enquiry', async () => {
    const { service } = setup();
    sheet = 'Timestamp,Name,Phone\n2026-10-01 10:00,Sharma,9812345678\n2026-10-05 16:30,Sharma,9812345678\n';
    const result = await service.syncNow('int-1', 'org-1');
    assert.deepEqual(result, { rows: 2, newRows: 2, created: 1, reEnquiries: 1, failed: 0 });
  });

  it('records a bad row as failed and retries it once it is fixed', async () => {
    const { service, ingested, events } = setup();
    sheet = 'Name,Phone\nSharma,12\n';
    const bad = await service.syncNow('int-1', 'org-1');
    assert.equal(bad.failed, 1);
    assert.equal(events[0].status, WebhookEventStatus.FAILED);
    assert.match(events[0].error ?? '', /Row 2/);

    assert.equal((await service.syncNow('int-1', 'org-1')).newRows, 0); // not retried while unchanged

    sheet = 'Name,Phone\nSharma,9812345678\n';
    assert.equal((await service.syncNow('int-1', 'org-1')).created, 1);
    assert.equal(ingested.length, 1);
  });

  it('sends one summary instead of per-lead notifications for a bulk import', async () => {
    const { service, ingested, summaries } = setup();
    const rows = Array.from({ length: 25 }, (_, i) => `Lead ${i},98${String(10000000 + i)}`);
    sheet = `Name,Phone\n${rows.join('\n')}\n`;
    await service.syncNow('int-1', 'org-1');
    assert.equal(ingested.length, 25);
    assert.ok(ingested.every((i) => i.silent));
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].sheetName, 'Leads sheet');
    assert.equal(summaries[0].created.length, 25);
    assert.deepEqual([summaries[0].created.filter((id) => id === 'rahul').length, summaries[0].created.filter((id) => id === 'priya').length], [13, 12]);

    sheet += 'One more,9700000001\n';
    await service.syncNow('int-1', 'org-1');
    assert.equal(ingested[25].silent, false);
    assert.equal(summaries.length, 1, 'a small sync notifies per lead, not with a summary');
  });

  it('keeps columns that are not lead fields on the lead as custom fields', async () => {
    const { service, ingested } = setup();
    sheet = 'Timestamp,Name,Phone,Budget,Preferred Brand,Remarks,Site Photo\n2026-10-01 10:00,Sharma,9812345678,2 lakh,Century,Call after 5,\n';
    await service.syncNow('int-1', 'org-1');
    // Budget is money: read past (see "money columns in a sheet").
    assert.deepEqual(ingested[0].input.customFields, { 'Preferred Brand': 'Century' });
    // Remarks is Feedback now; "Timestamp" is the lead's date (10:00 IST).
    assert.equal(ingested[0].input.feedback, 'Call after 5');
    assert.equal(ingested[0].input.enquiredAt?.toISOString(), '2026-10-01T04:30:00.000Z');
  });

  it('saves Customer Type as Buying For, and the Meta ad id (without "ag:") for the Admin', async () => {
    const { service, ingested } = setup();
    sheet = 'Name,Phone,Customer Type,Ad ID\nSharma,9812345678,Dealer,ag:120249746455520716\n';
    await service.syncNow('int-1', 'org-1');
    assert.equal(ingested[0].input.buyingFor, 'Dealer');
    assert.deepEqual(ingested[0].input.attribution, { adId: '120249746455520716' });
  });

  it('saves the Meta question "आप_किसके_लिए_plywood_खरीदना_चाहते_हैं?_" as Buying For, exactly as answered', async () => {
    const { service, ingested } = setup();
    sheet = 'full_name,phone_number,आप_किसके_लिए_plywood_खरीदना_चाहते_हैं?_,_आपकी_approx._requirement_कितनी_है?\nVikram,p:+919661335230,*_🏠_अपने_घर_के_लिए,1–10_sheets\n';
    await service.syncNow('int-1', 'org-1');
    assert.equal(ingested[0].input.buyingFor, '*_🏠_अपने_घर_के_लिए');
    assert.equal(ingested[0].input.requirementNotes, '1–10_sheets');
    assert.equal(ingested[0].input.customFields, undefined);
  });

  it('matches "Buying For" in English too, but not a column that merely says "Plywood"', async () => {
    const { service, ingested } = setup();
    sheet = 'Name,Phone,Buying For,Plywood\nSharma,9812345678,Dealer / retailer,18mm BWP\n';
    await service.syncNow('int-1', 'org-1');
    assert.equal(ingested[0].input.buyingFor, 'Dealer / retailer');
    assert.deepEqual(ingested[0].input.customFields, { Plywood: '18mm BWP' });
  });

  describe('a sheet laid out like the Tulsi Meta leads sheet', () => {
    const HEADER =
      'Date,आप_किसके_लिए_plywood_खरीदना_चाहते_हैं?_,_आपकी_approx._requirement_कितनी_है?,full_name,phone_number,email,Feedback ,id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,form_name,is_organic,platform,city,inbox_url,lead_status';
    const OLD_ROWS = [
      '16/09/2026,,,,,,,,,,,,,,,,,,,,,',
      '1,*_🏠_अपने_घर_के_लिए,1–10_sheets,Vikram Kumar,p:+919661335230,vikram@example.com,no,,,,,,,,,,,,,,,',
      '2,*_🏪_dealer_/_retailer,30–100_sheets,Ashwani Thawait,p:+919098768300,ashwani@example.com,,,,,,,,,,,,,,,,',
      '17/09/2026,,,,,,,,,,,,,,,,,,,,,',
      '1,*_📦_distributor_/_bulk_buyer,100+_sheets,Faisal Khan,p:9921402429,faisal@example.com,Call after 5,,,,,,,,,,,,,,,',
    ];
    // Pasted in Meta's own export order under the header above.
    const META_ROW =
      'l:1770073330888532,2026-10-17T18:12:34+05:30,ag:120249746455520716,Promoting lead generation: Tulsi MP city,as:120249746455550716,[23/09/2026] Promoting Tulsi MP city,c:120249746455580716,[23/09/2026] Promoting Tulsi MP city,f:2294372707985259,Tulsi MP city,false,ig,*_🏪_dealer_/_retailer,100+_sheets,Vipin Patidar,p:+919111118201,vipin@example.com,Rau,,,,CREATED';

    it('fills Buying For, Approx. Requirement, Feedback and the enquiry date from the day headings', async () => {
      const { service, ingested } = setup();
      sheet = [HEADER, ...OLD_ROWS].join('\n') + '\n';
      const result = await service.syncNow('int-1', 'org-1');
      assert.deepEqual([result.rows, result.created, result.failed], [3, 3, 0]); // day headings aren't leads

      const [vikram, ashwani, faisal] = ingested.map((i) => i.input);
      assert.equal(vikram.buyingFor, '*_🏠_अपने_घर_के_लिए');
      assert.equal(vikram.requirementNotes, '1–10_sheets');
      assert.equal(vikram.feedback, 'no');
      assert.equal(vikram.enquiredAt?.toISOString(), '2026-09-15T18:30:00.000Z'); // 16/09/2026 00:00 IST
      assert.equal(ashwani.enquiredAt?.toISOString(), '2026-09-15T18:30:00.000Z');
      assert.equal(faisal.enquiredAt?.toISOString(), '2026-09-16T18:30:00.000Z');
      assert.equal(faisal.feedback, 'Call after 5');
      assert.equal(vikram.customFields, undefined); // every column now has a home
    });

    it('reads a row pasted in Meta order by Meta’s layout, leaving out the ad details', async () => {
      const { service, ingested } = setup();
      sheet = [HEADER, ...OLD_ROWS, META_ROW].join('\n') + '\n';
      await service.syncNow('int-1', 'org-1');
      const vipin = ingested.find((i) => i.input.name === 'Vipin Patidar')?.input;
      assert.ok(vipin, 'the Meta-order row is imported');
      assert.equal(vipin.phone, '+919111118201');
      assert.equal(vipin.email, 'vipin@example.com');
      assert.equal(vipin.city, 'Rau');
      assert.equal(vipin.buyingFor, '*_🏪_dealer_/_retailer');
      assert.equal(vipin.requirementNotes, '100+_sheets');
      assert.equal(vipin.enquiredAt?.toISOString(), '2026-10-17T12:42:34.000Z');
      assert.equal(vipin.customFields, undefined);
      // The ad id is the one ad detail kept (for the Admin); campaign, ad set, form, platform and status are not.
      assert.deepEqual(vipin.attribution, { adId: '120249746455520716' });
      assert.doesNotMatch(JSON.stringify(vipin.rawPayload), /Promoting|120249746455550716|120249746455580716|2294372707985259|CREATED|"ig"/);
    });

    it('does not re-import rows already imported before these columns existed', async () => {
      const { service } = setup();
      sheet = [HEADER, ...OLD_ROWS].join('\n') + '\n';
      await service.syncNow('int-1', 'org-1');
      assert.equal((await service.syncNow('int-1', 'org-1')).newRows, 0);
    });
  });

  it('reads Meta export numbers written as "p:+91…"', async () => {
    const { service, ingested } = setup();
    sheet = 'full_name,phone_number,email\nVikram Kumar,p:+919661335230,v@example.com\nFaisal Khan,p:9921402429,f@example.com\n';
    assert.equal((await service.syncNow('int-1', 'org-1')).created, 2);
    assert.deepEqual(ingested.map((i) => i.input.phone), ['+919661335230', '9921402429']);
  });

  it('ignores a "Date" column holding serial numbers, so renumbering does not re-import', async () => {
    const { service } = setup();
    sheet = 'Date,full_name,phone_number\n16/09/2026,,\n1,Vikram,p:+919661335230\n2,Ashwani,p:+919098768300\n';
    assert.equal((await service.syncNow('int-1', 'org-1')).created, 2);

    sheet = 'Date,full_name,phone_number\n16/09/2026,,\n1,New Lead,p:+919800000001\n2,Vikram,p:+919661335230\n3,Ashwani,p:+919098768300\n';
    const after = await service.syncNow('int-1', 'org-1');
    assert.deepEqual([after.newRows, after.created, after.reEnquiries], [1, 1, 0]);
  });

  it('accepts a sheet with headers but no rows yet', async () => {
    const { service } = setup();
    sheet = 'Name,Phone,City\n';
    assert.deepEqual(await service.syncNow('int-1', 'org-1'), { rows: 0, newRows: 0, created: 0, reEnquiries: 0, failed: 0 });
  });

  it('flags a sheet that is not shared publicly and recovers once it is', async () => {
    const { service, integration } = setup();
    response = () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    await assert.rejects(service.syncNow('int-1', 'org-1'), /Anyone with the link/);
    assert.equal(integration.status, IntegrationStatus.ERROR);
    assert.match(String(integration.config.lastSyncError), /isn’t shared publicly/);

    response = () => new Response('Name,Phone\nSharma,9812345678\n', { headers: { 'content-type': 'text/csv' } });
    await service.syncNow('int-1', 'org-1');
    assert.equal(integration.status, IntegrationStatus.ACTIVE);
    assert.equal(integration.config.lastSyncError, null);
  });

  it('explains a sheet without recognisable headers', async () => {
    const { service } = setup();
    sheet = 'Your name,Your number\nSharma,9812345678\n';
    await assert.rejects(service.syncNow('int-1', 'org-1'), /header row with a name column/);
  });

  describe('with a Google service account configured', () => {
    const BOT = 'tulsi-crm@project.iam.gserviceaccount.com';

    it('reads a private sheet through the Sheets API, never the public link', async () => {
      let publicFetches = 0;
      response = () => {
        publicFetches++;
        return new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } });
      };
      const { service, ingested } = setup(IntegrationStatus.ACTIVE, {
        serviceAccountEmail: BOT,
        fetchCsv: async () => Buffer.from('Name,Phone,Budget\r\nSharma,9812345678,2 lakh\r\n'),
      });
      assert.equal((await service.syncNow('int-1', 'org-1')).created, 1);
      assert.equal(ingested[0].input.name, 'Sharma');
      assert.equal(publicFetches, 0);
    });

    it('falls back to the public link when the sheet is not shared with the service account', async () => {
      sheet = 'Name,Phone\nSharma,9812345678\n';
      const { service } = setup(IntegrationStatus.ACTIVE, {
        serviceAccountEmail: BOT,
        fetchCsv: async () => {
          throw new SheetAccessDeniedError('The caller does not have permission');
        },
      });
      assert.equal((await service.syncNow('int-1', 'org-1')).created, 1);
    });

    it('tells the Admin which email to share a private sheet with', async () => {
      response = () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } });
      const { service, integration } = setup(IntegrationStatus.ACTIVE, {
        serviceAccountEmail: BOT,
        fetchCsv: async () => {
          throw new SheetAccessDeniedError('The caller does not have permission');
        },
      });
      await assert.rejects(service.syncNow('int-1', 'org-1'), /add tulsi-crm@project\.iam\.gserviceaccount\.com as a Viewer/);
      assert.equal(integration.status, IntegrationStatus.ERROR);
    });

    it('reports a service-account problem instead of silently using the public link', async () => {
      sheet = 'Name,Phone\nSharma,9812345678\n';
      const { service } = setup(IntegrationStatus.ACTIVE, {
        serviceAccountEmail: BOT,
        fetchCsv: async () => {
          throw new Error('The Google Sheets API is not enabled in the CRM’s Google Cloud project');
        },
      });
      await assert.rejects(service.syncNow('int-1', 'org-1'), /not enabled/);
    });
  });

  it('refuses to sync a deactivated sheet', async () => {
    const { service } = setup(IntegrationStatus.INACTIVE);
    await assert.rejects(service.syncNow('int-1', 'org-1'), /deactivated/);
  });
});

describe('money columns in a sheet', () => {
  it('are read past, not kept — not even as extra details', async () => {
    const { service, ingested } = setup();
    sheet = 'Name,Phone,Estimated Value (₹),Budget,Amount,Site Photo\nSharma,9812345678,85000,2 lakh,5000,yes\n';
    assert.equal((await service.syncNow('int-1', 'org-1')).created, 1);
    assert.deepEqual(ingested[0].input.customFields, { 'Site Photo': 'yes' });
    assert.doesNotMatch(JSON.stringify(ingested[0].input.rawPayload), /85000|2 lakh|5000/);
  });
});
