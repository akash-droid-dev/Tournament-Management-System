/**
 * Eligibility engine — §5.2 and business rules §7.1.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { advisories, ageOnCutOff, evaluateEligibility, hardFailures, weighIn } from '../src/engines/eligibility.ts';
import '../src/sports/index.ts';
import { entry, event, participant, tournament } from './helpers.ts';

const ctx = (over = {}) => ({
  tournament: tournament(),
  event: event(),
  participant: participant('MH'),
  existingEntries: [],
  participantEntriesInTournament: [],
  asOf: '2026-02-01',
  ...over,
});

const ruleFailed = (r: ReturnType<typeof evaluateEligibility>, rule: string) =>
  r.checks.some((c) => c.rule === rule && !c.passed);

describe('age eligibility', () => {
  test('age is computed on the cut-off date, not today', () => {
    // Born 1 Jan 2010; on a 1 Jan 2026 cut-off that is exactly 16.
    assert.equal(ageOnCutOff('2010-01-01', '2026-01-01'), 16);
    // A birthday one day later means still 15 on the cut-off.
    assert.equal(ageOnCutOff('2010-01-02', '2026-01-01'), 15);
  });

  test('an athlete over the band is refused', () => {
    const r = evaluateEligibility(ctx({
      event: event({ ageCategory: 'U-17', participationType: 'individual' }),
      participant: participant('MH', { dateOfBirth: '2000-05-05', gender: 'M' }),
    }));
    assert.equal(r.eligible, false);
    assert.ok(ruleFailed(r, 'age-category'));
  });

  test('an athlete inside the band passes', () => {
    const r = evaluateEligibility(ctx({
      event: event({ ageCategory: 'U-17', participationType: 'individual' }),
      participant: participant('MH', { dateOfBirth: '2011-06-01', gender: 'M' }),
    }));
    assert.ok(!ruleFailed(r, 'age-category'));
  });
});

describe('upstream status and accreditation', () => {
  test('only an Approved upstream record may be entered', () => {
    for (const status of ['Pending', 'Rejected', 'Suspended'] as const) {
      const r = evaluateEligibility(ctx({ participant: participant('MH', { upstreamStatus: status }) }));
      assert.equal(r.eligible, false, `${status} must be refused`);
      assert.ok(ruleFailed(r, 'upstream-approved'));
    }
  });

  test('an expired accreditation blocks the entry', () => {
    const r = evaluateEligibility(ctx({
      participant: participant('MH', { accreditation: { id: 'A', validUntil: '2025-12-31', zones: [] } }),
    }));
    assert.equal(r.eligible, false);
    assert.ok(ruleFailed(r, 'accreditation-valid'));
  });

  test('a missing accreditation blocks the entry', () => {
    const r = evaluateEligibility(ctx({ participant: participant('MH', { accreditation: undefined }) }));
    assert.equal(r.eligible, false);
  });

  test('an open doping flag blocks the entry', () => {
    const r = evaluateEligibility(ctx({ participant: participant('MH', { dopingFlag: true }) }));
    assert.equal(r.eligible, false);
    assert.match(hardFailures(r).map((c) => c.message).join(' '), /doping flag/);
  });
});

describe('duplicates and quotas', () => {
  test('the same participant cannot be entered twice in one event', () => {
    const existing = entry(1, 'MH');
    const r = evaluateEligibility(ctx({ existingEntries: [existing] }));
    assert.equal(r.eligible, false);
    assert.ok(ruleFailed(r, 'duplicate-entry'));
  });

  test('a withdrawn entry does not count as a duplicate', () => {
    const scratched = entry(1, 'MH', undefined, { entryStatus: 'Scratched' });
    const r = evaluateEligibility(ctx({ existingEntries: [scratched] }));
    assert.ok(!ruleFailed(r, 'duplicate-entry'));
  });

  test('a unit quota is a hard limit', () => {
    const existing = entry(1, 'MH', undefined, { participantRef: { id: 'OTHER', displayName: 'Other MH', module: 'team-management' } });
    const r = evaluateEligibility(ctx({ existingEntries: [existing] }));
    assert.equal(r.eligible, false);
    assert.ok(ruleFailed(r, 'unit-quota'));
  });

  test('the cross-event limit is enforced', () => {
    const r = evaluateEligibility(ctx({
      participantEntriesInTournament: [{ eventId: 'EVT-OTHER', eventLabel: 'Another event' }],
    }));
    assert.equal(r.eligible, false);
    assert.ok(ruleFailed(r, 'max-events-per-athlete'));
  });
});

describe('hard versus soft failures', () => {
  test('a cross-event clash is an advisory, not a block', () => {
    const r = evaluateEligibility(ctx({
      tournament: tournament({ maxEventsPerAthlete: 3 }),
      participantEntriesInTournament: [{ eventId: 'EVT-X', eventLabel: 'Other event' }],
      overlappingEventIds: ['EVT-X'],
    }));
    assert.ok(r.eligible, 'a clash advisory must not block the entry');
    assert.ok(advisories(r).some((c) => c.rule === 'cross-event-clash'));
  });

  test('a declared weight over the limit blocks, and is provisional until the weigh-in', () => {
    const r = evaluateEligibility(ctx({
      event: event({ weightCategory: 'SM-85' }),
      participant: participant('MH', { declaredWeightKg: 92 }),
    }));
    assert.equal(r.eligible, false);
    assert.match(hardFailures(r).map((c) => c.message).join(' '), /provisional only/);
  });

  test('a missing declared weight is an advisory only', () => {
    const r = evaluateEligibility(ctx({
      event: event({ weightCategory: 'SM-85' }),
      participant: participant('MH', { declaredWeightKg: undefined }),
    }));
    assert.ok(r.eligible);
    assert.ok(advisories(r).some((c) => c.rule === 'weight-category'));
  });
});

describe('squad size', () => {
  test('a squad below the minimum on the mat blocks the entry', () => {
    const r = evaluateEligibility(ctx({
      participant: participant('MH', { rosterRefs: Array.from({ length: 6 }, (_, i) => ({ id: `A${i}`, displayName: `P${i}`, module: 'athlete-registration' as const })) }),
    }));
    assert.equal(r.eligible, false);
    assert.ok(ruleFailed(r, 'roster-size'));
  });

  test('an oversized squad is an advisory, since it can be trimmed at check-in', () => {
    const r = evaluateEligibility(ctx({
      participant: participant('MH', { rosterRefs: Array.from({ length: 15 }, (_, i) => ({ id: `A${i}`, displayName: `P${i}`, module: 'athlete-registration' as const })) }),
    }));
    assert.ok(r.eligible);
    assert.ok(advisories(r).some((c) => c.rule === 'roster-size'));
  });
});

describe('weigh-in', () => {
  test('a failure demands a scratch or a category move, never silent acceptance', () => {
    const out = weighIn(entry(1, 'MH'), 90, 85);
    assert.equal(out.passed, false);
    assert.equal(out.action, 'scratch-or-move');
  });

  test('within the limit passes with no action', () => {
    const out = weighIn(entry(1, 'MH'), 80, 85);
    assert.ok(out.passed);
    assert.equal(out.action, 'none');
  });

  test('an event with no weight limit always passes', () => {
    assert.ok(weighIn(entry(1, 'MH'), 200, undefined).passed);
  });
});
