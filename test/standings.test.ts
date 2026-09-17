/**
 * Standings, tie-breakers, progression and medals — §5.7, §8.5 and §9.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeStandings, conductDrawOfLots } from '../src/engines/standings.ts';
import { downstreamImpact, propagate, progressionStatus } from '../src/engines/progression.ts';
import { generateRankings, medalTally, reallocateAfterDisqualification, verifyMedals, approveAndPublishMedals } from '../src/engines/medals.ts';
import { kabaddi } from '../src/sports/index.ts';
import { entries, entryMeta, event, format, match, result } from './helpers.ts';

const units = ['MH', 'HR', 'PB', 'UP'];
const list = entries(units);
const meta = entryMeta(list);
const id = (u: string) => list.find((e) => e.unitId === u)!.entryId;

/** The full six-fixture slate for a four-side group. */
const FULL_SLATE: [string, string][] = [
  ['MH', 'HR'], ['PB', 'UP'], ['MH', 'PB'], ['HR', 'UP'], ['MH', 'UP'], ['HR', 'PB'],
];

/**
 * Every fixture in the group exists, but only the first `playedCount` have an
 * approved result. That is the real shape of a group mid-competition, and it is
 * what the qualification flag has to reason about: the engine derives group
 * membership from the fixtures, so a partial slate would look like a smaller,
 * already-decided group.
 */
function partialGroup(playedCount: number) {
  const matches = FULL_SLATE.map(([a, b], i) =>
    match({
      matchId: `MCH-${i + 1}`, matchNo: `M0${i + 1}`, stage: 'group', groupId: 'G1',
      sideA: { kind: 'entry', entryId: id(a), displayName: `${a} Kabaddi` },
      sideB: { kind: 'entry', entryId: id(b), displayName: `${b} Kabaddi` },
    }),
  );
  const results = FULL_SLATE.slice(0, playedCount).map(([a], i) =>
    result({ resultId: `RES-${i + 1}`, matchId: `MCH-${i + 1}`, finalScore: { a: 30, b: 20 }, winnerRef: id(a) }),
  );
  return { matches, results };
}

/** Build a group of league fixtures with the given scorelines. */
function league(scores: [string, string, number, number][]) {
  const matches = scores.map(([a, b], i) =>
    match({
      matchId: `MCH-${i + 1}`, matchNo: `M0${i + 1}`, stage: 'group', groupId: 'G1',
      sideA: { kind: 'entry', entryId: id(a), displayName: `${a} Kabaddi` },
      sideB: { kind: 'entry', entryId: id(b), displayName: `${b} Kabaddi` },
    }),
  );
  const results = scores.map(([a, b, sa, sb], i) =>
    result({
      resultId: `RES-${i + 1}`, matchId: `MCH-${i + 1}`,
      finalScore: { a: sa, b: sb },
      winnerRef: sa > sb ? id(a) : sb > sa ? id(b) : undefined,
    }),
  );
  return { matches, results };
}

const fmt = format({
  type: 'league-single',
  progressionRules: [{ fromGroupId: '*', positions: [1, 2], toStage: 'SF', seedApart: true }],
});

function standings(scores: [string, string, number, number][], over = {}) {
  const { matches, results } = league(scores);
  return computeStandings({ eventId: 'EVT-T', sportId: 'kabaddi', format: fmt, matches, results, entryMeta: meta, ...over });
}

