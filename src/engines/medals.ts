/**
 * Medal and ranking engine — §9 and business rules §7.5.
 *
 * §9.1 generates the final ranking from bracket results (knockout) or the
 * points table (league). §9.2 applies the sport's medal rule: gold and silver
 * from the final, bronze either from a play-off or as a joint award to both
 * losing semi-finalists.
 *
 * §7.5.23 is the gate: "Medals cannot be published while any result in that
 * event is unapproved or under protest, or while a doping/DQ flag is open on a
 * medallist." `verifyMedals` is the only path to publication.
 */

import type {
  Match,
  MedalRow,
  Result,
  StandingsRow,
  TournamentEvent,
} from '../domain/types.ts';
import { nowISO } from '../domain/ids.ts';
import { getSport } from '../sports/registry.ts';
import { loserOf, propagate, winnerOf } from './progression.ts';

export interface MedalInput {
  event: TournamentEvent;
  matches: Match[];
  results: Result[];
  standings?: StandingsRow[];
  entryMeta: Record<string, { displayName: string; unitId: string }>;
  /** Open doping or DQ flags pushed in from Athlete Registration (§11). */
  integrityFlags?: Record<string, string>;
}

/**
 * §9.1 — positions 1..N per event.
 *
 * Runs `propagate` first so bracket sides are resolved entries rather than
 * "Winner of M13" placeholders. Deriving the final's loser needs both sides
 * concrete, and calling this before propagation would otherwise silently drop
 * the silver medallist.
 */
export function generateRankings(input: MedalInput): MedalRow[] {
  const { event, results } = input;
  const matches = propagate({
    matches: input.matches,
    results,
    standings: input.standings,
    entryMeta: input.entryMeta,
  }).matches;
  const byId = new Map(results.map((r) => [r.matchId, r]));
  const rows: MedalRow[] = [];
  const meta = (id: string) => input.entryMeta[id] ?? { displayName: id, unitId: '' };
  const seen = new Set<string>();

  const add = (position: number, entryId: string | undefined, medal: MedalRow['medal'], joint = false) => {
    if (!entryId || seen.has(entryId)) return;
    seen.add(entryId);
    const m = meta(entryId);
    rows.push({
      eventId: event.eventId,
      position,
      participantRef: entryId,
      participantName: m.displayName,
      unitId: m.unitId,
      medal,
      jointFlag: joint,
      dqAnnotation: input.integrityFlags?.[entryId],
    });
  };

  const final = matches.find((m) => m.stage === 'F');

  if (final) {
    // Knockout or group+knockout: the bracket decides the podium.
    const fr = byId.get(final.matchId);
    add(1, winnerOf(final, fr), 'G');
    add(2, loserOf(final, fr), 'S');

    const semis = matches.filter((m) => m.stage === 'SF');
    const bronzeMatch = matches.find((m) => m.stage === 'bronze');

    if (event.medalRule === 'joint-bronze') {
      // §7.5.24 — no play-off; both losing semi-finalists take bronze.
      for (const sf of semis) {
        add(3, loserOf(sf, byId.get(sf.matchId)), 'B', true);
      }
    } else if (bronzeMatch) {
      const br = byId.get(bronzeMatch.matchId);
      add(3, winnerOf(bronzeMatch, br), 'B');
      add(4, loserOf(bronzeMatch, br), 'none');
    }

    // §9.2 "4th–8th placings where required": rank remaining losers by the
    // round they went out in, latest exit first.
    const stageDepth: Record<string, number> = { F: 0, SF: 1, QF: 2, R16: 3, R32: 4 };
    const eliminated = matches
      .filter((m) => m.stage !== 'bronze' && stageDepth[m.stage] !== undefined)
      .map((m) => ({ depth: stageDepth[m.stage] as number, entryId: loserOf(m, byId.get(m.matchId)) }))
      .filter((x) => x.entryId && !seen.has(x.entryId))
      .sort((a, b) => a.depth - b.depth);
    let next = rows.length + 1;
    for (const e of eliminated) add(next++, e.entryId, 'none');
  } else if (input.standings?.length) {
    // Pure league: the points table is the final ranking.
    const table = [...input.standings].sort((a, b) => a.rank - b.rank);
    table.forEach((row, i) => {
      add(i + 1, row.participantRef, i === 0 ? 'G' : i === 1 ? 'S' : i === 2 ? 'B' : 'none');
    });
  }

  return rows.sort((a, b) => a.position - b.position);
}

