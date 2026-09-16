/**
 * Exception playbook — §8, all fourteen scenarios.
 *
 * Each handler mirrors one numbered row of the §8 table: the trigger, the
 * system handling, and the deciding role. Two constraints run through all of
 * them:
 *
 *   §6.5   every terminal or exception status requires a reason code;
 *   §7.6.26 destructive or high-impact actions require a second-role approval.
 *
 * Handlers return the state change plus the audit writes and the exception
 * record, so nothing can be applied without leaving the trail §10.12 reports on.
 */

import type {
  ExceptionRecord,
  ISODateTime,
  Match,
  MatchOperations,
  MatchStatus,
  Result,
  Tournament,
  User,
} from '../domain/types.ts';
import type { AuditWrite } from '../domain/audit.ts';
import { newExceptionId, nowISO } from '../domain/ids.ts';
import { requiresSecondApproval, type HighImpactAction } from '../domain/rbac.ts';
import { MATCH_MACHINE, transition } from '../domain/status.ts';

export interface ExceptionOutcome {
  ok: boolean;
  error?: string;
  match?: Match;
  result?: Result;
  operations?: MatchOperations;
  exception?: ExceptionRecord;
  audit: AuditWrite[];
  /** Follow-on work the caller must run, named so nothing is silently skipped. */
  followUps?: string[];
}

function bad(error: string): ExceptionOutcome {
  return { ok: false, error, audit: [] };
}

function record(
  scenario: ExceptionRecord['scenario'],
  user: User,
  tournament: Tournament,
  detail: string,
  reasonCode: string,
  matchId?: string,
  eventId?: string,
  ratifiedBy?: string,
): ExceptionRecord {
  return {
    exceptionId: newExceptionId(),
    scenario,
    matchId,
    eventId,
    tournamentId: tournament.tournamentId,
    reasonCode,
    detail,
    decidedBy: user.userId,
    decidedByRole: user.role,
    ratifiedBy,
    at: nowISO(),
  };
}

function auditWrite(
  user: User,
  tournament: Tournament,
  entityType: string,
  entityId: string,
  action: string,
  extra: Partial<AuditWrite> = {},
): AuditWrite {
  return {
    userId: user.userId,
    userName: user.name,
    role: user.role,
    tournamentId: tournament.tournamentId,
    entityType,
    entityId,
    action,
    ...extra,
  };
}

/** Move a match's status through the §6.2 machine, with a reason code. */
function moveMatch(
  match: Match,
  to: MatchStatus,
  reasonCode: string,
): { ok: true; match: Match } | { ok: false; error: string } {
  const t = transition(MATCH_MACHINE, { from: match.matchStatus, to, reasonCode });
  if (!t.ok) return { ok: false, error: t.error as string };
  return { ok: true, match: { ...match, matchStatus: to } };
}

// ─── 1. Walkover ─────────────────────────────────────────────────────────────

/**
 * §8 exception 1 — one side concedes before the start. The Technical Official
 * confirms; the auto-result comes from the sport template via
 * `buildWalkoverResult` in the approval workflow.
 */
export function walkover(
  user: User,
  match: Match,
  tournament: Tournament,
  winningSide: 'A' | 'B',
  reasonCode: string,
  detail: string,
): ExceptionOutcome {
  if (user.role !== 'Technical Official' && user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
    return bad(`a walkover is confirmed by the Technical Official; ${user.role} may not (§8 exception 1)`);
  }
  if (!reasonCode?.trim()) return bad('a walkover requires a reason code (§6.2)');
  const moved = moveMatch(match, 'Walkover', reasonCode);
  if (!moved.ok) return bad(moved.error);
  return {
    ok: true,
    match: moved.match,
    exception: record('walkover', user, tournament, detail, reasonCode, match.matchId, match.eventId),
    audit: [
      auditWrite(user, tournament, 'match', match.matchId, 'match.walkover', {
        oldValue: match.matchStatus,
        newValue: 'Walkover',
        reasonCode,
      }),
    ],
    followUps: [
      'generate the sport-standard walkover result (buildWalkoverResult) and run it through verification and approval',
      'propagate the winner into the next-round slot',
      'recompute standings for the group',
    ],
  };
}

// ─── 2. No-show ──────────────────────────────────────────────────────────────

/**
 * §8 exception 2 — the no-show deadline expires. Treated as a walkover, and
 * the unit is flagged for repeat-offence tracking (§7.4.20 sanction flags).
 */
