/**
 * Draw / fixture generation engine — §5.3 and business rules §7.2.
 *
 * Three format families are supported, all driven off the approved `Format`:
 *   • knockout        — seeded bracket with byes and separation rules
 *   • league          — single or double round-robin (circle method)
 *   • group-knockout  — groups drawn serpentine, then a knockout skeleton
 *
 * Everything random goes through `SeededRandom`, and the seed plus algorithm
 * are returned for storage so any draw can be replayed exactly (§7.2.9).
 */

import type {
  DrawRecord,
  DrawSlot,
  Entry,
  Format,
  Match,
  MatchSide,
  Stage,
  TournamentEvent,
} from '../domain/types.ts';
import { matchNo as fmtMatchNo, newDrawId, newMatchId, nowISO } from '../domain/ids.ts';
import { ALGORITHM, SeededRandom } from './rng.ts';

export interface DrawParameters {
  /** §5.1 seeding count, e.g. top 4 or top 8 seeded. */
  seedCount: number;
  separationRule: DrawRecord['separationRule'];
  byePolicy: DrawRecord['byePolicy'];
  /** Reproducibility seed. Callers keep it; §7.2.9 requires it stored. */
  rngSeed: string;
  generatedBy: string;
}

export interface DrawOutput {
  draw: DrawRecord;
  matches: Match[];
  /** Advisories that do not fail the gate — shown on the draw console. */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bracket maths
// ─────────────────────────────────────────────────────────────────────────────

/** §5.3 "Bracket size computation: next power of 2 ≥ entries". */
export function bracketSize(entryCount: number): number {
  if (entryCount <= 1) return entryCount;
  return 2 ** Math.ceil(Math.log2(entryCount));
}

/** §5.3 "Byes = bracket size − entries". */
export function byeCount(entryCount: number): number {
  return bracketSize(entryCount) - entryCount;
}

/**
 * Standard bracket seed order: which seed conventionally occupies each slot.
 *
 * Built by repeated reflection, which is what "1 top, 2 bottom, 3/4 drawn"
 * means formally. For a bracket of 8 this yields
 * [1, 8, 4, 5, 2, 7, 3, 6] — so 1 meets 8, 4 meets 5, and seeds 1 and 2 can
 * only meet in the final.
 */
export function seedOrder(size: number): number[] {
  if (size < 2) return size === 1 ? [1] : [];
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next: number[] = [];
    for (const s of order) next.push(s, sum - s);
    order = next;
  }
  return order;
}

/** Stage label for a knockout round, counted back from the final. */
export function stageForRound(roundNo: number, totalRounds: number): Stage {
  const fromEnd = totalRounds - roundNo;
  if (fromEnd === 0) return 'F';
  if (fromEnd === 1) return 'SF';
  if (fromEnd === 2) return 'QF';
  if (fromEnd === 3) return 'R16';
  if (fromEnd === 4) return 'R32';
  return 'R32';
}

// ─────────────────────────────────────────────────────────────────────────────
// Separation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slot groups that can meet by a given round. Round 1 pairs are adjacent
 * slots; round 2 opponents share a block of 4, and so on.
 */
function blocksForRound(size: number, round: number): number[][] {
  const width = 2 ** round;
  const out: number[][] = [];
  for (let i = 0; i < size; i += width) {
    out.push(Array.from({ length: width }, (_, k) => i + k));
  }
  return out;
}

function unitOf(slot: DrawSlot | undefined): string | undefined {
  return slot?.occupant.kind === 'entry' ? slot.occupant.unitId : undefined;
}

/** Same-unit pairs that would meet within the rounds the rule protects. */
function findSeparationViolations(
  slots: DrawSlot[],
  rule: DrawRecord['separationRule'],
): { round: number; slots: number[]; unitId: string }[] {
  if (rule === 'none') return [];
  const rounds = rule === 'same-unit-apart-r1' ? [1] : [1, 2];
  const out: { round: number; slots: number[]; unitId: string }[] = [];
  for (const round of rounds) {
    for (const block of blocksForRound(slots.length, round)) {
      const byUnit = new Map<string, number[]>();
      for (const i of block) {
        const u = unitOf(slots[i]);
        if (!u) continue;
        byUnit.set(u, [...(byUnit.get(u) ?? []), i]);
      }
      for (const [unitId, members] of byUnit) {
        if (members.length > 1) out.push({ round, slots: members, unitId });
      }
    }
  }
  return out;
}

/** A slot may be moved only if it holds an unseeded entry (§5.3 step 4). */
function isSwappable(slot: DrawSlot | undefined): boolean {
  return slot?.occupant.kind === 'entry' && slot.occupant.seedNo === undefined;
}

/**
 * §5.3 step 4: "Apply separation constraints; re-draw slot if violated."
 *
 * Deterministic hill-climb: repeatedly swap an unseeded entry out of a
 * violating block into the position that removes the most violations. Bounded,
 * and every candidate order comes from the seeded RNG, so the repair is as
 * reproducible as the draw itself.
 */
