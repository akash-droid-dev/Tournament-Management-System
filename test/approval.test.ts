/**
 * Result approval chain and exception playbook — §5.6, §8 and §7.4.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as ra from '../src/workflow/result-approval.ts';
import * as ex from '../src/workflow/exceptions.ts';
import * as phases from '../src/workflow/phases.ts';
import { kabaddi } from '../src/sports/index.ts';
import { entries, entry, event, format, match, result, tournament, user } from './helpers.ts';

const scorer = user('sc1', 'Scorer');
const techOff = user('to1', 'Technical Official');
const techOff2 = user('to2', 'Technical Official');
const admin = user('ta1', 'Tournament Admin');
const admin2 = user('ta2', 'Tournament Admin');
const superAdmin = user('sa1', 'Super Admin');
const compMgr = user('cm1', 'Competition Manager');
const referee = user('rf1', 'Referee');
const jury = user('ju1', 'Jury of Appeal');
const tmMH = user('tm-mh', 'Team Manager', { unitId: 'MH' });

const T = tournament();
const M = match({ matchStatus: 'Completed (Provisional)' });
/** A timestamp far enough ahead that the protest window has closed. */
const LATER = new Date(Date.now() + 60 * 60_000);

function entered() {
  const out = ra.enterResult(scorer, { match: M, tournament: T, finalScore: { a: 30, b: 25 }, winnerRef: 'ENT-0001', outcomeType: 'played' }, undefined);
  assert.ok(out.ok, out.error);
  return out.value!;
}
function verified() {
  const out = ra.verifyResult(techOff, entered(), T);
  assert.ok(out.ok, out.error);
  return out.value!;
}
function approved() {
  const out = ra.approveResult(admin, verified(), T, { now: LATER });
  assert.ok(out.ok, out.error);
  return out.value!;
}

describe('result entry', () => {
  test('a result cannot be entered before the match is complete', () => {
    const out = ra.enterResult(scorer, { match: match({ matchStatus: 'Live' }), tournament: T, finalScore: { a: 1, b: 0 }, outcomeType: 'played' }, undefined);
    assert.equal(out.ok, false);
    assert.match(out.error!, /Completed \(Provisional\)/);
  });

  test('a winner that contradicts the score is refused', () => {
    const out = ra.enterResult(scorer, { match: M, tournament: T, finalScore: { a: 30, b: 25 }, winnerRef: 'ENT-0002', outcomeType: 'played' }, undefined);
    assert.equal(out.ok, false);
    assert.match(out.error!, /contradicts the score/);
  });

  test('a non-played outcome must name its winner explicitly', () => {
    const out = ra.enterResult(scorer, { match: M, tournament: T, finalScore: { a: 0, b: 0 }, outcomeType: 'retired' }, undefined);
    assert.equal(out.ok, false);
    assert.match(out.error!, /must name the winning side/);
  });

  test('entry writes an audit record', () => {
    const out = ra.enterResult(scorer, { match: M, tournament: T, finalScore: { a: 30, b: 25 }, winnerRef: 'ENT-0001', outcomeType: 'played' }, undefined);
    assert.equal(out.audit.length, 1);
    assert.equal(out.audit[0]!.action, 'result.enter');
    assert.equal(out.audit[0]!.userId, 'sc1');
  });

  test('a locked result cannot be re-entered', () => {
    const out = ra.enterResult(scorer, { match: M, tournament: T, finalScore: { a: 1, b: 0 }, winnerRef: 'ENT-0001', outcomeType: 'played' }, approved());
    assert.equal(out.ok, false);
    assert.match(out.error!, /correction workflow/);
  });
});

describe('maker–checker through the chain', () => {
  test('the enterer cannot verify', () => {
    const out = ra.verifyResult(scorer, entered(), T);
    assert.equal(out.ok, false);
    assert.match(out.error!, /maker–checker/);
  });

  test('the enterer cannot approve', () => {
    const v = verified();
    const out = ra.approveResult(user('sc1', 'Tournament Admin'), v, T, { now: LATER });
    assert.equal(out.ok, false);
    assert.match(out.error!, /maker–checker/);
  });

  test('a two-step chain requires the verifier and the approver to differ', () => {
    const v = verified();
    const out = ra.approveResult(user('to1', 'Tournament Admin'), v, T, { now: LATER });
    assert.equal(out.ok, false);
    assert.match(out.error!, /verifier and the approver to be different/);
  });

  test('a two-step chain refuses an unverified result', () => {
    const out = ra.approveResult(admin, entered(), T, { now: LATER });
    assert.equal(out.ok, false);
  });
});