export interface MedalVerification {
  ok: boolean
  blockers: string[];
  warnings: string[];
  rows: MedalRow[];
}

/**
 * §9.3 / §7.5.23 — the verification checklist that gates publication.
 *
 * Blocks on: any playable fixture in the event without an Approved result, any
 * result Under Protest, an open protest of any kind, an integrity flag on a
 * medallist, or an incomplete podium. Name spellings against accreditation are
 * a warning, since they are a data-quality issue rather than a rules one.
 */
export function verifyMedals(
  input: MedalInput,
  openProtestMatchIds: string[] = [],
): MedalVerification {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(input.results.map((r) => [r.matchId, r]));
  const sport = getSport(input.event.sport);

  const playable = input.matches.filter((m) => !m.byeFlag);
  for (const m of playable) {
    const r = byId.get(m.matchId);
    if (!r) {
      blockers.push(`${m.matchNo} has no result recorded`);
      continue;
    }
    if (r.resultStatus === 'Under Protest') {
      blockers.push(`${m.matchNo} is Under Protest; medals cannot be published while a protest is open (§7.5.23)`);
    } else if (r.resultStatus !== 'Approved') {
      blockers.push(`${m.matchNo} result is ${r.resultStatus}, not Approved (§7.5.23)`);
    }
  }
  for (const id of openProtestMatchIds) {
    const m = input.matches.find((x) => x.matchId === id);
    blockers.push(`an open protest remains on ${m?.matchNo ?? id} (§7.5.23)`);
  }

  const rows = generateRankings(input);

  for (const row of rows) {
    if (row.medal === 'none') continue;
    const flag = input.integrityFlags?.[row.participantRef];
    if (flag) {
      blockers.push(
        `${row.participantName} would take ${row.medal} but carries an open flag: ${flag} (§7.5.23)`,
      );
    }
    if (!row.unitId) {
      warnings.push(`${row.participantName} has no unit recorded — check the name and unit against accreditation (§9.3)`);
    }
  }

  // A podium fixture whose sides are still placeholders cannot yield a
  // medallist. Say so by name rather than only reporting a short podium.
  const resolved = propagate({
    matches: input.matches,
    results: input.results,
    standings: input.standings,
    entryMeta: input.entryMeta,
  }).matches;
  for (const m of resolved) {
    if (!['F', 'SF', 'bronze'].includes(m.stage)) continue;
    for (const side of [m.sideA, m.sideB]) {
      if (side.kind === 'placeholder' || side.kind === 'placeholder-standing') {
        blockers.push(
          `${m.matchNo} (${m.stage}) still has an unresolved side "${side.displayName}"; the podium cannot be derived until it is filled`,
        );
      }
    }
  }

  const expectedMedals = input.event.medalRule === 'joint-bronze' ? 4 : 3;
  const medalled = rows.filter((r) => r.medal !== 'none').length;
  if (medalled < expectedMedals && playable.length > 0) {
    blockers.push(
      `podium incomplete: ${medalled} of ${expectedMedals} medal positions resolved for a ${sport.name} ${input.event.medalRule} event`,
    );
  }

  return { ok: blockers.length === 0, blockers, warnings, rows };
}