export function noShow(
  user: User,
  match: Match,
  operations: MatchOperations,
  tournament: Tournament,
  absentSide: 'A' | 'B',
  now = new Date(),
): ExceptionOutcome {
  if (!operations.noShowDeadline) {
    return bad('no no-show timer was started for this match; confirm attendance first (§7.2)');
  }
  if (new Date(operations.noShowDeadline) > now) {
    const mins = Math.ceil((new Date(operations.noShowDeadline).getTime() - now.getTime()) / 60_000);
    return bad(`the no-show deadline has not expired yet — ${mins} min remaining (§7.2)`);
  }
  const present = absentSide === 'A' ? 'B' : 'A';
  const absentUnit = operations.attendance.find((a) => a.side === absentSide)?.participantName ?? absentSide;
  const out = walkover(
    user,
    match,
    tournament,
    present,
    'NO_SHOW',
    `${absentUnit} did not appear by the no-show deadline ${operations.noShowDeadline}; walkover awarded to side ${present}`,
  );
  if (!out.ok) return out;
  return {
    ...out,
    exception: out.exception ? { ...out.exception, scenario: 'no-show' } : undefined,
    followUps: [
      ...(out.followUps ?? []),
      'flag the absent unit for repeat-offence tracking; repeated no-shows can trigger a tournament-level sanction (§7.4.20)',
    ],
  };
}

/** §7.2 — start the no-show timer at attendance confirmation. */
export function startNoShowTimer(
  operations: MatchOperations,
  graceMins: number,
  from = new Date(),
): MatchOperations {
  const deadline = new Date(from.getTime() + graceMins * 60_000).toISOString();
  return { ...operations, noShowDeadline: deadline as ISODateTime };
}

// ─── 3. Disqualification ─────────────────────────────────────────────────────

/**
 * §8 exception 3 — rule violation, doping, or ineligibility discovered.
 *
 * Where ineligibility is discovered the document requires that "all affected
 * prior results recomputed (forfeits cascaded); medals re-allocated if needed",
 * and that the Admin approves the cascade. That cascade is a high-impact action,
 * so it needs a second-role ratification.
 */
export function disqualification(
  user: User,
  match: Match,
  tournament: Tournament,
  input: {
    disqualifiedEntryId: string;
    reasonCode: string;
    detail: string;
    /** True when the ground invalidates earlier matches too. */
    cascadePriorResults: boolean;
    ratifiedBy?: string;
  },
): ExceptionOutcome {
  if (user.role !== 'Technical Official' && user.role !== 'Jury of Appeal' && user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
    return bad(`a disqualification is ruled by a Technical Official or the Jury; ${user.role} may not (§8 exception 3)`);
  }
  if (!input.reasonCode?.trim()) return bad('a disqualification requires a reason code (§6.2)');

  if (input.cascadePriorResults) {
    const second = requiresSecondApproval(
      'dq-cascade' as HighImpactAction,
      user.userId,
      input.ratifiedBy,
      input.reasonCode,
    );
    if (!second.allowed) return bad(second.reason);
  }

  const moved = moveMatch(match, 'Disqualified', input.reasonCode);
  if (!moved.ok) return bad(moved.error);

  return {
    ok: true,
    match: moved.match,
    exception: record(
      'disqualification',
      user,
      tournament,
      input.detail,
      input.reasonCode,
      match.matchId,
      match.eventId,
      input.ratifiedBy,
    ),
    audit: [
      auditWrite(user, tournament, 'match', match.matchId, 'match.disqualify', {
        oldValue: match.matchStatus,
        newValue: 'Disqualified',
        reasonCode: input.reasonCode,
      }),
      auditWrite(user, tournament, 'entry', input.disqualifiedEntryId, 'entry.disqualify', {
        newValue: input.detail,
        reasonCode: input.reasonCode,
      }),
    ],
    followUps: input.cascadePriorResults
      ? [
          'run the post-lock correction workflow on every prior result involving the disqualified side, cascading forfeits (§8.3)',
          'recompute standings and progression for every affected group and bracket path',
          'reallocate medals and obtain a Jury ruling where a joint medal is involved (§8 exception 3)',
        ]
      : ['record the result per sport rule and propagate the outcome'],
  };
}

// ─── 4. Postponed match ──────────────────────────────────────────────────────

