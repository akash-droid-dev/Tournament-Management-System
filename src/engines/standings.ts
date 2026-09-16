/**
 * Points table and standings engine — §5.7 and business rules §7.5.
 *
 * §7.5.21: "Points tables recompute automatically on every result approval and
 * on every correction — never manually edited." This module therefore exposes
 * only a pure `computeStandings`; there is no setter for a standings row
 * anywhere in the codebase.
 *
 * §7.5.22: "Tie-breakers execute strictly in configured order; if all fail,
 * 'draw of lots' is conducted and the outcome + witnesses recorded." The order
 * comes from the sport template, and the rung that decided each position is
 * recorded on the row so the §12.12 tie-break explainer can show its work.
 */

import type {
  Format,
  Match,
  ProgressionRule,
  Result,
  StandingsRow,
} from '../domain/types.ts';
import { nowISO } from '../domain/ids.ts';
import { getSport, type TieBreakerSpec } from '../sports/registry.ts';
import { SeededRandom } from './rng.ts';

export interface StandingsInput {
  eventId: string;
  sportId: string;
  format: Format;
  matches: Match[];
  /** Only Approved results count towards a points table. */
  results: Result[];
  /** Entry ID → display name and unit, for the table's labels. */
  entryMeta: Record<string, { displayName: string; unitId: string }>;
  /** Recorded outcome of any draw of lots already conducted, entry IDs in rank order. */
  drawOfLots?: Record<string, string[]>;
}

/** A result only enters the table once it is Approved (§8.4/§8.5). */
function countable(r: Result): boolean {
  return r.resultStatus === 'Approved' && r.outcomeType !== 'void';
}

function blank(
  eventId: string,
  groupId: string,
  entryId: string,
  meta: { displayName: string; unitId: string } | undefined,
  metricLabel: string,
): StandingsRow {
  return {
    eventId,
    groupId,
    participantRef: entryId,
    participantName: meta?.displayName ?? entryId,
    unitId: meta?.unitId ?? '',
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    points: 0,
    scoreFor: 0,
    scoreAgainst: 0,
    sportMetric: 0,
    sportMetricLabel: metricLabel,
    bonusPoints: 0,
    tiebreakNotes: [],
    rank: 0,
    qualificationFlag: '',
    computedAt: nowISO(),
  };
}

/**
 * Build the points table for every group in the event.
 *
 * Byes are excluded: a bye is awarded without play, so counting it would give a
 * side a free win in a league table. Walkovers do count, with the sport's
 * configured walkover score (0–0 for Kabaddi, so score difference is not
 * distorted) and standard win points.
 */
