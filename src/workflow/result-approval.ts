/**
 * Result approval workflow — §5.6, §8.1–8.7 and business rules §7.4.
 *
 * The chain is: enter → verify → (protest window) → approve → LOCK, with a
 * permissioned post-lock correction path. Three rules shape every function
 * here:
 *
 *   §7.4.17 maker–checker: the user who entered a result can never be its
 *           approver. Checked at verify *and* approve.
 *   §7.4.18 approved results lock automatically; edits post-lock only via the
 *           correction workflow (unlock approval + reason + recompute + audit).
 *   §7.6.27 every transition writes an audit entry; the log is append-only.
 *
 * Each function returns the new state plus the audit writes the caller must
 * record, rather than writing them itself — that keeps the workflow pure and
 * testable while making it impossible to forget the audit trail, because the
 * caller receives it as part of the result.
 */

import type {
  CorrectionRecord,
  Match,
  Protest,
  Result,
  Tournament,
  User,
} from '../domain/types.ts';
import type { AuditWrite } from '../domain/audit.ts';
import { newResultId, nowISO } from '../domain/ids.ts';
import { canPublish, canUnlock, enforceMakerChecker, type AccessDecision } from '../domain/rbac.ts';
import { RESULT_MACHINE, transition } from '../domain/status.ts';
import { getSport } from '../sports/registry.ts';

export interface WorkflowOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
  /** Audit writes the caller must commit. Never empty on a successful change. */
  audit: AuditWrite[];
}

function fail<T>(error: string): WorkflowOutcome<T> {
  return { ok: false, error, audit: [] };
}