describe('protest window gates approval', () => {
  test('the window is open immediately after verification', () => {
    const w = ra.protestWindow(T, verified());
    assert.ok(w.open);
    assert.ok(w.remainingMins > 0 && w.remainingMins <= T.protestWindowMins);
  });

  test('approving inside the window is refused', () => {
    const out = ra.approveResult(admin, verified(), T);
    assert.equal(out.ok, false);
    assert.match(out.error!, /protest window is still open/);
  });

  test('approving inside the window is allowed with a recorded reason', () => {
    const out = ra.approveResult(admin, verified(), T, { overrideProtestWindow: { reasonCode: 'BROADCAST_DEADLINE' } });
    assert.ok(out.ok, out.error);
    assert.equal(out.audit[0]!.reasonCode, 'BROADCAST_DEADLINE');
  });

  test('the window closes after the configured minutes', () => {
    assert.equal(ra.protestWindow(T, verified(), LATER).open, false);
  });
});

describe('approval locks automatically', () => {
  test('approval sets the lock in the same step', () => {
    const r = approved();
    assert.equal(r.resultStatus, 'Approved');
    assert.ok(r.lockedAt, 'approval must lock the result, not leave it as a separate step');
  });

  test('publishing is a separate act unless the tournament says otherwise', () => {
    assert.equal(approved().publishedAt, undefined);
    const auto = ra.approveResult(admin, verified(), tournament({ autoPublishResults: true }), { now: LATER });
    assert.ok(auto.value!.publishedAt);
  });

  test('only an admin may publish', () => {
    const out = ra.publishResult(compMgr, approved(), T);
    assert.equal(out.ok, false);
    assert.match(out.error!, /restricted to Tournament Admin/);
  });

  test('an unapproved result cannot be published', () => {
    const out = ra.publishResult(admin, verified(), T);
    assert.equal(out.ok, false);
    assert.match(out.error!, /only an Approved result/);
  });
});

describe('return to scorer', () => {
  test('returning requires remarks', () => {
    const out = ra.returnToScorer(techOff, verified(), T, '');
    assert.equal(out.ok, false);
    assert.match(out.error!, /requires remarks/);
  });

  test('returning clears the verification and records the remarks', () => {
    const out = ra.returnToScorer(techOff, verified(), T, 'Half-time score does not match the sheet');
    assert.ok(out.ok, out.error);
    assert.equal(out.value!.resultStatus, 'Entered');
    assert.equal(out.value!.verifiedBy, undefined);
    assert.match(out.value!.verificationRemarks!, /Half-time score/);
  });
});

describe('protests', () => {
  const fileIt = (over = {}) =>
    ra.fileProtest(tmMH, verified(), T, { grounds: 'Substitution after the suspension expired', feePaid: T.protestFee, protestId: 'PRT-1', matchId: M.matchId, ...over });

  test('an underpaid fee is refused', () => {
    const out = fileIt({ feePaid: 100 });
    assert.equal(out.ok, false);
    assert.match(out.error!, /protest fee/);
  });

  test('grounds are required', () => {
    const out = fileIt({ grounds: '' });
    assert.equal(out.ok, false);
  });

  test('a protest after the window has closed is refused', () => {
    const out = fileIt({ now: LATER });
    assert.equal(out.ok, false);
    assert.match(out.error!, /window for this match closed/);
  });

  test('a filed protest holds the result Under Protest', () => {
    const out = fileIt();
    assert.ok(out.ok, out.error);
    assert.equal(out.value!.result.resultStatus, 'Under Protest');
    assert.equal(out.value!.protest.status, 'Filed');
    assert.equal(out.value!.protest.filedByUnit, 'MH');
  });

  test('a result Under Protest cannot be approved, and the message cites the rule', () => {
    const filed = fileIt().value!;
    const out = ra.approveResult(admin, filed.result, T, { now: LATER });
    assert.equal(out.ok, false);
    assert.match(out.error!, /§7\.4\.19/);
  });

  test('a rejected protest forfeits the fee and lets the result proceed', () => {
    const filed = fileIt().value!;
    const out = ra.ruleProtest(jury, filed.protest, filed.result, T, { outcome: 'Rejected', action: 'no-change', text: 'Accreditation verified; rejected.' });
    assert.ok(out.ok, out.error);
    assert.equal(out.value!.protest.feeForfeited, true);
    assert.equal(out.value!.result.resultStatus, 'Verified');
  });

  test('an upheld protest sends the result back for correction', () => {
    const filed = fileIt().value!;
    const out = ra.ruleProtest(jury, filed.protest, filed.result, T, { outcome: 'Upheld', action: 'amend-result', text: 'Point in the 34th minute reversed.' });
    assert.ok(out.ok, out.error);
    assert.equal(out.value!.result.resultStatus, 'Entered');
    assert.equal(out.value!.result.verifiedBy, undefined);
  });

  test('a ruling must be recorded in writing', () => {
    const filed = fileIt().value!;
    const out = ra.ruleProtest(jury, filed.protest, filed.result, T, { outcome: 'Rejected', action: 'no-change', text: '' });
    assert.equal(out.ok, false);
    assert.match(out.error!, /in writing/);
  });

  test('a Scorer may not rule on a protest', () => {
    const filed = fileIt().value!;
    const out = ra.ruleProtest(scorer, filed.protest, filed.result, T, { outcome: 'Rejected', action: 'no-change', text: 'x' });
    assert.equal(out.ok, false);
  });
});