/** §8 exception 4 — weather, venue failure, medical, force majeure. */
export function postpone(
  user: User,
  match: Match,
  tournament: Tournament,
  reasonCode: string,
  detail: string,
  approvedBy: string | undefined,
): ExceptionOutcome {
  if (!reasonCode?.trim()) return bad('a postponement requires a reason code (§6.2)');
  // "Competition Manager proposes, Admin approves."
  if (user.role === 'Competition Manager' && !approvedBy) {
    return bad('a Competition Manager proposes a postponement; a Tournament Admin must approve it (§8 exception 4)');
  }
  const moved = moveMatch(match, 'Postponed', reasonCode);
  if (!moved.ok) return bad(moved.error);
  return {
    ok: true,
    match: moved.match,
    exception: record('postponed', user, tournament, detail, reasonCode, match.matchId, match.eventId, approvedBy),
    audit: [
      auditWrite(user, tournament, 'match', match.matchId, 'match.postpone', {
        oldValue: match.matchStatus,
        newValue: 'Postponed',
        reasonCode,
      }),
    ],
    followUps: [
      'run the reschedule workflow with a full conflict re-check (§6.8)',
      'produce a shift report for dependent fixtures and notify affected parties only',
    ],
  };
}

// ─── 5. Cancelled match or event ─────────────────────────────────────────────

/**
 * §8 exception 5 — insufficient entries, safety, or a ruling. Decided by the
 * Tournament Admin, and high-impact enough to need a second role.
 */
export function cancelMatch(
  user: User,
  match: Match,
  tournament: Tournament,
  reasonCode: string,
  detail: string,
  pointsHandling: 'void' | 'shared',
  ratifiedBy: string | undefined,
): ExceptionOutcome {
  if (user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
    return bad(`cancelling a fixture is a Tournament Admin decision; ${user.role} may not (§8 exception 5)`);
  }
  const second = requiresSecondApproval('cancel-event', user.userId, ratifiedBy, reasonCode);
  if (!second.allowed) return bad(second.reason);
  const moved = moveMatch(match, 'Cancelled', reasonCode);
  if (!moved.ok) return bad(moved.error);
  return {
    ok: true,
    match: moved.match,
    exception: record(
      'cancelled',
      user,
      tournament,
      `${detail} — points handling: ${pointsHandling}`,
      reasonCode,
      match.matchId,
      match.eventId,
      ratifiedBy,
    ),
    audit: [
      auditWrite(user, tournament, 'match', match.matchId, 'match.cancel', {
        oldValue: match.matchStatus,
        newValue: 'Cancelled',
        reasonCode,
      }),
    ],
    followUps:
      pointsHandling === 'shared'
        ? ['record a shared-points result so the points table reflects the ruling, then recompute standings']
        : ['leave the fixture without a result; standings recompute with the match void'],
  };
}

// ─── 6. Tie / draw ───────────────────────────────────────────────────────────

/**
 * §8 exception 6 — level score at full time. The sport template decides what
 * happens: shared points in a league, or extra time then a golden raid in a
 * knockout. The Referee executes; the system does not silently pick a winner.
 */
export function resolveTie(
  match: Match,
  isLeague: boolean,
  tieBreakMode: string,
): { resolution: 'shared-points' | 'extra-time' | 'draw-of-lots'; instruction: string } {
  if (isLeague) {
    return {
      resolution: 'shared-points',
      instruction: `${match.matchNo} is level at full time. League rules apply: points are shared. (${tieBreakMode})`,
    };
  }
  return {
    resolution: 'extra-time',
    instruction: `${match.matchNo} is level at full time and must produce a winner. ${tieBreakMode} The Referee executes; record each phase as it is played.`,
  };
}

// ─── 7. Suspended match ──────────────────────────────────────────────────────

/**
 * §8 exception 7 — rain, light or an operational delay mid-match. State is
 * saved (score, clock, situation) so the match resumes from exactly where it
 * stopped, or the remainder is rescheduled.
 */
export function suspend(
  user: User,
  match: Match,
  operations: MatchOperations,
  tournament: Tournament,
  atClockSecs: number,
  reasonCode: string,
  detail: string,
): ExceptionOutcome {
  if (user.role !== 'Referee' && user.role !== 'Technical Official' && user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
    return bad(`a suspension is called by the Referee with the Technical Official; ${user.role} may not (§8 exception 7)`);
  }
  if (!reasonCode?.trim()) return bad('a suspension requires a reason code (§6.2)');
  const moved = moveMatch(match, 'Suspended', reasonCode);
  if (!moved.ok) return bad(moved.error);
  return {
    ok: true,
    match: moved.match,
    operations: {
      ...operations,
      suspensionLog: [
        ...operations.suspensionLog,
        { fromClockSecs: atClockSecs, reasonCode, decidedBy: user.userId },
      ],
    },
    exception: record('suspended', user, tournament, detail, reasonCode, match.matchId, match.eventId),
    audit: [
      auditWrite(user, tournament, 'match', match.matchId, 'match.suspend', {
        oldValue: match.matchStatus,
        newValue: { status: 'Suspended', atClockSecs },
        reasonCode,
      }),
    ],
    followUps: [
      'resume from the saved state when play can restart, or reschedule the remainder (§6.8)',
    ],
  };
}