describe('points table', () => {
  test('Kabaddi league points are 2 for a win, 1 for a tie, 0 for a loss', () => {
    const rows = standings([
      ['MH', 'HR', 30, 20], // MH win
      ['PB', 'UP', 25, 25], // tie
      ['MH', 'PB', 28, 30], // PB win
      ['HR', 'UP', 22, 22], // tie
      ['MH', 'UP', 31, 20], // MH win
      ['HR', 'PB', 18, 24], // PB win
    ]);
    const byUnit = Object.fromEntries(rows.map((r) => [r.unitId, r]));
    assert.equal(byUnit.MH!.points, 4, '2 wins');
    assert.equal(byUnit.PB!.points, 5, '2 wins and a tie');
    assert.equal(byUnit.HR!.points, 1, 'one tie');
    assert.equal(byUnit.UP!.points, 2, 'two ties');
  });

  test('the standings metric is score difference', () => {
    const rows = standings([['MH', 'HR', 30, 20]]);
    const mh = rows.find((r) => r.unitId === 'MH')!;
    assert.equal(mh.sportMetric, 10);
    assert.equal(mh.sportMetricLabel, kabaddi.sportMetric.label);
  });

  test('only Approved results count', () => {
    const { matches, results } = league([['MH', 'HR', 30, 20]]);
    const rows = computeStandings({
      eventId: 'EVT-T', sportId: 'kabaddi', format: fmt, matches,
      results: results.map((r) => ({ ...r, resultStatus: 'Verified' as const })),
      entryMeta: meta,
    });
    assert.ok(rows.every((r) => r.played === 0), 'an unapproved result must not enter the table');
  });

  test('a walkover counts as a win with the sport score, so score difference is not distorted', () => {
    const { matches } = league([['MH', 'HR', 0, 0]]);
    const results = [result({ resultId: 'RES-1', matchId: 'MCH-1', finalScore: { a: 0, b: 0 }, winnerRef: id('MH'), outcomeType: 'walkover' })];
    const rows = computeStandings({ eventId: 'EVT-T', sportId: 'kabaddi', format: fmt, matches, results, entryMeta: meta });
    const mh = rows.find((r) => r.unitId === 'MH')!;
    const hr = rows.find((r) => r.unitId === 'HR')!;
    assert.equal(mh.won, 1);
    assert.equal(mh.points, kabaddi.matchDefaults.pointsWin, 'standard win points are still awarded');
    assert.equal(mh.sportMetric, 0, 'no fabricated score difference');
    assert.equal(hr.lost, 1);
  });

  test('a bye is excluded, so it cannot give a free win', () => {
    const byeMatch = match({ matchId: 'MCH-B', matchNo: 'M99', stage: 'group', groupId: 'G1', byeFlag: true, sideB: { kind: 'bye', displayName: 'BYE' } });
    const { matches, results } = league([['MH', 'HR', 30, 20]]);
    const rows = computeStandings({ eventId: 'EVT-T', sportId: 'kabaddi', format: fmt, matches: [...matches, byeMatch], results, entryMeta: meta });
    assert.ok(rows.every((r) => r.played <= 1));
  });

  test('a losing bonus is only awarded when the preset configures one', () => {
    const franchise = format({ type: 'league-single', matchParams: { ...kabaddi.matchDefaults, ...kabaddi.presets['franchise-league'] } });
    const { matches, results } = league([['MH', 'HR', 30, 25]]); // 5-point margin
    const rows = computeStandings({ eventId: 'EVT-T', sportId: 'kabaddi', format: franchise, matches, results, entryMeta: meta });
    const hr = rows.find((r) => r.unitId === 'HR')!;
    assert.equal(hr.bonusPoints, 1, 'losing by 5 is within the 7-point bonus margin');
    assert.equal(hr.points, 1);

    const plain = standings([['MH', 'HR', 30, 25]]);
    assert.equal(plain.find((r) => r.unitId === 'HR')!.bonusPoints, 0, 'the federation preset has no losing bonus');
  });
});

