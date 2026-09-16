/**
 * Progression engine — §8.5 and §5.7.
 *
 * Two jobs:
 *   1. On result approval, push the winner (and, for a bronze play-off, the
 *      loser) into the next-round fixture slot.
 *   2. When a group stage completes, resolve `placeholder-standing` sides from
 *      the final table.
 *
 * §7.4.19 is enforced here: "A result Under Protest blocks progression of the
 * affected bracket path until the protest is ruled; unaffected matches
 * continue." Propagation is therefore per-path, never all-or-nothing.
 */

import type { Match, MatchSide, Result, StandingsRow } from '../domain/types.ts';

export interface PropagationInput {
  matches: Match[];
  results: Result[];
  standings?: StandingsRow[];
  entryMeta?: Record<string, { displayName: string; unitId: string }>;
}

export interface PropagationOutput {
  matches: Match[];
  /** Slots filled this pass, for the §9.2 progression tracker. */
  filled: { matchNo: string; side: 'A' | 'B'; entryId: string; displayName: string }[];
  /** Slots that stayed empty, with the reason — what the tracker shows as blocked. */
  blocked: { matchNo: string; side: 'A' | 'B'; reason: string }[];
}

/** Which entry won, accounting for outcomes where the score does not say. */
export function winnerOf(match: Match, result: Result | undefined): string | undefined {
  if (!result || result.resultStatus !== 'Approved') return undefined;
  if (result.winnerRef) return result.winnerRef;
  if (result.outcomeType !== 'played') return undefined;
  const { a, b } = result.finalScore;
  if (a === b) return undefined;
  const side = a > b ? match.sideA : match.sideB;
  return side.kind === 'entry' ? side.entryId : undefined;
}

export function loserOf(match: Match, result: Result | undefined): string | undefined {
  const w = winnerOf(match, result);
  if (!w) return undefined;
  for (const side of [match.sideA, match.sideB]) {
    if (side.kind === 'entry' && side.entryId !== w) return side.entryId;
  }
  return undefined;
}

/**
 * Resolve every placeholder that can now be resolved.
 *
 * Runs to a fixed point, so a chain of byes or a cascade of approvals settles
 * in one call rather than needing the caller to loop.
 */
export function propagate(input: PropagationInput): PropagationOutput {
  const matches = input.matches.map((m) => ({ ...m }));
  const byNo = new Map(matches.map((m) => [m.matchNo, m]));
  const resultByMatchId = new Map(input.results.map((r) => [r.matchId, r]));
  const filled: PropagationOutput['filled'] = [];
  // Keyed so repeated passes over the same still-unresolved slot report once,
  // with the most recent reason rather than one entry per pass.
  const blockedMap = new Map<string, PropagationOutput['blocked'][number]>();
  const block = (matchNo: string, side: 'A' | 'B', reason: string): void => {
    blockedMap.set(`${matchNo}|${side}`, { matchNo, side, reason });
  };

  const nameFor = (entryId: string): string =>
    input.entryMeta?.[entryId]?.displayName ??
    matches
      .flatMap((m) => [m.sideA, m.sideB])
      .find((s) => s.kind === 'entry' && s.entryId === entryId)?.displayName ??
    entryId;

  /** A bye advances its occupant without a result. */
  const byeAdvance = (m: Match): string | undefined => {
    if (!m.byeFlag) return undefined;
    for (const side of [m.sideA, m.sideB]) if (side.kind === 'entry') return side.entryId;
    return undefined;
  };

  let changed = true;
  let guard = 0;
  while (changed && guard++ < matches.length + 2) {
    changed = false;
    for (const m of matches) {
      for (const sideKey of ['A', 'B'] as const) {
        const side: MatchSide = sideKey === 'A' ? m.sideA : m.sideB;
        if (side.kind !== 'placeholder') continue;
        const feeder = byNo.get(side.matchNo);
        if (!feeder) {
          block(m.matchNo, sideKey, `feeder ${side.matchNo} not found`);
          continue;
        }
        const r = resultByMatchId.get(feeder.matchId);

        // §7.4.19 — a protest on the feeder freezes this path only.
        if (r?.resultStatus === 'Under Protest') {
          block(
            m.matchNo,
            sideKey,
            `${feeder.matchNo} is Under Protest; this bracket path is frozen until the protest is ruled (§7.4.19)`,
          );
          continue;
        }

        let entryId: string | undefined;
        if (side.source === 'winner') {
          entryId = byeAdvance(feeder) ?? winnerOf(feeder, r);
        } else {
          entryId = loserOf(feeder, r);
        }

        if (!entryId) {
          block(
            m.matchNo,
            sideKey,
            r
              ? `${feeder.matchNo} result is ${r.resultStatus}; an Approved result is needed to advance`
              : `${feeder.matchNo} has no result yet`,
          );
          continue;
        }

        const resolved: MatchSide = { kind: 'entry', entryId, displayName: nameFor(entryId) };
        if (sideKey === 'A') m.sideA = resolved;
        else m.sideB = resolved;
        filled.push({ matchNo: m.matchNo, side: sideKey, entryId, displayName: resolved.displayName });
        blockedMap.delete(`${m.matchNo}|${sideKey}`);
        changed = true;
      }
    }
  }

  // Resolve group-standing placeholders once the group is decided.
  if (input.standings?.length) {
    for (const m of matches) {
      for (const sideKey of ['A', 'B'] as const) {
        const side: MatchSide = sideKey === 'A' ? m.sideA : m.sideB;
        if (side.kind !== 'placeholder-standing') continue;
        const group = input.standings.filter((s) => s.groupId === side.groupId);
        const row = group.find((s) => s.rank === side.position);
        if (!group.length) {
          block(m.matchNo, sideKey, `no standings for group ${side.groupId}`);
          continue;
        }
        // Only a settled group may fill a knockout slot.
        if (!row || row.qualificationFlag !== 'Q') {
          block(
            m.matchNo,
            sideKey,
            `${side.groupId} is not decided yet — position ${side.position} is not confirmed qualified`,
          );
          continue;
        }
        const resolved: MatchSide = {
          kind: 'entry',
          entryId: row.participantRef,
          displayName: row.participantName,
        };
        if (sideKey === 'A') m.sideA = resolved;
        else m.sideB = resolved;
        filled.push({
          matchNo: m.matchNo,
          side: sideKey,
          entryId: row.participantRef,
          displayName: row.participantName,
        });
        blockedMap.delete(`${m.matchNo}|${sideKey}`);
      }
    }
  }

  return { matches, filled, blocked: [...blockedMap.values()] };
}

