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
  value: null,
  attempts: 1,
  ...o,
});

const ids = (rows: AllotmentCandidate[]) => rows.map((r) => r.id);
const rank = (rows: AllotmentCandidate[], p: AllotmentPriority, then: AllotmentPriority = AllotmentPriority.OLDEST_ENQUIRY, limit = 15) =>
  ids(rankCandidates(rows, p, then, limit, NOW));

describe('Automated Task Allotment ranking', () => {
  it('HIGHEST_VALUE puts the biggest deal first and leads without a value last', () => {
    const rows = [lead('none'), lead('small', { value: 500 }), lead('big', { value: 25000 })];
    assert.deepEqual(rank(rows, AllotmentPriority.HIGHEST_VALUE), ['big', 'small', 'none']);
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

  it('SMART favours a valuable, long-quiet lead over a cheap, recently tried one', () => {
    const rows = [
      lead('cheap-recent', { value: 500, lastContactAt: daysAgo(2), attempts: 4 }),
      lead('valuable-quiet', { value: 20000, lastContactAt: daysAgo(18), attempts: 1 }),
      lead('mid', { value: 8000, lastContactAt: daysAgo(8), attempts: 2 }),
    ];
    assert.deepEqual(rank(rows, AllotmentPriority.SMART), ['valuable-quiet', 'mid', 'cheap-recent']);
  });

  it('the tie-breaker decides between equal leads, then id keeps it stable', () => {
    const rows = [lead('b', { value: 500, createdAt: daysAgo(3) }), lead('a', { value: 500, createdAt: daysAgo(20) }), lead('c', { value: 500, createdAt: daysAgo(20) })];
    assert.deepEqual(rank(rows, AllotmentPriority.HIGHEST_VALUE, AllotmentPriority.NEWEST_ENQUIRY), ['b', 'a', 'c']);
  });

  it('keeps only the batch size', () => {
    const rows = Array.from({ length: 40 }, (_, i) => lead(`l${String(i).padStart(2, '0')}`, { value: i * 100 }));
    const top = rank(rows, AllotmentPriority.HIGHEST_VALUE, AllotmentPriority.OLDEST_ENQUIRY, 15);
    assert.equal(top.length, 15);
    assert.equal(top[0], 'l39');
  });
});