describe('tie-breakers', () => {
  test('head-to-head is applied before score difference', () => {
    // MH and HR both finish on 4 points. MH has a far better score difference
    // (+55 against +2) but lost the head-to-head. Head-to-head sits above
    // score difference in the hierarchy, so HR must finish first — which is
    // exactly what a hierarchy applied out of order would get wrong.
    const rows = standings([
      ['MH', 'HR', 20, 25], // HR beat MH head-to-head
      ['MH', 'PB', 40, 10], // MH wins big
      ['MH', 'UP', 40, 10], // MH wins big
      ['HR', 'PB', 22, 20], // HR wins narrowly
      ['HR', 'UP', 20, 25], // HR loses
      ['PB', 'UP', 30, 20], // PB wins
    ]);
    const mh = rows.find((r) => r.unitId === 'MH')!;
    const hr = rows.find((r) => r.unitId === 'HR')!;
    assert.equal(mh.points, hr.points, 'the scenario needs them level on points');
    assert.ok(mh.sportMetric > hr.sportMetric, 'MH must have the better score difference');
    assert.ok(hr.rank < mh.rank, 'the head-to-head winner must rank above despite the worse difference');
    assert.match(hr.tiebreakNotes.concat(mh.tiebreakNotes).join(' '), /Head-to-head/);
  });

  test('score difference separates sides level on points with a drawn head-to-head', () => {
    // PB and UP each take 2 points; PB beat UP, so PB leads on head-to-head.
    const rows = standings([
      ['MH', 'HR', 20, 25],
      ['MH', 'PB', 40, 10],
      ['MH', 'UP', 40, 10],
      ['HR', 'PB', 22, 20],
      ['HR', 'UP', 20, 25],
      ['PB', 'UP', 30, 20],
    ]);
    const pb = rows.find((r) => r.unitId === 'PB')!;
    const up = rows.find((r) => r.unitId === 'UP')!;
    assert.equal(pb.points, up.points);
    assert.ok(pb.rank < up.rank);
  });

  test('the rung that separated a row is recorded', () => {
    const rows = standings([
      ['MH', 'HR', 30, 10],
      ['PB', 'UP', 30, 10],
      ['MH', 'PB', 20, 20],
      ['HR', 'UP', 20, 20],
      ['MH', 'UP', 30, 10],
      ['HR', 'PB', 10, 30],
    ]);
    // Any row not decided on points alone must say what decided it.
    for (const r of rows) {
      const samePoints = rows.filter((x) => x.points === r.points);
      if (samePoints.length > 1) {
        assert.ok(r.tiebreakNotes.length > 0, `${r.unitId} is level on points but has no tie-break note`);
      }
    }
  });

  test('a tie that survives every rung demands a recorded draw of lots', () => {
    // PB and UP are constructed identical on every rung: same points, the same
    // result against each common opponent, an identical head-to-head, and the
    // same points for and against.
    const rows = standings([
      ['MH', 'HR', 20, 25],
      ['MH', 'PB', 30, 20],
      ['MH', 'UP', 30, 20],
      ['HR', 'PB', 30, 20],
      ['HR', 'UP', 30, 20],
      ['PB', 'UP', 25, 25],
    ]);
    const pb = rows.find((r) => r.unitId === 'PB')!;
    const up = rows.find((r) => r.unitId === 'UP')!;
    assert.equal(pb.points, up.points);
    assert.equal(pb.sportMetric, up.sportMetric);
    const notes = pb.tiebreakNotes.concat(up.tiebreakNotes).join(' ');
    assert.match(notes, /every tie-breaker exhausted/, 'the row must say the hierarchy ran out');
    assert.match(notes, /draw of lots must be conducted and recorded/);
  });

  test('a draw of lots is reproducible and demands witnesses', () => {
    const a = conductDrawOfLots(['E1', 'E2', 'E3'], 'lots-2026', ['to1', 'ju1']);
    const b = conductDrawOfLots(['E1', 'E2', 'E3'], 'lots-2026', ['to1', 'ju1']);
    assert.deepEqual(a.order, b.order, 'the same seed must give the same order');
    assert.throws(() => conductDrawOfLots(['E1', 'E2'], 's', ['to1']), /at least two witnesses/);
  });

  test('the hierarchy is applied in the configured order', () => {
    const keys = kabaddi.tieBreakers.map((t) => t.key);
    assert.equal(keys[0], 'points', 'points must be the first rung');
    assert.equal(keys[1], 'headToHead');
    assert.equal(keys.at(-1), 'drawOfLots', 'a draw of lots must be the last resort');
  });
});

describe('qualification marking', () => {
  test('no flag is shown while fixtures in the group remain unplayed', () => {
    const { matches, results } = partialGroup(3);
    const rows = computeStandings({ eventId: 'EVT-T', sportId: 'kabaddi', format: fmt, matches, results, entryMeta: meta });
    assert.equal(rows.length, 4, 'group membership comes from the fixtures, so all four sides appear');
    assert.ok(
      rows.every((r) => r.qualificationFlag === ''),
      'a side must not be shown a Q it could still lose, nor an E it could still escape',
    );
  });

  test('the top two are flagged Q once every fixture has been played', () => {
    const { matches, results } = partialGroup(6);
    const rows = computeStandings({ eventId: 'EVT-T', sportId: 'kabaddi', format: fmt, matches, results, entryMeta: meta });
    assert.ok(rows.every((r) => r.qualificationFlag !== ''), 'a completed group must be flagged');
    assert.equal(rows.filter((r) => r.qualificationFlag === 'Q').length, 2, 'top two advance');
    assert.equal(rows.filter((r) => r.qualificationFlag === 'E').length, 2);
  });
});