/**
 * §9.2 progression tracker: which next-round slots are filled and which are
 * blocked, with the reason.
 */
export function progressionStatus(input: PropagationInput): {
  total: number;
  resolved: number;
  pending: { matchNo: string; side: 'A' | 'B'; waitingOn: string; reason: string }[];
} {
  const out = propagate(input);
  const placeholders = input.matches.flatMap((m) =>
    (['A', 'B'] as const)
      .map((k) => ({ k, side: k === 'A' ? m.sideA : m.sideB, m }))
      .filter((x) => x.side.kind === 'placeholder' || x.side.kind === 'placeholder-standing'),
  );
  const pending = out.blocked.map((b) => {
    const m = input.matches.find((x) => x.matchNo === b.matchNo);
    const side = m ? (b.side === 'A' ? m.sideA : m.sideB) : undefined;
    const waitingOn =
      side?.kind === 'placeholder'
        ? side.matchNo
        : side?.kind === 'placeholder-standing'
          ? `${side.groupId} standings`
          : '?';
    return { matchNo: b.matchNo, side: b.side, waitingOn, reason: b.reason };
  });
  return { total: placeholders.length, resolved: out.filled.length, pending };
}

/**
 * §8.7 / §8 exception 10 — after a correction, downstream fixtures must be
 * recomputed. Returns the fixtures whose sides came from the corrected match,
 * so the Correction screen can warn exactly what else changes.
 */
export function downstreamImpact(
  matches: Match[],
  correctedMatchNo: string,
): { matchNo: string; stage: string; matchStatus: string; reason: string }[] {
  const impacted: { matchNo: string; stage: string; matchStatus: string; reason: string }[] = [];
  const byNo = new Map(matches.map((m) => [m.matchNo, m]));
  const seen = new Set<string>();

  const walk = (no: string, depth: number): void => {
    const m = byNo.get(no);
    if (!m?.progression) return;
    for (const target of [m.progression.winnerTo, m.progression.loserTo]) {
      if (!target || seen.has(target.matchNo)) continue;
      seen.add(target.matchNo);
      const t = byNo.get(target.matchNo);
      if (!t) continue;
      impacted.push({
        matchNo: t.matchNo,
        stage: t.stage,
        matchStatus: t.matchStatus,
        reason:
          depth === 0
            ? `side ${target.side} came directly from ${no}`
            : `downstream of ${no} via ${depth} further round(s)`,
      });
      walk(target.matchNo, depth + 1);
    }
  };

  walk(correctedMatchNo, 0);
  return impacted;
}
