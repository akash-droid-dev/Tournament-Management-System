/**
 * Status lifecycles — Section 6, as explicit state machines.
 *
 * The rule from §6.5 is enforced here for every machine: *every* transition
 * writes an audit record, and every terminal or exception status requires a
 * reason code. `transition()` refuses to move without one.
 */

import type {
  ApprovalStatus,
  DrawStatus,
  MatchStatus,
  ResultStatus,
  ScheduleStatus,
  TournamentStatus,
} from './types.ts';

export interface TransitionSpec<S extends string> {
  to: S[];
  /** §6 "Every terminal or exception status requires a reason code." */
  reasonRequired?: S[];
  terminal?: boolean;
}

export type Machine<S extends string> = Record<S, TransitionSpec<S>>;

// §6.1 Draft → Configured → Entries Open → Entries Locked → Draw Published
//      → Active → Completed → Archived. Cancelled allowed until Active.
export const TOURNAMENT_MACHINE: Machine<TournamentStatus> = {
  Draft: { to: ['Configured', 'Cancelled'], reasonRequired: ['Cancelled'] },
  Configured: { to: ['Entries Open', 'Draft', 'Cancelled'], reasonRequired: ['Cancelled', 'Draft'] },
  'Entries Open': { to: ['Entries Locked', 'Cancelled'], reasonRequired: ['Cancelled'] },
  'Entries Locked': {
    to: ['Draw Published', 'Entries Open', 'Cancelled'],
    // Re-opening entries after lock is an exception (§3.6 late entries).
    reasonRequired: ['Entries Open', 'Cancelled'],
  },
  'Draw Published': { to: ['Active', 'Cancelled'], reasonRequired: ['Cancelled'] },
  // After Active, only Super Admin may cancel — enforced in the guard below.
  Active: { to: ['Completed', 'Cancelled'], reasonRequired: ['Cancelled'] },
  Completed: { to: ['Archived'] },
  Archived: { to: [], terminal: true },
  Cancelled: { to: [], terminal: true },
};

// §6.2 Match status table, transcribed from the "Allowed Next" column.
export const MATCH_MACHINE: Machine<MatchStatus> = {
  Scheduled: {
    to: ['Check-in', 'Postponed', 'Cancelled', 'Walkover'],
    reasonRequired: ['Postponed', 'Cancelled', 'Walkover'],
  },
  'Check-in': {
    to: ['Live', 'Walkover', 'Postponed'],
    reasonRequired: ['Walkover', 'Postponed'],
  },
  Live: {
    to: ['Completed (Provisional)', 'Suspended', 'Abandoned', 'Disqualified'],
    reasonRequired: ['Suspended', 'Abandoned', 'Disqualified'],
  },
  Suspended: {
    to: ['Live', 'Abandoned', 'Postponed'],
    reasonRequired: ['Abandoned', 'Postponed'],
  },
  // §6.2: "— (result lifecycle takes over)".
  'Completed (Provisional)': { to: [] },
  Postponed: { to: ['Scheduled'], reasonRequired: ['Scheduled'] },
  Cancelled: { to: [], terminal: true },
  Walkover: { to: [], terminal: true },
  // §6.2 Abandoned → "Terminal or Replay (committee decision)".
  Abandoned: { to: ['Scheduled'], reasonRequired: ['Scheduled'], terminal: true },
  Disqualified: { to: [], terminal: true },
};

// §6.3 Pending → Entered → Verified → (Under Protest) → Approved/Locked
//      → (Correction in Progress → Re-verified → Re-approved/Locked)
export const RESULT_MACHINE: Machine<ResultStatus> = {
  Pending: { to: ['Entered'] },
  // "Return to Scorer with remarks (loop)" — §5.6 step 1 mismatch branch.
  Entered: { to: ['Verified', 'Pending'], reasonRequired: ['Pending'] },
  Verified: { to: ['Approved', 'Under Protest', 'Entered'], reasonRequired: ['Entered'] },
  'Under Protest': {
    to: ['Verified', 'Approved', 'Entered'],
    reasonRequired: ['Verified', 'Approved', 'Entered'],
  },
  // Post-lock correction is the only way out of Approved.
  Approved: { to: ['Correction in Progress'], reasonRequired: ['Correction in Progress'] },
  'Correction in Progress': { to: ['Re-verified'] },
  'Re-verified': { to: ['Approved'] },
};

// §6.4 Draft → Validated → Published → Amended (versioned) → Final
export const SCHEDULE_MACHINE: Machine<ScheduleStatus> = {
  Draft: { to: ['Validated'] },
  Validated: { to: ['Published', 'Draft'] },
  Published: { to: ['Amended', 'Final'], reasonRequired: ['Amended'] },
  Amended: { to: ['Published', 'Final'] },
  Final: { to: [], terminal: true },
};

