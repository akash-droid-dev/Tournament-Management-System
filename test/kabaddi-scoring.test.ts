/**
 * Kabaddi scoring rules — the sport template's state machine.
 *
 * These are the rules a federation would dispute, so each test names the rule
 * it protects rather than just the function it calls.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { KABADDI_EVENTS, kabaddi, type KabaddiState, type ScoreEventInput } from '../src/sports/index.ts';

const P = kabaddi.matchDefaults;
const eng = kabaddi.scoring;

/** Apply a sequence of events, asserting each is legal. */
function play(events: { type: string; side: 'A' | 'B'; value?: number; detail?: Record<string, string | number | boolean> }[]): KabaddiState {
  let s = eng.initialState(P);
  let clock = 0;
  for (const ev of events) {
    clock += 30;
    const input = { ...ev, clockSecs: clock };
    const v = eng.validate(s, input);
    assert.ok(v.legal, `expected "${ev.type}" for ${ev.side} to be legal, got: ${v.issues.map((i) => i.message).join('; ')}`);
    s = eng.apply(s, input).state;
  }
  return s;
}

describe('Kabaddi scoring', () => {
  test('starts seven a side with the score level', () => {
    const s = eng.initialState(P);
    assert.equal(s.A.onCourt, 7);
    assert.equal(s.B.onCourt, 7);
    assert.equal(s.A.score, 0);
    assert.equal(s.raidingSide, 'A');
    assert.equal(s.doOrDie, false);
  });

  test('a raid touch scores one point per defender and puts them out', () => {
    const s = play([{ type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 2 }]);
    assert.equal(s.A.score, 2);
    assert.equal(s.B.onCourt, 5, 'two defenders should be off the mat');
    assert.equal(s.raidingSide, 'B', 'the raid should alternate');
  });

  test('the raid alternates every raid', () => {
    const s = play([
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A' },
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'B' },
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A' },
    ]);
    assert.equal(s.raidingSide, 'B');
    assert.equal(s.raidNo, 4);
  });

  test('an all-out awards two points and returns the full complement to the mat', () => {
    const s = play([
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 3 },
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'B' },
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 4 },
    ]);
    // 3 + 4 touch points, plus 2 for the all-out.
    assert.equal(s.A.score, 9);
    assert.equal(s.A.stats.allOuts, 1);
    assert.equal(s.B.onCourt, 7, 'the all-out side brings everyone back on');
  });

  test('a bonus needs six or more defenders on the mat', () => {
    let s = play([{ type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 4 }]);
    // B now has 3 on the mat and is raiding; A is defending with 7, so a
    // bonus is available to B.
    assert.ok(eng.validate(s, { type: KABADDI_EVENTS.RAID_BONUS, side: 'B', clockSecs: 100 }).legal);
    // Hand the raid back to A, who faces B's depleted defence.
    s = eng.apply(s, { type: KABADDI_EVENTS.RAID_EMPTY, side: 'B', clockSecs: 110 }).state;
    const v = eng.validate(s, { type: KABADDI_EVENTS.RAID_BONUS, side: 'A', clockSecs: 120 });
    assert.equal(v.legal, false);
    assert.match(v.issues[0]!.message, /bonus needs 6\+ defenders/);
  });

  test('a bonus point does not revive an out player', () => {
    // A loses a raider to a tackle, then takes a bonus on its next raid.
    let s = play([
      { type: KABADDI_EVENTS.TACKLE, side: 'B' },
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'B' },
    ]);
    assert.equal(s.A.onCourt, 6, 'A should be a player down');
    const before = s.A.onCourt;
    s = eng.apply(s, { type: KABADDI_EVENTS.RAID_BONUS, side: 'A', clockSecs: 200 }).state;
    assert.equal(s.A.score, 1);
    assert.equal(s.A.onCourt, before, 'a bonus point must not bring a player back on');
  });

  test('a touch point does revive, in the order players went out', () => {
    let s = play([
      { type: KABADDI_EVENTS.TACKLE, side: 'B' },
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'B' },
    ]);
    assert.equal(s.A.onCourt, 6);
    s = eng.apply(s, { type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 1, clockSecs: 200 }).state;
    assert.equal(s.A.onCourt, 7, 'the touch point should revive the out player');
    assert.equal(s.A.outQueue.length, 0);
  });

  test('a tackle by three or fewer defenders is upgraded to a super tackle', () => {
    let s = play([{ type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 4 }]);
    // B is on 3 and now raiding; hand the raid back so B defends on 3.
    s = eng.apply(s, { type: KABADDI_EVENTS.RAID_EMPTY, side: 'B', clockSecs: 100 }).state;
    assert.equal(s.B.onCourt, 3);
    const out = eng.apply(s, { type: KABADDI_EVENTS.TACKLE, side: 'B', clockSecs: 110 });
    assert.equal(out.state.B.score, 2, 'a super tackle is worth two');
    assert.equal(out.state.B.stats.superTackles, 1);
    assert.ok(out.derived.some((d) => d.type === KABADDI_EVENTS.SUPER_TACKLE), 'the upgrade should be recorded as a derived event');
  });

  test('a super tackle entered directly is refused when the defence is not short', () => {
    const s = eng.initialState(P);
    const v = eng.validate(s, { type: KABADDI_EVENTS.SUPER_TACKLE, side: 'B', clockSecs: 10 });
    assert.equal(v.legal, false);
    assert.match(v.issues[0]!.message, /super tackle needs 3 or fewer/);
  });

  test('the third consecutive empty raid is do-or-die, and failing it concedes a point', () => {
    // A empties twice, so A's third raid is do-or-die.
    let s = play([
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A' },
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 1 },
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A' },
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 1 },
    ]);
    assert.equal(s.raidingSide, 'A');
    assert.equal(s.doOrDie, true, "A's third consecutive empty raid must be do-or-die");
    const before = s.B.score;
    const out = eng.apply(s, { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A', clockSecs: 500 });
    assert.equal(out.state.B.score, before + 1, 'the defence takes the point');
    assert.ok(out.derived.some((d) => d.type === KABADDI_EVENTS.DO_OR_DIE_FAIL));
  });

  test('a do-or-die raid resets the sequence either way, so a side cannot be stuck in it', () => {
    let s = play([
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A' },
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 1 },
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A' },
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 1 },
    ]);
    assert.equal(s.doOrDie, true);
    s = eng.apply(s, { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A', clockSecs: 500 }).state; // fails
    s = eng.apply(s, { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 1, clockSecs: 530 }).state;
    assert.equal(s.raidingSide, 'A');
    assert.equal(s.doOrDie, false, 'the counter must restart after a do-or-die resolves');
  });

  test('a tackle is not an empty raid, so it resets the do-or-die counter', () => {
    const s = play([
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A' },
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 1 },
      { type: KABADDI_EVENTS.TACKLE, side: 'B' }, // A raids, B tackles
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 1 },
    ]);
    assert.equal(s.raidingSide, 'A');
    assert.equal(s.doOrDie, false, 'the defence scored, so that raid was not empty');
  });

  test('a touch cannot put out more defenders than are on the mat', () => {
    const s = play([{ type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 5 }]);
    // B now has 2 and is raiding; hand the raid back so A faces 2 defenders.
    const s2 = eng.apply(s, { type: KABADDI_EVENTS.RAID_EMPTY, side: 'B', clockSecs: 100 }).state;
    const v = eng.validate(s2, { type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 3, clockSecs: 110 });
    assert.equal(v.legal, false);
    assert.match(v.issues.map((i) => i.message).join(' '), /cannot touch 3 defenders/);
  });

  test('a raid point cannot be credited to the defending side', () => {
    const s = eng.initialState(P);
    const v = eng.validate(s, { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 1, clockSecs: 10 });
    assert.equal(v.legal, false);
    assert.match(v.issues[0]!.message, /A is raiding/);
  });

  test('derived events cannot be entered by hand', () => {
    const s = eng.initialState(P);
    for (const type of [KABADDI_EVENTS.ALL_OUT, KABADDI_EVENTS.REVIVE, KABADDI_EVENTS.DO_OR_DIE_FAIL]) {
      const v = eng.validate(s, { type, side: 'A', value: 2, clockSecs: 10 });
      assert.equal(v.legal, false, `${type} should be refused`);
      assert.match(v.issues[0]!.message, /derived by the rules engine/);
    }
  });

  test('the clock cannot move backwards', () => {
    const s = eng.apply(eng.initialState(P), { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A', clockSecs: 600 }).state;
    const v = eng.validate(s, { type: KABADDI_EVENTS.RAID_EMPTY, side: 'B', clockSecs: 300 });
    assert.equal(v.legal, false);
    assert.match(v.issues[0]!.message, /backwards/);
  });

  test('a yellow card puts the player out and suspends them for two minutes', () => {
    const out = eng.apply(eng.initialState(P), {
      type: KABADDI_EVENTS.CARD_YELLOW, side: 'A', participantId: 'ATH-1', clockSecs: 60,
    });
    assert.equal(out.state.A.onCourt, 6);
    assert.equal(out.state.A.cards.yellow, 1);
    assert.equal(out.state.A.suspensions[0]!.untilClockSecs, 60 + 120);
  });

  test('replaying the stored event log reproduces the same state', () => {
    let s = eng.initialState(P);
    const stored: Parameters<typeof eng.replay>[1] = [];
    let seq = 0;
    let clock = 0;
    const inputs: Omit<ScoreEventInput, 'clockSecs'>[] = [
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'A', value: 2 },
      { type: KABADDI_EVENTS.TACKLE, side: 'A' },
      { type: KABADDI_EVENTS.RAID_BONUS, side: 'B' },
      { type: KABADDI_EVENTS.RAID_EMPTY, side: 'A' },
      { type: KABADDI_EVENTS.RAID_TOUCH, side: 'B', value: 3 },
    ];
    for (const i of inputs) {
      clock += 40;
      const input: ScoreEventInput = { ...i, clockSecs: clock };
      const out = eng.apply(s, input);
      s = out.state;
      for (const e of [input, ...out.derived]) {
        stored.push({
          seq: ++seq, timestamp: '', clockSecs: e.clockSecs, type: e.type, side: e.side,
          value: e.value ?? 0, detail: e.detail, enteredBy: 'sc1',
        });
      }
    }
    const replayed = eng.replay(P, stored);
    assert.deepEqual(eng.summarize(replayed), eng.summarize(s), 'replay must reproduce the score and statistics');
    assert.equal(replayed.raidingSide, s.raidingSide);
    assert.equal(replayed.A.onCourt, s.A.onCourt);
    assert.equal(replayed.B.onCourt, s.B.onCourt);
  });

  test('the walkover convention records no points for or against', () => {
    // A fabricated score would distort every other side's score difference.
    assert.equal(kabaddi.walkover.winnerScore, 0);
    assert.equal(kabaddi.walkover.loserScore, 0);
    assert.equal(kabaddi.walkover.outcomeType, 'walkover');
  });

  test('the sport metric is score difference', () => {
    assert.equal(kabaddi.sportMetric.label, 'Score Diff');
    assert.equal(kabaddi.sportMetric.compute({ scoreFor: 30, scoreAgainst: 22, played: 1 }), 8);
  });

  test('federation-set numbers are marked as configurable defaults', () => {
    // Anything a federation revises must be flagged, not asserted as a rule.
    const all = [...kabaddi.categories.age, ...kabaddi.categories.weight];
    assert.ok(all.length > 0);
    assert.ok(
      all.every((c) => c.source === 'configurable-default'),
      'weight limits and age bands are federation-set and must be marked configurable',
    );
  });
});