describe('post-lock correction', () => {
  test('an unlock needs a reason code and a second role', () => {
    const r = approved();
    assert.match(ra.unlockResult(admin, r, T, { reasonCode: '', initiatedBy: 'cm1' }).error!, /reason code/);
    assert.match(ra.unlockResult(admin, r, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'ta1' }).error!, /initiator cannot also approve/);
    assert.match(ra.unlockResult(compMgr, r, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'cm1' }).error!, /Tournament Admin or Super Admin/);
    assert.ok(ra.unlockResult(admin, r, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'cm1' }).ok);
  });

  test('the full correction path stores old and new values, both approvers and the reason', () => {
    const locked = approved();
    const unlocked = ra.unlockResult(admin, locked, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'cm1' }).value!;
    const corrected = ra.applyCorrection(admin, unlocked, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'cm1', newFinalScore: { a: 30, b: 28 } }, 'ta1');
    assert.ok(corrected.ok, corrected.error);
    const history = corrected.value!.correctionHistory;
    assert.equal(history.length, 1);
    assert.match(history[0]!.oldValue, /"b":25/);
    assert.match(history[0]!.newValue, /"b":28/);
    assert.equal(history[0]!.reasonCode, 'DATA_ENTRY_ERROR');
    assert.equal(history[0]!.unlockedBy, 'ta1');

    // A correction clears the prior verification, approval, lock and publication.
    assert.equal(corrected.value!.verifiedBy, undefined);
    assert.equal(corrected.value!.approvedBy, undefined);
    assert.equal(corrected.value!.lockedAt, undefined);
    assert.equal(corrected.value!.publishedAt, undefined);

    const reVerified = ra.reVerifyCorrection(techOff2, corrected.value!, T);
    assert.ok(reVerified.ok, reVerified.error);
    const reApproved = ra.reApproveCorrection(admin2, reVerified.value!, T);
    assert.ok(reApproved.ok, reApproved.error);
    assert.equal(reApproved.value!.resultStatus, 'Approved');
    assert.ok(reApproved.value!.lockedAt, 'a re-approved correction must re-lock');
    assert.deepEqual(reApproved.value!.finalScore, { a: 30, b: 28 });
  });

  test('the person who made the correction cannot re-verify it', () => {
    const locked = approved();
    const unlocked = ra.unlockResult(admin, locked, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'cm1' }).value!;
    const corrected = ra.applyCorrection(admin, unlocked, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'cm1', newFinalScore: { a: 31, b: 25 } }, 'ta1').value!;
    const out = ra.reVerifyCorrection(admin, corrected, T);
    assert.equal(out.ok, false);
    assert.match(out.error!, /cannot re-verify/);
  });

  test('a correction that changes nothing is refused', () => {
    const locked = approved();
    const unlocked = ra.unlockResult(admin, locked, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'cm1' }).value!;
    const out = ra.applyCorrection(admin, unlocked, T, { reasonCode: 'DATA_ENTRY_ERROR', initiatedBy: 'cm1', newFinalScore: { a: 30, b: 25 } }, 'ta1');
    assert.equal(out.ok, false);
    assert.match(out.error!, /must alter something/);
  });

  test('a correction cannot be applied without an unlock', () => {
    const out = ra.applyCorrection(admin, approved(), T, { reasonCode: 'X', initiatedBy: 'cm1', newFinalScore: { a: 1, b: 0 } }, 'ta1');
    assert.equal(out.ok, false);
    assert.match(out.error!, /unlocked first/);
  });
});

