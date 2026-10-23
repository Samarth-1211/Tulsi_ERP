import { AllotmentPriority } from '@prisma/client';

/** What the ranking needs to know about one qualifying lead. */
export interface AllotmentCandidate {
  id: string;
  createdAt: Date;
  lastContactAt: Date | null;
  attempts: number; // follow-ups logged so far
}

// SMART weights: the lead that has gone quiet longest matters most, then the
// one that has had the fewest tries. (Lead value no longer counts — the CRM keeps no money.)
const SMART_WEIGHTS = { silence: 0.6, freshness: 0.4 };

/**
 * SMART score in [0, 1] per candidate. Silence is scaled against the longest
 * in this set, so the score only compares leads with each other.
 */
export function smartScores(candidates: AllotmentCandidate[], now = new Date()): Map<string, number> {
  const silenceOf = (c: AllotmentCandidate) => now.getTime() - (c.lastContactAt ?? c.createdAt).getTime();
  const maxSilence = Math.max(0, ...candidates.map(silenceOf));
  return new Map(
    candidates.map((c) => [
      c.id,
      SMART_WEIGHTS.silence * (maxSilence > 0 ? silenceOf(c) / maxSilence : 0) +
        SMART_WEIGHTS.freshness / (1 + c.attempts),
    ]),
  );
}

type Compare = (a: AllotmentCandidate, b: AllotmentCandidate) => number;

function comparator(priority: AllotmentPriority, scores: Map<string, number>): Compare {
  switch (priority) {
    case AllotmentPriority.LONGEST_SILENT:
      return (a, b) => (a.lastContactAt?.getTime() ?? 0) - (b.lastContactAt?.getTime() ?? 0);
    case AllotmentPriority.NEWEST_ENQUIRY:
      return (a, b) => b.createdAt.getTime() - a.createdAt.getTime();
    case AllotmentPriority.OLDEST_ENQUIRY:
      return (a, b) => a.createdAt.getTime() - b.createdAt.getTime();
    case AllotmentPriority.FEWEST_ATTEMPTS:
      return (a, b) => a.attempts - b.attempts;
    case AllotmentPriority.MOST_ENGAGED:
      return (a, b) => b.attempts - a.attempts;
    // HIGHEST_VALUE is retired with lead value; an org still set to it gets SMART.
    case AllotmentPriority.SMART:
    default:
      return (a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
  }
}

/**
 * Orders candidates by the org's chosen priority, then its tie-breaker, then
 * id (so the same data always gives the same batch), and keeps the first `limit`.
 */
export function rankCandidates(
  candidates: AllotmentCandidate[],
  priority: AllotmentPriority,
  thenBy: AllotmentPriority,
  limit: number,
  now = new Date(),
): AllotmentCandidate[] {
  const scores = smartScores(candidates, now);
  const first = comparator(priority, scores);
  const second = comparator(thenBy, scores);
  return [...candidates]
    .sort((a, b) => first(a, b) || second(a, b) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
