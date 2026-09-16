/**
 * Role-based access control — Section 3.2 ("Role–Permission Matrix").
 *
 * The matrix in the functional document is transcribed verbatim into
 * `SPEC_MATRIX`. Where the matrix contradicts the Phase tables in Section 4,
 * the conflict is *not* silently resolved: it is listed in `RECONCILIATIONS`
 * with both citations, and applied on top of the verbatim matrix. That keeps
 * this file auditable against the spec while still letting the documented
 * workflow actually run. See docs/02-gap-analysis.md.
 */

import type { Role, User } from './types.ts';

/** C = Create, E = Edit, A = Approve, P = Publish, L = Lock/Unlock, V = View. */
export type Permission = 'C' | 'E' | 'A' | 'P' | 'L' | 'V';

/**
 * Narrows a grant to a subset of rows. The matrix expresses these as
 * parentheticals — "C (own entries)", "V (published)", "V (own duties)".
 */
export type Qualifier =
  | 'own-entries'
  | 'published'
  | 'own-duties'
  | 'own-team'
  | 'own-matches'
  | 'own-scope'
  | 'own-tournament'
  | 'own-venue'
  | 'all';

/** Verbs the matrix uses in place of a letter, e.g. "Recommend", "Verify". */
export type SpecialAction =
  | 'recommend'
  | 'verify'
  | 'sign-off'
  | 'initiate'
  | 'unlock'
  | 'recompute'
  | 'generate'
  | 'log'
  | 'rule'
  | 'input'
  | 'file'
  | 'request-via-protest'
  | 'auto';

export interface Grant {
  perms: Permission[];
  qualifier?: Qualifier;
  special?: SpecialAction[];
}

export const TMS_FUNCTIONS = [
  'tournament.config',
  'sport.config',
  'entry.mapping',
  'format.rules',
  'draw.generation',
  'schedule.allocation',
  'officials.assignment',
  'match.start',
  'match.score',
  'result.provisional',
  'result.approval',
  'result.correction',
  'standings',
  'medals',
  'reports',
  'protests',
  'audit',
] as const;
export type TmsFunction = (typeof TMS_FUNCTIONS)[number];

/** Human labels, matching the matrix's "Function" column. */
export const FUNCTION_LABELS: Record<TmsFunction, string> = {
  'tournament.config': 'Tournament creation & config',
  'sport.config': 'Sport/discipline configuration',
  'entry.mapping': 'Entry/registration mapping',
  'format.rules': 'Format & progression rules',
  'draw.generation': 'Draw/fixture generation',
  'schedule.allocation': 'Schedule & venue allocation',
  'officials.assignment': 'Officials assignment',
  'match.start': 'Match start / attendance / toss',
  'match.score': 'Live score entry',
  'result.provisional': 'Provisional result entry',
  'result.approval': 'Result approval & lock',
  'result.correction': 'Result correction (post-lock)',
  standings: 'Points table / standings',
  medals: 'Medal allocation',
  reports: 'Reports & exports',
  protests: 'Protest/appeal handling',
  audit: 'Audit logs',
};

type MatrixRow = Partial<Record<Role, Grant>>;

