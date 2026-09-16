/**
 * Officials assignment engine — §6.5–6.6 and business rules §7.3.
 *
 * The officials pool itself lives in the Volunteer/Officials Management module
 * (§11 inbound). This engine consumes a snapshot of that pool, filters it by
 * sport qualification, accreditation and availability, applies the neutrality
 * rule, and writes duty assignments back (§11 outbound).
 */

import type {
  ISODate,
  ISODateTime,
  Match,
  OfficialAssignment,
  Tournament,
  Venue,
} from '../domain/types.ts';
import { newAssignmentId, nowISO } from '../domain/ids.ts';
import { getSport } from '../sports/registry.ts';
import { TRAVEL_BUFFER_MINS, toMins } from './scheduler.ts';

/** Snapshot of one official from the Officials module. Read by reference. */
export interface OfficialSnapshot {
  officialId: string;
  name: string;
  /** Sport keys this official is qualified for. */
  sports: string[];
  /** Roles they may fill, matching the sport template's panel role names. */
  roles: string[];
  /** Grade, checked against the panel's `qualificationGrade` requirement. */
  grade?: string;
  /** Unit/state affiliation — the basis of the neutrality rule (§7.3.13). */
  unitId: string;
  accreditation?: { id: string; validUntil: ISODate };
  /** Dates the official has declared unavailable. */
  unavailableDates?: ISODate[];
  /** §6.6 max matches per day per official. */
  maxMatchesPerDay?: number;
}

export const DEFAULT_MAX_MATCHES_PER_DAY = 4;

export interface AssignmentContext {
  tournament: Tournament;
  match: Match;
  /** Unit of each side, for the neutrality check. */
  sideUnits: { a?: string; b?: string };
  pool: OfficialSnapshot[];
  /** Every assignment already made across the tournament. */
  existing: OfficialAssignment[];
  /** All matches, so overlap and travel checks can see the schedule. */
  allMatches: Match[];
  venues: Venue[];
  sportId: string;
  assignedBy: string;
}

export interface EligibilityIssue {
  severity: 'hard' | 'soft';
  code:
    | 'NOT_QUALIFIED_SPORT'
    | 'NOT_QUALIFIED_ROLE'
    | 'GRADE_TOO_LOW'
    | 'ACCREDITATION_INVALID'
    | 'UNAVAILABLE_DATE'
    | 'NEUTRALITY_FAIL'
    | 'OVERLAPPING_DUTY'
    | 'TRAVEL_BUFFER'
    | 'MAX_MATCHES_PER_DAY'
    | 'ALREADY_ON_THIS_MATCH';
  message: string;
}

export interface CandidateAssessment {
  official: OfficialSnapshot;
  role: string;
  issues: EligibilityIssue[];
  assignable: boolean;
  /** Higher is a better fit — drives the §12.8 assignment board's ordering. */
  score: number;
}

/** Grade ordering, best first. Unknown grades sort last. */
const GRADE_RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

function gradeMeets(have: string | undefined, need: string | undefined): boolean {
  if (!need) return true;
  if (!have) return false;
  return (GRADE_RANK[have] ?? 99) <= (GRADE_RANK[need] ?? 99);
}

function matchSpan(m: Match, fallbackMins: number): { start: number; end: number } | undefined {
  if (!m.scheduledDate || !m.scheduledTime) return undefined;
  const base = Math.floor(new Date(`${m.scheduledDate}T00:00:00Z`).getTime() / 60000);
  const start = base + toMins(m.scheduledTime);
  return { start, end: start + (m.durationMins ?? fallbackMins) };
}

/**
 * Assess one official for one seat on one match.
 *
 * §7.3.13 neutrality, §7.3.14 no overlapping duties plus a cross-venue travel
 * buffer, §6.6 max matches per day, and the sport's qualification and
 * accreditation requirements.
 */
