/**
 * The ten-phase tournament lifecycle — §4.
 *
 * "Each phase has an entry condition (gate) that must be satisfied before the
 * next phase can begin." Every gate in the document is expressed here as a
 * predicate that returns the *reasons* it is not satisfied, so the UI can show
 * a checklist rather than a bare "not ready".
 */

import type {
  DrawRecord,
  Entry,
  Format,
  Match,
  MedalRow,
  OfficialAssignment,
  Protest,
  Result,
  Tournament,
  TournamentEvent,
} from '../domain/types.ts';
import { meetsMinimumPanel } from '../engines/officials.ts';
import { detectConflicts, type SchedulingContext } from '../engines/scheduler.ts';

export const PHASES = [
  { no: 1, key: 'tournament-creation', name: 'Tournament Creation' },
  { no: 2, key: 'sport-configuration', name: 'Sport and Discipline Configuration' },
  { no: 3, key: 'registration-mapping', name: 'Team / Athlete Registration Mapping' },
  { no: 4, key: 'format-setup', name: 'Tournament Format Setup' },
  { no: 5, key: 'draw-generation', name: 'Fixture / Draw Generation' },
  { no: 6, key: 'schedule-officials', name: 'Venue, Schedule and Officials Assignment' },
  { no: 7, key: 'match-operations', name: 'Match Operations (Match Day)' },
  { no: 8, key: 'result-management', name: 'Result Management, Standings and Progression' },
  { no: 9, key: 'medals', name: 'Medal / Ranking Management' },
  { no: 10, key: 'reports-closure', name: 'Reports and Tournament Closure' },
] as const;

export type PhaseKey = (typeof PHASES)[number]['key'];

export interface GateResult {
  /** The phase this gate opens. */
  phase: PhaseKey;
  open: boolean;
  /** Each unmet condition, in the document's own terms. */
  blockers: string[];
  /** Conditions met, so the UI can render a full checklist. */
  satisfied: string[];
}

