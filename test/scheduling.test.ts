/**
 * Scheduling and officials — §5.4, §6.3–6.6 and business rules §7.2–7.3.
 *
 * The distinction under test is the one the document draws: hard conflicts
 * block publishing, soft ones only warn.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { autoSchedule, detectConflicts, proposeReschedule, toMins, toTime } from '../src/engines/scheduler.ts';
import { assessCandidate, autoAssignOfficials, meetsMinimumPanel, rankCandidates } from '../src/engines/officials.ts';
import { generateKnockout } from '../src/engines/draw.ts';
import { kabaddi } from '../src/sports/index.ts';
import { GRID, entries, entryMeta, event, format, match, official, tournament, venue } from './helpers.ts';

const list = entries(['MH', 'HR', 'PB', 'UP', 'RJ', 'TN', 'KA', 'DL']);
const units = Object.fromEntries(Object.entries(entryMeta(list)).map(([k, v]) => [k, v.unitId]));

function ko() {
  return generateKnockout(event(), format(), list, {
    seedCount: 0, separationRule: 'none', byePolicy: 'top-seeds', rngSeed: 'sched', generatedBy: 'cm1',
  });
}

const sctx = (matches = ko().matches, over = {}) => ({
  matches, venues: [venue()], grid: GRID, entryUnits: units, sportId: 'kabaddi', ...over,
});

describe('time helpers', () => {
  test('round-trip minutes and clock time', () => {
    assert.equal(toMins('09:15'), 555);
    assert.equal(toTime(555), '09:15');
    assert.equal(toTime(0), '00:00');
  });
});

describe('auto-scheduler', () => {
  test('places every playable fixture with no hard conflicts', () => {
    const out = autoSchedule(sctx());
    assert.deepEqual(out.unplaced, []);
    assert.deepEqual(out.conflicts.hard, []);
    assert.ok(out.conflicts.publishable);
  });

  test('uses the mats in parallel rather than serialising onto one', () => {
    const out = autoSchedule(sctx());
    const r1 = out.matches.filter((m) => m.roundNo === 1);
    const byFop = new Set(r1.map((m) => m.fopId));
    assert.ok(byFop.size > 1, 'round-one fixtures should spread across the available mats');
  });

  test('never schedules a fixture before its feeder finishes', () => {
    const out = autoSchedule(sctx());
    const byNo = new Map(out.matches.map((m) => [m.matchNo, m]));
    const abs = (m: typeof out.matches[number]) =>
      new Date(`${m.scheduledDate}T${m.scheduledTime}:00Z`).getTime();
    for (const m of out.matches) {
      for (const side of [m.sideA, m.sideB]) {
        if (side.kind !== 'placeholder') continue;
        const f = byNo.get(side.matchNo);
        if (!f?.scheduledDate) continue;
        assert.ok(abs(m) >= abs(f), `${m.matchNo} starts before its feeder ${f.matchNo}`);
      }
    }
  });

  test('honours the sport rest gap between a side\'s fixtures', () => {
    const out = autoSchedule(sctx());
    const abs = (m: typeof out.matches[number]) => new Date(`${m.scheduledDate}T${m.scheduledTime}:00Z`).getTime() / 60000;
    const byEntry = new Map<string, number[][]>();
    for (const m of out.matches) {
      if (!m.scheduledDate) continue;
      for (const s of [m.sideA, m.sideB]) {
        if (s.kind !== 'entry') continue;
        const arr = byEntry.get(s.entryId) ?? [];
        arr.push([abs(m), abs(m) + (m.durationMins ?? 45)]);
        byEntry.set(s.entryId, arr);
      }
    }
    for (const [entryId, spans] of byEntry) {
      spans.sort((a, b) => a[0]! - b[0]!);
      for (let i = 0; i < spans.length - 1; i++) {
        const gap = spans[i + 1]![0]! - spans[i]![1]!;
        assert.ok(gap >= kabaddi.restGap.hardMins, `${entryId} gets only ${gap} min rest`);
      }
    }
  });

  test('a bye is never scheduled, because it is awarded without play', () => {
    const out = autoSchedule(sctx());
    for (const m of out.matches.filter((x) => x.byeFlag)) {
      assert.equal(m.scheduledDate, undefined);
    }
  });

  test('a prime fixture is preferred into an evening slot but never left unplaced', () => {
    const base = ko();
    const final = base.matches.find((m) => m.stage === 'F')!;
    const out = autoSchedule({ ...sctx(base.matches), primeMatchNos: [final.matchNo] });
    const placed = out.matches.find((m) => m.matchNo === final.matchNo)!;
    assert.ok(placed.scheduledDate, 'a prime fixture must still be placed');
    assert.equal(placed.session, 'evening');
  });
});

describe('hard conflicts block publishing', () => {
  test('a double-booked mat', () => {
    const out = autoSchedule(sctx());
    const [a, b] = out.matches.filter((m) => m.scheduledDate && !m.byeFlag);
    const clashed = out.matches.map((m) =>
      m.matchNo === b!.matchNo ? { ...m, scheduledDate: a!.scheduledDate, scheduledTime: a!.scheduledTime, fopId: a!.fopId } : m,
    );
    const r = detectConflicts(sctx(clashed));
    assert.ok(r.hard.some((c) => c.code === 'FOP_DOUBLE_BOOKED'));
    assert.equal(r.publishable, false);
  });

  test('a fixture outside the venue operating hours', () => {
    const out = autoSchedule(sctx());
    const moved = out.matches.map((m) => (m.scheduledDate ? { ...m, scheduledTime: '23:30' } : m));
    const r = detectConflicts(sctx(moved));
    assert.ok(r.hard.some((c) => c.code === 'OUTSIDE_OPERATING_HOURS'));
  });

  test('a fixture inside a maintenance window', () => {
    const v = venue({ maintenanceBlocks: [{ fopId: 'V1-MAT-1', date: '2026-03-10', from: '09:00', to: '12:00', reason: 'resurfacing' }] });
    const out = autoSchedule(sctx());
    const moved = out.matches.map((m) =>
      m.matchNo === 'M01' ? { ...m, scheduledDate: '2026-03-10', scheduledTime: '10:00', fopId: 'V1-MAT-1', venueId: 'V1' } : m,
    );
    const r = detectConflicts(sctx(moved, { venues: [v] }));
    assert.ok(r.hard.some((c) => c.code === 'MAINTENANCE_BLOCK'));
  });

  test('a rest gap below the sport hard minimum', () => {
    const a = match({ matchId: 'M-a', matchNo: 'M01', scheduledDate: '2026-03-10', scheduledTime: '09:00', fopId: 'V1-MAT-1', venueId: 'V1', durationMins: 45, matchStatus: 'Scheduled' });
    const b = match({ matchId: 'M-b', matchNo: 'M02', scheduledDate: '2026-03-10', scheduledTime: '09:50', fopId: 'V1-MAT-2', venueId: 'V1', durationMins: 45, matchStatus: 'Scheduled' });
    const r = detectConflicts(sctx([a, b]));
    assert.ok(r.hard.some((c) => c.code === 'REST_GAP_SHORT'), JSON.stringify(r.hard));
  });

  test('an unscheduled playable fixture', () => {
    const r = detectConflicts(sctx([match({ matchStatus: 'Scheduled' })]));
    assert.ok(r.hard.some((c) => c.code === 'UNSCHEDULED'));
  });

  test('a semi-final fed by a group table, scheduled before its group finishes', () => {
    const group = match({ matchId: 'g1', matchNo: 'M01', groupId: 'G1', scheduledDate: '2026-03-11', scheduledTime: '14:00', fopId: 'V1-MAT-1', venueId: 'V1', durationMins: 45, matchStatus: 'Scheduled' });
    const sf = match({
      matchId: 'sf', matchNo: 'M20', stage: 'SF', roundNo: 101, groupId: undefined, matchStatus: 'Scheduled',
      sideA: { kind: 'placeholder-standing', groupId: 'G1', position: 1, displayName: 'G1 #1' },
      sideB: { kind: 'placeholder-standing', groupId: 'G1', position: 2, displayName: 'G1 #2' },
      scheduledDate: '2026-03-10', scheduledTime: '09:00', fopId: 'V1-MAT-2', venueId: 'V1', durationMins: 45,
    });
    const r = detectConflicts(sctx([group, sf]));
    assert.ok(r.hard.some((c) => c.code === 'ROUND_ORDER'), JSON.stringify(r.hard));
  });
});

describe('soft conflicts warn but do not block', () => {
  test('a rest gap between the hard minimum and the recommendation', () => {
    const gap = kabaddi.restGap.hardMins + 5; // above hard, below recommended
    const a = match({ matchId: 'M-a', matchNo: 'M01', scheduledDate: '2026-03-10', scheduledTime: '09:00', fopId: 'V1-MAT-1', venueId: 'V1', durationMins: 45, matchStatus: 'Scheduled' });
    const b = match({ matchId: 'M-b', matchNo: 'M02', scheduledDate: '2026-03-10', scheduledTime: toTime(toMins('09:45') + gap), fopId: 'V1-MAT-2', venueId: 'V1', durationMins: 45, matchStatus: 'Scheduled' });
    const r = detectConflicts(sctx([a, b]));
    assert.deepEqual(r.hard.filter((c) => c.code === 'REST_GAP_SHORT'), []);
    assert.ok(r.soft.some((c) => c.code === 'REST_GAP_SHORT'));
    assert.ok(r.publishable, 'a soft conflict must not block publishing');
  });

  test('a unit made to play at two venues on one day', () => {
    const v2 = venue({ venueId: 'V2', name: 'Second venue', fopList: [{ fopId: 'V2-MAT-1', venueId: 'V2', type: 'mat', name: 'Mat 1' }] });
    const a = match({ matchId: 'M-a', matchNo: 'M01', scheduledDate: '2026-03-10', scheduledTime: '09:00', fopId: 'V1-MAT-1', venueId: 'V1', durationMins: 45, matchStatus: 'Scheduled' });
    const b = match({ matchId: 'M-b', matchNo: 'M02', scheduledDate: '2026-03-10', scheduledTime: '15:00', fopId: 'V2-MAT-1', venueId: 'V2', durationMins: 45, matchStatus: 'Scheduled' });
    const r = detectConflicts(sctx([a, b], { venues: [venue(), v2] }));
    assert.ok(r.soft.some((c) => c.code === 'VENUE_HOPPING'));
    assert.ok(r.publishable);
  });
});

describe('reschedule', () => {
  test('a reschedule without a reason code is refused', () => {
    const out = autoSchedule(sctx());
    const target = out.matches.find((m) => m.scheduledDate)!;
    const r = proposeReschedule(sctx(out.matches), { matchNo: target.matchNo, toDate: '2026-03-12', toTime: '10:00', toFopId: 'V1-MAT-1', reasonCode: '', requestedBy: 'cm1' }, 'ta1');
    assert.equal(r.accepted, false);
    assert.match(r.error!, /reason code/);
  });

  test('a reschedule into a clash is refused, and the original plan is untouched', () => {
    const out = autoSchedule(sctx());
    const [a, b] = out.matches.filter((m) => m.scheduledDate && !m.byeFlag);
    const r = proposeReschedule(
      sctx(out.matches),
      { matchNo: b!.matchNo, toDate: a!.scheduledDate!, toTime: a!.scheduledTime!, toFopId: a!.fopId!, reasonCode: 'WEATHER', requestedBy: 'cm1' },
      'ta1',
    );
    assert.equal(r.accepted, false);
    assert.equal(r.matches, out.matches, 'the plan must not be mutated by a refused move');
  });

  test('an accepted reschedule bumps the version and keeps the prior slot in history', () => {
    const out = autoSchedule(sctx());
    // The final is the only fixture with no successors, so moving it later
    // cannot break round order. Moving an earlier round would — and the engine
    // correctly refuses that, which the clash test above already covers.
    const target = out.matches.find((m) => m.stage === 'F' && m.scheduledDate)!;
    const r = proposeReschedule(
      sctx(out.matches),
      { matchNo: target.matchNo, toDate: '2026-03-12', toTime: '10:00', toFopId: 'V1-MAT-1', reasonCode: 'VENUE_UNAVAILABLE', requestedBy: 'cm1' },
      'ta1',
    );
    assert.ok(r.accepted, r.error);
    const moved = r.matches.find((m) => m.matchNo === target.matchNo)!;
    assert.equal(moved.versionNo, target.versionNo + 1);
    assert.equal(moved.rescheduleHistory.length, 1);
    assert.equal(moved.rescheduleHistory[0]!.fromTime, target.scheduledTime);
    assert.equal(moved.rescheduleHistory[0]!.approvedBy, 'ta1');
  });

  test('moving an early-round fixture past the round it feeds is refused', () => {
    const out = autoSchedule(sctx());
    const r1 = out.matches.find((m) => m.roundNo === 1 && m.scheduledDate && !m.byeFlag)!;
    const r = proposeReschedule(
      sctx(out.matches),
      { matchNo: r1.matchNo, toDate: '2026-03-12', toTime: '20:00', toFopId: 'V1-MAT-1', reasonCode: 'WEATHER', requestedBy: 'cm1' },
      'ta1',
    );
    assert.equal(r.accepted, false);
    assert.match(r.error!, /before its feeder/);
  });
});

describe('officials assignment', () => {
  const pool = [
    official('O1', 'GJ', ['Referee', 'Umpire', 'Match Commissioner']),
    official('O2', 'KL', ['Referee', 'Umpire', 'Match Commissioner']),
    official('O3', 'WB', ['Umpire', 'Scorer', 'Assistant Scorer'], 'B'),
    official('O4', 'OD', ['Umpire', 'Scorer', 'Assistant Scorer'], 'B'),
    official('O5', 'AS', ['Assistant Scorer', 'Time Keeper'], 'C'),
    official('O6', 'TS', ['Assistant Scorer', 'Time Keeper'], 'C'),
    official('O7', 'MP', ['Time Keeper', 'Assistant Scorer'], 'C'),
    official('O8', 'JH', ['Match Commissioner', 'Referee']),
  ];
  const m = match({ scheduledDate: '2026-03-10', scheduledTime: '09:00', fopId: 'V1-MAT-1', venueId: 'V1', durationMins: 45, matchStatus: 'Scheduled' });
  const actx = (over = {}) => ({
    tournament: tournament(),
    match: m,
    sideUnits: { a: 'MH', b: 'HR' },
    pool,
    existing: [],
    allMatches: [m],
    venues: [venue()],
    sportId: 'kabaddi',
    assignedBy: 'cm1',
    ...over,
  });

  test('fills the full panel from an adequate pool', () => {
    const out = autoAssignOfficials(actx());
    assert.deepEqual(out.unfilled, [], JSON.stringify(out.unfilled));
    assert.equal(out.assignments.length, kabaddi.officials.panel.reduce((n, p) => n + p.count, 0));
  });

  test('neutrality blocks an official from a participating unit', () => {
    const a = assessCandidate(actx(), official('OX', 'MH', ['Referee']), 'Referee');
    assert.equal(a.assignable, false);
    assert.ok(a.issues.some((i) => i.code === 'NEUTRALITY_FAIL' && i.severity === 'hard'));
  });

  test('neutrality is advisory when the tournament does not enforce it', () => {
    const a = assessCandidate(actx({ tournament: tournament({ enforceOfficialNeutrality: false }) }), official('OX', 'MH', ['Referee']), 'Referee');
    assert.ok(a.assignable, 'an advisory must not block');
    assert.ok(a.issues.some((i) => i.code === 'NEUTRALITY_FAIL' && i.severity === 'soft'));
  });

  test('an official qualified for another sport is refused', () => {
    const a = assessCandidate(actx(), official('OV', 'GJ', ['Referee'], 'A', { sports: ['volleyball'] }), 'Referee');
    assert.equal(a.assignable, false);
    assert.ok(a.issues.some((i) => i.code === 'NOT_QUALIFIED_SPORT'));
  });

  test('a lapsed accreditation is refused', () => {
    const a = assessCandidate(actx(), official('OL', 'GJ', ['Referee'], 'A', { accreditation: { id: 'x', validUntil: '2025-01-01' } }), 'Referee');
    assert.equal(a.assignable, false);
    assert.ok(a.issues.some((i) => i.code === 'ACCREDITATION_INVALID'));
  });

  test('a grade below the seat requirement is refused', () => {
    const a = assessCandidate(actx(), official('OG', 'GJ', ['Referee'], 'C'), 'Referee');
    assert.equal(a.assignable, false);
    assert.ok(a.issues.some((i) => i.code === 'GRADE_TOO_LOW'));
  });

  test('a declared unavailable date is refused', () => {
    const a = assessCandidate(actx(), official('OU', 'GJ', ['Referee'], 'A', { unavailableDates: ['2026-03-10'] }), 'Referee');
    assert.equal(a.assignable, false);
    assert.ok(a.issues.some((i) => i.code === 'UNAVAILABLE_DATE'));
  });

  test('an overlapping duty is refused', () => {
    const other = match({ matchId: 'MCH-2', matchNo: 'M02', scheduledDate: '2026-03-10', scheduledTime: '09:15', fopId: 'V1-MAT-2', venueId: 'V1', durationMins: 45, matchStatus: 'Scheduled' });
    const existing = [{
      assignmentId: 'A1', matchId: 'MCH-2', officialId: 'O1', officialName: 'Official O1', role: 'Referee',
      unitId: 'GJ', venueId: 'V1', neutralityCheckResult: 'pass' as const, status: 'assigned' as const,
      assignedBy: 'cm1', assignedAt: '',
    }];
    const a = assessCandidate(actx({ existing, allMatches: [m, other] }), pool[0]!, 'Referee');
    assert.equal(a.assignable, false);
    assert.ok(a.issues.some((i) => i.code === 'OVERLAPPING_DUTY'));
  });

  test('an unfilled seat reports why each candidate failed', () => {
    // Pool of one, from a participating unit.
    const out = autoAssignOfficials(actx({ pool: [official('OM', 'MH', ['Referee', 'Umpire', 'Scorer', 'Assistant Scorer', 'Time Keeper', 'Match Commissioner'])] }));
    assert.ok(out.unfilled.length > 0);
    assert.ok(out.unfilled[0]!.reasons.length > 0, 'a pool gap must be explained');
    assert.match(out.unfilled.flatMap((u) => u.reasons).join(' '), /neutrality/i);
  });

  test('candidates are ranked with the assignable ones first', () => {
    const ranked = rankCandidates(actx(), 'Referee');
    const firstBad = ranked.findIndex((c) => !c.assignable);
    if (firstBad !== -1) {
      assert.ok(ranked.slice(firstBad).every((c) => !c.assignable), 'assignable candidates must sort first');
    }
  });

  test('the minimum panel gate names what is missing', () => {
    const none = meetsMinimumPanel('kabaddi', []);
    assert.equal(none.ok, false);
    assert.deepEqual(
      none.missing.map((x) => x.role).sort(),
      kabaddi.officials.minimumToStart.map((x) => x.role).sort(),
    );
    const full = autoAssignOfficials(actx());
    assert.ok(meetsMinimumPanel('kabaddi', full.assignments).ok);
  });
});