/** §9.4 — record verification and approval, then lock and publish. */
export function approveAndPublishMedals(
  rows: MedalRow[],
  verifiedBy: string,
  approvedBy: string,
): { rows: MedalRow[]; error?: string } {
  if (verifiedBy === approvedBy) {
    return {
      rows,
      error:
        'maker–checker: the Technical Official who verified the medal list cannot also be the approver (§3.2)',
    };
  }
  const at = nowISO();
  return { rows: rows.map((r) => ({ ...r, verifiedBy, approvedBy, publishedAt: at })) };
}

/** §9.4 / §10.10 — unit-wise medal tally, fed to the Medal Tally module. */
export function medalTally(
  rows: MedalRow[],
): { unitId: string; gold: number; silver: number; bronze: number; total: number; rank: number }[] {
  const byUnit = new Map<string, { gold: number; silver: number; bronze: number }>();
  for (const r of rows) {
    if (r.medal === 'none' || !r.unitId) continue;
    const t = byUnit.get(r.unitId) ?? { gold: 0, silver: 0, bronze: 0 };
    if (r.medal === 'G') t.gold++;
    else if (r.medal === 'S') t.silver++;
    else t.bronze++;
    byUnit.set(r.unitId, t);
  }
  // Tally rank is by gold first, then silver, then bronze — the standard
  // convention for a games medal table.
  const list = [...byUnit.entries()]
    .map(([unitId, t]) => ({ unitId, ...t, total: t.gold + t.silver + t.bronze, rank: 0 }))
    .sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.unitId.localeCompare(b.unitId));
  // Units level on all three medal counts share a rank.
  let rank = 0;
  let prev: string | undefined;
  list.forEach((row, i) => {
    const key = `${row.gold}-${row.silver}-${row.bronze}`;
    if (key !== prev) rank = i + 1;
    row.rank = rank;
    prev = key;
  });
  return list;
}

/** §9.5 — victory ceremony sheet. */
export function ceremonySheet(
  event: TournamentEvent,
  rows: MedalRow[],
  presenters: string[],
  scheduledAt?: string,
): {
  eventLabel: string;
  scheduledAt?: string;
  presenters: string[];
  medallists: { medal: string; name: string; unit: string; joint: boolean }[];
} {
  return {
    eventLabel: `${event.discipline} · ${event.ageCategory} · ${event.genderCategory}${event.weightCategory ? ` · ${event.weightCategory}` : ''}`,
    scheduledAt,
    presenters,
    medallists: rows
      .filter((r) => r.medal !== 'none')
      .map((r) => ({
        medal: r.medal === 'G' ? 'Gold' : r.medal === 'S' ? 'Silver' : 'Bronze',
        name: r.participantName,
        unit: r.unitId,
        joint: r.jointFlag,
      })),
  };
}

/**
 * §8 exception 3 — a disqualification discovered after the event.
 *
 * Re-ranks the podium with the disqualified side removed. Tie groups are
 * preserved: two sides sharing joint bronze stay level with each other as they
 * move up, so a cascade can never mint two silvers where the rules allow one.
 *
 * Scope note: this re-allocates *rankings* only. §8.3 also requires that, where
 * ineligibility is discovered, "all affected prior results recomputed (forfeits
 * cascaded)" — that is the correction workflow's job (§5.6 post-lock
 * correction), which re-approves each affected result and then calls this
 * function on the recomputed bracket. The returned rows are deliberately
 * unpublished and unapproved so they cannot reach the public tally without
 * passing the §9.3 verification checklist again.
 *
 * Open rules question, surfaced rather than decided: §8 exception 3 says medals
 * are "re-allocated if needed" but does not say how a *joint* medal cascades.
 * Promoting a joint-bronze pair produces two sides level at the next position.
 * Preserving the tie is the only option that invents no ranking the competition
 * never produced, so that is what happens here — but `decisionRequired` is set
 * so the Medal Management screen forces the Jury or Tournament Admin to rule
 * explicitly. Federations differ (some vacate the medal instead of promoting),
 * which is why this is a human decision and not a hardcoded rule.
 */