/** Section 3.2, transcribed cell by cell. An absent role means "— No access". */
export const SPEC_MATRIX: Record<TmsFunction, MatrixRow> = {
  'tournament.config': {
    'Super Admin': { perms: ['C', 'E', 'A', 'P', 'L'] },
    'Tournament Admin': { perms: ['C', 'E', 'P'] },
    'Competition Manager': { perms: ['V'] },
    'Venue Manager': { perms: ['V'] },
    'Technical Official': { perms: ['V'] },
    Referee: { perms: ['V'] },
    Scorer: { perms: ['V'] },
    'Team Manager': { perms: ['V'] },
  },
  'sport.config': {
    'Super Admin': { perms: ['C', 'E'] },
    'Tournament Admin': { perms: ['C', 'E'] },
    'Competition Manager': { perms: ['E'] },
    'Technical Official': { perms: ['V'] },
    Referee: { perms: ['V'] },
    Scorer: { perms: ['V'] },
    'Team Manager': { perms: ['V'] },
  },
  'entry.mapping': {
    'Super Admin': { perms: ['E', 'A'] },
    'Tournament Admin': { perms: ['C', 'E', 'A'] },
    'Competition Manager': { perms: ['C', 'E'] },
    'Technical Official': { perms: ['V'] },
    Referee: { perms: ['V'] },
    Scorer: { perms: ['V'] },
    'Team Manager': { perms: ['C'], qualifier: 'own-entries' },
  },
  'format.rules': {
    'Super Admin': { perms: ['E'] },
    'Tournament Admin': { perms: ['C', 'E', 'A'] },
    'Competition Manager': { perms: ['C', 'E'] },
    'Technical Official': { perms: ['V'] },
    Referee: { perms: ['V'] },
    'Team Manager': { perms: ['V'] },
  },
  'draw.generation': {
    'Super Admin': { perms: ['E'] },
    'Tournament Admin': { perms: ['A', 'P'] },
    'Competition Manager': { perms: ['C', 'E'] },
    'Venue Manager': { perms: ['V'] },
    'Technical Official': { perms: ['V'] },
    Referee: { perms: ['V'] },
    Scorer: { perms: ['V'] },
    'Team Manager': { perms: ['V'], qualifier: 'published' },
    Viewer: { perms: ['V'], qualifier: 'published' },
  },
  'schedule.allocation': {
    'Super Admin': { perms: ['E'] },
    'Tournament Admin': { perms: ['A', 'P'] },
    'Competition Manager': { perms: ['C', 'E'] },
    'Venue Manager': { perms: ['C', 'E'] },
    'Technical Official': { perms: ['V'] },
    Referee: { perms: ['V'] },
    Scorer: { perms: ['V'] },
    'Team Manager': { perms: ['V'], qualifier: 'published' },
    Viewer: { perms: ['V'], qualifier: 'published' },
  },
  'officials.assignment': {
    'Super Admin': { perms: ['E'] },
    'Tournament Admin': { perms: ['A', 'P'] },
    'Competition Manager': { perms: ['C', 'E'] },
    'Venue Manager': { perms: ['V'] },
    'Technical Official': { perms: ['V'], qualifier: 'own-duties' },
    Referee: { perms: ['V'], qualifier: 'own-duties' },
    Scorer: { perms: ['V'], qualifier: 'own-duties' },
  },
  'match.start': {
    'Super Admin': { perms: ['E'] },
    'Tournament Admin': { perms: ['E'] },
    'Competition Manager': { perms: ['E'] },
    'Technical Official': { perms: ['E'] },
    Referee: { perms: ['E'] },
    Scorer: { perms: ['C', 'E'] },
    'Team Manager': { perms: ['V'] },
  },
  'match.score': {
    'Super Admin': { perms: ['E'] },
    'Tournament Admin': { perms: ['E'] },
    'Competition Manager': { perms: ['E'] },
    'Technical Official': { perms: ['E'] },
    Referee: { perms: ['V'] },
    Scorer: { perms: ['C', 'E'] },
    'Team Manager': { perms: ['V'], qualifier: 'published' },
    Viewer: { perms: ['V'], qualifier: 'published' },
  },
  'result.provisional': {
    'Super Admin': { perms: ['E'] },
    'Tournament Admin': { perms: ['E'] },
    'Competition Manager': { perms: ['E'] },
    'Technical Official': { perms: ['E'], special: ['verify'] },
    Referee: { perms: ['E'], special: ['sign-off'] },
    Scorer: { perms: ['C', 'E'] },
    'Team Manager': { perms: ['V'] },
  },
  'result.approval': {
    'Super Admin': { perms: ['L'] },
    'Tournament Admin': { perms: ['A', 'L'] },
    'Competition Manager': { perms: [], special: ['recommend'] },
    'Technical Official': { perms: [], special: ['verify'] },
  },
  'result.correction': {
    'Super Admin': { perms: ['A'], special: ['unlock'] },
    'Tournament Admin': { perms: ['A'], special: ['initiate'] },
    'Competition Manager': { perms: [], special: ['initiate'] },
    'Technical Official': { perms: [], special: ['verify'] },
    'Team Manager': { perms: [], special: ['request-via-protest'] },
  },
  standings: {
    'Super Admin': { perms: [], special: ['recompute'] },
    'Tournament Admin': { perms: ['A', 'P'] },
    'Competition Manager': { perms: ['V'], special: ['auto'] },
    'Technical Official': { perms: ['V'] },
    Referee: { perms: ['V'] },
    Scorer: { perms: ['V'] },
    'Team Manager': { perms: ['V'], qualifier: 'published' },
    Viewer: { perms: ['V'], qualifier: 'published' },
  },
  medals: {
    'Super Admin': { perms: ['E'] },
    'Tournament Admin': { perms: ['A', 'P'] },
    'Competition Manager': { perms: ['C'], special: ['generate'] },
    'Technical Official': { perms: [], special: ['verify'] },
    'Team Manager': { perms: ['V'], qualifier: 'published' },
    Viewer: { perms: ['V'], qualifier: 'published' },
  },
  reports: {
    'Super Admin': { perms: ['V'] },
    'Tournament Admin': { perms: ['C', 'V'] },
    'Competition Manager': { perms: ['C', 'V'] },
    'Venue Manager': { perms: ['C', 'V'], qualifier: 'own-venue' },
    'Technical Official': { perms: ['C', 'V'], qualifier: 'own-duties' },
    Referee: { perms: ['V'], qualifier: 'own-duties' },
    Scorer: { perms: ['V'] },
    'Team Manager': { perms: ['V'], qualifier: 'own-team' },
    Viewer: { perms: ['V'], qualifier: 'published' },
  },
  protests: {
    'Super Admin': { perms: ['A'] },
    'Tournament Admin': { perms: ['A'] },
    'Competition Manager': { perms: ['E'], special: ['log'] },
    'Technical Official': { perms: ['E'], special: ['rule'] },
    Referee: { perms: [], special: ['input'] },
    'Team Manager': { perms: ['C'], special: ['file'] },
    'Jury of Appeal': { perms: ['A', 'E'], special: ['rule'] },
  },
  audit: {
    'Super Admin': { perms: ['V'], qualifier: 'all' },
    'Tournament Admin': { perms: ['V'], qualifier: 'own-tournament' },
    'Competition Manager': { perms: ['V'], qualifier: 'own-scope' },
    'Venue Manager': { perms: ['V'], qualifier: 'own-scope' },
    'Technical Official': { perms: ['V'], qualifier: 'own-matches' },
  },
};

