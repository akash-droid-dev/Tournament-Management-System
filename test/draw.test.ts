/**
 * Draw engine — bracket maths, seeding, byes, separation and the §5.3
 * validation gate, plus the §7.2.9 reproducibility guarantee.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bracketSize,
  byeCount,
  generateGroupKnockout,
  generateKnockout,
  generateLeague,
  roundRobinPairings,
  seedOrder,
  serpentineGroups,
  validateDraw,
  verifyReproducible,
} from '../src/engines/draw.ts';
import { SeededRandom } from '../src/engines/rng.ts';
import '../src/sports/index.ts';
import { entries, event, format } from './helpers.ts';

const params = (over = {}) => ({
  seedCount: 4,
  separationRule: 'same-unit-apart-r1' as const,
  byePolicy: 'top-seeds' as const,
  rngSeed: 'test-seed',
  generatedBy: 'cm1',
  ...over,
});

describe('bracket maths', () => {
  test('bracket size is the next power of two at or above the entry count', () => {
    assert.equal(bracketSize(2), 2);
    assert.equal(bracketSize(5), 8);
    assert.equal(bracketSize(8), 8);
    assert.equal(bracketSize(9), 16);
    assert.equal(bracketSize(12), 16);
  });

  test('byes equal bracket size minus entries', () => {
    assert.equal(byeCount(8), 0);
    assert.equal(byeCount(6), 2);
    assert.equal(byeCount(12), 4);
  });

  test('seed order keeps the top two seeds apart until the final', () => {
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    const o16 = seedOrder(16);
    // Seed 1 in the first half, seed 2 in the second.
    assert.ok(o16.indexOf(1) < 8);
    assert.ok(o16.indexOf(2) >= 8);
  });
});

describe('seeded RNG', () => {
  test('the same seed produces the same sequence', () => {
    const a = new SeededRandom('abc');
    const b = new SeededRandom('abc');
    assert.deepEqual([a.next(), a.next(), a.next()], [b.next(), b.next(), b.next()]);
  });

  test('different seeds produce different sequences', () => {
    assert.notEqual(new SeededRandom('abc').next(), new SeededRandom('abd').next());
  });

  test('a shuffle is deterministic and a permutation', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const x = new SeededRandom('s').shuffle(items);
    const y = new SeededRandom('s').shuffle(items);
    assert.deepEqual(x, y);
    assert.deepEqual([...x].sort((p, q) => p - q), items);
  });
});

describe('knockout draw', () => {
  test('twelve entries with four seeds gives a sixteen bracket and four byes, all to seeds', () => {
    const list = entries(['MH', 'HR', 'PB', 'UP', 'RJ', 'TN', 'KA', 'DL', 'GJ', 'KL', 'MP', 'BR'], 4);
    const out = generateKnockout(event(), format(), list, params());
    assert.equal(out.draw.bracketSize, 16);
    assert.equal(out.draw.byeCount, 4);
    assert.deepEqual(out.draw.validationErrors, []);

    // Each bye must sit opposite a seeded entry.
    const bySlot = new Map(out.draw.slots.map((s) => [s.slot, s]));
    const byeSlots = out.draw.slots.filter((s) => s.occupant.kind === 'bye');
    assert.equal(byeSlots.length, 4);
    for (const b of byeSlots) {
      const opponent = bySlot.get(b.slot % 2 === 0 ? b.slot + 1 : b.slot - 1);
      assert.equal(opponent?.occupant.kind, 'entry');
      assert.ok(
        opponent?.occupant.kind === 'entry' && opponent.occupant.seedNo !== undefined,
        'a bye must face a seeded entry under the top-seeds policy',
      );
    }
  });

  test('every entry occupies exactly one slot', () => {
    const list = entries(['MH', 'HR', 'PB', 'UP', 'RJ', 'TN'], 2);
    const out = generateKnockout(event(), format(), list, params({ seedCount: 2 }));
    const ids = out.draw.slots.filter((s) => s.occupant.kind === 'entry').map((s) => (s.occupant as { entryId: string }).entryId);
    assert.equal(new Set(ids).size, list.length);
    assert.equal(ids.length, list.length);
  });

  test('progression is mapped for every fixture except the final', () => {
    const out = generateKnockout(event(), format(), entries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']), params({ seedCount: 0 }));
    for (const m of out.matches) {
      if (m.stage === 'F') continue;
      assert.ok(m.progression?.winnerTo, `${m.matchNo} has no onward progression`);
    }
    assert.deepEqual(out.draw.validationErrors, []);
  });

  test('the separation rule keeps two sides from one unit out of a round-one pairing', () => {
    const list = entries(['MH', 'MH', 'HR', 'HR', 'PB', 'PB', 'UP', 'UP']);
    const out = generateKnockout(event(), format(), list, params({ seedCount: 0 }));
    const unitOf = (entryId: string) => list.find((e) => e.entryId === entryId)?.unitId;
    for (const m of out.matches.filter((x) => x.roundNo === 1)) {
      if (m.sideA.kind !== 'entry' || m.sideB.kind !== 'entry') continue;
      assert.notEqual(unitOf(m.sideA.entryId), unitOf(m.sideB.entryId), `${m.matchNo} pairs one unit against itself`);
    }
    assert.deepEqual(out.warnings, []);
  });

  test('a separation rule that cannot be honoured is reported, not silently ignored', () => {
    // Every entry from one unit: no arrangement can separate them.
    const list = entries(['MH', 'MH', 'MH', 'MH']);
    const out = generateKnockout(event(), format(), list, params({ seedCount: 0 }));
    assert.ok(out.warnings.length > 0, 'an unsatisfiable separation rule must warn');
    assert.match(out.warnings.join(' '), /separation/i);
  });

  test('a joint-bronze event has no bronze play-off; a play-off event does', () => {
    const list = entries(['A', 'B', 'C', 'D']);
    const joint = generateKnockout(event({ medalRule: 'joint-bronze' }), format(), list, params({ seedCount: 0 }));
    assert.equal(joint.matches.filter((m) => m.stage === 'bronze').length, 0);

    const playoff = generateKnockout(event({ medalRule: 'playoff' }), format(), list, params({ seedCount: 0 }));
    const bronze = playoff.matches.filter((m) => m.stage === 'bronze');
    assert.equal(bronze.length, 1);
    assert.equal(bronze[0]!.sideA.kind, 'placeholder');
    assert.equal((bronze[0]!.sideA as { source: string }).source, 'loser');
  });

  test('a stored draw replays exactly from its seed', () => {
    const list = entries(['MH', 'HR', 'PB', 'UP', 'RJ', 'TN', 'KA', 'DL'], 4);
    const out = generateKnockout(event(), format(), list, params({ rngSeed: 'dispute-2026' }));
    const check = verifyReproducible(event(), format(), list, out.draw);
    assert.ok(check.reproducible, check.detail);
  });

  test('a different seed produces a different draw', () => {
    const list = entries(['MH', 'HR', 'PB', 'UP', 'RJ', 'TN', 'KA', 'DL']);
    const key = (o: ReturnType<typeof generateKnockout>) =>
      o.draw.slots.map((s) => (s.occupant.kind === 'bye' ? 'BYE' : s.occupant.entryId)).join(',');
    assert.notEqual(
      key(generateKnockout(event(), format(), list, params({ seedCount: 0, rngSeed: 'one' }))),
      key(generateKnockout(event(), format(), list, params({ seedCount: 0, rngSeed: 'two' }))),
    );
  });

  test('the draw record stores the RNG algorithm as well as the seed', () => {
    const out = generateKnockout(event(), format(), entries(['A', 'B', 'C', 'D']), params());
    assert.ok(out.draw.rngAlgorithm, 'the algorithm must be stored so a replay is exact');
    assert.equal(out.draw.rngSeed, 'test-seed');
  });
});

describe('validation gate', () => {
  const baseSlots = [
    { slot: 0, nominalSeed: 1, occupant: { kind: 'entry' as const, entryId: 'E1', displayName: 'E1', unitId: 'MH' } },
    { slot: 1, nominalSeed: 2, occupant: { kind: 'entry' as const, entryId: 'E2', displayName: 'E2', unitId: 'HR' } },
  ];

  test('rejects a participant appearing twice in one round', () => {
    const errors = validateDraw(
      [
        { ...baseM('M01'), sideA: ent('E1'), sideB: ent('E2') },
        { ...baseM('M02'), sideA: ent('E1'), sideB: ent('E3') },
      ],
      baseSlots,
      { entryCount: 2, byeCount: 0 },
    );
    assert.ok(errors.some((e) => /appears in 2 fixtures of round 1/.test(e)), errors.join('; '));
  });

  test('rejects a duplicate pairing', () => {
    const errors = validateDraw(
      [
        { ...baseM('M01'), sideA: ent('E1'), sideB: ent('E2') },
        { ...baseM('M02'), roundNo: 2, sideA: ent('E2'), sideB: ent('E1') },
      ],
      baseSlots,
      { entryCount: 2, byeCount: 0 },
    );
    assert.ok(errors.some((e) => /duplicate pairing/.test(e)), errors.join('; '));
  });

  test('rejects a bye outside round one', () => {
    const errors = validateDraw(
      [{ ...baseM('M01'), roundNo: 2, byeFlag: true, stage: 'QF' }],
      baseSlots,
      { entryCount: 2, byeCount: 0 },
    );
    assert.ok(errors.some((e) => /byes are round-1 only/.test(e)), errors.join('; '));
  });

  test('rejects a bye count that does not match the bracket', () => {
    const errors = validateDraw([], baseSlots, { entryCount: 2, byeCount: 2, bracketSize: 4 });
    assert.ok(errors.some((e) => /bye count mismatch/.test(e)), errors.join('; '));
  });

  test('rejects a progression placeholder pointing at a fixture that does not exist', () => {
    const errors = validateDraw(
      [{ ...baseM('M09'), stage: 'QF', roundNo: 2, sideA: { kind: 'placeholder', source: 'winner', matchNo: 'M99', displayName: 'Winner of M99' }, sideB: ent('E2'), progression: { winnerTo: { matchNo: 'M13', side: 'A' } } }],
      baseSlots,
      { entryCount: 2, byeCount: 0 },
    );
    assert.ok(errors.some((e) => /no such fixture exists/.test(e)), errors.join('; '));
  });

  test('rejects a dead end — a non-final fixture with nowhere to progress', () => {
    const errors = validateDraw(
      [{ ...baseM('M01'), stage: 'SF', sideA: ent('E1'), sideB: ent('E2') }],
      baseSlots,
      { entryCount: 2, byeCount: 0 },
    );
    assert.ok(errors.some((e) => /dead end/.test(e)), errors.join('; '));
  });
});

describe('league draw', () => {
  test('round robin gives every unique pairing exactly once', () => {
    for (const n of [4, 5, 6, 7, 8]) {
      const ids = Array.from({ length: n }, (_, i) => `T${i}`);
      const rounds = roundRobinPairings(ids);
      const all = rounds.flat();
      assert.equal(all.length, (n * (n - 1)) / 2, `${n} sides should give ${(n * (n - 1)) / 2} fixtures`);
      assert.equal(new Set(all.map((p) => [p.a, p.b].sort().join('|'))).size, all.length, 'no pairing may repeat');
      // No side plays twice in one round.
      for (const r of rounds) {
        const seen = r.flatMap((p) => [p.a, p.b]);
        assert.equal(new Set(seen).size, seen.length);
      }
    }
  });

  test('a double round-robin plays every pairing twice, with the fixture reversed', () => {
    const out = generateLeague(event(), format({ type: 'league-double', matchesPerPairing: 2 }), entries(['A', 'B', 'C', 'D']), params({ seedCount: 0 }));
    assert.equal(out.matches.length, 12);
    assert.deepEqual(out.draw.validationErrors, [], 'a double round-robin legitimately repeats pairings');
  });
});

describe('group + knockout', () => {
  test('serpentine distribution spreads the top seeds across groups', () => {
    const groups = serpentineGroups([1, 2, 3, 4, 5, 6, 7, 8], 2);
    assert.deepEqual(groups[0], [1, 4, 5, 8]);
    assert.deepEqual(groups[1], [2, 3, 6, 7]);
  });

  test('seeds one and two land in different groups', () => {
    const list = entries(['MH', 'HR', 'PB', 'UP', 'RJ', 'TN', 'KA', 'DL'], 2);
    const out = generateGroupKnockout(
      event(),
      format({ type: 'group-knockout', groupCount: 2, teamsPerGroup: 4, progressionRules: [{ fromGroupId: '*', positions: [1, 2], toStage: 'SF', seedApart: true }] }),
      list,
      params({ seedCount: 2 }),
    );
    const seedGroups = out.draw.slots
      .filter((s) => s.occupant.kind === 'entry' && s.occupant.seedNo !== undefined)
      .map((s) => s.groupId);
    assert.equal(new Set(seedGroups).size, 2, 'the two seeds must be in different groups');
    assert.deepEqual(out.draw.validationErrors, []);
  });

  test('group winners are paired against runners-up from another group', () => {
    const out = generateGroupKnockout(
      event(),
      format({ type: 'group-knockout', groupCount: 2, teamsPerGroup: 4, progressionRules: [{ fromGroupId: '*', positions: [1, 2], toStage: 'SF', seedApart: true }] }),
      entries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 2),
      params({ seedCount: 2 }),
    );
    const sfs = out.matches.filter((m) => m.stage === 'SF');
    assert.equal(sfs.length, 2);
    for (const sf of sfs) {
      const a = sf.sideA as { groupId: string; position: number };
      const b = sf.sideB as { groupId: string; position: number };
      assert.notEqual(a.groupId, b.groupId, 'a semi-final should not pair two sides from the same group');
      assert.notEqual(a.position, b.position, 'a group winner should meet a runner-up');
    }
  });
});

// ── local helpers ──────────────────────────────────────────────────────────

function baseM(matchNo: string) {
  return {
    matchId: `MCH-${matchNo}`,
    eventId: 'EVT-T',
    stage: 'group' as const,
    roundNo: 1,
    matchNo,
    sideA: ent('E1'),
    sideB: ent('E2'),
    byeFlag: false,
    officials: [],
    matchStatus: 'Scheduled' as const,
    versionNo: 1,
    rescheduleHistory: [],
  };
}

function ent(entryId: string) {
  return { kind: 'entry' as const, entryId, displayName: entryId };
}