export interface ReallocationOutcome {
  rows: MedalRow[];
  /** Set when the cascade produced an outcome the rules do not settle. */
  decisionRequired?: string;
  /** Plain-language account of what moved, for the audit reason and the UI. */
  changes: string[];
}

export function reallocateAfterDisqualification(
  rows: MedalRow[],
  disqualifiedEntryId: string,
  annotation: string,
): ReallocationOutcome {
  const dq = rows.find((r) => r.participantRef === disqualifiedEntryId);
  const kept = rows
    .filter((r) => r.participantRef !== disqualifiedEntryId)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.position - b.position);

  const jointBronze = rows.some((r) => r.medal === 'B' && r.jointFlag);

  // Dense re-rank that keeps sides who shared a position sharing the new one.
  let nextPosition = 1;
  let previousOld: number | undefined;
  for (const r of kept) {
    if (previousOld !== undefined && r.position !== previousOld) {
      nextPosition += 1;
    }
    previousOld = r.position;
    r.position = nextPosition;
  }
  // Advance a whole tie group together, so a group's size is respected when
  // the next position is computed.
  const groups = new Map<number, MedalRow[]>();
  for (const r of kept) groups.set(r.position, [...(groups.get(r.position) ?? []), r]);
  let cursor = 1;
  for (const pos of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(pos) as MedalRow[];
    for (const r of group) r.position = cursor;
    cursor += group.length;
  }

  for (const r of kept) {
    r.medal = r.position === 1 ? 'G' : r.position === 2 ? 'S' : r.position === 3 ? 'B' : 'none';
    // A joint-bronze event awards bronze to both semi-final losers, so
    // position 4 also takes bronze when the tie group sits there.
    if (jointBronze && r.position === 4 && kept.some((x) => x.position === 3 && x.jointFlag)) {
      r.medal = 'B';
    }
    r.jointFlag = kept.filter((x) => x.position === r.position).length > 1 || (jointBronze && r.medal === 'B');
    // Re-allocated medals are unpublished until re-verified and re-approved.
    r.publishedAt = undefined;
    r.approvedBy = undefined;
    r.verifiedBy = undefined;
  }

  const out = [...kept];
  if (dq) {
    out.push({
      ...dq,
      medal: 'none',
      jointFlag: false,
      position: cursor,
      dqAnnotation: annotation,
      publishedAt: undefined,
      approvedBy: undefined,
      verifiedBy: undefined,
    });
  }
  out.sort((a, b) => a.position - b.position);

  const before = new Map(rows.map((r) => [r.participantRef, r]));
  const changes: string[] = [];
  for (const r of out) {
    const was = before.get(r.participantRef);
    if (!was) continue;
    if (was.medal !== r.medal || was.position !== r.position) {
      changes.push(
        `${r.participantName}: position ${was.position} → ${r.position}, medal ${was.medal} → ${r.medal}`,
      );
    }
  }

  // Two sides sharing a medal position above bronze is not something the
  // competition produced, so it needs an explicit ruling.
  const shared = [...new Set(out.filter((r) => r.medal === 'G' || r.medal === 'S').map((r) => r.position))]
    .filter((pos) => out.filter((r) => r.position === pos).length > 1);
  const decisionRequired = shared.length
    ? `the cascade leaves ${out
        .filter((r) => shared.includes(r.position))
        .map((r) => r.participantName)
        .join(' and ')} level at position ${shared.join(', ')} with a ${out.find((r) => shared.includes(r.position))?.medal === 'G' ? 'gold' : 'silver'} medal each, because they shared a joint medal before the disqualification. §8 exception 3 does not say whether a joint medal promotes as a pair or the vacated medal is withheld — the Jury of Appeal or Tournament Admin must rule and record the decision before publication.`
    : undefined;

  return { rows: out, decisionRequired, changes };
}