export function computeStandings(input: StandingsInput): StandingsRow[] {
  const sport = getSport(input.sportId);
  const mp = input.format.matchParams;
  const byId = new Map(input.results.map((r) => [r.matchId, r]));

  const groupMatches = input.matches.filter((m) => m.stage === 'group' && !m.byeFlag);
  const groups = new Map<string, Set<string>>();
  for (const m of groupMatches) {
    const gid = m.groupId ?? 'G1';
    const set = groups.get(gid) ?? new Set<string>();
    for (const side of [m.sideA, m.sideB]) if (side.kind === 'entry') set.add(side.entryId);
    groups.set(gid, set);
  }

  const out: StandingsRow[] = [];

  for (const [groupId, members] of groups) {
    const rows = new Map<string, StandingsRow>();
    for (const entryId of members) {
      rows.set(entryId, blank(input.eventId, groupId, entryId, input.entryMeta[entryId], sport.sportMetric.label));
    }

    // Head-to-head ledger, needed by the tie-breaker of the same name.
    const h2h = new Map<string, { for: number; against: number; points: number }>();
    const h2hKey = (a: string, b: string) => `${a}>${b}`;

    for (const m of groupMatches) {
      if ((m.groupId ?? 'G1') !== groupId) continue;
      const r = byId.get(m.matchId);
      if (!r || !countable(r)) continue;
      if (m.sideA.kind !== 'entry' || m.sideB.kind !== 'entry') continue;
      const a = rows.get(m.sideA.entryId);
      const b = rows.get(m.sideB.entryId);
      if (!a || !b) continue;

      const sa = r.finalScore.a;
      const sb = r.finalScore.b;
      a.played++;
      b.played++;
      a.scoreFor += sa;
      a.scoreAgainst += sb;
      b.scoreFor += sb;
      b.scoreAgainst += sa;

      const decideByScore = r.outcomeType === 'played';
      // For a walkover, retirement or DQ the winner is recorded explicitly,
      // because the score alone (0–0 for a Kabaddi walkover) does not say who won.
      const winner = decideByScore ? (sa > sb ? 'A' : sb > sa ? 'B' : 'D') : r.winnerRef === m.sideA.entryId ? 'A' : r.winnerRef === m.sideB.entryId ? 'B' : 'D';

      if (winner === 'A') {
        a.won++;
        b.lost++;
        a.points += mp.pointsWin;
        b.points += mp.pointsLoss;
      } else if (winner === 'B') {
        b.won++;
        a.lost++;
        b.points += mp.pointsWin;
        a.points += mp.pointsLoss;
      } else {
        a.drawn++;
        b.drawn++;
        a.points += mp.pointsDraw;
        b.points += mp.pointsDraw;
      }

      // Losing bonus point — only when the sport preset configures one, and
      // only for a match actually played.
      if (mp.bonusPointMargin !== undefined && mp.pointsBonus && decideByScore && winner !== 'D') {
        const margin = Math.abs(sa - sb);
        if (margin <= mp.bonusPointMargin) {
          const loser = winner === 'A' ? b : a;
          loser.bonusPoints += mp.pointsBonus;
          loser.points += mp.pointsBonus;
        }
      }

      const aw = winner === 'A' ? mp.pointsWin : winner === 'D' ? mp.pointsDraw : mp.pointsLoss;
      const bw = winner === 'B' ? mp.pointsWin : winner === 'D' ? mp.pointsDraw : mp.pointsLoss;
      const ka = h2hKey(m.sideA.entryId, m.sideB.entryId);
      const kb = h2hKey(m.sideB.entryId, m.sideA.entryId);
      const ea = h2h.get(ka) ?? { for: 0, against: 0, points: 0 };
      const eb = h2h.get(kb) ?? { for: 0, against: 0, points: 0 };
      h2h.set(ka, { for: ea.for + sa, against: ea.against + sb, points: ea.points + aw });
      h2h.set(kb, { for: eb.for + sb, against: eb.against + sa, points: eb.points + bw });
    }

    for (const row of rows.values()) {
      row.sportMetric = sport.sportMetric.compute(row);
    }

    const ranked = rankWithTieBreakers(
      [...rows.values()],
      sport.tieBreakers,
      h2h,
      input.drawOfLots?.[groupId],
      input.eventId,
      groupId,
    );
    out.push(...ranked);
  }

  // §5.7 qualification marking.
  return markQualification(out, input.format.progressionRules, groups.size);
}

interface H2HLedger {
  get(key: string): { for: number; against: number; points: number } | undefined;
}

/**
 * Sort rows by the sport's ordered tie-breaker hierarchy.
 *
 * Rows are grouped by each rung in turn: any set still tied moves to the next
 * rung. The rung that separated a row is written to `tiebreakNotes`, so the
 * table can explain exactly why one side finished above another.
 */
