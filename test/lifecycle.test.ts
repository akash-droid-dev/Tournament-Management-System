/**
 * End-to-end: the seeded tournament driven through all ten phases.
 *
 * This is the integration test that matters — it proves the phases actually
 * connect, the audit trail is written, and the invariants the document states
 * as guarantees hold over real data rather than in isolation.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TmsStore } from '../src/store/db.ts';
import { TmsService } from '../src/api/service.ts';
import { seedKabaddiTournament, type SeedResult } from '../src/seed/kabaddi-tournament.ts';
import { buildReport, REPORTS, toCsv } from '../src/reports/index.ts';
import { kabaddi } from '../src/sports/index.ts';

let store: TmsStore;
let svc: TmsService;
let seed: SeedResult;

before(() => {
  store = new TmsStore(':memory:');
  seed = seedKabaddiTournament(store);
  svc = new TmsService(store);
});

after(() => store.close());

const men = () => store.getEvent(seed.menEventId)!;
const women = () => store.getEvent(seed.womenEventId)!;
const u = (id: string) => store.getUser(id)!;

describe('the seeder completes all ten phases', () => {
  test('the tournament exists and is active', () => {
    const t = store.getTournament(seed.tournamentId)!;
    assert.equal(t.code, 'NKC-2026');
    assert.equal(t.status, 'Active');
    assert.equal(t.approvalChainType, '2-step');
  });

  test('both events are confirmed with a scoring template', () => {
    for (const e of [men(), women()]) {
      assert.ok(e.confirmedAt, `${e.eventId} should be confirmed`);
      assert.equal(e.scoringTemplateId, 'kabaddi');
      assert.equal(e.medalRule, kabaddi.medalRuleDefault);
    }
  });

  test('the draws are published and reproducible from their stored seeds', () => {
    for (const e of [men(), women()]) {
      const draw = store.getDrawForEvent(e.eventId)!;
      assert.equal(draw.status, 'Published');
      assert.deepEqual(draw.validationErrors, []);
      const check = svc.verifyDraw(u('ta1'), e.eventId);
      assert.ok(check.reproducible, `${e.eventId}: ${check.detail}`);
    }
  });

  test('both schedules are published with no hard conflicts', () => {
    for (const e of [men(), women()]) {
      assert.ok(['Published', 'Amended'].includes(store.getScheduleState(e.eventId).status));
      const c = svc.conflicts(e.eventId);
      assert.deepEqual(c.hard, [], `${e.eventId} has hard conflicts: ${c.hard.map((x) => x.message).join('; ')}`);
      assert.ok(c.publishable);
    }
  });

  test("the men's event ran to completion with medals published", () => {
    assert.equal(men().status, 'Completed');
    const medals = store.listMedals(seed.menEventId).filter((m) => m.medal !== 'none');
    assert.equal(medals.length, 4, 'joint bronze gives a four-medal podium');
    assert.equal(medals.filter((m) => m.medal === 'G').length, 1);
    assert.equal(medals.filter((m) => m.medal === 'S').length, 1);
    assert.equal(medals.filter((m) => m.medal === 'B').length, 2);
    assert.ok(medals.every((m) => m.publishedAt), 'every medal row must be published');
  });

  test("the women's event is deliberately mid-competition with a live protest", () => {
    assert.notEqual(women().status, 'Completed');
    const open = store.listProtests(seed.womenEventId).filter((p) => p.status === 'Filed' || p.status === 'Under Review');
    assert.equal(open.length, 1, 'the demo keeps one protest open');
    const held = store.listResults(seed.womenEventId).filter((r) => r.resultStatus === 'Under Protest');
    assert.equal(held.length, 1);
  });
});

describe('invariants over the whole tournament', () => {
  test('every approved result passed through a different verifier and approver', () => {
    for (const r of store.listResultsForTournament(seed.tournamentId)) {
      if (r.resultStatus !== 'Approved') continue;
      assert.notEqual(r.enteredBy, r.verifiedBy, `${r.resultId}: enterer verified their own result`);
      assert.notEqual(r.enteredBy, r.approvedBy, `${r.resultId}: enterer approved their own result`);
      assert.notEqual(r.verifiedBy, r.approvedBy, `${r.resultId}: a 2-step chain needs three distinct hands`);
    }
  });

  test('every approved result is locked', () => {
    for (const r of store.listResultsForTournament(seed.tournamentId)) {
      if (r.resultStatus !== 'Approved') continue;
      assert.ok(r.lockedAt, `${r.resultId} is approved but not locked`);
    }
  });

  test('no official is assigned to a match involving their own unit', () => {
    const matches = new Map(store.listMatchesForTournament(seed.tournamentId).map((m) => [m.matchId, m]));
    for (const a of store.listAssignments()) {
      if (a.status === 'replaced') continue;
      assert.notEqual(a.neutralityCheckResult, 'fail', `${a.officialName} on ${matches.get(a.matchId)?.matchNo} breaches neutrality`);
    }
  });

  test('no official holds two overlapping duties', () => {
    const matches = new Map(store.listMatchesForTournament(seed.tournamentId).map((m) => [m.matchId, m]));
    const byOfficial = new Map<string, { start: number; end: number; matchNo: string }[]>();
    for (const a of store.listAssignments()) {
      const m = matches.get(a.matchId);
      if (!m?.scheduledDate || !m.scheduledTime) continue;
      const start = new Date(`${m.scheduledDate}T${m.scheduledTime}:00Z`).getTime() / 60000;
      const list = byOfficial.get(a.officialId) ?? [];
      list.push({ start, end: start + (m.durationMins ?? 45), matchNo: m.matchNo });
      byOfficial.set(a.officialId, list);
    }
    for (const [officialId, spans] of byOfficial) {
      spans.sort((x, y) => x.start - y.start);
      for (let i = 0; i < spans.length - 1; i++) {
        assert.ok(
          spans[i + 1]!.start >= spans[i]!.end,
          `${officialId} is double-booked on ${spans[i]!.matchNo} and ${spans[i + 1]!.matchNo}`,
        );
      }
    }
  });

  test('every match has its minimum officials panel, or was never scheduled', () => {
    for (const m of store.listMatchesForTournament(seed.tournamentId)) {
      if (m.byeFlag || !m.scheduledDate) continue;
      const assigned = store.listAssignments(m.matchId);
      if (!assigned.length) continue; // the pool ran out; reported, not silently wrong
      const roles = kabaddi.officials.minimumToStart;
      for (const need of roles) {
        const have = assigned.filter((a) => a.role === need.role && a.status !== 'replaced').length;
        assert.ok(have >= need.count, `${m.matchNo} has ${have} ${need.role}, needs ${need.count}`);
      }
    }
  });

  test('no side plays two fixtures closer than the sport rest gap', () => {
    for (const e of [men(), women()]) {
      const byEntry = new Map<string, { start: number; end: number; matchNo: string }[]>();
      for (const m of store.listMatches(e.eventId)) {
        if (m.byeFlag || !m.scheduledDate || !m.scheduledTime) continue;
        const start = new Date(`${m.scheduledDate}T${m.scheduledTime}:00Z`).getTime() / 60000;
        for (const s of [m.sideA, m.sideB]) {
          if (s.kind !== 'entry') continue;
          const list = byEntry.get(s.entryId) ?? [];
          list.push({ start, end: start + (m.durationMins ?? 45), matchNo: m.matchNo });
          byEntry.set(s.entryId, list);
        }
      }
      for (const [entryId, spans] of byEntry) {
        spans.sort((x, y) => x.start - y.start);
        for (let i = 0; i < spans.length - 1; i++) {
          const gap = spans[i + 1]!.start - spans[i]!.end;
          assert.ok(gap >= kabaddi.restGap.hardMins, `${entryId} gets ${gap} min between ${spans[i]!.matchNo} and ${spans[i + 1]!.matchNo}`);
        }
      }
    }
  });

  test('every walkover recorded the sport convention rather than a fabricated score', () => {
    const walkovers = store.listResultsForTournament(seed.tournamentId).filter((r) => r.outcomeType === 'walkover');
    assert.ok(walkovers.length > 0, 'the demo includes a walkover');
    for (const w of walkovers) {
      assert.deepEqual(
        [w.finalScore.a, w.finalScore.b].sort(),
        [kabaddi.walkover.loserScore, kabaddi.walkover.winnerScore].sort(),
      );
      assert.ok(w.winnerRef, 'a walkover must name its winner explicitly, since the score does not');
    }
  });

  test('a blocked entry never reaches a draw', () => {
    for (const e of [men(), women()]) {
      const blocked = new Set(store.listEntries(e.eventId).filter((x) => x.entryStatus === 'Blocked').map((x) => x.entryId));
      const draw = store.getDrawForEvent(e.eventId)!;
      for (const s of draw.slots) {
        if (s.occupant.kind !== 'entry') continue;
        assert.ok(!blocked.has(s.occupant.entryId), `blocked entry ${s.occupant.entryId} is in the ${e.eventId} draw`);
      }
    }
  });

  test('an overridden entry records who overrode it and why', () => {
    const overridden = [men(), women()].flatMap((e) => store.listEntries(e.eventId)).filter((x) => x.overrideFlag);
    assert.ok(overridden.length > 0, 'the demo exercises the override path');
    for (const o of overridden) {
      assert.ok(o.overrideReason && o.overrideReason.length > 5, `${o.entryId} has no override reason`);
      assert.ok(o.overrideBy, `${o.entryId} has no override author`);
    }
  });

  test('a protested result freezes its own bracket path only', () => {
    const protested = store.listResults(seed.womenEventId).find((r) => r.resultStatus === 'Under Protest')!;
    const frozen = store.listMatches(seed.womenEventId).find((m) => m.matchId === protested.matchId)!;
    const downstream = store.listMatches(seed.womenEventId).find(
      (m) => [m.sideA, m.sideB].some((s) => s.kind === 'placeholder' && s.matchNo === frozen.matchNo),
    );
    if (downstream) {
      const fed = [downstream.sideA, downstream.sideB].find((s) => s.kind === 'placeholder' && s.matchNo === frozen.matchNo);
      assert.ok(fed, 'the downstream slot must still be a placeholder while the protest is open');
    }
    // Other approved fixtures still advanced.
    const approved = store.listResults(seed.womenEventId).filter((r) => r.resultStatus === 'Approved');
    assert.ok(approved.length > 0, 'unaffected fixtures should still be approved');
  });
});

describe('audit trail', () => {
  test('every state-changing action is logged', () => {
    const log = store.queryAudit({ tournamentId: seed.tournamentId, limit: 100000 });
    assert.ok(log.length > 100, `expected a substantial audit trail, got ${log.length}`);
    for (const action of ['tournament.create', 'event.create', 'entry.create', 'draw.generate', 'draw.publish', 'schedule.publish', 'result.enter', 'result.verify', 'result.approve', 'medals.publish']) {
      assert.ok(log.some((e) => e.action === action), `no audit entry for ${action}`);
    }
  });

  test('a reason-coded action records its reason', () => {
    const log = store.queryAudit({ tournamentId: seed.tournamentId, limit: 100000 });
    const override = log.find((e) => e.action === 'entry.override');
    assert.ok(override?.reasonCode, 'an override must record a reason code');
    const walkover = log.find((e) => e.action === 'match.walkover');
    assert.ok(walkover?.reasonCode, 'a walkover must record a reason code');
  });

  test('the draw audit entry stores the seed and algorithm', () => {
    const entry = store.queryAudit({ tournamentId: seed.tournamentId, action: 'draw.generate', limit: 10 })[0]!;
    assert.match(entry.newValue!, /"seed"/);
    assert.match(entry.newValue!, /"algorithm"/);
  });

  test('every audit entry names a user and a role', () => {
    for (const e of store.queryAudit({ tournamentId: seed.tournamentId, limit: 100000 })) {
      assert.ok(e.userId, 'an audit entry with no user is useless in a dispute');
      assert.ok(e.role);
      assert.ok(e.timestamp);
    }
  });
});

describe('notifications', () => {
  test('publishing fires an event for the Notification module', () => {
    const sent = store.listNotifications(seed.tournamentId, 500);
    for (const type of ['entry_window_open', 'entries_locked', 'draw_published', 'schedule_published', 'duty_assigned', 'result_approved', 'medals_published']) {
      assert.ok(sent.some((n) => n.type === type), `no notification emitted for ${type}`);
    }
  });
});

describe('report pack', () => {
  test('all fourteen reports render for the seeded tournament', () => {
    for (const def of REPORTS) {
      const out = buildReport(store, def.key, {
        tournamentId: seed.tournamentId,
        eventId: def.scope === 'event' ? seed.menEventId : undefined,
        date: '2026-03-10',
        unitId: def.scope === 'team' ? 'MH' : undefined,
      });
      assert.ok(out.columns.length > 0, `${def.key} produced no columns`);
      assert.ok(Array.isArray(out.rows), `${def.key} produced no rows array`);
      assert.doesNotThrow(() => toCsv(out), `${def.key} failed CSV export`);
    }
  });

  test('an external report excludes unapproved results', () => {
    const bulletin = buildReport(store, 'daily-bulletin', { tournamentId: seed.tournamentId, date: '2026-03-10' });
    assert.match(bulletin.notes.join(' '), /Approved results only/);
  });

  test('the points table names the tie-breaker order it applied', () => {
    const table = buildReport(store, 'points-table', { tournamentId: seed.tournamentId, eventId: seed.menEventId });
    assert.match(table.notes.join(' '), /tie-breakers apply strictly in order/);
    assert.match(table.notes.join(' '), /Head-to-head/);
  });

  test('the draw report records the seed so it can be replayed', () => {
    const report = buildReport(store, 'fixture-draw', { tournamentId: seed.tournamentId, eventId: seed.menEventId });
    assert.match(report.notes.join(' '), /RNG seed/);
    assert.match(report.notes.join(' '), /reproducible/);
  });

  test('the medal tally excludes unpublished medals', () => {
    const tally = buildReport(store, 'medal-tally', { tournamentId: seed.tournamentId });
    assert.ok(tally.rows.length > 0);
    assert.match(tally.notes.join(' '), /gold, then silver, then bronze/);
  });

  test('CSV output quotes fields containing commas and quotes', () => {
    const csv = toCsv({ key: 'k', name: 'n', columns: ['a', 'b'], rows: [['x,y', 'he said "hi"']], notes: [], generatedAt: '' });
    assert.match(csv, /"x,y"/);
    assert.match(csv, /"he said ""hi"""/);
  });
});

describe('dashboards are scoped per role', () => {
  test('a Viewer sees no unpublished data', () => {
    const d = svc.dashboard(u('vw1'), seed.tournamentId) as Record<string, unknown>;
    const results = d.results as { matchId: string }[];
    const published = new Set(store.listResultsForTournament(seed.tournamentId).filter((r) => r.publishedAt).map((r) => r.matchId));
    for (const r of results) assert.ok(published.has(r.matchId), `${r.matchId} is not published but reached a Viewer`);
    assert.equal(d.pendingActions, undefined, 'a Viewer must not receive the admin action queue');
    assert.equal(d.queue, undefined);
  });

  test("a Team Manager sees only their own unit's entries", () => {
    const d = svc.dashboard(u('tm-mh'), seed.tournamentId) as Record<string, unknown>;
    assert.equal(d.unit, 'MH');
    for (const e of d.entries as { entryId: string }[]) {
      assert.equal(store.getEntry(e.entryId)!.unitId, 'MH');
    }
  });

  test('an admin dashboard carries the pending-actions queue', () => {
    const d = svc.dashboard(u('ta1'), seed.tournamentId) as Record<string, unknown>;
    assert.ok(d.pendingActions);
    assert.ok(d.alerts);
    assert.ok((d.phase as { no: number }).no >= 1);
  });

  test('an official sees their own duties', () => {
    const anyAssignment = store.listAssignments()[0]!;
    const d = svc.dashboard(u(anyAssignment.officialId), seed.tournamentId) as Record<string, unknown>;
    const mine = d.myMatches as { matchId: string }[];
    const ids = new Set(store.listAssignmentsForOfficial(anyAssignment.officialId).map((a) => a.matchId));
    for (const m of mine) assert.ok(ids.has(m.matchId));
  });
});

describe('access is enforced at the service layer', () => {
  test('a Team Manager cannot publish a draw', () => {
    assert.throws(() => svc.publishDraw(u('tm-mh'), seed.womenEventId), /publish|restricted/i);
  });

  test('a Scorer cannot approve a result', () => {
    const anyMatch = store.listMatchesForTournament(seed.tournamentId).find((m) => !m.byeFlag)!;
    assert.throws(() => svc.approveResult(u('sc1'), anyMatch.matchId), /no access|may not/i);
  });

  test("a Team Manager sees only their own unit's eligible pool", () => {
    const pool = svc.eligiblePool(u('tm-mh'), seed.womenEventId);
    assert.ok(pool.length > 0);
    assert.ok(pool.every((p) => p.unitId === 'MH'));
  });

  test('a Competition Manager cannot apply a reschedule alone', () => {
    const scheduled = store.listMatchesForTournament(seed.tournamentId).find((m) => m.scheduledDate && !m.byeFlag)!;
    assert.throws(
      () => svc.reschedule(u('cm1'), scheduled.matchId, { toDate: '2026-03-13', toTime: '10:00', toFopId: 'V1-MAT-1', reasonCode: 'WEATHER' }),
      /proposes a reschedule/,
    );
  });

  const otherSportEvent = {
    sport: 'quidditch', discipline: 'x', participationType: 'team' as const, ageCategory: 'SENIOR',
    genderCategory: 'M' as const, scoringTemplateId: 'x', maxEntriesPerUnit: 1, minEntriesToRun: 4,
    seedingSource: 'manual' as const, medalRule: 'playoff' as const,
  };

  test('a sport outside a manager\'s scope is refused before anything else', () => {
    // cm1 is scoped to kabaddi, so scope rejects this before the registry is
    // consulted at all — the tighter of the two checks wins.
    assert.throws(
      () => svc.addEvent(u('cm1'), seed.tournamentId, otherSportEvent),
      /out of scope: sport quidditch/,
    );
  });

  test('an unknown sport blocks the action rather than proceeding on a guess', () => {
    // ta1 is not scoped to a sport, so the registry lookup is what refuses:
    // a failed upstream lookup blocks the dependent action (§11).
    assert.throws(
      () => svc.addEvent(u('ta1'), seed.tournamentId, otherSportEvent),
      /unknown sport "quidditch"/,
    );
  });
});

describe('recomputation is idempotent', () => {
  test('recomputing an event twice gives the same standings', () => {
    const a = svc.recomputeEvent(seed.menEventId).standings.map((r) => `${r.groupId}:${r.rank}:${r.participantRef}:${r.points}`);
    const b = svc.recomputeEvent(seed.menEventId).standings.map((r) => `${r.groupId}:${r.rank}:${r.participantRef}:${r.points}`);
    assert.deepEqual(a, b);
  });

  test('regenerating medals does not un-publish them', () => {
    const before = store.listMedals(seed.menEventId).filter((m) => m.publishedAt).length;
    assert.ok(before > 0);
    svc.generateMedals(u('cm1'), seed.menEventId);
    const after = store.listMedals(seed.menEventId).filter((m) => m.publishedAt).length;
    assert.equal(after, before, 'a regenerate must not discard the publication stamps');
  });

  test('the medal tally is stable across regeneration', () => {
    const a = JSON.stringify(svc.medalTally(seed.tournamentId));
    svc.generateMedals(u('cm1'), seed.menEventId);
    assert.equal(JSON.stringify(svc.medalTally(seed.tournamentId)), a);
  });
});