function audit(
  user: User,
  tournamentId: string,
  entityId: string,
  action: string,
  extra: Partial<AuditWrite> = {},
): AuditWrite {
  return {
    userId: user.userId,
    userName: user.name,
    role: user.role,
    tournamentId,
    entityType: 'result',
    entityId,
    action,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.1 Provisional result entry
// ─────────────────────────────────────────────────────────────────────────────

export interface ResultEntryInput {
  match: Match;
  tournament: Tournament;
  finalScore: { a: number; b: number };
  winnerRef?: string;
  outcomeType: Result['outcomeType'];
  statistics?: Record<string, number>;
  /** §8.14 set when the score came off a paper scoresheet after the fact. */
  offlineEntry?: boolean;
}

/**
 * §8.1 — the Scorer submits the final score and statistics.
 *
 * Refuses a match that has not reached a completed or terminal state, and
 * refuses a scoreline that contradicts the recorded winner.
 */
export function enterResult(
  user: User,
  input: ResultEntryInput,
  existing: Result | undefined,
): WorkflowOutcome<Result> {
  const { match, tournament } = input;
  const allowed = ['Completed (Provisional)', 'Walkover', 'Abandoned', 'Disqualified', 'Cancelled'];
  if (!allowed.includes(match.matchStatus)) {
    return fail(
      `${match.matchNo} is ${match.matchStatus}; a result may only be entered once the match is Completed (Provisional) or has a terminal exception status (§7.8)`,
    );
  }
  if (existing && existing.resultStatus === 'Approved') {
    return fail(
      `${match.matchNo} already has an Approved and locked result; use the correction workflow (§7.4.18)`,
    );
  }

  // A played match must be decided by its score; an exception outcome names
  // the winner explicitly because the score alone does not say.
  if (input.outcomeType === 'played') {
    if (input.finalScore.a === input.finalScore.b && input.winnerRef) {
      return fail('a level score cannot name a winner without a tie-break outcome being recorded first');
    }
    const derived =
      input.finalScore.a > input.finalScore.b
        ? match.sideA
        : input.finalScore.b > input.finalScore.a
          ? match.sideB
          : undefined;
    const derivedId = derived?.kind === 'entry' ? derived.entryId : undefined;
    if (input.winnerRef && derivedId && input.winnerRef !== derivedId) {
      return fail(
        `winner ${input.winnerRef} contradicts the score ${input.finalScore.a}–${input.finalScore.b}, which was won by ${derivedId}`,
      );
    }
  } else if (input.outcomeType !== 'void' && input.outcomeType !== 'abandoned' && !input.winnerRef) {
    return fail(`outcome "${input.outcomeType}" must name the winning side explicitly`);
  }

  const from = existing?.resultStatus ?? 'Pending';
  const t = transition(RESULT_MACHINE, { from, to: 'Entered' });
  if (!t.ok) return fail(t.error as string);

  const result: Result = {
    resultId: existing?.resultId ?? newResultId(),
    matchId: match.matchId,
    eventId: match.eventId,
    finalScore: input.finalScore,
    winnerRef: input.winnerRef,
    outcomeType: input.outcomeType,
    resultStatus: 'Entered',
    statistics: input.statistics,
    enteredBy: user.userId,
    enteredAt: nowISO(),
    correctionHistory: existing?.correctionHistory ?? [],
    // Re-entry after a send-back clears the previous verification.
    verifiedBy: undefined,
    verifiedAt: undefined,
    verificationRemarks: undefined,
  };

  return {
    ok: true,
    value: result,
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'result.enter', {
        oldValue: existing ? { status: from, score: existing.finalScore } : undefined,
        newValue: { status: 'Entered', score: input.finalScore, outcome: input.outcomeType },
        reasonCode: input.offlineEntry ? 'OFFLINE_ENTRY_RECONCILIATION' : undefined,
      }),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.2 Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §8.2 — the Technical Official cross-checks against the signed scoresheet.
 *
 * §8.14 makes verification mandatory for an offline entry, which is already the
 * case: no result reaches Approved without passing through here.
 */
export function verifyResult(
  user: User,
  result: Result,
  tournament: Tournament,
): WorkflowOutcome<Result> {
  const mc = enforceMakerChecker(result.enteredBy, user.userId, 'verify');
  if (!mc.allowed) return fail(mc.reason);
  const t = transition(RESULT_MACHINE, { from: result.resultStatus, to: 'Verified' });
  if (!t.ok) return fail(t.error as string);

  const next: Result = { ...result, resultStatus: 'Verified', verifiedBy: user.userId, verifiedAt: nowISO() };
  return {
    ok: true,
    value: next,
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'result.verify', {
        oldValue: result.resultStatus,
        newValue: 'Verified',
      }),
    ],
  };
}

/** §5.6 — "Mismatch → Return to Scorer with remarks (loop)". */
export function returnToScorer(
  user: User,
  result: Result,
  tournament: Tournament,
  remarks: string,
): WorkflowOutcome<Result> {
  if (!remarks?.trim()) return fail('returning a result to the Scorer requires remarks (§5.6)');
  const t = transition(RESULT_MACHINE, {
    from: result.resultStatus,
    to: result.resultStatus === 'Verified' ? 'Entered' : 'Pending',
    reasonCode: 'SCORESHEET_MISMATCH',
  });
  if (!t.ok) return fail(t.error as string);

  const next: Result = {
    ...result,
    resultStatus: t.to as Result['resultStatus'],
    verificationRemarks: remarks,
    verifiedBy: undefined,
    verifiedAt: undefined,
  };
  return {
    ok: true,
    value: next,
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'result.return-to-scorer', {
        oldValue: result.resultStatus,
        newValue: t.to,
        reasonCode: 'SCORESHEET_MISMATCH',
      }),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.3 Protest window
// ─────────────────────────────────────────────────────────────────────────────

/** §8.3 — is the configurable post-match protest window still open? */
export function protestWindow(
  tournament: Tournament,
  result: Result,
  now = new Date(),
): { open: boolean; closesAt?: string; remainingMins: number } {
  const anchor = result.verifiedAt ?? result.enteredAt;
  if (!anchor) return { open: false, remainingMins: 0 };
  const closes = new Date(new Date(anchor).getTime() + tournament.protestWindowMins * 60_000);
  const remaining = Math.ceil((closes.getTime() - now.getTime()) / 60_000);
  return { open: remaining > 0, closesAt: closes.toISOString(), remainingMins: Math.max(0, remaining) };
}

/**
 * §8.3 — a Team Manager files a protest with the configured fee. The result is
 * held Under Protest, which §7.4.19 uses to freeze the affected bracket path.
 */
export function fileProtest(
  user: User,
  result: Result,
  tournament: Tournament,
  input: { grounds: string; feePaid: number; protestId: string; matchId: string; now?: Date },
): WorkflowOutcome<{ result: Result; protest: Protest }> {
  const win = protestWindow(tournament, result, input.now);
  if (!win.open) {
    return fail(
      `the protest window for this match closed at ${win.closesAt ?? 'an earlier time'} (${tournament.protestWindowMins} min after verification) (§8.3)`,
    );
  }
  if (!input.grounds?.trim()) return fail('a protest must state its grounds');
  if (input.feePaid < tournament.protestFee) {
    return fail(`protest fee of ${tournament.protestFee} is required; ${input.feePaid} was paid (§8.3)`);
  }
  if (!user.scope.unitId) return fail('only a Team Manager with a unit may file a protest');

  const t = transition(RESULT_MACHINE, {
    from: result.resultStatus,
    to: 'Under Protest',
  });
  if (!t.ok) return fail(t.error as string);

  const protest: Protest = {
    protestId: input.protestId,
    matchId: input.matchId,
    eventId: result.eventId,
    filedBy: user.userId,
    filedByUnit: user.scope.unitId,
    filedAt: nowISO(),
    grounds: input.grounds,
    feePaid: input.feePaid,
    status: 'Filed',
  };
  const next: Result = { ...result, resultStatus: 'Under Protest', protestRef: protest.protestId };
  return {
    ok: true,
    value: { result: next, protest },
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'protest.file', {
        oldValue: result.resultStatus,
        newValue: 'Under Protest',
        reasonCode: 'PROTEST_FILED',
      }),
      {
        userId: user.userId,
        userName: user.name,
        role: user.role,
        tournamentId: tournament.tournamentId,
        entityType: 'protest',
        entityId: protest.protestId,
        action: 'protest.file',
        newValue: { grounds: input.grounds, fee: input.feePaid, unit: user.scope.unitId },
      },
    ],
  };
}

