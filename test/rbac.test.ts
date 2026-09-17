/**
 * Role-based access — the §3.2 matrix and the five prose rules under it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  can,
  canDo,
  canPublish,
  canUnlock,
  describeMatrix,
  enforceMakerChecker,
  RECONCILIATIONS,
  requiresSecondApproval,
  SPEC_MATRIX,
  STRUCTURAL_RECONCILIATIONS,
} from '../src/domain/rbac.ts';
import { user } from './helpers.ts';

describe('permission matrix', () => {
  test('a role with no cell has no access', () => {
    const d = can(user('sc1', 'Scorer'), 'result.approval', 'A');
    assert.equal(d.allowed, false);
    assert.match(d.reason, /has no access/);
  });

  test('a Viewer sees published data and nothing else', () => {
    const v = user('vw1', 'Viewer');
    assert.ok(can(v, 'draw.generation', 'V', { isPublished: true }).allowed);
    assert.equal(can(v, 'draw.generation', 'V', { isPublished: false }).allowed, false);
    assert.equal(can(v, 'draw.generation', 'E').allowed, false);
    assert.equal(can(v, 'audit', 'V').allowed, false);
  });

  test('a Team Manager may only create entries for their own unit', () => {
    const tm = user('tm1', 'Team Manager', { unitId: 'MH' });
    assert.ok(can(tm, 'entry.mapping', 'C', { ownerUnitId: 'MH' }).allowed);
    const other = can(tm, 'entry.mapping', 'C', { ownerUnitId: 'HR' });
    assert.equal(other.allowed, false);
    assert.match(other.reason, /own unit/);
  });

  test('scope narrows a role to its assigned objects', () => {
    const cm = user('cm1', 'Competition Manager', { tournamentIds: ['TRN-1'], sportIds: ['kabaddi'] });
    assert.ok(can(cm, 'draw.generation', 'C', { tournamentId: 'TRN-1', sportId: 'kabaddi' }).allowed);
    assert.equal(can(cm, 'draw.generation', 'C', { tournamentId: 'TRN-9' }).allowed, false);
    assert.equal(can(cm, 'draw.generation', 'C', { tournamentId: 'TRN-1', sportId: 'volleyball' }).allowed, false);
  });

  test('an official-scoped grant is limited to their own duties', () => {
    const ref = user('rf1', 'Referee');
    assert.ok(can(ref, 'officials.assignment', 'V', { assignedOfficialIds: ['rf1'] }).allowed);
    assert.equal(can(ref, 'officials.assignment', 'V', { assignedOfficialIds: ['rf2'] }).allowed, false);
  });

  test('Super Admin is not blocked by scope', () => {
    const sa = user('sa1', 'Super Admin');
    assert.ok(can(sa, 'draw.generation', 'E', { tournamentId: 'anything', sportId: 'anything' }).allowed);
  });
});

describe('structural view rule', () => {
  test('an action grant implies view, so an approver can open what they approve', () => {
    // §3.2 lists Tournament Admin as "A P" on draw generation, with no V.
    assert.deepEqual(SPEC_MATRIX['draw.generation']['Tournament Admin']?.perms, ['A', 'P']);
    assert.ok(can(user('ta1', 'Tournament Admin'), 'draw.generation', 'V').allowed);
  });

  test('a named verb implies view, so a verifier can read what they verify', () => {
    // §3.2 lists Technical Official as "Verify" only on result approval.
    assert.deepEqual(SPEC_MATRIX['result.approval']['Technical Official']?.perms, []);
    assert.ok(can(user('to1', 'Technical Official'), 'result.approval', 'V').allowed);
    assert.ok(canDo(user('to1', 'Technical Official'), 'result.approval', 'verify').allowed);
  });

  test('the rule never grants view where there is no cell at all', () => {
    assert.equal(SPEC_MATRIX['result.approval']['Scorer'], undefined);
    assert.equal(can(user('sc1', 'Scorer'), 'result.approval', 'V').allowed, false);
  });

  test('the rule is documented rather than applied silently', () => {
    assert.ok(STRUCTURAL_RECONCILIATIONS.length > 0);
    assert.match(STRUCTURAL_RECONCILIATIONS[0]!.rule, /implies V/);
  });
});

describe('reconciliations against the phase tables', () => {
  test('each one carries both citations and a rationale', () => {
    assert.ok(RECONCILIATIONS.length > 0);
    for (const r of RECONCILIATIONS) {
      assert.match(r.matrixSays, /§/, `${r.fn}/${r.role} must cite the matrix`);
      assert.match(r.phaseSays, /§/, `${r.fn}/${r.role} must cite the phase table`);
      assert.ok(r.rationale.length > 20);
    }
  });

  test('a Competition Manager can create events, which Phase 2 requires', () => {
    // The matrix says only "E"; §2.1 assigns "Add sport(s)" to this role.
    assert.deepEqual(SPEC_MATRIX['sport.config']['Competition Manager']?.perms, ['E']);
    assert.ok(can(user('cm1', 'Competition Manager'), 'sport.config', 'C').allowed);
  });

  test('the matrix description flags every reconciled cell', () => {
    const flagged = describeMatrix().flatMap((r) => r.cells.filter((c) => c.reconciled).map((c) => `${r.fn}/${c.role}`));
    for (const r of RECONCILIATIONS) assert.ok(flagged.includes(`${r.fn}/${r.role}`), `${r.fn}/${r.role} should be flagged`);
  });
});

describe('maker–checker', () => {
  test('the user who entered a result cannot verify or approve it', () => {
    for (const step of ['verify', 'approve'] as const) {
      const d = enforceMakerChecker('sc1', 'sc1', step);
      assert.equal(d.allowed, false);
      assert.match(d.reason, /maker–checker/);
    }
  });

  test('a different user may verify and approve', () => {
    assert.ok(enforceMakerChecker('sc1', 'to1', 'verify').allowed);
    assert.ok(enforceMakerChecker('sc1', 'ta1', 'approve').allowed);
  });

  test('a result with no recorded enterer does not block', () => {
    assert.ok(enforceMakerChecker(undefined, 'ta1', 'approve').allowed);
  });
});

describe('publishing and unlocking', () => {
  test('only Tournament Admin and Super Admin may publish', () => {
    assert.ok(canPublish(user('ta1', 'Tournament Admin')).allowed);
    assert.ok(canPublish(user('sa1', 'Super Admin')).allowed);
    for (const role of ['Competition Manager', 'Venue Manager', 'Technical Official', 'Referee', 'Scorer', 'Team Manager', 'Viewer'] as const) {
      const d = canPublish(user('u', role));
      assert.equal(d.allowed, false, `${role} must not publish`);
      assert.match(d.reason, /restricted to Tournament Admin/);
    }
  });

  test('an unlock needs the right role and a reason code', () => {
    assert.equal(canUnlock(user('cm1', 'Competition Manager'), 'DATA_ENTRY_ERROR').allowed, false);
    const noReason = canUnlock(user('ta1', 'Tournament Admin'), '');
    assert.equal(noReason.allowed, false);
    assert.match(noReason.reason, /reason code/);
    assert.ok(canUnlock(user('ta1', 'Tournament Admin'), 'DATA_ENTRY_ERROR').allowed);
  });
});

describe('second-role approval for high-impact actions', () => {
  test('a reason code is required', () => {
    const d = requiresSecondApproval('unlock', 'ta1', 'sa1', '');
    assert.equal(d.allowed, false);
    assert.match(d.reason, /reason code/);
  });

  test('a ratifier is required', () => {
    const d = requiresSecondApproval('redraw', 'ta1', undefined, 'REDRAW_FORMAT_CHANGE');
    assert.equal(d.allowed, false);
    assert.match(d.reason, /second-role approval/);
  });

  test('the initiator cannot ratify their own action', () => {
    const d = requiresSecondApproval('dq-cascade', 'ta1', 'ta1', 'DOPING');
    assert.equal(d.allowed, false);
    assert.match(d.reason, /cannot self-approve/);
  });

  test('a different ratifier with a reason code is accepted', () => {
    assert.ok(requiresSecondApproval('mass-reschedule', 'cm1', 'ta1', 'WEATHER').allowed);
  });
});