describe('walkover auto-result', () => {
  test('the score comes from the sport template, not the workflow', () => {
    const out = ra.buildWalkoverResult(scorer, match({ matchStatus: 'Check-in' }), T, 'A', 'CONCEDED', 'kabaddi');
    assert.ok(out.ok, out.error);
    assert.deepEqual(out.value!.finalScore, { a: kabaddi.walkover.winnerScore, b: kabaddi.walkover.loserScore });
    assert.equal(out.value!.outcomeType, 'walkover');
    assert.equal(out.value!.winnerRef, 'ENT-0001');
  });

  test('a walkover requires a reason code', () => {
    assert.equal(ra.buildWalkoverResult(scorer, M, T, 'A', '', 'kabaddi').ok, false);
  });

  test('a walkover cannot be awarded to an unresolved side', () => {
    const m = match({ sideA: { kind: 'placeholder', source: 'winner', matchNo: 'M01', displayName: 'W' } });
    const out = ra.buildWalkoverResult(scorer, m, T, 'A', 'CONCEDED', 'kabaddi');
    assert.equal(out.ok, false);
    assert.match(out.error!, /not a confirmed entry/);
  });
});

describe('approval queue', () => {
  test('classifies what each finished fixture is waiting on', () => {
    const q = ra.approvalQueue([M], [entered()], T);
    assert.equal(q[0]!.awaiting, 'verification');

    const q2 = ra.approvalQueue([M], [verified()], T);
    assert.equal(q2[0]!.awaiting, 'protest window', 'a verified result waits out the window before approval');

    const q3 = ra.approvalQueue([M], [verified()], T, 30, LATER);
    assert.equal(q3[0]!.awaiting, 'approval');

    const q4 = ra.approvalQueue([M], [], T);
    assert.equal(q4[0]!.awaiting, 'entry');
  });

  test('an approved result leaves the queue', () => {
    assert.equal(ra.approvalQueue([M], [approved()], T, 30, LATER).length, 0);
  });

  test('byes and unfinished fixtures never enter the queue', () => {
    assert.equal(ra.approvalQueue([match({ byeFlag: true })], [], T).length, 0);
    assert.equal(ra.approvalQueue([match({ matchStatus: 'Scheduled' })], [], T).length, 0);
  });
});