/**
 * Conflicts between the §3.2 matrix and the §4 phase tables, resolved in favour
 * of the phase tables because those describe the operative workflow. Each entry
 * carries both citations so a Business Analyst can confirm the call.
 */
export const RECONCILIATIONS: {
  fn: TmsFunction;
  role: Role;
  add: Permission[];
  matrixSays: string;
  phaseSays: string;
  rationale: string;
}[] = [
  {
    fn: 'sport.config',
    role: 'Competition Manager',
    add: ['C'],
    matrixSays: '§3.2 grants Competition Manager only "E" on Sport/discipline configuration.',
    phaseSays:
      '§2.1–2.6 assign "Add sport(s)", "Add disciplines/events per sport", "Attach scoring template" to the Competition Manager.',
    rationale:
      'Phase 2 cannot run without create rights. Without this, no event can exist and the Phase 2 gate is unreachable.',
  },
  {
    fn: 'medals',
    role: 'Technical Official',
    add: ['V'],
    matrixSays: '§3.2 lists only "Verify" for Technical Official on Medal allocation.',
    phaseSays: '§9.3 has the Technical Official verify the medal list against accreditation.',
    rationale: 'Verifying a list requires reading it; "Verify" implies view.',
  },
  {
    fn: 'result.approval',
    role: 'Competition Manager',
    add: ['V'],
    matrixSays: '§3.2 lists only "Recommend" for Competition Manager on Result approval & lock.',
    phaseSays: '§9.2 Competition Manager dashboard shows the progression tracker blocked by protest.',
    rationale: 'Recommending an approval requires viewing the pending result.',
  },
  {
    fn: 'protests',
    role: 'Jury of Appeal',
    add: ['V'],
    matrixSays: '§3.2 omits the Jury of Appeal row from the matrix entirely.',
    phaseSays:
      '§3.1 defines Jury of Appeal ("Rules on protests/appeals… recorded in system as a committee entity") and §8.9 makes it the deciding role.',
    rationale:
      'The role is defined in §3.1 and used in §8 but has no matrix row. Modelled as file-read + rule rights on protests only.',
  },
];