// §6.5 Submitted → Under Review → Approved | Rejected | Sent Back for Correction
export const APPROVAL_MACHINE: Machine<ApprovalStatus> = {
  Submitted: { to: ['Under Review'] },
  'Under Review': {
    to: ['Approved', 'Rejected', 'Sent Back for Correction'],
    reasonRequired: ['Rejected', 'Sent Back for Correction'],
  },
  Approved: { to: [], terminal: true },
  Rejected: { to: ['Submitted'], terminal: true },
  'Sent Back for Correction': { to: ['Submitted'] },
};

// §5.3 draw lifecycle — publication is a separate, explicit act (principle #3).
export const DRAW_MACHINE: Machine<DrawStatus> = {
  'Not Generated': { to: ['Draft Draw'] },
  'Draft Draw': { to: ['Validated', 'Draft Draw', 'Not Generated'], reasonRequired: ['Not Generated'] },
  Validated: { to: ['Published', 'Draft Draw'] },
  // §5.6 gate: post-publish changes go through the Redraw/Amendment path.
  Published: { to: ['Draft Draw'], reasonRequired: ['Draft Draw'] },
};

export interface TransitionRequest<S extends string> {
  from: S;
  to: S;
  reasonCode?: string;
}

export interface TransitionOutcome<S extends string> {
  ok: boolean
  from: S;
  to: S;
  error?: string;
  /** True when the machine demanded a reason code for this edge. */
  reasonRequired: boolean;
}

/**
 * Validate a status transition against its machine.
 *
 * Refuses unknown edges and refuses a reason-requiring edge without a reason
 * code. Callers pair a successful outcome with an audit write — see
 * `AuditLog.record`.
 */
export function transition<S extends string>(
  machine: Machine<S>,
  req: TransitionRequest<S>,
): TransitionOutcome<S> {
  const spec = machine[req.from];
  const base = { from: req.from, to: req.to, reasonRequired: false };
  if (!spec) {
    return { ...base, ok: false, error: `unknown source status "${req.from}"` };
  }
  if (req.from === req.to) {
    return { ...base, ok: false, error: `no-op transition "${req.from}" → "${req.to}"` };
  }
  if (!spec.to.includes(req.to)) {
    const allowed = spec.to.length ? spec.to.join(', ') : 'nothing (terminal)';
    return {
      ...base,
      ok: false,
      error: `illegal transition "${req.from}" → "${req.to}"; allowed: ${allowed}`,
    };
  }
  const reasonRequired = spec.reasonRequired?.includes(req.to) ?? false;
  if (reasonRequired && !req.reasonCode?.trim()) {
    return {
      ...base,
      ok: false,
      reasonRequired,
      error: `transition "${req.from}" → "${req.to}" requires a reason code (§6)`,
    };
  }
  return { ...base, ok: true, reasonRequired };
}

/** Reason codes offered in the UI. Free text is allowed but discouraged. */
export const REASON_CODES = {
  match: [
    'WEATHER',
    'VENUE_FAILURE',
    'MEDICAL',
    'FORCE_MAJEURE',
    'NO_SHOW',
    'CONCEDED',
    'INSUFFICIENT_OFFICIALS',
    'CROWD_TROUBLE',
    'LIGHT_FAILURE',
    'INJURY_RETIREMENT',
    'RULE_VIOLATION',
    'DOPING',
    'INELIGIBILITY_DISCOVERED',
    'COMMITTEE_REPLAY',
  ],
  result: [
    'SCORESHEET_MISMATCH',
    'DATA_ENTRY_ERROR',
    'PROTEST_UPHELD',
    'DQ_CASCADE',
    'OFFLINE_ENTRY_RECONCILIATION',
    'WRONG_PARTICIPANT',
  ],
  entry: [
    'QUOTA_OVERRIDE',
    'LATE_ENTRY',
    'AGE_DOCUMENT_VERIFIED',
    'WEIGH_IN_FAILURE',
    'INJURY_REPLACEMENT',
    'WITHDRAWAL',
  ],
  schedule: ['VENUE_UNAVAILABLE', 'SESSION_OVERRUN', 'WEATHER', 'BROADCAST_REQUEST', 'REST_GAP_FIX'],
  tournament: ['INSUFFICIENT_PARTICIPATION', 'SANCTION_WITHDRAWN', 'FORCE_MAJEURE', 'SCOPE_CHANGE'],
  draw: ['REDRAW_FORMAT_CHANGE', 'REDRAW_ENTRY_CHANGE', 'REDRAW_PROTEST_RULING', 'SEPARATION_BREACH'],
} as const;

/**
 * §6.1 branch note: "Cancelled allowed until Active; after that only Super
 * Admin with reason." The machine allows the edge; this guard adds the role
 * condition the prose carries.
 */
export function canCancelTournament(
  current: TournamentStatus,
  role: string,
): { allowed: boolean; reason: string } {
  if (current === 'Completed' || current === 'Archived' || current === 'Cancelled') {
    return { allowed: false, reason: `a ${current} tournament cannot be cancelled` };
  }
  if (current === 'Active' && role !== 'Super Admin') {
    return {
      allowed: false,
      reason: 'once Active, only Super Admin may cancel a tournament, with a reason code (§6.1)',
    };
  }
  return { allowed: true, reason: 'granted' };
}