export function assessCandidate(
  ctx: AssignmentContext,
  official: OfficialSnapshot,
  role: string,
): CandidateAssessment {
  const sport = getSport(ctx.sportId);
  const issues: EligibilityIssue[] = [];
  const seat = sport.officials.panel.find((p) => p.role === role);
  const dur = ctx.match.durationMins ?? sport.matchDefaults.durationMins;

  if (!official.sports.includes(ctx.sportId)) {
    issues.push({
      severity: 'hard',
      code: 'NOT_QUALIFIED_SPORT',
      message: `${official.name} is not qualified for ${sport.name} (qualified: ${official.sports.join(', ') || 'none'})`,
    });
  }
  if (!official.roles.includes(role)) {
    issues.push({
      severity: 'hard',
      code: 'NOT_QUALIFIED_ROLE',
      message: `${official.name} is not certified as ${role} (certified: ${official.roles.join(', ') || 'none'})`,
    });
  }
  if (!gradeMeets(official.grade, seat?.qualificationGrade)) {
    issues.push({
      severity: 'hard',
      code: 'GRADE_TOO_LOW',
      message: `${role} requires grade ${seat?.qualificationGrade}; ${official.name} holds ${official.grade ?? 'none'}`,
    });
  }

  // §11 Accreditation is inbound and blocks the duty, not just the check-in.
  const day = ctx.match.scheduledDate;
  if (!official.accreditation) {
    issues.push({
      severity: 'hard',
      code: 'ACCREDITATION_INVALID',
      message: `${official.name} has no accreditation record`,
    });
  } else if (day && official.accreditation.validUntil < day) {
    issues.push({
      severity: 'hard',
      code: 'ACCREDITATION_INVALID',
      message: `${official.name}'s accreditation expired ${official.accreditation.validUntil}, before ${day}`,
    });
  }

  if (day && official.unavailableDates?.includes(day)) {
    issues.push({
      severity: 'hard',
      code: 'UNAVAILABLE_DATE',
      message: `${official.name} has declared ${day} unavailable`,
    });
  }

  // §7.3.13 — neutrality. Configurable per tournament level.
  const clashUnit = [ctx.sideUnits.a, ctx.sideUnits.b].find((u) => u && u === official.unitId);
  if (clashUnit) {
    issues.push({
      severity: ctx.tournament.enforceOfficialNeutrality ? 'hard' : 'soft',
      code: 'NEUTRALITY_FAIL',
      message: ctx.tournament.enforceOfficialNeutrality
        ? `${official.name} is from ${official.unitId}, which is playing this match — neutrality rule blocks the assignment (§7.3.13)`
        : `${official.name} is from ${official.unitId}, which is playing this match — neutrality is not enforced at this tournament level, so this is an advisory`,
    });
  }

  if (ctx.existing.some((a) => a.matchId === ctx.match.matchId && a.officialId === official.officialId && a.status !== 'replaced')) {
    issues.push({
      severity: 'hard',
      code: 'ALREADY_ON_THIS_MATCH',
      message: `${official.name} already holds a seat on ${ctx.match.matchNo}`,
    });
  }

  // §7.3.14 — no overlapping duties, plus the cross-venue travel buffer.
  const thisSpan = matchSpan(ctx.match, dur);
  const dutyMatchIds = new Set(
    ctx.existing.filter((a) => a.officialId === official.officialId && a.status !== 'replaced').map((a) => a.matchId),
  );
  const duties = ctx.allMatches.filter((m) => dutyMatchIds.has(m.matchId) && m.matchId !== ctx.match.matchId);

  if (thisSpan) {
    for (const d of duties) {
      const ds = matchSpan(d, d.durationMins ?? dur);
      if (!ds) continue;
      if (thisSpan.start < ds.end && ds.start < thisSpan.end) {
        issues.push({
          severity: 'hard',
          code: 'OVERLAPPING_DUTY',
          message: `${official.name} is already on duty for ${d.matchNo} at that time (§7.3.14)`,
        });
      } else if (d.venueId && ctx.match.venueId && d.venueId !== ctx.match.venueId) {
        const gap = thisSpan.start >= ds.end ? thisSpan.start - ds.end : ds.start - thisSpan.end;
        if (gap < TRAVEL_BUFFER_MINS) {
          issues.push({
            severity: 'hard',
            code: 'TRAVEL_BUFFER',
            message: `${official.name} has only ${gap} min between ${d.matchNo} at ${d.venueId} and ${ctx.match.matchNo} at ${ctx.match.venueId}; ${TRAVEL_BUFFER_MINS} min travel buffer required (§6.6)`,
          });
        }
      }
    }
  }

  // §6.6 — max matches per day.
  const cap = official.maxMatchesPerDay ?? DEFAULT_MAX_MATCHES_PER_DAY;
  const sameDay = duties.filter((d) => d.scheduledDate === day).length;
  if (day && sameDay >= cap) {
    issues.push({
      severity: 'hard',
      code: 'MAX_MATCHES_PER_DAY',
      message: `${official.name} already has ${sameDay} matches on ${day}; the cap is ${cap} (§6.6)`,
    });
  }

  // Prefer a fresher official and the exact grade asked for, so the board
  // spreads load rather than piling duties on the first eligible name.
  const totalDuties = duties.length;
  const score =
    100 -
    totalDuties * 8 -
    sameDay * 15 -
    (GRADE_RANK[official.grade ?? ''] ?? 5) -
    issues.filter((i) => i.severity === 'soft').length * 20;

  return {
    official,
    role,
    issues,
    assignable: !issues.some((i) => i.severity === 'hard'),
    score,
  };
}