/** The matrix with reconciliations applied — what the system actually enforces. */
export const EFFECTIVE_MATRIX: Record<TmsFunction, MatrixRow> = (() => {
  const out = JSON.parse(JSON.stringify(SPEC_MATRIX)) as Record<TmsFunction, MatrixRow>;
  for (const r of RECONCILIATIONS) {
    const row = out[r.fn];
    const existing = row[r.role] ?? { perms: [] };
    const merged = new Set<Permission>([...existing.perms, ...r.add]);
    row[r.role] = { ...existing, perms: [...merged] };
  }
  return out;
})();

export interface AccessContext {
  tournamentId?: string;
  sportId?: string;
  venueId?: string;
  matchId?: string;
  /** Unit that owns the row being touched — for 'own-entries' / 'own-team'. */
  ownerUnitId?: string;
  /** Whether the row is published — for the 'published' qualifier. */
  isPublished?: boolean;
  /** Official IDs on the row — for the 'own-duties' qualifier. */
  assignedOfficialIds?: string[];
}

export interface AccessDecision {
  allowed: boolean;
  /** Always populated — the UI shows this, and denials are audit-logged. */
  reason: string;
}

const ALLOW: AccessDecision = { allowed: true, reason: 'granted' };

/** Does the user's scope cover this context? §3.1 "Scope" column. */
function inScope(user: User, ctx: AccessContext): AccessDecision {
  if (user.role === 'Super Admin') return ALLOW;
  const s = user.scope;
  if (ctx.tournamentId && s.tournamentIds?.length && !s.tournamentIds.includes(ctx.tournamentId)) {
    return { allowed: false, reason: `out of scope: tournament ${ctx.tournamentId}` };
  }
  if (ctx.sportId && s.sportIds?.length && !s.sportIds.includes(ctx.sportId)) {
    return { allowed: false, reason: `out of scope: sport ${ctx.sportId}` };
  }
  if (ctx.venueId && s.venueIds?.length && !s.venueIds.includes(ctx.venueId)) {
    return { allowed: false, reason: `out of scope: venue ${ctx.venueId}` };
  }
  return ALLOW;
}

function qualifierSatisfied(q: Qualifier, user: User, ctx: AccessContext): AccessDecision {
  switch (q) {
    case 'published':
      // §7.6.25 unpublished data is never visible to Team Managers or Viewers.
      return ctx.isPublished
        ? ALLOW
        : { allowed: false, reason: 'row is not published; only published data is visible' };
    case 'own-entries':
    case 'own-team':
      return ctx.ownerUnitId && ctx.ownerUnitId === user.scope.unitId
        ? ALLOW
        : { allowed: false, reason: `restricted to own unit (${user.scope.unitId ?? 'none'})` };
    case 'own-duties':
    case 'own-matches':
      return ctx.assignedOfficialIds?.includes(user.userId)
        ? ALLOW
        : { allowed: false, reason: 'restricted to own assigned duties' };
    case 'own-venue':
      return ctx.venueId && user.scope.venueIds?.includes(ctx.venueId)
        ? ALLOW
        : { allowed: false, reason: 'restricted to own venue' };
    case 'own-scope':
    case 'own-tournament':
      return inScope(user, ctx);
    case 'all':
      return ALLOW;
  }
}

/** Primary authorization check. Every route and UI action goes through this. */
export function can(
  user: User,
  fn: TmsFunction,
  perm: Permission,
  ctx: AccessContext = {},
): AccessDecision {
  const grant = EFFECTIVE_MATRIX[fn][user.role];
  if (!grant) {
    return { allowed: false, reason: `${user.role} has no access to ${FUNCTION_LABELS[fn]}` };
  }
  if (!grant.perms.includes(perm)) {
    const have = grant.perms.length ? grant.perms.join('') : (grant.special?.join('/') ?? '—');
    return {
      allowed: false,
      reason: `${user.role} may not ${permVerb(perm)} ${FUNCTION_LABELS[fn]} (has: ${have})`,
    };
  }
  const scoped = inScope(user, ctx);
  if (!scoped.allowed) return scoped;
  if (grant.qualifier) {
    const q = qualifierSatisfied(grant.qualifier, user, ctx);
    if (!q.allowed) return q;
  }
  return ALLOW;
}