/**
 * §8.9 — the Jury rules. Upheld amends the result or orders a replay; rejected
 * forfeits the fee and lets the result proceed.
 */
export function ruleProtest(
  user: User,
  protest: Protest,
  result: Result,
  tournament: Tournament,
  ruling: { outcome: 'Upheld' | 'Rejected'; action: Protest['rulingAction']; text: string },
): WorkflowOutcome<{ protest: Protest; result: Result }> {
  if (user.role !== 'Jury of Appeal' && user.role !== 'Technical Official' && user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
    return fail(`${user.role} may not rule on a protest (§8 exception 9)`);
  }
  if (!ruling.text?.trim()) return fail('a protest ruling must be recorded in writing (§8.9)');
  if (protest.status === 'Upheld' || protest.status === 'Rejected') {
    return fail(`protest ${protest.protestId} is already ${protest.status}`);
  }

  const nextProtest: Protest = {
    ...protest,
    status: ruling.outcome,
    ruling: ruling.text,
    rulingAction: ruling.action,
    ruledBy: user.userId,
    ruledAt: nowISO(),
    feeForfeited: ruling.outcome === 'Rejected',
  };

  // Rejected → the result returns to Verified and proceeds to approval.
  // Upheld → back to Entered so the correction is made and re-verified.
  const to: Result['resultStatus'] = ruling.outcome === 'Rejected' ? 'Verified' : 'Entered';
  const t = transition(RESULT_MACHINE, {
    from: result.resultStatus,
    to,
    reasonCode: 'PROTEST_UPHELD',
  });
  if (!t.ok) return fail(t.error as string);

  const nextResult: Result = {
    ...result,
    resultStatus: to,
    ...(to === 'Entered' ? { verifiedBy: undefined, verifiedAt: undefined } : {}),
  };

  return {
    ok: true,
    value: { protest: nextProtest, result: nextResult },
    audit: [
      {
        userId: user.userId,
        userName: user.name,
        role: user.role,
        tournamentId: tournament.tournamentId,
        entityType: 'protest',
        entityId: protest.protestId,
        action: `protest.${ruling.outcome.toLowerCase()}`,
        oldValue: protest.status,
        newValue: { status: ruling.outcome, action: ruling.action, ruling: ruling.text },
        reasonCode: ruling.outcome === 'Upheld' ? 'PROTEST_UPHELD' : 'PROTEST_REJECTED',
      },
      audit(user, tournament.tournamentId, result.resultId, 'result.protest-ruled', {
        oldValue: result.resultStatus,
        newValue: to,
        reasonCode: 'PROTEST_UPHELD',
      }),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.4 Approval and automatic lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §8.4 — Tournament Admin approves; §7.4.18 locks the result automatically on
 * approval. §8.6 publishes immediately when the tournament is configured for
 * publish-on-approve.
 *
 * The protest window must have closed, otherwise approving would lock a result
 * a Team Manager still has the right to contest.
 */
export function approveResult(
  user: User,
  result: Result,
  tournament: Tournament,
  opts: { now?: Date; overrideProtestWindow?: { reasonCode: string } } = {},
): WorkflowOutcome<Result> {
  const mc = enforceMakerChecker(result.enteredBy, user.userId, 'approve');
  if (!mc.allowed) return fail(mc.reason);

  // §7.4.19 — a result Under Protest cannot be approved until the protest is
  // ruled. Checked before the state machine so the message names the rule
  // rather than reporting a missing reason code.
  if (result.resultStatus === 'Under Protest') {
    return fail(
      `${result.resultId} is Under Protest${result.protestRef ? ` (${result.protestRef})` : ''}; the protest must be ruled by the Jury before the result can be approved (§7.4.19)`,
    );
  }

  // The verifier cannot also be the approver when the chain is 2-step: that
  // would collapse two of the three roles the document separates.
  if (tournament.approvalChainType === '2-step' && result.verifiedBy === user.userId) {
    return fail(
      'a 2-step approval chain requires the verifier and the approver to be different people (§3.2 maker–checker)',
    );
  }
  if (tournament.approvalChainType === '2-step' && !result.verifiedBy) {
    return fail('this tournament uses a 2-step chain; the result must be verified before approval (§1.4)');
  }

  const pub: AccessDecision = canPublish(user);
  if (!pub.allowed) return fail(pub.reason);

  const win = protestWindow(tournament, result, opts.now);
  if (win.open && !opts.overrideProtestWindow) {
    return fail(
      `the protest window is still open for another ${win.remainingMins} min (closes ${win.closesAt}); approving now would lock the result before teams may contest it (§8.3)`,
    );
  }

  const t = transition(RESULT_MACHINE, { from: result.resultStatus, to: 'Approved' });
  if (!t.ok) return fail(t.error as string);

  const at = nowISO();
  const next: Result = {
    ...result,
    resultStatus: 'Approved',
    approvedBy: user.userId,
    approvedAt: at,
    // §7.4.18 — approval locks the result. Not a separate, skippable step.
    lockedAt: at,
    publishedAt: tournament.autoPublishResults ? at : result.publishedAt,
  };

  return {
    ok: true,
    value: next,
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'result.approve', {
        oldValue: result.resultStatus,
        newValue: 'Approved (locked)',
        reasonCode: opts.overrideProtestWindow?.reasonCode,
      }),
      ...(tournament.autoPublishResults
        ? [audit(user, tournament.tournamentId, result.resultId, 'result.publish', { newValue: at })]
        : []),
    ],
  };
}

/** §8.6 — publish as a separate explicit act (design principle #3). */
export function publishResult(
  user: User,
  result: Result,
  tournament: Tournament,
): WorkflowOutcome<Result> {
  const pub = canPublish(user);
  if (!pub.allowed) return fail(pub.reason);
  if (result.resultStatus !== 'Approved') {
    return fail(`only an Approved result may be published; this one is ${result.resultStatus} (§5.8)`);
  }
  if (result.publishedAt) return fail('this result is already published');
  const at = nowISO();
  return {
    ok: true,
    value: { ...result, publishedAt: at },
    audit: [audit(user, tournament.tournamentId, result.resultId, 'result.publish', { newValue: at })],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.7 Post-lock correction
// ─────────────────────────────────────────────────────────────────────────────

export interface CorrectionRequest {
  reasonCode: string;
  /** Who is asking. §8.7: Admin or Competition Manager may initiate. */
  initiatedBy: string;
  newFinalScore?: { a: number; b: number };
  newWinnerRef?: string;
  newOutcomeType?: Result['outcomeType'];
  newStatistics?: Record<string, number>;
}

/**
 * §8.7 step 1 — unlock. Requires Tournament Admin or Super Admin *and* a reason
 * code (§3.2 rule 3), and the initiator cannot self-ratify (§7.6.26).
 */
export function unlockResult(
  user: User,
  result: Result,
  tournament: Tournament,
  req: CorrectionRequest,
): WorkflowOutcome<Result> {
  const u = canUnlock(user, req.reasonCode);
  if (!u.allowed) return fail(u.reason);
  if (req.initiatedBy === user.userId) {
    return fail(
      'a post-lock correction needs a second role: the initiator cannot also approve the unlock (§7.6.26)',
    );
  }
  const t = transition(RESULT_MACHINE, {
    from: result.resultStatus,
    to: 'Correction in Progress',
    reasonCode: req.reasonCode,
  });
  if (!t.ok) return fail(t.error as string);

  return {
    ok: true,
    value: { ...result, resultStatus: 'Correction in Progress' },
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'result.unlock', {
        oldValue: 'Approved (locked)',
        newValue: 'Correction in Progress',
        reasonCode: req.reasonCode,
      }),
    ],
  };
}

/**
 * §8.7 step 2 — apply the correction, storing old and new values for every
 * field touched, plus both approvers and the reason code (§13.6
 * correction_history).
 */
export function applyCorrection(
  user: User,
  result: Result,
  tournament: Tournament,
  req: CorrectionRequest,
  unlockedBy: string,
): WorkflowOutcome<Result> {
  if (result.resultStatus !== 'Correction in Progress') {
    return fail(`the result must be unlocked first; it is ${result.resultStatus} (§8.7)`);
  }
  const changes: CorrectionRecord[] = [];
  const at = nowISO();
  const record = (field: string, oldValue: unknown, newValue: unknown) => {
    changes.push({
      field,
      oldValue: JSON.stringify(oldValue),
      newValue: JSON.stringify(newValue),
      reasonCode: req.reasonCode,
      unlockedBy,
      approvedBy: user.userId,
      unlockedAt: at,
    });
  };

  const next: Result = { ...result };
  if (req.newFinalScore && (req.newFinalScore.a !== result.finalScore.a || req.newFinalScore.b !== result.finalScore.b)) {
    record('finalScore', result.finalScore, req.newFinalScore);
    next.finalScore = req.newFinalScore;
  }
  if (req.newWinnerRef !== undefined && req.newWinnerRef !== result.winnerRef) {
    record('winnerRef', result.winnerRef, req.newWinnerRef);
    next.winnerRef = req.newWinnerRef;
  }
  if (req.newOutcomeType && req.newOutcomeType !== result.outcomeType) {
    record('outcomeType', result.outcomeType, req.newOutcomeType);
    next.outcomeType = req.newOutcomeType;
  }
  if (req.newStatistics) {
    record('statistics', result.statistics, req.newStatistics);
    next.statistics = req.newStatistics;
  }
  if (!changes.length) return fail('no change was supplied; a correction must alter something');

  next.correctionHistory = [...result.correctionHistory, ...changes];
  // A correction must be re-verified and re-approved, so the prior
  // verification and approval are cleared rather than carried forward.
  next.verifiedBy = undefined;
  next.verifiedAt = undefined;
  next.approvedBy = undefined;
  next.approvedAt = undefined;
  next.lockedAt = undefined;
  next.publishedAt = undefined;

  // The edit stays in Correction in Progress: a Technical Official must
  // re-verify it (reVerifyCorrection) before it can be re-approved, so this
  // call deliberately does not advance the status.
  next.resultStatus = 'Correction in Progress';

  return {
    ok: true,
    value: next,
    audit: changes.map((c) =>
      audit(user, tournament.tournamentId, result.resultId, 'result.correct', {
        oldValue: c.oldValue,
        newValue: c.newValue,
        reasonCode: c.reasonCode,
      }),
    ),
  };
}

/** §8.7 step 3 — re-verify a correction before it can be re-approved. */
export function reVerifyCorrection(
  user: User,
  result: Result,
  tournament: Tournament,
): WorkflowOutcome<Result> {
  if (result.resultStatus !== 'Correction in Progress') {
    return fail(`expected a result in Correction in Progress; this one is ${result.resultStatus}`);
  }
  const lastCorrection = result.correctionHistory.at(-1);
  if (lastCorrection && lastCorrection.approvedBy === user.userId) {
    return fail(
      'the user who made the correction cannot re-verify it; a different Technical Official must check it (§7.4.17)',
    );
  }
  const t = transition(RESULT_MACHINE, { from: result.resultStatus, to: 'Re-verified' });
  if (!t.ok) return fail(t.error as string);
  return {
    ok: true,
    value: { ...result, resultStatus: 'Re-verified', verifiedBy: user.userId, verifiedAt: nowISO() },
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'result.re-verify', {
        oldValue: 'Correction in Progress',
        newValue: 'Re-verified',
      }),
    ],
  };
}