describe('exception playbook', () => {
  const live = match({ matchStatus: 'Live' });
  const checkin = match({ matchStatus: 'Check-in' });
  const ops = () => ({ matchId: M.matchId, attendance: [], scoreEvents: [], periodScores: [], sanctions: [], suspensionLog: [] });

  test('a walkover is confirmed by the Technical Official, not the Scorer', () => {
    assert.equal(ex.walkover(scorer, checkin, T, 'A', 'CONCEDED', 'x').ok, false);
    assert.ok(ex.walkover(techOff, checkin, T, 'A', 'CONCEDED', 'conceded before start').ok);
  });

  test('a no-show cannot be ruled before the deadline expires', () => {
    const timed = ex.startNoShowTimer(ops(), 15);
    const early = ex.noShow(techOff, checkin, timed, T, 'B');
    assert.equal(early.ok, false);
    assert.match(early.error!, /has not expired yet/);

    const expired = ex.startNoShowTimer(ops(), 15, new Date(Date.now() - 20 * 60_000));
    const out = ex.noShow(techOff, checkin, expired, T, 'B');
    assert.ok(out.ok, out.error);
    assert.equal(out.exception!.scenario, 'no-show');
    assert.match(out.followUps!.join(' '), /repeat-offence/);
  });

  test('a disqualification cascade needs a second-role ratification', () => {
    const base = { disqualifiedEntryId: 'ENT-0002', reasonCode: 'INELIGIBILITY_DISCOVERED', detail: 'Player 7 ineligible', cascadePriorResults: true };
    assert.match(ex.disqualification(techOff, live, T, base).error!, /second-role approval/);
    const out = ex.disqualification(techOff, live, T, { ...base, ratifiedBy: 'ta1' });
    assert.ok(out.ok, out.error);
    assert.equal(out.exception!.ratifiedBy, 'ta1');
    assert.match(out.followUps!.join(' '), /cascading forfeits/);
  });

  test('a postponement proposed by a Competition Manager needs Admin approval', () => {
    assert.match(ex.postpone(compMgr, checkin, T, 'WEATHER', 'rain', undefined).error!, /Tournament Admin must approve/);
    assert.ok(ex.postpone(compMgr, checkin, T, 'WEATHER', 'rain', 'ta1').ok);
  });

  test('cancelling a fixture is an Admin act with a second role', () => {
    // §6.2 allows Cancelled from Scheduled; from Check-in the only exits are
    // Live, Walkover and Postponed, which the machine enforces.
    const scheduled = match({ matchStatus: 'Scheduled' });
    assert.equal(ex.cancelMatch(compMgr, scheduled, T, 'SAFETY', 'x', 'void', 'ta1').ok, false);
    assert.match(ex.cancelMatch(admin, scheduled, T, 'SAFETY', 'x', 'void', undefined).error!, /second-role approval/);
    const ok = ex.cancelMatch(admin, scheduled, T, 'SAFETY', 'crowd trouble', 'void', 'sa1');
    assert.ok(ok.ok, ok.error);
    assert.equal(ok.match!.matchStatus, 'Cancelled');
  });

  test('a fixture already at Check-in cannot be cancelled, only played, walked over or postponed', () => {
    const out = ex.cancelMatch(admin, checkin, T, 'SAFETY', 'x', 'void', 'sa1');
    assert.equal(out.ok, false);
    assert.match(out.error!, /illegal transition "Check-in" → "Cancelled"/);
  });

  test('a suspension saves the clock position, and resuming closes it', () => {
    const s = ex.suspend(referee, live, ops(), T, 900, 'WEATHER', 'rain stopped play');
    assert.ok(s.ok, s.error);
    assert.equal(s.match!.matchStatus, 'Suspended');
    assert.equal(s.operations!.suspensionLog[0]!.fromClockSecs, 900);
    assert.equal(s.operations!.suspensionLog[0]!.toClockSecs, undefined);

    const r = ex.resume(referee, s.match!, s.operations!, T, 1500);
    assert.ok(r.ok, r.error);
    assert.equal(r.match!.matchStatus, 'Live');
    assert.equal(r.operations!.suspensionLog[0]!.toClockSecs, 1500);
  });

  test('resuming with no open suspension is refused', () => {
    assert.equal(ex.resume(referee, match({ matchStatus: 'Suspended' }), ops(), T, 100).ok, false);
  });

  test('an abandonment needs a committee decision and Admin ratification', () => {
    const base = { reasonCode: 'LIGHT_FAILURE', detail: 'floodlights failed' };
    assert.match(ex.abandon(techOff, live, T, { ...base, committeeDecision: 'void' as const }).error!, /ratified by the Tournament Admin/);
    assert.match(ex.abandon(techOff, live, T, { ...base, committeeDecision: 'award-result' as const, ratifiedBy: 'ta1' }).error!, /naming the side/);
    const out = ex.abandon(techOff, live, T, { ...base, committeeDecision: 'replay' as const, ratifiedBy: 'ta1' });
    assert.ok(out.ok, out.error);
    assert.match(out.followUps!.join(' '), /replay/);
  });

  test('a tie in a league shares points; in a knockout it must produce a winner', () => {
    assert.equal(ex.resolveTie(M, true, kabaddi.matchDefaults.tieBreakMode).resolution, 'shared-points');
    assert.equal(ex.resolveTie(M, false, kabaddi.matchDefaults.tieBreakMode).resolution, 'extra-time');
  });

  test('a participant change is allowed only from the reserve list, before the first match', () => {
    const base = { entryId: 'ENT-0001', outgoingRef: 'A1', incomingRef: 'A2', reasonCode: 'INJURY_REPLACEMENT', approvedBy: 'ta1' };
    assert.match(ex.participantChange(compMgr, T, { ...base, incomingIsApprovedReserve: false, eligibilityPassed: true, firstMatchStarted: false }).error!, /approved reserve list/);
    assert.match(ex.participantChange(compMgr, T, { ...base, incomingIsApprovedReserve: true, eligibilityPassed: true, firstMatchStarted: true }).error!, /lock point has passed/);
    assert.match(ex.participantChange(compMgr, T, { ...base, incomingIsApprovedReserve: true, eligibilityPassed: false, firstMatchStarted: false }).error!, /failed eligibility/);
    assert.ok(ex.participantChange(compMgr, T, { ...base, incomingIsApprovedReserve: true, eligibilityPassed: true, firstMatchStarted: false }).ok);
  });

  test('a session shift that shortens rest gaps must be acknowledged', () => {
    const base = { date: '2026-03-11', shiftMins: -45, reasonCode: 'WEATHER', detail: 'morning lost', approvedBy: 'ta1', introducedSoftConflicts: ['MH gets 35 min rest'] };
    assert.match(ex.sessionShift(compMgr, T, { ...base, acknowledged: false }).error!, /Explicit acknowledgment is required/);
    assert.ok(ex.sessionShift(compMgr, T, { ...base, acknowledged: true }).ok);
  });

  test('an offline entry must reference the paper scoresheet', () => {
    const withEvents = { ...ops(), scoreEvents: [{ seq: 1, timestamp: '', clockSecs: 10, type: 'raid-touch', side: 'A' as const, value: 1, enteredBy: 'sc1' }] };
    assert.match(ex.offlineEntry(techOff, M, withEvents, T, { reasonCode: 'SYSTEM_OUTAGE', detail: 'x', scoresheetRef: '' }).error!, /signed paper scoresheet/);
    const out = ex.offlineEntry(techOff, M, withEvents, T, { reasonCode: 'SYSTEM_OUTAGE', detail: 'network down', scoresheetRef: 'SHEET-M01' });
    assert.ok(out.ok, out.error);
    assert.ok(out.operations!.scoreEvents.every((e) => e.offlineEntry));
    assert.match(out.followUps!.join(' '), /mandatory/);
  });

  test('every exception records a reason code and who decided it', () => {
    const out = ex.walkover(techOff, checkin, T, 'A', 'CONCEDED', 'conceded');
    assert.equal(out.exception!.reasonCode, 'CONCEDED');
    assert.equal(out.exception!.decidedBy, 'to1');
    assert.equal(out.exception!.decidedByRole, 'Technical Official');
    assert.ok(out.audit.length > 0, 'an exception must leave an audit trail');
  });
});