/** §8 exception 7 — resume a suspended match from its saved state. */
export function resume(
  user: User,
  match: Match,
  operations: MatchOperations,
  tournament: Tournament,
  atClockSecs: number,
): ExceptionOutcome {
  const moved = moveMatch(match, 'Live', 'RESUME');
  if (!moved.ok) return bad(moved.error);
  const open = operations.suspensionLog.findLast((s) => s.toClockSecs === undefined);
  if (!open) return bad('there is no open suspension to resume from');
  return {
    ok: true,
    match: moved.match,
    operations: {
      ...operations,
      suspensionLog: operations.suspensionLog.map((s) =>
        s === open ? { ...s, toClockSecs: atClockSecs } : s,
      ),
    },
    audit: [
      auditWrite(user, tournament, 'match', match.matchId, 'match.resume', {
        oldValue: 'Suspended',
        newValue: `Live (resumed at ${atClockSecs}s)`,
      }),
    ],
  };
}

// ─── 8. Abandoned match ──────────────────────────────────────────────────────

/**
 * §8 exception 8 — the match cannot be completed or resumed. "Committee
 * decision: replay in full, resume, or award result; decision + basis
 * recorded." The Admin ratifies.
 */
export function abandon(
  user: User,
  match: Match,
  tournament: Tournament,
  input: {
    reasonCode: string;
    detail: string;
    committeeDecision: 'replay' | 'award-result' | 'void';
    awardedTo?: 'A' | 'B';
    ratifiedBy?: string;
  },
): ExceptionOutcome {
  if (!input.reasonCode?.trim()) return bad('abandoning a match requires a reason code (§6.2)');
  if (!input.ratifiedBy) {
    return bad('an abandonment ruling must be ratified by the Tournament Admin (§8 exception 8)');
  }
  if (input.committeeDecision === 'award-result' && !input.awardedTo) {
    return bad('awarding the result requires naming the side it is awarded to');
  }
  const moved = moveMatch(match, 'Abandoned', input.reasonCode);
  if (!moved.ok) return bad(moved.error);
  return {
    ok: true,
    match: moved.match,
    exception: record(
      'abandoned',
      user,
      tournament,
      `${input.detail} — committee decision: ${input.committeeDecision}${input.awardedTo ? ` (awarded to side ${input.awardedTo})` : ''}`,
      input.reasonCode,
      match.matchId,
      match.eventId,
      input.ratifiedBy,
    ),
    audit: [
      auditWrite(user, tournament, 'match', match.matchId, 'match.abandon', {
        oldValue: match.matchStatus,
        newValue: `Abandoned (${input.committeeDecision})`,
        reasonCode: input.reasonCode,
      }),
    ],
    followUps:
      input.committeeDecision === 'replay'
        ? ['schedule the replay as a new fixture version with a full conflict re-check']
        : input.committeeDecision === 'award-result'
          ? ['record the awarded result and run it through verification and approval']
          : ['leave the fixture void; standings recompute without it'],
  };
}

// ─── 11. Participant / team change ───────────────────────────────────────────

/**
 * §8 exception 11 — injury replacement or roster change. "Allowed only from
 * approved reserve list, before event-specific lock point (e.g. before first
 * match); eligibility re-validated; logged."
 */
export function participantChange(
  user: User,
  tournament: Tournament,
  input: {
    entryId: string;
    outgoingRef: string;
    incomingRef: string;
    incomingIsApprovedReserve: boolean;
    eligibilityPassed: boolean;
    firstMatchStarted: boolean;
    reasonCode: string;
    approvedBy?: string;
  },
): ExceptionOutcome {
  if (!input.reasonCode?.trim()) return bad('a participant change requires a reason code (§6.2)');
  if (input.firstMatchStarted) {
    return bad(
      'the event-specific lock point has passed: a participant change is only allowed before the first match (§8 exception 11)',
    );
  }
  if (!input.incomingIsApprovedReserve) {
    return bad('replacements may only come from the approved reserve list (§8 exception 11)');
  }
  if (!input.eligibilityPassed) {
    return bad('the incoming participant failed eligibility re-validation (§8 exception 11)');
  }
  if (user.role === 'Competition Manager' && !input.approvedBy) {
    return bad('a Competition Manager proposes a participant change; Tournament Admin approval is required (§8 exception 11)');
  }
  return {
    ok: true,
    exception: record(
      'participant-change',
      user,
      tournament,
      `${input.outgoingRef} replaced by ${input.incomingRef} on entry ${input.entryId}`,
      input.reasonCode,
      undefined,
      undefined,
      input.approvedBy,
    ),
    audit: [
      auditWrite(user, tournament, 'entry', input.entryId, 'entry.participant-change', {
        oldValue: input.outgoingRef,
        newValue: input.incomingRef,
        reasonCode: input.reasonCode,
      }),
    ],
  };
}