export function rankWithTieBreakers(
  rows: StandingsRow[],
  tieBreakers: TieBreakerSpec[],
  h2h: H2HLedger,
  lots: string[] | undefined,
  eventId: string,
  groupId: string,
): StandingsRow[] {
  const valueOf = (row: StandingsRow, key: string, cohort: StandingsRow[]): number => {
    switch (key) {
      case 'points':
        return row.points;
      case 'scoreDiff':
        return row.sportMetric;
      case 'scoreFor':
        return row.scoreFor;
      case 'scoreAgainst':
        return -row.scoreAgainst;
      case 'wins':
        return row.won;
      case 'fairPlay':
        // Placeholder until card counts are aggregated per side; kept so the
        // rung exists in the hierarchy and is visible in the explainer.
        return 0;
      case 'headToHead': {
        // Only the matches among the tied cohort count.
        let pts = 0;
        let diff = 0;
        for (const other of cohort) {
          if (other.participantRef === row.participantRef) continue;
          const e = h2h.get(`${row.participantRef}>${other.participantRef}`);
          if (!e) continue;
          pts += e.points;
          diff += e.for - e.against;
        }
        // Points dominate; difference breaks a level head-to-head.
        return pts * 1000 + diff;
      }
      case 'drawOfLots':
        if (!lots) return 0;
        const ix = lots.indexOf(row.participantRef);
        return ix === -1 ? 0 : lots.length - ix;
      default:
        return 0;
    }
  };

  /** Recursively separate a cohort, descending the hierarchy. */
  const separate = (cohort: StandingsRow[], depth: number): StandingsRow[] => {
    if (cohort.length <= 1 || depth >= tieBreakers.length) return cohort;
    const tb = tieBreakers[depth] as TieBreakerSpec;
    const buckets = new Map<number, StandingsRow[]>();
    for (const row of cohort) {
      const v = valueOf(row, tb.key, cohort);
      buckets.set(v, [...(buckets.get(v) ?? []), row]);
    }
    const keys = [...buckets.keys()].sort((a, b) => (tb.higherIsBetter ? b - a : a - b));
    const out: StandingsRow[] = [];
    for (const k of keys) {
      const bucket = buckets.get(k) as StandingsRow[];
      if (bucket.length > 1) {
        // Still tied at this rung — note it and descend.
        out.push(...separate(bucket, depth + 1));
      } else {
        const only = bucket[0] as StandingsRow;
        if (depth > 0) {
          only.tiebreakNotes = [...only.tiebreakNotes, `separated on ${tb.label}`];
        }
        out.push(only);
      }
    }
    return out;
  };

  const sorted = separate(rows, 0);

  // Anything still tied after the whole hierarchy needs a recorded draw of lots.
  const unresolved: string[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i] as StandingsRow;
    const b = sorted[i + 1] as StandingsRow;
    const identical = tieBreakers.every(
      (tb) => valueOf(a, tb.key, sorted) === valueOf(b, tb.key, sorted),
    );
    if (identical) unresolved.push(a.participantRef, b.participantRef);
  }
  if (unresolved.length && !lots) {
    const names = [...new Set(unresolved)];
    for (const row of sorted) {
      if (names.includes(row.participantRef)) {
        row.tiebreakNotes = [
          ...row.tiebreakNotes,
          `every tie-breaker exhausted against ${names.filter((n) => n !== row.participantRef).join(', ')} — a draw of lots must be conducted and recorded (§7.5.22)`,
        ];
      }
    }
  }

  sorted.forEach((r, i) => {
    r.rank = i + 1;
    r.computedAt = nowISO();
    r.eventId = eventId;
    r.groupId = groupId;
  });
  return sorted;
}

/**
 * §5.7 — "positions meeting progression rule flagged Q (qualified) / E
 * (eliminated); qualified entries auto-fill next-stage fixture placeholders."
 *
 * A flag is only set once the group is complete; while matches remain the
 * position could still change, so the flag stays blank rather than misleading
 * a Team Manager.
 */
export function markQualification(
  rows: StandingsRow[],
  rules: ProgressionRule[],
  _groupCount: number,
): StandingsRow[] {
  const byGroup = new Map<string, StandingsRow[]>();
  for (const r of rows) byGroup.set(r.groupId, [...(byGroup.get(r.groupId) ?? []), r]);

  for (const [groupId, group] of byGroup) {
    const applicable = rules.filter((r) => r.fromGroupId === '*' || r.fromGroupId === groupId);
    if (!applicable.length) continue;
    const qualifying = new Set<number>(applicable.flatMap((r) => r.positions));
    // A group is decided only when every side has played every other side.
    const expectedEach = group.length - 1;
    const complete = group.every((r) => r.played >= expectedEach);
    for (const row of group) {
      row.qualificationFlag = complete ? (qualifying.has(row.rank) ? 'Q' : 'E') : '';
    }
  }
  return rows;
}

/**
 * §7.5.22 — conduct a draw of lots. The seeded RNG makes the outcome
 * reproducible from the recorded seed, and the witnesses are stored so the
 * §10.12 exception register can show who observed it.
 */
export function conductDrawOfLots(
  tiedEntryIds: string[],
  seed: string,
  witnesses: string[],
): { order: string[]; seed: string; witnesses: string[]; at: string } {
  if (witnesses.length < 2) {
    throw new Error('a draw of lots must record at least two witnesses (§7.5.22)');
  }
  const rng = new SeededRandom(seed);
  return { order: rng.shuffle(tiedEntryIds), seed, witnesses, at: nowISO() };
}