describe('progression', () => {
  const ent = (entryId: string, displayName: string) => ({ kind: 'entry' as const, entryId, displayName });
  const sf1 = match({ matchId: 'K1', matchNo: 'M20', stage: 'SF', roundNo: 101, sideA: ent('E1', 'MH'), sideB: ent('E2', 'HR'), progression: { winnerTo: { matchNo: 'M22', side: 'A' } }, matchStatus: 'Completed (Provisional)' });
  const sf2 = match({ matchId: 'K2', matchNo: 'M21', stage: 'SF', roundNo: 101, sideA: ent('E3', 'PB'), sideB: ent('E4', 'UP'), progression: { winnerTo: { matchNo: 'M22', side: 'B' } }, matchStatus: 'Completed (Provisional)' });
  const fin = match({ matchId: 'K3', matchNo: 'M22', stage: 'F', roundNo: 102, sideA: { kind: 'placeholder', source: 'winner', matchNo: 'M20', displayName: 'Winner of M20' }, sideB: { kind: 'placeholder', source: 'winner', matchNo: 'M21', displayName: 'Winner of M21' }, matchStatus: 'Scheduled' });

  test('an approved winner fills the next-round slot', () => {
    const out = propagate({
      matches: [sf1, sf2, fin],
      results: [
        result({ resultId: 'r1', matchId: 'K1', finalScore: { a: 30, b: 25 }, winnerRef: 'E1' }),
        result({ resultId: 'r2', matchId: 'K2', finalScore: { a: 20, b: 30 }, winnerRef: 'E4' }),
      ],
    });
    const f = out.matches.find((m) => m.matchNo === 'M22')!;
    assert.equal((f.sideA as { entryId: string }).entryId, 'E1');
    assert.equal((f.sideB as { entryId: string }).entryId, 'E4');
    assert.equal(out.blocked.length, 0);
  });

  test('a protest freezes only its own bracket path', () => {
    const out = propagate({
      matches: [sf1, sf2, fin],
      results: [
        result({ resultId: 'r1', matchId: 'K1', winnerRef: 'E1', resultStatus: 'Under Protest' }),
        result({ resultId: 'r2', matchId: 'K2', finalScore: { a: 20, b: 30 }, winnerRef: 'E4' }),
      ],
    });
    const f = out.matches.find((m) => m.matchNo === 'M22')!;
    assert.equal(f.sideA.kind, 'placeholder', 'the protested path must stay frozen');
    assert.equal((f.sideB as { entryId: string }).entryId, 'E4', 'the unaffected path must still advance');
    assert.equal(out.blocked.length, 1, 'the blocker should be reported exactly once');
    assert.match(out.blocked[0]!.reason, /Under Protest/);
  });

  test('a bye advances its occupant without a result', () => {
    const bye = match({ matchId: 'B1', matchNo: 'M01', byeFlag: true, sideA: ent('E9', 'KA'), sideB: { kind: 'bye', displayName: 'BYE' }, progression: { winnerTo: { matchNo: 'M09', side: 'A' } }, matchStatus: 'Scheduled' });
    const next = match({ matchId: 'B2', matchNo: 'M09', stage: 'QF', roundNo: 2, sideA: { kind: 'placeholder', source: 'winner', matchNo: 'M01', displayName: 'Winner of M01' }, sideB: ent('E8', 'DL'), matchStatus: 'Scheduled' });
    const out = propagate({ matches: [bye, next], results: [] });
    assert.equal((out.matches.find((m) => m.matchNo === 'M09')!.sideA as { entryId: string }).entryId, 'E9');
  });

  test('a group-standing placeholder only resolves once the group is decided', () => {
    const sf = match({
      matchId: 'S1', matchNo: 'M30', stage: 'SF', roundNo: 101, matchStatus: 'Scheduled',
      sideA: { kind: 'placeholder-standing', groupId: 'G1', position: 1, displayName: 'G1 #1' },
      sideB: { kind: 'placeholder-standing', groupId: 'G1', position: 2, displayName: 'G1 #2' },
    });
    const partial = partialGroup(3);
    const undecided = computeStandings({ eventId: 'EVT-T', sportId: 'kabaddi', format: fmt, matches: partial.matches, results: partial.results, entryMeta: meta });
    const a = propagate({ matches: [sf], results: [], standings: undecided, entryMeta: meta });
    assert.equal(a.matches[0]!.sideA.kind, 'placeholder-standing');
    assert.match(a.blocked[0]!.reason, /not decided yet/);

    const full = partialGroup(6);
    const decided = computeStandings({ eventId: 'EVT-T', sportId: 'kabaddi', format: fmt, matches: full.matches, results: full.results, entryMeta: meta });
    const b = propagate({ matches: [sf], results: [], standings: decided, entryMeta: meta });
    assert.equal(b.matches[0]!.sideA.kind, 'entry');
    assert.equal(b.matches[0]!.sideB.kind, 'entry');
  });

  test('downstream impact walks the whole progression graph', () => {
    const impacted = downstreamImpact([sf1, sf2, fin], 'M20');
    assert.deepEqual(impacted.map((i) => i.matchNo), ['M22']);
    assert.equal(downstreamImpact([sf1, sf2, fin], 'M22').length, 0, 'the final has no downstream');
  });

  test('progression status reports what each pending slot waits on', () => {
    const s = progressionStatus({ matches: [sf1, sf2, fin], results: [] });
    assert.equal(s.total, 2);
    assert.equal(s.resolved, 0);
    assert.deepEqual(s.pending.map((p) => p.waitingOn).sort(), ['M20', 'M21']);
  });
});

