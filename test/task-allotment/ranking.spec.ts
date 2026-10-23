import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AllotmentPriority } from '@prisma/client';
import { AllotmentCandidate, rankCandidates } from '../../src/modules/task-allotment/utils/allotment-ranking.util';

const NOW = new Date('2026-10-21T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const lead = (id: string, o: Partial<AllotmentCandidate> = {}): AllotmentCandidate => ({
  id,
  createdAt: daysAgo(10),
  lastContactAt: daysAgo(5),
  attempts: 1,
  ...o,
});

const ids = (rows: AllotmentCandidate[]) => rows.map((r) => r.id);
const rank = (rows: AllotmentCandidate[], p: AllotmentPriority, then: AllotmentPriority = AllotmentPriority.OLDEST_ENQUIRY, limit = 15) =>
  ids(rankCandidates(rows, p, then, limit, NOW));

describe('Automated Task Allotment ranking', () => {
  it('HIGHEST_VALUE (retired with lead value) ranks like SMART', () => {
    const rows = [lead('recent', { lastContactAt: daysAgo(2), attempts: 3 }), lead('quiet', { lastContactAt: daysAgo(15) })];
    assert.deepEqual(rank(rows, AllotmentPriority.HIGHEST_VALUE), rank(rows, AllotmentPriority.SMART));
    assert.deepEqual(rank(rows, AllotmentPriority.SMART), ['quiet', 'recent']);
  });

  it('LONGEST_SILENT puts the lead contacted longest ago first', () => {
    const rows = [lead('recent', { lastContactAt: daysAgo(3) }), lead('quiet', { lastContactAt: daysAgo(20) })];
    assert.deepEqual(rank(rows, AllotmentPriority.LONGEST_SILENT), ['quiet', 'recent']);
  });

  it('NEWEST_ENQUIRY / OLDEST_ENQUIRY order by when the lead came in', () => {
    const rows = [lead('old', { createdAt: daysAgo(28) }), lead('new', { createdAt: daysAgo(4) })];
    assert.deepEqual(rank(rows, AllotmentPriority.NEWEST_ENQUIRY), ['new', 'old']);
    assert.deepEqual(rank(rows, AllotmentPriority.OLDEST_ENQUIRY), ['old', 'new']);
  });

  it('FEWEST_ATTEMPTS / MOST_ENGAGED order by follow-ups logged', () => {
    const rows = [lead('many', { attempts: 6 }), lead('one', { attempts: 1 })];
    assert.deepEqual(rank(rows, AllotmentPriority.FEWEST_ATTEMPTS), ['one', 'many']);
    assert.deepEqual(rank(rows, AllotmentPriority.MOST_ENGAGED), ['many', 'one']);
  });

  it('SMART favours a long-quiet, little-tried lead over a recently, often tried one', () => {
    const rows = [
      lead('recent-often', { lastContactAt: daysAgo(2), attempts: 4 }),
      lead('quiet-once', { lastContactAt: daysAgo(18), attempts: 1 }),
      lead('mid', { lastContactAt: daysAgo(8), attempts: 2 }),
    ];
    assert.deepEqual(rank(rows, AllotmentPriority.SMART), ['quiet-once', 'mid', 'recent-often']);
  });

  it('the tie-breaker decides between equal leads, then id keeps it stable', () => {
    const rows = [lead('b', { createdAt: daysAgo(3) }), lead('a', { createdAt: daysAgo(20) }), lead('c', { createdAt: daysAgo(20) })];
    assert.deepEqual(rank(rows, AllotmentPriority.FEWEST_ATTEMPTS, AllotmentPriority.NEWEST_ENQUIRY), ['b', 'a', 'c']);
  });

  it('keeps only the batch size', () => {
    const rows = Array.from({ length: 40 }, (_, i) => lead(`l${String(i).padStart(2, '0')}`, { attempts: 40 - i }));
    const top = rank(rows, AllotmentPriority.FEWEST_ATTEMPTS, AllotmentPriority.OLDEST_ENQUIRY, 15);
    assert.equal(top.length, 15);
    assert.equal(top[0], 'l39');
  });
});