describe('phase gates', () => {
  test('tournament validation applies the §5.1 list', () => {
    const bad = phases.validateTournament(tournament({ endDate: '2026-03-01', entryDeadline: '2026-03-20' }), {
      existingCodes: [], organizingBodyExists: false, competitionManagerCount: 0, intendedSportCount: 0,
    });
    assert.equal(bad.open, false);
    const joined = bad.blockers.join(' ');
    assert.match(joined, /end date/);
    assert.match(joined, /entry deadline/);
    assert.match(joined, /organizing body/);
    assert.match(joined, /Competition Manager/);
    assert.match(joined, /no sport/);
  });

  test('a duplicate tournament code is rejected but its own code is not', () => {
    const t = tournament();
    assert.ok(
      phases.validateTournament(t, { existingCodes: [t.code], organizingBodyExists: true, competitionManagerCount: 1, intendedSportCount: 1 }).open,
      'a tournament must not be blocked by its own code',
    );
    assert.equal(
      phases.validateTournament(t, { existingCodes: ['OTHER', t.code, t.code], organizingBodyExists: true, competitionManagerCount: 1, intendedSportCount: 1 }).open,
      true,
    );
  });

  test('the entries gate enforces the minimum-entries rule', () => {
    const g = phases.gateToFormat(event({ status: 'Entries Locked', minEntriesToRun: 4 }), entries(['MH', 'HR']));
    assert.equal(g.open, false);
    assert.match(g.blockers.join(' '), /Cancelled – Insufficient Entries/);
  });

  test('the entries gate refuses unresolved entries', () => {
    const list = [...entries(['MH', 'HR', 'PB', 'UP']), entry(9, 'GJ', undefined, { entryStatus: 'Blocked' })];
    const g = phases.gateToFormat(event({ status: 'Entries Locked' }), list);
    assert.equal(g.open, false);
    assert.match(g.blockers.join(' '), /Submitted or Blocked/);
  });

  test('the draw gate refuses a group format with no progression rules', () => {
    const g = phases.gateToDraw(
      event(),
      format({ type: 'group-knockout', groupCount: 2, teamsPerGroup: 4, progressionRules: [] }),
      entries(['MH', 'HR', 'PB', 'UP', 'RJ', 'TN', 'KA', 'DL']),
    );
    assert.equal(g.open, false);
    assert.match(g.blockers.join(' '), /dead end/);
  });

  test('the draw gate refuses groups that cannot hold the entries', () => {
    const g = phases.gateToDraw(
      event(),
      format({ type: 'group-knockout', groupCount: 2, teamsPerGroup: 2, progressionRules: [{ fromGroupId: '*', positions: [1], toStage: 'SF', seedApart: true }] }),
      entries(['MH', 'HR', 'PB', 'UP', 'RJ', 'TN']),
    );
    assert.equal(g.open, false);
    assert.match(g.blockers.join(' '), /hold 4 sides but 6 are entered/);
  });

  test('the schedule gate requires a published draw with no validation errors', () => {
    const base = { drawId: 'D', eventId: 'EVT-T', slots: [], rngAlgorithm: 'x', rngSeed: 's', bracketSize: 4, entryCount: 4, byeCount: 0, seedCount: 0, separationRule: 'none' as const, byePolicy: 'top-seeds' as const, manualAdjustments: [], generatedBy: 'cm1', generatedAt: '' };
    assert.equal(phases.gateToSchedule(undefined, []).open, false);
    assert.equal(phases.gateToSchedule({ ...base, status: 'Draft Draw', validationErrors: [] }, [match()]).open, false);
    assert.equal(phases.gateToSchedule({ ...base, status: 'Published', validationErrors: ['duplicate pairing'] }, [match()]).open, false);
    assert.ok(phases.gateToSchedule({ ...base, status: 'Published', validationErrors: [] }, [match()]).open);
  });

  test('the match-operations gate requires the minimum officials panel', () => {
    const scheduled = match({ scheduledDate: '2026-03-10', scheduledTime: '09:00', fopId: 'V1-MAT-1', matchStatus: 'Scheduled' });
    const g = phases.gateToMatchOperations(scheduled, [], 'kabaddi', true);
    assert.equal(g.open, false);
    assert.match(g.blockers.join(' '), /minimum officials panel incomplete/);
  });

  test('the match-operations gate requires a published schedule', () => {
    const scheduled = match({ scheduledDate: '2026-03-10', scheduledTime: '09:00', fopId: 'V1-MAT-1', matchStatus: 'Scheduled' });
    const g = phases.gateToMatchOperations(scheduled, [], 'kabaddi', false);
    assert.match(g.blockers.join(' '), /schedule has not been published/);
  });

  test('the medals gate requires every result approved and no open protest', () => {
    const g = phases.gateToMedals([M], [result({ resultStatus: 'Verified' })], [], true);
    assert.equal(g.open, false);
    assert.match(g.blockers.join(' '), /not Approved/);

    const withProtest = phases.gateToMedals([M], [result()], [{ protestId: 'P1', matchId: M.matchId, eventId: 'EVT-T', filedBy: 'tm', filedByUnit: 'MH', filedAt: '', grounds: 'g', feePaid: 1, status: 'Filed' }], true);
    assert.equal(withProtest.open, false);
    assert.match(withProtest.blockers.join(' '), /open protest/);

    assert.ok(phases.gateToMedals([M], [result()], [], true).open);
  });

  test('a terminal exception status must carry a recorded ruling', () => {
    const walkedOver = match({ matchStatus: 'Walkover' });
    assert.equal(phases.gateToResultManagement(walkedOver, false).open, false);
    assert.ok(phases.gateToResultManagement(walkedOver, true).open);
  });

  test('the current phase is derived from state, not stored', () => {
    assert.equal(phases.currentPhase(tournament({ status: 'Draft' }), [], [], []).no, 1);
    assert.equal(phases.currentPhase(tournament({ status: 'Configured' }), [], [], []).no, 2);
    assert.equal(phases.currentPhase(tournament({ status: 'Entries Open' }), [], [], []).no, 3);
    assert.equal(phases.currentPhase(tournament({ status: 'Draw Published' }), [], [], []).no, 6);
    assert.equal(phases.currentPhase(tournament({ status: 'Completed' }), [], [], []).no, 10);
    // Every playable fixture approved moves an active tournament to medals.
    const p = phases.currentPhase(tournament({ status: 'Active' }), [event()], [M], [result()]);
    assert.equal(p.no, 9);
    assert.equal(p.progressPct, 100);
  });
});