function gate(phase: PhaseKey, checks: { label: string; ok: boolean; detail?: string }[]): GateResult {
  return {
    phase,
    open: checks.every((c) => c.ok),
    blockers: checks.filter((c) => !c.ok).map((c) => c.detail ?? c.label),
    satisfied: checks.filter((c) => c.ok).map((c) => c.label),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 → 2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §1.6 validation and the gate "Tournament status = Configured".
 *
 * The §5.1 validation list is applied here: "end date ≥ start date; entry
 * deadline < start date; organizing body exists in master; no duplicate
 * tournament code; at least one Competition Manager assigned before entries
 * open."
 */
export function validateTournament(
  t: Tournament,
  ctx: {
    existingCodes: string[];
    organizingBodyExists: boolean;
    competitionManagerCount: number;
    intendedSportCount: number;
  },
): GateResult {
  return gate('sport-configuration', [
    {
      label: 'end date is on or after the start date',
      ok: t.endDate >= t.startDate,
      detail: `end date ${t.endDate} is before start date ${t.startDate}`,
    },
    {
      label: 'entry deadline falls before the start date',
      ok: t.entryDeadline < t.startDate,
      detail: `entry deadline ${t.entryDeadline} is not before the start date ${t.startDate}`,
    },
    {
      label: 'withdrawal deadline is on or after the entry deadline',
      ok: t.withdrawalDeadline >= t.entryDeadline,
      detail: `withdrawal deadline ${t.withdrawalDeadline} precedes the entry deadline ${t.entryDeadline}`,
    },
    {
      label: 'organizing body exists in the GMS master',
      ok: ctx.organizingBodyExists,
      detail: `organizing body "${t.organizingBody}" was not found in the GMS master`,
    },
    {
      label: 'tournament code is unique',
      ok: !ctx.existingCodes.filter((c) => c !== t.code).includes(t.code),
      detail: `tournament code "${t.code}" is already in use`,
    },
    {
      label: 'at least one sport is intended',
      ok: ctx.intendedSportCount >= 1,
      detail: 'no sport has been declared for this tournament',
    },
    {
      label: 'at least one Competition Manager is assigned',
      ok: ctx.competitionManagerCount >= 1,
      detail: 'no Competition Manager is mapped; one is required before entries open (§5.1)',
    },
    {
      label: 'a category cut-off date is set for age eligibility',
      ok: Boolean(t.categoryCutOffDate),
      detail: 'no category cut-off date is set; age eligibility cannot be computed (§7.1.2)',
    },
    {
      label: 'protest window and fee are configured',
      ok: t.protestWindowMins > 0,
      detail: 'protest window is zero; §8.3 requires a configurable window',
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 → 3
// ─────────────────────────────────────────────────────────────────────────────

/** Gate: "At least one event confirmed with a scoring template attached." */
export function gateToRegistration(events: TournamentEvent[]): GateResult {
  const confirmed = events.filter((e) => e.confirmedAt);
  const withTemplate = confirmed.filter((e) => Boolean(e.scoringTemplateId));
  return gate('registration-mapping', [
    {
      label: 'at least one event is confirmed',
      ok: confirmed.length >= 1,
      detail: 'no event has been confirmed; the event catalogue must be locked first (§2.7)',
    },
    {
      label: 'every confirmed event has a scoring template',
      ok: confirmed.length > 0 && withTemplate.length === confirmed.length,
      detail: `${confirmed.length - withTemplate.length} confirmed event(s) have no scoring template attached (§2.5)`,
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 → 4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate: "Entries locked for the event; minimum-entries rule satisfied (else
 * event flagged Cancelled – Insufficient Entries)."
 */
export function gateToFormat(event: TournamentEvent, entries: Entry[]): GateResult {
  const live = entries.filter((e) => e.entryStatus === 'Confirmed');
  const min = event.minEntriesToRun;
  return gate('format-setup', [
    {
      label: 'entries are locked for this event',
      ok: event.status === 'Entries Locked' || event.status === 'Format Approved' || event.status === 'Draw Published',
      detail: `event status is ${event.status}; entries must be locked before a format is set (§3.6)`,
    },
    {
      label: `at least ${min} confirmed entries`,
      ok: live.length >= min,
      detail: `only ${live.length} confirmed entr${live.length === 1 ? 'y' : 'ies'} against a minimum of ${min}; the event must be flagged "Cancelled – Insufficient Entries" or merged by Admin decision (§7.1.6)`,
    },
    {
      label: 'no entry is left unresolved',
      ok: !entries.some((e) => e.entryStatus === 'Blocked' || e.entryStatus === 'Submitted'),
      detail: `${entries.filter((e) => e.entryStatus === 'Blocked' || e.entryStatus === 'Submitted').length} entr(ies) are still Submitted or Blocked; each must be confirmed, corrected, overridden or scratched (§3.5)`,
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 → 5
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate: "Format approved for the event."
 *
 * §4.5 also requires validating the format against the entry count: bracket
 * size vs. entries (computing byes), group maths consistency, and progression
 * rules complete with no dead ends.
 */
export function gateToDraw(
  event: TournamentEvent,
  format: Format | undefined,
  entries: Entry[],
): GateResult {
  const live = entries.filter((e) => e.entryStatus === 'Confirmed').length;
  const checks: { label: string; ok: boolean; detail?: string }[] = [
    {
      label: 'a format exists for this event',
      ok: Boolean(format),
      detail: 'no format has been defined (§4.1)',
    },
  ];
  if (format) {
    checks.push({
      label: 'format is approved by the Tournament Admin',
      ok: format.approvalStatus === 'Approved',
      detail: `format approval status is ${format.approvalStatus}; Tournament Admin approval is required (§4.6)`,
    });
    const isGrouped = format.type === 'group-knockout' || format.type === 'pool';
    if (isGrouped) {
      checks.push({
        label: 'group maths is consistent with the entry count',
        ok: format.groupCount > 0 && format.groupCount * format.teamsPerGroup >= live,
        detail: `${format.groupCount} group(s) of ${format.teamsPerGroup} hold ${format.groupCount * format.teamsPerGroup} sides but ${live} are entered (§4.5)`,
      });
      checks.push({
        label: 'progression rules are defined',
        ok: format.progressionRules.length > 0,
        detail: 'a group stage with no progression rules is a dead end (§4.5)',
      });
    }
    const needsBracket = format.type === 'knockout' || format.type === 'qualification-finals';
    if (needsBracket) {
      checks.push({
        label: 'entry count is high enough for a bracket',
        ok: live >= 2,
        detail: `a knockout needs at least 2 entries; ${live} confirmed`,
      });
    }
    checks.push({
      label: 'match parameters are complete',
      ok: format.matchParams.periods > 0 && format.matchParams.periodMins > 0,
      detail: 'match duration and period structure must be set (§4.4)',
    });
  }
  return gate('draw-generation', checks);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 → 6
// ─────────────────────────────────────────────────────────────────────────────

/** Gate: "Draw published." */
export function gateToSchedule(draw: DrawRecord | undefined, matches: Match[]): GateResult {
  return gate('schedule-officials', [
    {
      label: 'a draw has been generated',
      ok: Boolean(draw),
      detail: 'no draw exists for this event (§5.2)',
    },
    {
      label: 'the draw passed validation with no errors',
      ok: Boolean(draw) && draw!.validationErrors.length === 0,
      detail: `draw validation failed: ${draw?.validationErrors.join('; ')}`,
    },
    {
      label: 'the draw is published',
      ok: draw?.status === 'Published',
      detail: `draw status is ${draw?.status ?? 'Not Generated'}; Tournament Admin must approve and publish it (§5.6)`,
    },
    {
      label: 'fixtures exist',
      ok: matches.length > 0,
      detail: 'the draw produced no fixtures',
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 → 7
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate: "Match has published schedule + minimum required officials assigned."
 *
 * Evaluated per match, because match day starts per fixture rather than per
 * event — one mat can be underway while another fixture is still unstaffed.
 */
export function gateToMatchOperations(
  match: Match,
  assignments: OfficialAssignment[],
  sportId: string,
  schedulePublished: boolean,
): GateResult {
  const panel = meetsMinimumPanel(sportId, assignments.filter((a) => a.matchId === match.matchId));
  return gate('match-operations', [
    {
      label: 'fixture has a date, time and field of play',
      ok: Boolean(match.scheduledDate && match.scheduledTime && match.fopId),
      detail: `${match.matchNo} is not fully scheduled (§6.3)`,
    },
    {
      label: 'schedule is published',
      ok: schedulePublished,
      detail: 'the schedule has not been published; teams and officials have not been notified (§6.7)',
    },
    {
      label: "sport's minimum officials panel is filled",
      ok: panel.ok,
      detail: `minimum officials panel incomplete: ${panel.missing
        .map((m) => `${m.role} ${m.have}/${m.needed}`)
        .join(', ')} (§7.3.15)`,
    },
  ]);
}

/** §6.7 — the schedule cannot be published while hard conflicts remain. */
export function gateToPublishSchedule(
  ctx: SchedulingContext,
  acknowledgedSoftCodes: string[] = [],
): GateResult {
  const report = detectConflicts(ctx);
  const unacknowledged = report.soft.filter((c) => !acknowledgedSoftCodes.includes(c.code));
  return gate('schedule-officials', [
    {
      label: 'no hard scheduling conflicts',
      ok: report.hard.length === 0,
      detail: `${report.hard.length} hard conflict(s) block publishing: ${report.hard
        .map((c) => c.message)
        .join('; ')} (§7.2.11)`,
    },
    {
      label: 'all soft conflicts acknowledged',
      ok: unacknowledged.length === 0,
      detail: `${unacknowledged.length} soft conflict(s) need explicit acknowledgment: ${unacknowledged
        .map((c) => c.message)
        .join('; ')} (§7.2.11)`,
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 → 8
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate: "Match in Completed (Provisional) (or terminal exception status with
 * ruling recorded)."
 */
export function gateToResultManagement(match: Match, exceptionRulingRecorded: boolean): GateResult {
  const terminal = ['Cancelled', 'Walkover', 'Abandoned', 'Disqualified'];
  const isTerminal = terminal.includes(match.matchStatus);
  return gate('result-management', [
    {
      label: 'match is complete or has a terminal exception status',
      ok: match.matchStatus === 'Completed (Provisional)' || isTerminal,
      detail: `${match.matchNo} is ${match.matchStatus}; it must reach Completed (Provisional) or a terminal exception status`,
    },
    {
      label: 'terminal exception carries a recorded ruling',
      ok: !isTerminal || exceptionRulingRecorded,
      detail: `${match.matchNo} is ${match.matchStatus} but no ruling has been recorded (§6.5 reason code requirement)`,
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 → 9
// ─────────────────────────────────────────────────────────────────────────────

/** Gate: "All matches of the event Approved; final standings computed." */
export function gateToMedals(
  matches: Match[],
  results: Result[],
  protests: Protest[],
  standingsComputed: boolean,
): GateResult {
  const playable = matches.filter((m) => !m.byeFlag);
  const byId = new Map(results.map((r) => [r.matchId, r]));
  const unapproved = playable.filter((m) => byId.get(m.matchId)?.resultStatus !== 'Approved');
  const open = protests.filter((p) => p.status === 'Filed' || p.status === 'Under Review');
  return gate('medals', [
    {
      label: 'every playable fixture has an Approved result',
      ok: unapproved.length === 0,
      detail: `${unapproved.length} fixture(s) are not Approved: ${unapproved
        .map((m) => `${m.matchNo} (${byId.get(m.matchId)?.resultStatus ?? 'no result'})`)
        .join(', ')}`,
    },
    {
      label: 'no protest is open',
      ok: open.length === 0,
      detail: `${open.length} open protest(s): ${open.map((p) => p.protestId).join(', ')} (§7.5.23)`,
    },
    {
      label: 'final standings are computed',
      ok: standingsComputed,
      detail: 'final standings have not been computed for this event',
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9 → 10 and closure
// ─────────────────────────────────────────────────────────────────────────────

/** §10.2 — "Resolve open items" before closure. */
export function gateToClosure(
  events: TournamentEvent[],
  results: Result[],
  protests: Protest[],
  medals: MedalRow[],
): GateResult {
  const unfinished = events.filter(
    (e) => e.status !== 'Completed' && !e.status.startsWith('Cancelled'),
  );
  const openProtests = protests.filter((p) => p.status === 'Filed' || p.status === 'Under Review');
  const unapproved = results.filter((r) => r.resultStatus !== 'Approved');
  const liveEvents = events.filter((e) => !e.status.startsWith('Cancelled'));
  const unpublishedMedals = liveEvents.filter(
    (e) => !medals.some((m) => m.eventId === e.eventId && m.publishedAt),
  );
  return gate('reports-closure', [
    {
      label: 'every event is completed or cancelled',
      ok: unfinished.length === 0,
      detail: `${unfinished.length} event(s) still in progress: ${unfinished.map((e) => e.eventId).join(', ')}`,
    },
    {
      label: 'all protests are closed',
      ok: openProtests.length === 0,
      detail: `${openProtests.length} protest(s) still open (§10.2)`,
    },
    {
      label: 'all results are approved',
      ok: unapproved.length === 0,
      detail: `${unapproved.length} result(s) not approved (§10.2)`,
    },
    {
      label: 'medals published for every live event',
      ok: unpublishedMedals.length === 0,
      detail: `${unpublishedMedals.length} event(s) have no published medal list: ${unpublishedMedals.map((e) => e.eventId).join(', ')}`,
    },
  ]);
}

/**
 * Which phase a tournament is actually in, derived from state rather than
 * stored — so it can never drift out of step with the data. Drives the §9.1
 * "tournament health strip".
 */
export function currentPhase(t: Tournament, events: TournamentEvent[], matches: Match[], results: Result[]): {
  phase: PhaseKey;
  no: number;
  name: string;
  progressPct: number;
} {
  const pick = (key: PhaseKey) => {
    const p = PHASES.find((x) => x.key === key) as (typeof PHASES)[number];
    return { phase: p.key, no: p.no, name: p.name };
  };

  const playable = matches.filter((m) => !m.byeFlag);
  const approved = results.filter((r) => r.resultStatus === 'Approved').length;
  const progressPct = playable.length ? Math.round((approved / playable.length) * 100) : 0;

  if (t.status === 'Archived' || t.status === 'Completed') return { ...pick('reports-closure'), progressPct };
  if (t.status === 'Draft') return { ...pick('tournament-creation'), progressPct };
  if (t.status === 'Configured') return { ...pick('sport-configuration'), progressPct };
  if (t.status === 'Entries Open') return { ...pick('registration-mapping'), progressPct };
  if (t.status === 'Entries Locked') {
    const anyFormat = events.some((e) => e.formatId);
    return { ...pick(anyFormat ? 'draw-generation' : 'format-setup'), progressPct };
  }
  if (t.status === 'Draw Published') return { ...pick('schedule-officials'), progressPct };
  if (t.status === 'Active') {
    if (playable.length && approved === playable.length) return { ...pick('medals'), progressPct };
    const anyLive = matches.some((m) => m.matchStatus === 'Live' || m.matchStatus === 'Check-in');
    return { ...pick(anyLive ? 'match-operations' : 'result-management'), progressPct };
  }
  return { ...pick('tournament-creation'), progressPct };
}