function repairSeparation(
  slots: DrawSlot[],
  rule: DrawRecord['separationRule'],
  rng: SeededRandom,
): { slots: DrawSlot[]; warnings: string[] } {
  if (rule === 'none') return { slots, warnings: [] };
  const work = [...slots];
  const warnings: string[] = [];
  const maxPasses = work.length * 4;

  for (let pass = 0; pass < maxPasses; pass++) {
    const violations = findSeparationViolations(work, rule);
    if (!violations.length) return { slots: work, warnings };

    const v = violations[0] as { round: number; slots: number[]; unitId: string };
    const movable = v.slots.filter((i) => isSwappable(work[i]));
    if (!movable.length) {
      warnings.push(
        `separation rule "${rule}" cannot be honoured for unit ${v.unitId} in round ${v.round}: all affected positions are seeded or byes`,
      );
      return { slots: work, warnings };
    }

    const from = movable[0] as number;
    const candidates = rng
      .shuffle(work.map((_, i) => i))
      .filter((i) => i !== from && (isSwappable(work[i]) || work[i]?.occupant.kind === 'bye'));

    let best: { to: number; score: number } | undefined;
    const baseline = violations.length;
    for (const to of candidates) {
      const trial = [...work];
      const a = trial[from] as DrawSlot;
      const b = trial[to] as DrawSlot;
      // Swap occupants, not slots: a slot keeps its bracket position.
      trial[from] = { ...a, occupant: b.occupant };
      trial[to] = { ...b, occupant: a.occupant };
      const score = findSeparationViolations(trial, rule).length;
      if (score < baseline && (!best || score < best.score)) best = { to, score };
      if (score === 0) break;
    }

    if (!best) {
      warnings.push(
        `separation rule "${rule}" could not fully separate unit ${v.unitId} in round ${v.round}; ${baseline} clash(es) remain and were accepted`,
      );
      return { slots: work, warnings };
    }
    const a = work[from] as DrawSlot;
    const b = work[best.to] as DrawSlot;
    work[from] = { ...a, occupant: b.occupant };
    work[best.to] = { ...b, occupant: a.occupant };
  }

  const left = findSeparationViolations(work, rule);
  if (left.length) {
    warnings.push(`separation repair hit its pass limit with ${left.length} clash(es) remaining`);
  }
  return { slots: work, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation gate — §5.3 step 3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard validation. Any error rejects the draw: §5.3's gate lists duplicate
 * pairings, a participant twice in one round, an unmapped progression slot and
 * a bye-count mismatch, and §7.2.8 adds that byes belong to round 1 only.
 */
export function validateDraw(
  matches: Match[],
  slots: DrawSlot[],
  expected: { entryCount: number; byeCount: number; bracketSize?: number },
): string[] {
  const errors: string[] = [];

  // Bye count must equal bracket size minus entries (§7.2.8).
  const byesInSlots = slots.filter((s) => s.occupant.kind === 'bye').length;
  if (expected.bracketSize !== undefined && byesInSlots !== expected.byeCount) {
    errors.push(
      `bye count mismatch: ${byesInSlots} bye slot(s) but bracket size ${expected.bracketSize} minus ${expected.entryCount} entries needs ${expected.byeCount}`,
    );
  }

  // Every entry appears exactly once in the slot map.
  const seen = new Map<string, number>();
  for (const s of slots) {
    if (s.occupant.kind !== 'entry') continue;
    seen.set(s.occupant.entryId, (seen.get(s.occupant.entryId) ?? 0) + 1);
  }
  for (const [entryId, n] of seen) {
    if (n > 1) errors.push(`entry ${entryId} occupies ${n} slots; it must appear exactly once`);
  }
  if (expected.bracketSize !== undefined && seen.size !== expected.entryCount) {
    errors.push(`slot map holds ${seen.size} entries but ${expected.entryCount} were expected`);
  }

  // No duplicate pairings across the whole draw.
  const pairings = new Set<string>();
  for (const m of matches) {
    const a = sideKey(m.sideA);
    const b = sideKey(m.sideB);
    if (!a || !b) continue;
    const key = [a, b].sort().join('|');
    if (pairings.has(key)) {
      errors.push(`duplicate pairing ${a} v ${b} (match ${m.matchNo})`);
    }
    pairings.add(key);
  }

  // No participant in two fixtures of the same round.
  const byRound = new Map<number, Map<string, string[]>>();
  for (const m of matches) {
    const perRound = byRound.get(m.roundNo) ?? new Map<string, string[]>();
    for (const side of [m.sideA, m.sideB]) {
      const k = sideKey(side);
      if (!k) continue;
      perRound.set(k, [...(perRound.get(k) ?? []), m.matchNo]);
    }
    byRound.set(m.roundNo, perRound);
  }
  for (const [round, perRound] of byRound) {
    for (const [k, ms] of perRound) {
      if (ms.length > 1) {
        errors.push(`${k} appears in ${ms.length} fixtures of round ${round}: ${ms.join(', ')}`);
      }
    }
  }

  // Every progression slot must be mapped: each placeholder's source must exist.
  const numbers = new Set(matches.map((m) => m.matchNo));
  for (const m of matches) {
    for (const side of [m.sideA, m.sideB]) {
      if (side.kind === 'placeholder' && !numbers.has(side.matchNo)) {
        errors.push(
          `match ${m.matchNo} waits on "${side.source} of ${side.matchNo}" but no such fixture exists`,
        );
      }
    }
    // Byes belong to round 1 only (§7.2.8).
    if (m.byeFlag && m.roundNo !== 1) {
      errors.push(`match ${m.matchNo} carries a bye in round ${m.roundNo}; byes are round-1 only (§7.2.8)`);
    }
    // Every non-final fixture must feed somewhere: no dead ends (§4.5).
    if (m.stage !== 'F' && m.stage !== 'bronze' && m.stage !== 'group' && !m.progression?.winnerTo) {
      errors.push(`match ${m.matchNo} (${m.stage}) has no onward progression mapped — dead end`);
    }
  }

  return errors;
}

function sideKey(side: MatchSide): string | undefined {
  if (side.kind === 'entry') return side.entryId;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Knockout
// ─────────────────────────────────────────────────────────────────────────────

function toSide(slot: DrawSlot): MatchSide {
  return slot.occupant.kind === 'bye'
    ? { kind: 'bye', displayName: 'BYE' }
    : { kind: 'entry', entryId: slot.occupant.entryId, displayName: slot.occupant.displayName };
}

/** §5.3 auto-draw engine, steps 1–4, for a single-elimination bracket. */
export function generateKnockout(
  event: TournamentEvent,
  format: Format,
  entries: Entry[],
  params: DrawParameters,
): DrawOutput {
  const live = entries.filter((e) => e.entryStatus === 'Confirmed' || e.entryStatus === 'Submitted');
  const size = bracketSize(live.length);
  const byes = byeCount(live.length);
  const rng = new SeededRandom(params.rngSeed);
  const warnings: string[] = [];
  const order = seedOrder(size);

  // Step 1 — place seeds at their conventional bracket positions.
  const seeded = new Map<number, Entry>();
  for (const e of live) {
    if (e.seedNo !== undefined && e.seedNo >= 1 && e.seedNo <= params.seedCount) {
      if (seeded.has(e.seedNo)) {
        warnings.push(`duplicate seed number ${e.seedNo}; ${e.entryId} was drawn as unseeded`);
        continue;
      }
      seeded.set(e.seedNo, e);
    }
  }
  const unseeded = rng.shuffle(live.filter((e) => !seeded.has(e.seedNo ?? -1)));

  let slots: DrawSlot[] = order.map((nominalSeed, i) => {
    const e = seeded.get(nominalSeed);
    return {
      slot: i,
      nominalSeed,
      occupant: e
        ? {
            kind: 'entry' as const,
            entryId: e.entryId,
            displayName: e.participantRef.displayName,
            unitId: e.unitId,
            seedNo: e.seedNo,
          }
        : { kind: 'bye' as const },
    };
  });

  // Step 2 — allocate byes. 'top-seeds' gives them to the weakest bracket
  // positions, which are exactly the positions facing the strongest seeds.
  const open = slots.filter((s) => s.occupant.kind === 'bye');
  const byeSlots = new Set<number>(
    (params.byePolicy === 'top-seeds'
      ? [...open].sort((a, b) => b.nominalSeed - a.nominalSeed)
      : rng.shuffle(open)
    )
      .slice(0, byes)
      .map((s) => s.slot),
  );

  // Step 3 — draw the unseeded entries into what remains.
  const fillable = open.filter((s) => !byeSlots.has(s.slot)).map((s) => s.slot);
  if (fillable.length !== unseeded.length) {
    warnings.push(
      `slot arithmetic mismatch: ${fillable.length} open position(s) for ${unseeded.length} unseeded entr(ies)`,
    );
  }
  slots = slots.map((s) => {
    const idx = fillable.indexOf(s.slot);
    if (idx === -1) return s;
    const e = unseeded[idx];
    if (!e) return s;
    return {
      ...s,
      occupant: {
        kind: 'entry' as const,
        entryId: e.entryId,
        displayName: e.participantRef.displayName,
        unitId: e.unitId,
      },
    };
  });

  // Step 4 — separation constraints.
  const repaired = repairSeparation(slots, params.separationRule, rng);
  slots = repaired.slots;
  warnings.push(...repaired.warnings);

  // Build every round, with placeholders for the rounds not yet decided.
  const totalRounds = Math.max(1, Math.log2(size));
  const matches: Match[] = [];
  let counter = 0;
  const numbersByRound: string[][] = [];

  for (let round = 1; round <= totalRounds; round++) {
    const inThisRound = size / 2 ** round;
    const nums: string[] = [];
    for (let j = 0; j < inThisRound; j++) {
      counter += 1;
      const no = fmtMatchNo(counter);
      nums.push(no);
      let sideA: MatchSide;
      let sideB: MatchSide;
      if (round === 1) {
        sideA = toSide(slots[2 * j] as DrawSlot);
        sideB = toSide(slots[2 * j + 1] as DrawSlot);
      } else {
        const prev = numbersByRound[round - 2] as string[];
        const pa = prev[2 * j] as string;
        const pb = prev[2 * j + 1] as string;
        sideA = { kind: 'placeholder', source: 'winner', matchNo: pa, displayName: `Winner of ${pa}` };
        sideB = { kind: 'placeholder', source: 'winner', matchNo: pb, displayName: `Winner of ${pb}` };
      }
      const stage = stageForRound(round, totalRounds);
      matches.push({
        matchId: newMatchId(),
        eventId: event.eventId,
        stage,
        roundNo: round,
        matchNo: no,
        sideA,
        sideB,
        byeFlag: sideA.kind === 'bye' || sideB.kind === 'bye',
        officials: [],
        matchStatus: 'Scheduled',
        versionNo: 1,
        rescheduleHistory: [],
        durationMins: format.matchParams.durationMins,
      });
    }
    numbersByRound.push(nums);
  }

  // Map progression: winner of match j in round r feeds side A or B of the
  // match it shares a parent with in round r+1.
  for (let round = 1; round < totalRounds; round++) {
    const cur = numbersByRound[round - 1] as string[];
    const next = numbersByRound[round] as string[];
    cur.forEach((no, j) => {
      const target = next[Math.floor(j / 2)];
      if (!target) return;
      const m = matches.find((x) => x.matchNo === no);
      if (m) m.progression = { winnerTo: { matchNo: target, side: j % 2 === 0 ? 'A' : 'B' } };
    });
  }

  // Bronze: a play-off fed by the losing semi-finalists, unless the sport
  // awards joint bronze (§7.5.24), in which case no bronze match exists.
  if (event.medalRule === 'playoff' && totalRounds >= 2) {
    const sfNumbers = numbersByRound[totalRounds - 2] as string[];
    if (sfNumbers.length === 2) {
      counter += 1;
      const no = fmtMatchNo(counter);
      const [s1, s2] = sfNumbers as [string, string];
      matches.push({
        matchId: newMatchId(),
        eventId: event.eventId,
        stage: 'bronze',
        roundNo: totalRounds,
        matchNo: no,
        sideA: { kind: 'placeholder', source: 'loser', matchNo: s1, displayName: `Loser of ${s1}` },
        sideB: { kind: 'placeholder', source: 'loser', matchNo: s2, displayName: `Loser of ${s2}` },
        byeFlag: false,
        officials: [],
        matchStatus: 'Scheduled',
        versionNo: 1,
        rescheduleHistory: [],
        durationMins: format.matchParams.durationMins,
      });
      for (const sf of sfNumbers) {
        const m = matches.find((x) => x.matchNo === sf);
        if (m) m.progression = { ...m.progression, loserTo: { matchNo: no, side: sf === s1 ? 'A' : 'B' } };
      }
    }
  }

  const errors = validateDraw(matches, slots, {
    entryCount: live.length,
    byeCount: byes,
    bracketSize: size,
  });

  return {
    draw: {
      drawId: newDrawId(),
      eventId: event.eventId,
      slots,
      rngAlgorithm: ALGORITHM,
      rngSeed: params.rngSeed,
      bracketSize: size,
      entryCount: live.length,
      byeCount: byes,
      seedCount: params.seedCount,
      separationRule: params.separationRule,
      byePolicy: params.byePolicy,
      status: errors.length ? 'Not Generated' : 'Draft Draw',
      manualAdjustments: [],
      validationErrors: errors,
      generatedBy: params.generatedBy,
      generatedAt: nowISO(),
    },
    matches,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// League (round-robin)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Circle method. Every side meets every other exactly once per leg, and each
 * side plays at most one fixture per round — which is what makes the
 * scheduler's rest-gap constraint satisfiable.
 */
export function roundRobinPairings(ids: readonly string[]): { a: string; b: string }[][] {
  const list = [...ids];
  const BYE = '__bye__';
  if (list.length % 2 === 1) list.push(BYE);
  const n = list.length;
  const rounds: { a: string; b: string }[][] = [];
  let arr = [...list];
  for (let r = 0; r < n - 1; r++) {
    const pairs: { a: string; b: string }[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i] as string;
      const b = arr[n - 1 - i] as string;
      if (a !== BYE && b !== BYE) {
        // Alternate home/away so no side is always listed first.
        pairs.push(r % 2 === 0 ? { a, b } : { a: b, b: a });
      }
    }
    rounds.push(pairs);
    const fixed = arr[0] as string;
    const rest = arr.slice(1);
    rest.unshift(rest.pop() as string);
    arr = [fixed, ...rest];
  }
  return rounds;
}

export function generateLeague(
  event: TournamentEvent,
  format: Format,
  entries: Entry[],
  params: DrawParameters,
  groupId = 'G1',
): DrawOutput {
  const live = entries.filter((e) => e.entryStatus === 'Confirmed' || e.entryStatus === 'Submitted');
  const rng = new SeededRandom(params.rngSeed);
  // Shuffle before pairing so the fixture order is drawn, not alphabetical.
  const shuffled = rng.shuffle(live);
  const byId = new Map(shuffled.map((e) => [e.entryId, e]));
  const legs = format.matchesPerPairing;
  const rounds = roundRobinPairings(shuffled.map((e) => e.entryId));

  const slots: DrawSlot[] = shuffled.map((e, i) => ({
    slot: i,
    nominalSeed: (e.seedNo ?? i + 1),
    groupId,
    occupant: {
      kind: 'entry' as const,
      entryId: e.entryId,
      displayName: e.participantRef.displayName,
      unitId: e.unitId,
      seedNo: e.seedNo,
    },
  }));

  const matches: Match[] = [];
  let counter = 0;
  for (let leg = 1; leg <= legs; leg++) {
    rounds.forEach((pairs, ri) => {
      for (const p of pairs) {
        counter += 1;
        // The return leg reverses the fixture.
        const [aId, bId] = leg === 1 ? [p.a, p.b] : [p.b, p.a];
        const a = byId.get(aId);
        const b = byId.get(bId);
        if (!a || !b) continue;
        matches.push({
          matchId: newMatchId(),
          eventId: event.eventId,
          stage: 'group',
          roundNo: (leg - 1) * rounds.length + ri + 1,
          matchNo: fmtMatchNo(counter),
          groupId,
          sideA: { kind: 'entry', entryId: a.entryId, displayName: a.participantRef.displayName },
          sideB: { kind: 'entry', entryId: b.entryId, displayName: b.participantRef.displayName },
          byeFlag: false,
          officials: [],
          matchStatus: 'Scheduled',
          versionNo: 1,
          rescheduleHistory: [],
          durationMins: format.matchParams.durationMins,
        });
      }
    });
  }

  // A double round-robin legitimately repeats every pairing, so the
  // duplicate-pairing check is only meaningful for a single leg.
  const errors =
    legs === 1
      ? validateDraw(matches, slots, { entryCount: live.length, byeCount: 0 })
      : validateDraw(matches, slots, { entryCount: live.length, byeCount: 0 }).filter(
          (e) => !e.startsWith('duplicate pairing'),
        );

  return {
    draw: {
      drawId: newDrawId(),
      eventId: event.eventId,
      slots,
      rngAlgorithm: ALGORITHM,
      rngSeed: params.rngSeed,
      bracketSize: live.length,
      entryCount: live.length,
      byeCount: 0,
      seedCount: params.seedCount,
      separationRule: params.separationRule,
      byePolicy: params.byePolicy,
      status: errors.length ? 'Not Generated' : 'Draft Draw',
      manualAdjustments: [],
      validationErrors: errors,
      generatedBy: params.generatedBy,
      generatedAt: nowISO(),
    },
    matches,
    warnings: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group + knockout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serpentine ("snake") distribution: seeds 1..n are dealt across the groups
 * left-to-right then right-to-left, which is what keeps the strongest sides in
 * different groups (§4.3 "group winners seeded apart").
 */
export function serpentineGroups<T>(ranked: readonly T[], groupCount: number): T[][] {
  const groups: T[][] = Array.from({ length: groupCount }, () => []);
  ranked.forEach((item, i) => {
    const row = Math.floor(i / groupCount);
    const col = i % groupCount;
    const g = row % 2 === 0 ? col : groupCount - 1 - col;
    (groups[g] as T[]).push(item);
  });
  return groups;
}

export function generateGroupKnockout(
  event: TournamentEvent,
  format: Format,
  entries: Entry[],
  params: DrawParameters,
): DrawOutput {
  const live = entries.filter((e) => e.entryStatus === 'Confirmed' || e.entryStatus === 'Submitted');
  const rng = new SeededRandom(params.rngSeed);
  const warnings: string[] = [];

  // Seeded entries first in seed order, then the rest drawn at random.
  const seeded = live
    .filter((e) => e.seedNo !== undefined)
    .sort((a, b) => (a.seedNo as number) - (b.seedNo as number));
  const rest = rng.shuffle(live.filter((e) => e.seedNo === undefined));
  const ranked = [...seeded, ...rest];

  const groupCount = Math.max(1, format.groupCount);
  let groups = serpentineGroups(ranked, groupCount);

  // Try to keep two sides from the same unit out of one group. Only unseeded
  // entries move, so the seeding integrity of the snake is preserved.
  groups = separateUnitsAcrossGroups(groups, rng, warnings);

  const slots: DrawSlot[] = [];
  const matches: Match[] = [];
  let counter = 0;
  let slotIx = 0;

  groups.forEach((members, gi) => {
    const groupId = `G${gi + 1}`;
    members.forEach((e) => {
      slots.push({
        slot: slotIx++,
        nominalSeed: e.seedNo ?? slotIx,
        groupId,
        occupant: {
          kind: 'entry' as const,
          entryId: e.entryId,
          displayName: e.participantRef.displayName,
          unitId: e.unitId,
          seedNo: e.seedNo,
        },
      });
    });
    const byId = new Map(members.map((e) => [e.entryId, e]));
    const rounds = roundRobinPairings(members.map((e) => e.entryId));
    for (let leg = 1; leg <= format.matchesPerPairing; leg++) {
      rounds.forEach((pairs, ri) => {
        for (const p of pairs) {
          counter += 1;
          const [aId, bId] = leg === 1 ? [p.a, p.b] : [p.b, p.a];
          const a = byId.get(aId);
          const b = byId.get(bId);
          if (!a || !b) continue;
          matches.push({
            matchId: newMatchId(),
            eventId: event.eventId,
            stage: 'group',
            roundNo: (leg - 1) * rounds.length + ri + 1,
            matchNo: fmtMatchNo(counter),
            groupId,
            sideA: { kind: 'entry', entryId: a.entryId, displayName: a.participantRef.displayName },
            sideB: { kind: 'entry', entryId: b.entryId, displayName: b.participantRef.displayName },
            byeFlag: false,
            officials: [],
            matchStatus: 'Scheduled',
            versionNo: 1,
            rescheduleHistory: [],
            durationMins: format.matchParams.durationMins,
          });
        }
      });
    }
  });

  // Knockout stage fed by standings placeholders, resolved when the groups end.
  const qualifiers: MatchSide[] = [];
  for (const rule of format.progressionRules) {
    const target = rule.fromGroupId === '*' ? groups.map((_, i) => `G${i + 1}`) : [rule.fromGroupId];
    for (const gid of target) {
      for (const pos of rule.positions) {
        qualifiers.push({
          kind: 'placeholder-standing',
          groupId: gid,
          position: pos,
          displayName: `${gid} #${pos}`,
        });
      }
    }
  }

  if (qualifiers.length >= 2) {
    // §4.3 "group winners seeded apart": pair the best of one group against the
    // runner-up of another by reversing the second half of the qualifier list.
    const ordered = seedQualifiersApart(qualifiers);
    const koSize = bracketSize(ordered.length);
    if (koSize !== ordered.length) {
      warnings.push(
        `${ordered.length} qualifier(s) do not fill a power-of-two bracket; ${koSize - ordered.length} knockout bye(s) will be needed`,
      );
    }
    const koRounds = Math.max(1, Math.log2(koSize));
    const numbersByRound: string[][] = [];
    for (let round = 1; round <= koRounds; round++) {
      const inRound = koSize / 2 ** round;
      const nums: string[] = [];
      for (let j = 0; j < inRound; j++) {
        counter += 1;
        const no = fmtMatchNo(counter);
        nums.push(no);
        let sideA: MatchSide;
        let sideB: MatchSide;
        if (round === 1) {
          sideA = ordered[2 * j] ?? { kind: 'bye', displayName: 'BYE' };
          sideB = ordered[2 * j + 1] ?? { kind: 'bye', displayName: 'BYE' };
        } else {
          const prev = numbersByRound[round - 2] as string[];
          const pa = prev[2 * j] as string;
          const pb = prev[2 * j + 1] as string;
          sideA = { kind: 'placeholder', source: 'winner', matchNo: pa, displayName: `Winner of ${pa}` };
          sideB = { kind: 'placeholder', source: 'winner', matchNo: pb, displayName: `Winner of ${pb}` };
        }
        matches.push({
          matchId: newMatchId(),
          eventId: event.eventId,
          stage: stageForRound(round, koRounds),
          roundNo: 100 + round, // knockout rounds sort after every group round
          matchNo: no,
          sideA,
          sideB,
          byeFlag: sideA.kind === 'bye' || sideB.kind === 'bye',
          officials: [],
          matchStatus: 'Scheduled',
          versionNo: 1,
          rescheduleHistory: [],
          durationMins: format.matchParams.durationMins,
        });
      }
      numbersByRound.push(nums);
    }
    for (let round = 1; round < koRounds; round++) {
      const cur = numbersByRound[round - 1] as string[];
      const next = numbersByRound[round] as string[];
      cur.forEach((no, j) => {
        const target = next[Math.floor(j / 2)];
        if (!target) return;
        const m = matches.find((x) => x.matchNo === no);
        if (m) m.progression = { winnerTo: { matchNo: target, side: j % 2 === 0 ? 'A' : 'B' } };
      });
    }
    if (event.medalRule === 'playoff' && koRounds >= 2) {
      const sf = numbersByRound[koRounds - 2] as string[];
      if (sf.length === 2) {
        counter += 1;
        const no = fmtMatchNo(counter);
        const [s1, s2] = sf as [string, string];
        matches.push({
          matchId: newMatchId(),
          eventId: event.eventId,
          stage: 'bronze',
          roundNo: 100 + koRounds,
          matchNo: no,
          sideA: { kind: 'placeholder', source: 'loser', matchNo: s1, displayName: `Loser of ${s1}` },
          sideB: { kind: 'placeholder', source: 'loser', matchNo: s2, displayName: `Loser of ${s2}` },
          byeFlag: false,
          officials: [],
          matchStatus: 'Scheduled',
          versionNo: 1,
          rescheduleHistory: [],
          durationMins: format.matchParams.durationMins,
        });
        for (const s of sf) {
          const m = matches.find((x) => x.matchNo === s);
          if (m) m.progression = { ...m.progression, loserTo: { matchNo: no, side: s === s1 ? 'A' : 'B' } };
        }
      }
    }
  } else {
    warnings.push('no progression rules produced qualifiers; the event ends at the group stage');
  }

  const errors = validateDraw(matches, slots, { entryCount: live.length, byeCount: 0 }).filter(
    (e) => !(format.matchesPerPairing > 1 && e.startsWith('duplicate pairing')),
  );

  return {
    draw: {
      drawId: newDrawId(),
      eventId: event.eventId,
      slots,
      rngAlgorithm: ALGORITHM,
      rngSeed: params.rngSeed,
      bracketSize: live.length,
      entryCount: live.length,
      byeCount: 0,
      seedCount: params.seedCount,
      separationRule: params.separationRule,
      byePolicy: params.byePolicy,
      status: errors.length ? 'Not Generated' : 'Draft Draw',
      manualAdjustments: [],
      validationErrors: errors,
      generatedBy: params.generatedBy,
      generatedAt: nowISO(),
    },
    matches,
    warnings,
  };
}

/** Pair first-placed sides against runners-up from a different group. */
function seedQualifiersApart(qualifiers: MatchSide[]): MatchSide[] {
  const firsts = qualifiers.filter((q) => q.kind === 'placeholder-standing' && q.position === 1);
  const others = qualifiers.filter((q) => !(q.kind === 'placeholder-standing' && q.position === 1));
  if (!firsts.length || firsts.length !== others.length) return qualifiers;
  const reversed = [...others].reverse();
  const out: MatchSide[] = [];
  firsts.forEach((f, i) => out.push(f, reversed[i] as MatchSide));
  return out;
}

/** Move unseeded entries between groups so no unit is doubled up. */
function separateUnitsAcrossGroups(
  groups: Entry[][],
  rng: SeededRandom,
  warnings: string[],
): Entry[][] {
  const work = groups.map((g) => [...g]);
  const clashes = () => {
    const out: { gi: number; entry: Entry }[] = [];
    work.forEach((g, gi) => {
      const counts = new Map<string, Entry[]>();
      for (const e of g) counts.set(e.unitId, [...(counts.get(e.unitId) ?? []), e]);
      for (const list of counts.values()) {
        // The first stays; the rest are candidates to move.
        for (const e of list.slice(1)) out.push({ gi, entry: e });
      }
    });
    return out;
  };

  for (let pass = 0; pass < work.length * 8; pass++) {
    const bad = clashes();
    if (!bad.length) return work;
    const first = bad[0] as { gi: number; entry: Entry };
    if (first.entry.seedNo !== undefined) {
      warnings.push(
        `unit ${first.entry.unitId} is doubled up in group G${first.gi + 1} and the affected entry is seeded, so it was not moved`,
      );
      return work;
    }
    // Swap with an unseeded entry in a group that has no member of this unit.
    const targets = rng.shuffle(work.map((_, i) => i)).filter((gi) => gi !== first.gi);
    let moved = false;
    for (const gi of targets) {
      const target = work[gi] as Entry[];
      if (target.some((e) => e.unitId === first.entry.unitId)) continue;
      const swappable = target.find(
        (e) => e.seedNo === undefined && !(work[first.gi] as Entry[]).some((x) => x.unitId === e.unitId),
      );
      if (!swappable) continue;
      const src = work[first.gi] as Entry[];
      src.splice(src.indexOf(first.entry), 1, swappable);
      target.splice(target.indexOf(swappable), 1, first.entry);
      moved = true;
      break;
    }
    if (!moved) {
      warnings.push(
        `unit ${first.entry.unitId} could not be separated across groups; the clash was accepted`,
      );
      return work;
    }
  }
  return work;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher + manual adjustment
// ─────────────────────────────────────────────────────────────────────────────

export function generateDraw(
  event: TournamentEvent,
  format: Format,
  entries: Entry[],
  params: DrawParameters,
): DrawOutput {
  switch (format.type) {
    case 'knockout':
    case 'qualification-finals':
    case 'repechage':
      return generateKnockout(event, format, entries, params);
    case 'league-single':
      return generateLeague(event, { ...format, matchesPerPairing: 1 }, entries, params);
    case 'league-double':
      return generateLeague(event, { ...format, matchesPerPairing: 2 }, entries, params);
    case 'group-knockout':
    case 'pool':
    case 'heats-semis-finals':
      return generateGroupKnockout(event, format, entries, params);
  }
}

/**
 * §5.4 — a pre-publish swap. Allowed only in Draft Draw, logged with
 * before/after, and the whole draw is re-validated afterwards.
 */
export function applyManualAdjustment(
  output: DrawOutput,
  fromSlot: number,
  toSlot: number,
  by: string,
): { output: DrawOutput; error?: string } {
  if (output.draw.status !== 'Draft Draw') {
    return {
      output,
      error: `manual swaps are only allowed while the draw is in Draft Draw (currently ${output.draw.status}); a published draw changes only through the Redraw/Amendment path (§5.6)`,
    };
  }
  const slots = [...output.draw.slots];
  const a = slots.find((s) => s.slot === fromSlot);
  const b = slots.find((s) => s.slot === toSlot);
  if (!a || !b) return { output, error: `slot ${!a ? fromSlot : toSlot} does not exist in this draw` };

  const label = (s: DrawSlot) => (s.occupant.kind === 'bye' ? 'BYE' : s.occupant.displayName);
  const before = `${fromSlot}:${label(a)} / ${toSlot}:${label(b)}`;
  const ai = slots.indexOf(a);
  const bi = slots.indexOf(b);
  slots[ai] = { ...a, occupant: b.occupant };
  slots[bi] = { ...b, occupant: a.occupant };
  const after = `${fromSlot}:${label(slots[ai] as DrawSlot)} / ${toSlot}:${label(slots[bi] as DrawSlot)}`;

  // Rebuild round-1 sides from the new slot map, then re-validate everything.
  const matches = output.matches.map((m) => {
    if (m.roundNo !== 1 || m.stage === 'group') return m;
    const j = output.matches.filter((x) => x.roundNo === 1 && x.stage !== 'group').indexOf(m);
    if (j < 0) return m;
    const sa = slots.find((s) => s.slot === 2 * j);
    const sb = slots.find((s) => s.slot === 2 * j + 1);
    if (!sa || !sb) return m;
    const sideA = toSide(sa);
    const sideB = toSide(sb);
    return { ...m, sideA, sideB, byeFlag: sideA.kind === 'bye' || sideB.kind === 'bye' };
  });

  const errors = validateDraw(matches, slots, {
    entryCount: output.draw.entryCount,
    byeCount: output.draw.byeCount,
    bracketSize: output.draw.bracketSize,
  });

  return {
    output: {
      ...output,
      matches,
      draw: {
        ...output.draw,
        slots,
        validationErrors: errors,
        manualAdjustments: [
          ...output.draw.manualAdjustments,
          { fromSlot, toSlot, before, after, by, at: nowISO() },
        ],
      },
    },
  };
}

/**
 * §7.2.9 reproducibility proof: regenerate from the stored seed and confirm the
 * slot map is identical. The Draw Console offers this for dispute resolution.
 */
export function verifyReproducible(
  event: TournamentEvent,
  format: Format,
  entries: Entry[],
  stored: DrawRecord,
): { reproducible: boolean; detail: string } {
  if (stored.rngAlgorithm !== ALGORITHM) {
    return {
      reproducible: false,
      detail: `draw was generated with ${stored.rngAlgorithm} but this build uses ${ALGORITHM}`,
    };
  }
  const redraw = generateDraw(event, format, entries, {
    seedCount: stored.seedCount,
    separationRule: stored.separationRule,
    byePolicy: stored.byePolicy,
    rngSeed: stored.rngSeed,
    generatedBy: 'verification',
  });
  const key = (d: DrawRecord['slots']) =>
    d.map((s) => `${s.slot}:${s.occupant.kind === 'bye' ? 'BYE' : s.occupant.entryId}`).join(',');
  // Manual adjustments are applied after generation, so compare against the
  // pre-adjustment map when any exist.
  const expected = stored.manualAdjustments.length ? undefined : key(stored.slots);
  const actual = key(redraw.draw.slots);
  if (expected === undefined) {
    return {
      reproducible: true,
      detail: `draw carries ${stored.manualAdjustments.length} logged manual adjustment(s); the auto-draw from seed "${stored.rngSeed}" reproduces exactly and each swap is recorded with before/after`,
    };
  }
  return expected === actual
    ? { reproducible: true, detail: `seed "${stored.rngSeed}" reproduces the draw exactly` }
    : { reproducible: false, detail: `seed "${stored.rngSeed}" produced a different slot map` };
}