/** §12.8 — the assignment board's candidate list for one seat. */
export function rankCandidates(ctx: AssignmentContext, role: string): CandidateAssessment[] {
  return ctx.pool
    .map((o) => assessCandidate(ctx, o, role))
    .sort((a, b) => Number(b.assignable) - Number(a.assignable) || b.score - a.score);
}

export interface AutoAssignResult {
  assignments: OfficialAssignment[];
  /** Seats the engine could not fill, with the reason each candidate failed. */
  unfilled: { role: string; needed: number; filled: number; reasons: string[] }[];
}

/**
 * §6.5 — fill a match's full panel from the pool. Seats are filled
 * best-candidate-first; every unfilled seat is reported with the reasons so the
 * Competition Manager can see whether it is a pool gap or a rule block.
 */
export function autoAssignOfficials(ctx: AssignmentContext): AutoAssignResult {
  const sport = getSport(ctx.sportId);
  const assignments: OfficialAssignment[] = [];
  const unfilled: AutoAssignResult['unfilled'] = [];
  let working = [...ctx.existing];

  for (const seat of sport.officials.panel) {
    let filled = 0;
    const reasons: string[] = [];
    for (let i = 0; i < seat.count; i++) {
      const ranked = rankCandidates({ ...ctx, existing: working }, seat.role);
      const pick = ranked.find((c) => c.assignable);
      if (!pick) {
        const top = ranked.slice(0, 3).flatMap((c) => c.issues.filter((x) => x.severity === 'hard').map((x) => x.message));
        reasons.push(...(top.length ? top : ['no official in the pool is certified for this seat']));
        break;
      }
      const a = buildAssignment(ctx, pick.official, seat.role, pick.issues);
      assignments.push(a);
      working = [...working, a];
      filled++;
    }
    if (filled < seat.count) {
      unfilled.push({ role: seat.role, needed: seat.count, filled, reasons: [...new Set(reasons)] });
    }
  }

  return { assignments, unfilled };
}

function buildAssignment(
  ctx: AssignmentContext,
  official: OfficialSnapshot,
  role: string,
  issues: EligibilityIssue[],
): OfficialAssignment {
  const neutralityIssue = issues.find((i) => i.code === 'NEUTRALITY_FAIL');
  const neutrality: OfficialAssignment['neutralityCheckResult'] = !ctx.sideUnits.a && !ctx.sideUnits.b
    ? 'not-applicable'
    : neutralityIssue
      ? ctx.tournament.enforceOfficialNeutrality
        ? 'fail'
        : 'waived'
      : 'pass';

  // Report time: officials report before the fixture, warm-up included.
  let reportTime: ISODateTime | undefined;
  if (ctx.match.scheduledDate && ctx.match.scheduledTime) {
    const d = new Date(`${ctx.match.scheduledDate}T${ctx.match.scheduledTime}:00Z`);
    d.setUTCMinutes(d.getUTCMinutes() - REPORT_BEFORE_MINS);
    reportTime = d.toISOString();
  }

  return {
    assignmentId: newAssignmentId(),
    matchId: ctx.match.matchId,
    officialId: official.officialId,
    officialName: official.name,
    role,
    unitId: official.unitId,
    venueId: ctx.match.venueId,
    reportTime,
    neutralityCheckResult: neutrality,
    status: 'assigned',
    assignedBy: ctx.assignedBy,
    assignedAt: nowISO(),
  };
}

/** Officials report this many minutes before the scheduled start. */
export const REPORT_BEFORE_MINS = 60;

/**
 * §7.3.15 — "Each match must meet its sport's minimum officials template
 * before it can move to Check-in." This is the gate Phase 7 consults.
 */