// ─── 13. Weather / operational delay (day level) ──────────────────────────────

/**
 * §8 exception 13 — a session is lost. The session-shift tool compresses the
 * remaining grid; reduced rest gaps are flagged for acknowledgment rather than
 * applied silently.
 */
export function sessionShift(
  user: User,
  tournament: Tournament,
  input: {
    date: string;
    shiftMins: number;
    reasonCode: string;
    detail: string;
    approvedBy?: string;
    /** Soft conflicts the shift introduces, which must be acknowledged. */
    introducedSoftConflicts: string[];
    acknowledged: boolean;
  },
): ExceptionOutcome {
  if (!input.reasonCode?.trim()) return bad('a session shift requires a reason code (§6.2)');
  if (user.role === 'Competition Manager' && !input.approvedBy) {
    return bad('a session shift needs Tournament Admin approval (§8 exception 13)');
  }
  if (input.introducedSoftConflicts.length && !input.acknowledged) {
    return bad(
      `this shift reduces rest gaps below the recommendation: ${input.introducedSoftConflicts.join('; ')}. Explicit acknowledgment is required before it can be applied (§7.2.11)`,
    );
  }
  return {
    ok: true,
    exception: record(
      'weather-delay',
      user,
      tournament,
      `${input.detail} — remaining grid on ${input.date} shifted by ${input.shiftMins} min`,
      input.reasonCode,
      undefined,
      undefined,
      input.approvedBy,
    ),
    audit: [
      auditWrite(user, tournament, 'schedule', input.date, 'schedule.session-shift', {
        newValue: { shiftMins: input.shiftMins, acknowledgedSoftConflicts: input.introducedSoftConflicts },
        reasonCode: input.reasonCode,
      }),
    ],
    followUps: ['re-run the conflict report and notify every affected party'],
  };
}

// ─── 14. Data / system outage during a match ─────────────────────────────────

/**
 * §8 exception 14 — live entry is impossible. The paper scoresheet is the
 * fallback; the post-facto entry is marked as an offline entry, and
 * verification is mandatory before approval.
 *
 * Verification is already mandatory for every result, so what this adds is the
 * offline marker on each event and an explicit note in the audit trail.
 */
export function offlineEntry(
  user: User,
  match: Match,
  operations: MatchOperations,
  tournament: Tournament,
  input: { reasonCode: string; detail: string; scoresheetRef: string },
): ExceptionOutcome {
  if (!input.reasonCode?.trim()) return bad('an offline entry requires a reason code (§6.2)');
  if (!input.scoresheetRef?.trim()) {
    return bad('an offline entry must reference the signed paper scoresheet it was transcribed from (§8 exception 14)');
  }
  return {
    ok: true,
    operations: {
      ...operations,
      scoreEvents: operations.scoreEvents.map((e) => ({ ...e, offlineEntry: true })),
    },
    exception: record(
      'system-outage',
      user,
      tournament,
      `${input.detail} — transcribed from scoresheet ${input.scoresheetRef}`,
      input.reasonCode,
      match.matchId,
      match.eventId,
    ),
    audit: [
      auditWrite(user, tournament, 'match', match.matchId, 'match.offline-entry', {
        newValue: { scoresheetRef: input.scoresheetRef, events: operations.scoreEvents.length },
        reasonCode: input.reasonCode,
      }),
    ],
    followUps: [
      'verification by a Technical Official against the signed scoresheet is mandatory before approval (§8 exception 14)',
    ],
  };
}

/** §10.12 exception and protest register. */
export function exceptionRegister(
  records: ExceptionRecord[],
  filter: { scenario?: ExceptionRecord['scenario']; eventId?: string } = {},
): ExceptionRecord[] {
  return records
    .filter((r) => !filter.scenario || r.scenario === filter.scenario)
    .filter((r) => !filter.eventId || r.eventId === filter.eventId)
    .sort((a, b) => b.at.localeCompare(a.at));
}