/** §8.7 step 4 — re-approve and re-lock. */
export function reApproveCorrection(
  user: User,
  result: Result,
  tournament: Tournament,
): WorkflowOutcome<Result> {
  if (result.resultStatus !== 'Re-verified') {
    return fail(`a correction must be re-verified before re-approval; this one is ${result.resultStatus}`);
  }
  const pub = canPublish(user);
  if (!pub.allowed) return fail(pub.reason);
  if (result.verifiedBy === user.userId) {
    return fail('the re-verifier cannot also re-approve the correction (§7.4.17)');
  }
  const t = transition(RESULT_MACHINE, { from: 'Re-verified', to: 'Approved' });
  if (!t.ok) return fail(t.error as string);
  const at = nowISO();
  return {
    ok: true,
    value: {
      ...result,
      resultStatus: 'Approved',
      approvedBy: user.userId,
      approvedAt: at,
      lockedAt: at,
      publishedAt: tournament.autoPublishResults ? at : undefined,
    },
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'result.re-approve', {
        oldValue: 'Re-verified',
        newValue: 'Approved (locked)',
        reasonCode: result.correctionHistory.at(-1)?.reasonCode,
      }),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §7.4.20 Walkover auto-result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §7.4.20 / §8 exceptions 1–2 — a walkover or no-show auto-generates the
 * sport's standard result. The numbers come from the sport template, so a
 * federation that mandates a nominal score changes configuration, not code.
 */
export function buildWalkoverResult(
  user: User,
  match: Match,
  tournament: Tournament,
  winningSide: 'A' | 'B',
  reasonCode: string,
  sportId: string,
): WorkflowOutcome<Result> {
  if (!reasonCode?.trim()) return fail('a walkover requires a reason code (§6.2)');
  const sport = getSport(sportId);
  const winner = winningSide === 'A' ? match.sideA : match.sideB;
  if (winner.kind !== 'entry') {
    return fail(`side ${winningSide} of ${match.matchNo} is not a confirmed entry, so it cannot be awarded a walkover`);
  }
  const { winnerScore, loserScore } = sport.walkover;
  const result: Result = {
    resultId: newResultId(),
    matchId: match.matchId,
    eventId: match.eventId,
    finalScore:
      winningSide === 'A' ? { a: winnerScore, b: loserScore } : { a: loserScore, b: winnerScore },
    winnerRef: winner.entryId,
    outcomeType: sport.walkover.outcomeType,
    resultStatus: 'Entered',
    enteredBy: user.userId,
    enteredAt: nowISO(),
    correctionHistory: [],
  };
  return {
    ok: true,
    value: result,
    audit: [
      audit(user, tournament.tournamentId, result.resultId, 'result.walkover', {
        newValue: { winner: winner.entryId, score: result.finalScore, note: sport.walkover.note },
        reasonCode,
      }),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue for §12.10
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §12.10 approval queue, plus §9.1's "overdue results (completed > X min
 * without entry)" alert.
 */
export function approvalQueue(
  matches: Match[],
  results: Result[],
  tournament: Tournament,
  overdueMins = 30,
  now = new Date(),
): {
  matchNo: string;
  matchId: string;
  status: Result['resultStatus'] | 'no result';
  enteredBy?: string;
  awaiting: 'entry' | 'verification' | 'protest window' | 'approval' | 'correction' | 'none';
  protestWindowRemainingMins?: number;
  overdue: boolean;
}[] {
  const byMatch = new Map(results.map((r) => [r.matchId, r]));
  return matches
    .filter((m) => !m.byeFlag)
    .filter((m) => ['Completed (Provisional)', 'Walkover', 'Abandoned', 'Disqualified'].includes(m.matchStatus))
    .map((m) => {
      const r = byMatch.get(m.matchId);
      if (!r) {
        return {
          matchNo: m.matchNo,
          matchId: m.matchId,
          status: 'no result' as const,
          awaiting: 'entry' as const,
          overdue: true,
        };
      }
      const win = protestWindow(tournament, r, now);
      const awaiting: 'entry' | 'verification' | 'protest window' | 'approval' | 'correction' | 'none' =
        r.resultStatus === 'Entered'
          ? 'verification'
          : r.resultStatus === 'Verified'
            ? win.open
              ? 'protest window'
              : 'approval'
            : r.resultStatus === 'Under Protest'
              ? 'protest window'
              : r.resultStatus === 'Correction in Progress'
                ? 'correction'
                : r.resultStatus === 'Re-verified'
                  ? 'approval'
                  : 'none';
      const ageMins = r.enteredAt
        ? Math.floor((now.getTime() - new Date(r.enteredAt).getTime()) / 60_000)
        : 0;
      return {
        matchNo: m.matchNo,
        matchId: m.matchId,
        status: r.resultStatus,
        enteredBy: r.enteredBy,
        awaiting,
        protestWindowRemainingMins: win.open ? win.remainingMins : undefined,
        overdue: awaiting !== 'none' && ageMins > overdueMins,
      };
    })
    .filter((row) => row.awaiting !== 'none');
}