export function meetsMinimumPanel(
  sportId: string,
  assignments: OfficialAssignment[],
): { ok: boolean; missing: { role: string; needed: number; have: number }[] } {
  const sport = getSport(sportId);
  const live = assignments.filter((a) => a.status !== 'replaced');
  const missing: { role: string; needed: number; have: number }[] = [];
  for (const need of sport.officials.minimumToStart) {
    const have = live.filter((a) => a.role === need.role).length;
    if (have < need.count) missing.push({ role: need.role, needed: need.count, have });
  }
  return { ok: missing.length === 0, missing };
}

/**
 * §8 exception 11-adjacent: replace an official. The old assignment is kept as
 * 'replaced' rather than deleted, so the duty roster history stays intact.
 */
export function replaceOfficial(
  ctx: AssignmentContext,
  assignmentId: string,
  replacement: OfficialSnapshot,
  reasonCode: string,
): { assignments: OfficialAssignment[]; error?: string } {
  const old = ctx.existing.find((a) => a.assignmentId === assignmentId);
  if (!old) return { assignments: ctx.existing, error: `no assignment ${assignmentId}` };
  if (!reasonCode?.trim()) {
    return { assignments: ctx.existing, error: 'replacing an official requires a reason code (§6)' };
  }
  const assessment = assessCandidate(ctx, replacement, old.role);
  if (!assessment.assignable) {
    return {
      assignments: ctx.existing,
      error: `replacement rejected — ${assessment.issues
        .filter((i) => i.severity === 'hard')
        .map((i) => i.message)
        .join('; ')}`,
    };
  }
  const fresh = buildAssignment(ctx, replacement, old.role, assessment.issues);
  return {
    assignments: [
      ...ctx.existing.map((a) => (a.assignmentId === assignmentId ? { ...a, status: 'replaced' as const } : a)),
      fresh,
    ],
  };
}

/** §10.5 official duty roster, grouped per official. */
export function dutyRoster(
  assignments: OfficialAssignment[],
  matches: Match[],
): {
  officialId: string;
  officialName: string;
  duties: {
    matchNo: string;
    role: string;
    date?: ISODate;
    time?: string;
    venueId?: string;
    fopId?: string;
    reportTime?: ISODateTime;
    neutrality: OfficialAssignment['neutralityCheckResult'];
    status: OfficialAssignment['status'];
  }[];
}[] {
  const byMatch = new Map(matches.map((m) => [m.matchId, m]));
  const grouped = new Map<string, { name: string; duties: ReturnType<typeof dutyRoster>[number]['duties'] }>();
  for (const a of assignments) {
    const m = byMatch.get(a.matchId);
    const g = grouped.get(a.officialId) ?? { name: a.officialName, duties: [] };
    g.duties.push({
      matchNo: m?.matchNo ?? a.matchId,
      role: a.role,
      date: m?.scheduledDate,
      time: m?.scheduledTime,
      venueId: a.venueId ?? m?.venueId,
      fopId: m?.fopId,
      reportTime: a.reportTime,
      neutrality: a.neutralityCheckResult,
      status: a.status,
    });
    grouped.set(a.officialId, g);
  }
  return [...grouped.entries()].map(([officialId, g]) => ({
    officialId,
    officialName: g.name,
    duties: g.duties.sort((x, y) => `${x.date}${x.time}`.localeCompare(`${y.date}${y.time}`)),
  }));
}

/** §9.2 "Officials coverage: matches missing minimum officials in next 24/48 hrs". */
export function coverageGaps(
  sportId: string,
  matches: Match[],
  assignments: OfficialAssignment[],
  withinHours = 48,
  now = new Date(),
): { matchNo: string; date?: ISODate; time?: string; missing: { role: string; needed: number; have: number }[] }[] {
  const horizon = new Date(now.getTime() + withinHours * 3600_000);
  return matches
    .filter((m) => !m.byeFlag && m.scheduledDate && m.scheduledTime)
    .filter((m) => {
      const at = new Date(`${m.scheduledDate}T${m.scheduledTime}:00Z`);
      return at >= now && at <= horizon;
    })
    .map((m) => ({
      matchNo: m.matchNo,
      date: m.scheduledDate,
      time: m.scheduledTime,
      ...meetsMinimumPanel(sportId, assignments.filter((a) => a.matchId === m.matchId)),
    }))
    .filter((r) => !r.ok)
    .map(({ matchNo, date, time, missing }) => ({ matchNo, date, time, missing }));
}