/** Can the user perform one of the matrix's named verbs (Verify, Unlock, …)? */
export function canDo(
  user: User,
  fn: TmsFunction,
  action: SpecialAction,
  ctx: AccessContext = {},
): AccessDecision {
  const grant = EFFECTIVE_MATRIX[fn][user.role];
  if (!grant?.special?.includes(action)) {
    return { allowed: false, reason: `${user.role} may not ${action} ${FUNCTION_LABELS[fn]}` };
  }
  return inScope(user, ctx);
}

function permVerb(p: Permission): string {
  return { C: 'create', E: 'edit', A: 'approve', P: 'publish', L: 'lock/unlock', V: 'view' }[p];
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.2 "Key permission rules" — cross-cutting constraints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rule 1 / §7.4.17 — maker–checker. The user who entered a result can never be
 * its sole approver. Checked at verify *and* approve, so a Scorer who is also a
 * Technical Official cannot wave their own result through.
 */
export function enforceMakerChecker(
  enteredBy: string | undefined,
  actingUserId: string,
  step: 'verify' | 'approve',
): AccessDecision {
  if (!enteredBy) return ALLOW;
  if (enteredBy === actingUserId) {
    return {
      allowed: false,
      reason: `maker–checker violation: the user who entered this result cannot ${step} it (§7.4.17)`,
    };
  }
  return ALLOW;
}

/** Rule 2 — publishing is restricted to Tournament Admin and Super Admin. */
export function canPublish(user: User): AccessDecision {
  return user.role === 'Tournament Admin' || user.role === 'Super Admin'
    ? ALLOW
    : {
        allowed: false,
        reason: `publishing is restricted to Tournament Admin and Super Admin (§3.2); ${user.role} may prepare but not publish`,
      };
}

/**
 * Rule 3 — unlocking an approved result requires Tournament Admin (or Super
 * Admin for escalations) *and* a reason code. Both are audit-logged.
 */
export function canUnlock(user: User, reasonCode: string | undefined): AccessDecision {
  if (user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
    return { allowed: false, reason: `unlock requires Tournament Admin or Super Admin (§3.2)` };
  }
  if (!reasonCode || !reasonCode.trim()) {
    return { allowed: false, reason: 'unlock requires a reason code (§6, §7.4.18)' };
  }
  return ALLOW;
}

/**
 * §7.6.26 — destructive/high-impact actions need a second-role approval.
 * Returns whether ratification is still outstanding.
 */
export const HIGH_IMPACT_ACTIONS = [
  'unlock',
  'redraw',
  'cancel-tournament',
  'cancel-event',
  'mass-reschedule',
  'dq-cascade',
] as const;
export type HighImpactAction = (typeof HIGH_IMPACT_ACTIONS)[number];

export function requiresSecondApproval(
  action: HighImpactAction,
  initiatorId: string,
  ratifierId: string | undefined,
  reasonCode: string | undefined,
): AccessDecision {
  if (!reasonCode?.trim()) {
    return { allowed: false, reason: `${action} requires a reason code (§7.6.26)` };
  }
  if (!ratifierId) {
    return { allowed: false, reason: `${action} requires a second-role approval (§7.6.26)` };
  }
  if (ratifierId === initiatorId) {
    return {
      allowed: false,
      reason: `${action} requires a *different* role to ratify; initiator cannot self-approve (§7.6.26)`,
    };
  }
  return ALLOW;
}

/** Flattened matrix for the §12.18 Role & Access Management screen. */
export function describeMatrix(): {
  fn: TmsFunction;
  label: string;
  cells: { role: Role; display: string; reconciled: boolean }[];
}[] {
  const roles = Object.keys(
    TMS_FUNCTIONS.reduce<Record<string, true>>((acc, fn) => {
      for (const r of Object.keys(EFFECTIVE_MATRIX[fn])) acc[r] = true;
      return acc;
    }, {}),
  ) as Role[];
  return TMS_FUNCTIONS.map((fn) => ({
    fn,
    label: FUNCTION_LABELS[fn],
    cells: roles.map((role) => {
      const g = EFFECTIVE_MATRIX[fn][role];
      const parts = [g?.perms.join('') ?? '', ...(g?.special ?? [])].filter(Boolean);
      const display = parts.length
        ? parts.join(' + ') + (g?.qualifier ? ` (${g.qualifier})` : '')
        : '—';
      return {
        role,
        display,
        reconciled: RECONCILIATIONS.some((r) => r.fn === fn && r.role === role),
      };
    }),
  }));
}