describe('medals', () => {
  const ent = (entryId: string, displayName: string) => ({ kind: 'entry' as const, entryId, displayName });
  const build = () => {
    const sf1 = match({ matchId: 'K1', matchNo: 'M20', stage: 'SF', roundNo: 101, sideA: ent(id('MH'), 'MH Kabaddi'), sideB: ent(id('HR'), 'HR Kabaddi'), progression: { winnerTo: { matchNo: 'M22', side: 'A' } } });
    const sf2 = match({ matchId: 'K2', matchNo: 'M21', stage: 'SF', roundNo: 101, sideA: ent(id('PB'), 'PB Kabaddi'), sideB: ent(id('UP'), 'UP Kabaddi'), progression: { winnerTo: { matchNo: 'M22', side: 'B' } } });
    const fin = match({ matchId: 'K3', matchNo: 'M22', stage: 'F', roundNo: 102, sideA: { kind: 'placeholder', source: 'winner', matchNo: 'M20', displayName: 'W20' }, sideB: { kind: 'placeholder', source: 'winner', matchNo: 'M21', displayName: 'W21' } });
    const results = [
      result({ resultId: 'r1', matchId: 'K1', finalScore: { a: 30, b: 25 }, winnerRef: id('MH') }),
      result({ resultId: 'r2', matchId: 'K2', finalScore: { a: 30, b: 20 }, winnerRef: id('PB') }),
      result({ resultId: 'r3', matchId: 'K3', finalScore: { a: 33, b: 30 }, winnerRef: id('MH') }),
    ];
    return { matches: [sf1, sf2, fin], results };
  };

  test('joint bronze awards two bronzes to the losing semi-finalists', () => {
    const { matches, results } = build();
    const rows = generateRankings({ event: event({ medalRule: 'joint-bronze' }), matches, results, entryMeta: meta });
    const medals = rows.filter((r) => r.medal !== 'none');
    assert.equal(medals.filter((r) => r.medal === 'G').length, 1);
    assert.equal(medals.filter((r) => r.medal === 'S').length, 1);
    const bronze = medals.filter((r) => r.medal === 'B');
    assert.equal(bronze.length, 2);
    assert.ok(bronze.every((r) => r.jointFlag));
    assert.equal(rows.find((r) => r.medal === 'G')!.unitId, 'MH');
    assert.equal(rows.find((r) => r.medal === 'S')!.unitId, 'PB');
  });

  test('rankings resolve bracket placeholders first, so the silver is not lost', () => {
    // The final's sides are placeholders until propagation runs.
    const { matches, results } = build();
    const rows = generateRankings({ event: event(), matches, results, entryMeta: meta });
    assert.ok(rows.some((r) => r.medal === 'S'), 'the silver medallist must be derived');
  });

  test('an unapproved result blocks publication', () => {
    const { matches, results } = build();
    const v = verifyMedals({ event: event(), matches, results: results.map((r, i) => (i === 2 ? { ...r, resultStatus: 'Verified' as const } : r)), entryMeta: meta });
    assert.equal(v.ok, false);
    assert.match(v.blockers.join(' '), /not Approved/);
  });

  test('an open protest blocks publication', () => {
    const { matches, results } = build();
    const v = verifyMedals({ event: event(), matches, results, entryMeta: meta }, ['K1']);
    assert.equal(v.ok, false);
    assert.match(v.blockers.join(' '), /open protest/);
  });

  test('an integrity flag on a medallist blocks publication', () => {
    const { matches, results } = build();
    const v = verifyMedals({ event: event(), matches, results, entryMeta: meta, integrityFlags: { [id('MH')]: 'doping sample B pending' } });
    assert.equal(v.ok, false);
    assert.match(v.blockers.join(' '), /doping sample B pending/);
  });

  test('a complete, clean event passes verification', () => {
    const { matches, results } = build();
    const v = verifyMedals({ event: event(), matches, results, entryMeta: meta });
    assert.ok(v.ok, v.blockers.join('; '));
  });

  test('medal approval enforces maker–checker against the verifier', () => {
    const { matches, results } = build();
    const v = verifyMedals({ event: event(), matches, results, entryMeta: meta });
    const same = approveAndPublishMedals(v.rows, 'to1', 'to1');
    assert.match(same.error!, /maker–checker/);
    const ok = approveAndPublishMedals(v.rows, 'to1', 'ta1');
    assert.equal(ok.error, undefined);
    assert.ok(ok.rows.every((r) => r.publishedAt));
  });

  test('the tally ranks by gold, then silver, then bronze, and shares a rank on a level count', () => {
    const rows = [
      { eventId: 'E', position: 1, participantRef: 'a', participantName: 'A', unitId: 'MH', medal: 'G' as const, jointFlag: false },
      { eventId: 'E', position: 2, participantRef: 'b', participantName: 'B', unitId: 'HR', medal: 'S' as const, jointFlag: false },
      { eventId: 'E', position: 3, participantRef: 'c', participantName: 'C', unitId: 'PB', medal: 'B' as const, jointFlag: true },
      { eventId: 'E', position: 3, participantRef: 'd', participantName: 'D', unitId: 'UP', medal: 'B' as const, jointFlag: true },
    ];
    const t = medalTally(rows);
    assert.equal(t[0]!.unitId, 'MH');
    assert.equal(t[0]!.rank, 1);
    assert.equal(t[1]!.unitId, 'HR');
    // PB and UP are level on one bronze each, so they share rank 3.
    assert.equal(t[2]!.rank, 3);
    assert.equal(t[3]!.rank, 3);
  });

  test('a disqualification cascade preserves a joint tie and demands a ruling', () => {
    const rows = [
      { eventId: 'E', position: 1, participantRef: 'a', participantName: 'A', unitId: 'MH', medal: 'G' as const, jointFlag: false },
      { eventId: 'E', position: 2, participantRef: 'b', participantName: 'B', unitId: 'HR', medal: 'S' as const, jointFlag: false },
      { eventId: 'E', position: 3, participantRef: 'c', participantName: 'C', unitId: 'PB', medal: 'B' as const, jointFlag: true },
      { eventId: 'E', position: 3, participantRef: 'd', participantName: 'D', unitId: 'UP', medal: 'B' as const, jointFlag: true },
    ];
    const out = reallocateAfterDisqualification(rows, 'a', 'DQ: ineligible player');
    assert.equal(out.rows.find((r) => r.participantRef === 'b')!.medal, 'G', 'the silver moves up to gold');
    const promoted = out.rows.filter((r) => r.participantRef === 'c' || r.participantRef === 'd');
    assert.ok(promoted.every((r) => r.position === 2), 'the joint pair must move up together');
    assert.ok(out.decisionRequired, 'two sides level on a silver needs an explicit ruling');
    assert.match(out.decisionRequired!, /Jury of Appeal or Tournament Admin must rule/);
    assert.ok(out.rows.every((r) => !r.publishedAt), 'a reallocated podium must be unpublished');
  });

  test('disqualifying a joint bronze needs no ruling, because no tie is created above bronze', () => {
    const rows = [
      { eventId: 'E', position: 1, participantRef: 'a', participantName: 'A', unitId: 'MH', medal: 'G' as const, jointFlag: false },
      { eventId: 'E', position: 2, participantRef: 'b', participantName: 'B', unitId: 'HR', medal: 'S' as const, jointFlag: false },
      { eventId: 'E', position: 3, participantRef: 'c', participantName: 'C', unitId: 'PB', medal: 'B' as const, jointFlag: true },
      { eventId: 'E', position: 3, participantRef: 'd', participantName: 'D', unitId: 'UP', medal: 'B' as const, jointFlag: true },
    ];
    const out = reallocateAfterDisqualification(rows, 'c', 'DQ: doping');
    assert.equal(out.decisionRequired, undefined);
    assert.equal(out.rows.find((r) => r.participantRef === 'a')!.medal, 'G');
    assert.equal(out.rows.find((r) => r.participantRef === 'd')!.medal, 'B');
  });
});
