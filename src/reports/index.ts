/**
 * Report pack — §10, all fourteen reports.
 *
 * §5.8 governs what these may contain: "System renders from LIVE approved data
 * only (provisional/unpublished data excluded from external reports; internal
 * ops reports may include provisional flagged as such)". Each report therefore
 * declares its `audience`, and `buildReport` filters accordingly instead of
 * leaving it to each renderer to remember.
 *
 * §5.8 also requires that "every export is logged (who, what, when) for
 * controlled documents" — the service records an audit entry per export.
 */

import type { Match, Result, Role } from '../domain/types.ts';
import { getSport } from '../sports/registry.ts';
import { dutyRoster } from '../engines/officials.ts';
import { medalTally } from '../engines/medals.ts';
import { toMins, toTime } from '../engines/scheduler.ts';
import type { TmsStoreLike } from '../store/store.ts';

export interface ReportDefinition {
  key: string;
  no: number;
  name: string;
  purpose: string;
  /** 'external' renders approved and published data only (§5.8). */
  audience: 'external' | 'internal';
  formats: ('PDF' | 'Excel' | 'CSV' | 'print')[];
  /** Which scope the report needs — drives the Reports Hub filter panel. */
  scope: 'tournament' | 'event' | 'date' | 'venue' | 'team' | 'official';
  roles: Role[];
}

/** §10 catalogue, in the document's own order and numbering. */
export const REPORTS: ReportDefinition[] = [
  { key: 'fixture-draw', no: 1, name: 'Fixture / Draw report', purpose: 'Official draw publication per event', audience: 'external', formats: ['PDF', 'print'], scope: 'event', roles: ['Tournament Admin', 'Competition Manager', 'Team Manager', 'Viewer'] },
  { key: 'schedule-master', no: 2, name: 'Match schedule (master)', purpose: 'Day-wise ops plan', audience: 'internal', formats: ['PDF', 'Excel', 'CSV'], scope: 'tournament', roles: ['Tournament Admin', 'Competition Manager', 'Venue Manager'] },
  { key: 'schedule-team', no: 3, name: 'Team-wise schedule', purpose: 'Team logistics', audience: 'external', formats: ['PDF', 'CSV'], scope: 'team', roles: ['Tournament Admin', 'Competition Manager', 'Team Manager'] },
  { key: 'schedule-venue', no: 4, name: 'Venue-wise schedule / run sheet', purpose: 'Venue operations', audience: 'internal', formats: ['PDF', 'Excel', 'CSV'], scope: 'venue', roles: ['Tournament Admin', 'Competition Manager', 'Venue Manager'] },
  { key: 'duty-roster', no: 5, name: 'Official duty roster', purpose: 'Officials deployment', audience: 'internal', formats: ['PDF', 'Excel', 'CSV'], scope: 'tournament', roles: ['Tournament Admin', 'Competition Manager', 'Technical Official', 'Referee', 'Scorer'] },
  { key: 'match-result', no: 6, name: 'Match result report', purpose: 'Per-match record', audience: 'external', formats: ['PDF'], scope: 'event', roles: ['Tournament Admin', 'Competition Manager', 'Technical Official', 'Team Manager', 'Viewer'] },
  { key: 'daily-bulletin', no: 7, name: 'Daily results bulletin', purpose: 'End-of-day publication', audience: 'external', formats: ['PDF', 'print'], scope: 'date', roles: ['Tournament Admin', 'Competition Manager', 'Viewer'] },
  { key: 'points-table', no: 8, name: 'Points table / standings', purpose: 'Group/league position', audience: 'external', formats: ['PDF', 'Excel', 'CSV'], scope: 'event', roles: ['Tournament Admin', 'Competition Manager', 'Team Manager', 'Viewer'] },
  { key: 'final-ranking', no: 9, name: 'Final ranking & medal report', purpose: 'Event closure', audience: 'external', formats: ['PDF', 'Excel', 'CSV'], scope: 'event', roles: ['Tournament Admin', 'Competition Manager', 'Viewer'] },
  { key: 'medal-tally', no: 10, name: 'Medal tally', purpose: 'Unit-wise summary', audience: 'external', formats: ['PDF', 'Excel', 'CSV'], scope: 'tournament', roles: ['Tournament Admin', 'Competition Manager', 'Viewer'] },
  { key: 'entry-scratch', no: 11, name: 'Entry list / scratch report', purpose: 'Pre-competition control', audience: 'internal', formats: ['Excel', 'CSV'], scope: 'event', roles: ['Tournament Admin', 'Competition Manager'] },
  { key: 'exception-register', no: 12, name: 'Exception & protest register', purpose: 'Governance', audience: 'internal', formats: ['PDF', 'Excel', 'CSV'], scope: 'tournament', roles: ['Super Admin', 'Tournament Admin', 'Competition Manager'] },
  { key: 'audit-extract', no: 13, name: 'Audit trail extract', purpose: 'Compliance / dispute', audience: 'internal', formats: ['Excel', 'CSV'], scope: 'tournament', roles: ['Super Admin', 'Tournament Admin'] },
  { key: 'final-tournament', no: 14, name: 'Final tournament report', purpose: 'Post-event record', audience: 'internal', formats: ['PDF'], scope: 'tournament', roles: ['Super Admin', 'Tournament Admin'] },
];

export interface ReportOutput {
  key: string;
  name: string;
  /** Column headings, in order. */
  columns: string[];
  rows: (string | number)[][];
  /** Notes rendered under the table — provisional-data warnings live here. */
  notes: string[];
  generatedAt: string;
}

export interface ReportScope {
  tournamentId: string;
  eventId?: string;
  date?: string;
  venueId?: string;
  unitId?: string;
  officialId?: string;
  /** §5.8 — an internal ops report may include provisional data, flagged. */
  includeProvisional?: boolean;
}

/** §5.8 — external reports see approved (and, where relevant, published) data. */
function visibleResults(store: TmsStoreLike, results: Result[], def: ReportDefinition, scope: ReportScope): Result[] {
  void store;
  if (def.audience === 'external') return results.filter((r) => r.resultStatus === 'Approved');
  return scope.includeProvisional ? results : results.filter((r) => r.resultStatus === 'Approved');
}

function scoreOf(r: Result | undefined): string {
  if (!r) return '—';
  const base = `${r.finalScore.a}–${r.finalScore.b}`;
  return r.outcomeType === 'played' ? base : `${base} (${r.outcomeType})`;
}

function sideNames(m: Match): [string, string] {
  return [m.sideA.displayName, m.sideB.displayName];
}

export function buildReport(store: TmsStoreLike, key: string, scope: ReportScope): ReportOutput {
  const def = REPORTS.find((r) => r.key === key);
  if (!def) throw new Error(`unknown report "${key}"; see the §10 catalogue`);
  const at = new Date().toISOString();
  const notes: string[] = [];
  const events = scope.eventId
    ? [store.getEvent(scope.eventId)].filter((e): e is NonNullable<typeof e> => Boolean(e))
    : store.listEvents(scope.tournamentId);

  const out = (columns: string[], rows: (string | number)[][]): ReportOutput => ({
    key, name: def.name, columns, rows, notes, generatedAt: at,
  });

  switch (key) {
    // §10.1 — event, round, match no., participants, seed, bye markers, position.
    case 'fixture-draw': {
      const rows: (string | number)[][] = [];
      for (const e of events) {
        const draw = store.getDrawForEvent(e.eventId);
        if (draw?.status !== 'Published') {
          notes.push(`${e.discipline}: draw is ${draw?.status ?? 'not generated'} and is excluded — only a published draw appears on an official draw sheet (§5.6)`);
          continue;
        }
        const seedBySlot = new Map(draw.slots.map((s) => [s.slot, s]));
        for (const m of store.listMatches(e.eventId)) {
          const [a, b] = sideNames(m);
          const slotA = seedBySlot.get(2 * (Number(m.matchNo.slice(1)) - 1));
          rows.push([
            e.discipline, m.stage, `R${m.roundNo}`, m.matchNo, a, b,
            slotA?.occupant.kind === 'entry' && slotA.occupant.seedNo ? `seed ${slotA.occupant.seedNo}` : '',
            m.byeFlag ? 'BYE' : '',
            m.groupId ?? '',
          ]);
        }
        notes.push(`${e.discipline}: bracket ${draw.bracketSize}, ${draw.entryCount} entries, ${draw.byeCount} bye(s), RNG seed "${draw.rngSeed}" (${draw.rngAlgorithm}) — the draw is reproducible from this seed (§7.2.9)`);
      }
      return out(['Event', 'Stage', 'Round', 'Match', 'Side A', 'Side B', 'Seed', 'Bye', 'Group'], rows);
    }

    // §10.2 — date, session, time, venue, FOP, event, round, match, sides, officials.
    case 'schedule-master': {
      const rows = store
        .listMatchesForTournament(scope.tournamentId)
        .filter((m) => !m.byeFlag && (!scope.date || m.scheduledDate === scope.date))
        .map((m) => {
          const e = store.getEvent(m.eventId);
          const [a, b] = sideNames(m);
          return [
            m.scheduledDate ?? 'unscheduled', m.session ?? '', m.scheduledTime ?? '',
            m.venueId ?? '', m.fopId ?? '', e?.discipline ?? m.eventId, m.stage, m.matchNo,
            a, b, m.officials.map((o) => `${o.role}: ${o.officialName}`).join('; '), m.matchStatus,
          ];
        });
      const unscheduled = rows.filter((r) => r[0] === 'unscheduled').length;
      if (unscheduled) notes.push(`${unscheduled} fixture(s) are not yet scheduled`);
      return out(['Date', 'Session', 'Time', 'Venue', 'FOP', 'Event', 'Stage', 'Match', 'Side A', 'Side B', 'Officials', 'Status'], rows);
    }

    // §10.3 — team, all matches with date/time/venue/opponent, report times.
    case 'schedule-team': {
      if (!scope.unitId) throw new Error('the team-wise schedule needs a unit');
      const rows: (string | number)[][] = [];
      for (const e of events) {
        const mine = new Set(
          store.listEntries(e.eventId).filter((x) => x.unitId === scope.unitId).map((x) => x.entryId),
        );
        const state = store.getScheduleState(e.eventId);
        if (!['Published', 'Amended', 'Final'].includes(state.status)) {
          notes.push(`${e.discipline}: schedule is ${state.status}; unpublished fixtures are not shown to a team (§7.6.25)`);
          continue;
        }
        for (const m of store.listMatches(e.eventId)) {
          const isMine = [m.sideA, m.sideB].some((s) => s.kind === 'entry' && mine.has(s.entryId));
          if (!isMine || m.byeFlag) continue;
          const opponent = [m.sideA, m.sideB].find((s) => !(s.kind === 'entry' && mine.has(s.entryId)));
          const reportTime = m.scheduledTime ? toTime(Math.max(0, toMins(m.scheduledTime) - 45)) : '';
          rows.push([
            scope.unitId, e.discipline, m.matchNo, m.scheduledDate ?? '', m.scheduledTime ?? '',
            m.venueId ?? '', m.fopId ?? '', opponent?.displayName ?? '', reportTime, m.matchStatus,
          ]);
        }
      }
      return out(['Unit', 'Event', 'Match', 'Date', 'Time', 'Venue', 'FOP', 'Opponent', 'Report by', 'Status'], rows);
    }

    // §10.4 — FOP, slot-by-slot list, turnaround gaps, officials on duty.
    case 'schedule-venue': {
      const venues = store.listVenues(scope.tournamentId).filter((v) => !scope.venueId || v.venueId === scope.venueId);
      const rows: (string | number)[][] = [];
      for (const v of venues) {
        for (const f of v.fopList) {
          const onFop = store
            .listMatchesForTournament(scope.tournamentId)
            .filter((m) => m.fopId === f.fopId && !m.byeFlag && (!scope.date || m.scheduledDate === scope.date))
            .sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`));
          let prevEnd: number | undefined;
          for (const m of onFop) {
            const start = m.scheduledTime ? toMins(m.scheduledTime) : undefined;
            const gap = start !== undefined && prevEnd !== undefined ? start - prevEnd : undefined;
            const [a, b] = sideNames(m);
            rows.push([
              v.name, f.name, m.scheduledDate ?? '', m.scheduledTime ?? '', m.matchNo,
              `${a} v ${b}`, gap === undefined ? '' : `${gap} min`,
              m.officials.map((o) => o.officialName).join('; '), m.matchStatus,
            ]);
            if (start !== undefined) prevEnd = start + (m.durationMins ?? 45);
          }
          for (const mb of v.maintenanceBlocks.filter((x) => x.fopId === f.fopId)) {
            rows.push([v.name, f.name, mb.date, `${mb.from}–${mb.to}`, 'MAINTENANCE', mb.reason, '', '', 'blocked']);
          }
        }
      }
      return out(['Venue', 'FOP', 'Date', 'Time', 'Match', 'Fixture', 'Turnaround', 'Officials', 'Status'], rows);
    }

    // §10.5 — official, role, matches, times, venues, neutrality confirmation.
    case 'duty-roster': {
      const roster = dutyRoster(store.listAssignments(), store.listMatchesForTournament(scope.tournamentId));
      const rows = roster
        .filter((r) => !scope.officialId || r.officialId === scope.officialId)
        .flatMap((r) =>
          r.duties.map((d) => [
            r.officialName, d.role, d.matchNo, d.date ?? '', d.time ?? '',
            d.reportTime ? new Date(d.reportTime).toISOString().slice(11, 16) : '',
            d.venueId ?? '', d.fopId ?? '', d.neutrality, d.status,
          ]),
        );
      const failed = rows.filter((r) => r[8] === 'fail').length;
      if (failed) notes.push(`${failed} assignment(s) failed the neutrality check and must be replaced (§7.3.13)`);
      const waived = rows.filter((r) => r[8] === 'waived').length;
      if (waived) notes.push(`${waived} assignment(s) carry a waived neutrality check — neutrality is not enforced at this tournament level`);
      return out(['Official', 'Role', 'Match', 'Date', 'Time', 'Report by', 'Venue', 'FOP', 'Neutrality', 'Status'], rows);
    }

    // §10.6 — match no., sides, score by period, winner, duration, officials, exceptions, signature.
    case 'match-result': {
      const rows: (string | number)[][] = [];
      for (const e of events) {
        const results = visibleResults(store, store.listResults(e.eventId), def, scope);
        const byMatch = new Map(results.map((r) => [r.matchId, r]));
        for (const m of store.listMatches(e.eventId)) {
          const r = byMatch.get(m.matchId);
          if (!r) continue;
          const ops = store.getOperations(m.matchId);
          const [a, b] = sideNames(m);
          const periods = (ops?.periodScores ?? []).map((p) => `H${p.period} ${p.a}-${p.b}`).join(' / ');
          const duration =
            ops?.startTimeActual && ops?.endTimeActual
              ? `${Math.round((new Date(ops.endTimeActual).getTime() - new Date(ops.startTimeActual).getTime()) / 60000)} min`
              : '';
          rows.push([
            e.discipline, m.matchNo, a, b, scoreOf(r), periods,
            r.winnerRef ? (m.sideA.kind === 'entry' && m.sideA.entryId === r.winnerRef ? a : b) : 'none',
            duration, m.officials.map((o) => `${o.role}: ${o.officialName}`).join('; '),
            r.outcomeType === 'played' ? '' : r.outcomeType,
            ops?.refereeSignoff ? `signed by ${ops.refereeSignoff.officialName}` : 'UNSIGNED',
            r.resultStatus,
          ]);
        }
      }
      const unsigned = rows.filter((r) => r[10] === 'UNSIGNED').length;
      if (unsigned) notes.push(`${unsigned} match report(s) carry no referee signature (§7.7)`);
      return out(['Event', 'Match', 'Side A', 'Side B', 'Score', 'By half', 'Winner', 'Duration', 'Officials', 'Exception', 'Signature', 'Result status'], rows);
    }

    // §10.7 — all approved results of the day, grouped by event.
    case 'daily-bulletin': {
      const date = scope.date ?? new Date().toISOString().slice(0, 10);
      const rows: (string | number)[][] = [];
      for (const e of events) {
        const approved = store.listResults(e.eventId).filter((r) => r.resultStatus === 'Approved');
        const byMatch = new Map(approved.map((r) => [r.matchId, r]));
        for (const m of store.listMatches(e.eventId)) {
          if (m.scheduledDate !== date) continue;
          const r = byMatch.get(m.matchId);
          if (!r) continue;
          const [a, b] = sideNames(m);
          rows.push([e.discipline, m.stage, m.matchNo, a, b, scoreOf(r), m.fopId ?? '', m.scheduledTime ?? '']);
        }
      }
      notes.push(`Bulletin for ${date}. Approved results only — provisional and unapproved results are excluded from external publication (§5.8).`);
      return out(['Event', 'Stage', 'Match', 'Side A', 'Side B', 'Score', 'FOP', 'Time'], rows);
    }

    // §10.8 — P, W, D, L, points, sport metric, tie-break notes, Q flags.
    case 'points-table': {
      const rows: (string | number)[][] = [];
      for (const e of events) {
        const sport = getSport(e.sport);
        for (const s of store.listStandings(e.eventId)) {
          rows.push([
            e.discipline, s.groupId, s.rank, s.participantName, s.unitId,
            s.played, s.won, s.drawn, s.lost, s.points,
            s.scoreFor, s.scoreAgainst, s.sportMetric, s.bonusPoints,
            s.qualificationFlag || '—', s.tiebreakNotes.join('; '),
          ]);
        }
        notes.push(
          `${e.discipline}: metric is ${sport.sportMetric.label}; tie-breakers apply strictly in order — ${sport.tieBreakers.map((t, i) => `${i + 1}. ${t.label}`).join(', ')} (§7.5.22)`,
        );
      }
      return out(['Event', 'Group', 'Rank', 'Participant', 'Unit', 'P', 'W', 'D', 'L', 'Pts', 'For', 'Against', 'Metric', 'Bonus', 'Q/E', 'Tie-break notes'], rows);
    }

    // §10.9 — positions 1..N, medallists with unit, joint notes, DQ annotations.
    case 'final-ranking': {
      const rows: (string | number)[][] = [];
      for (const e of events) {
        for (const m of store.listMedals(e.eventId)) {
          if (def.audience === 'external' && !m.publishedAt) continue;
          rows.push([
            e.discipline, m.position, m.participantName, m.unitId,
            m.medal === 'none' ? '—' : m.medal, m.jointFlag ? 'joint' : '',
            m.dqAnnotation ?? '', m.publishedAt ? 'published' : 'unpublished',
          ]);
        }
        if (e.medalRule === 'joint-bronze') {
          notes.push(`${e.discipline}: joint bronze — both losing semi-finalists take bronze and no play-off is held (§7.5.24)`);
        }
      }
      return out(['Event', 'Position', 'Participant', 'Unit', 'Medal', 'Joint', 'DQ note', 'State'], rows);
    }

    // §10.10 — unit, G, S, B, total, tally rank.
    case 'medal-tally': {
      const published = store.listMedalsForTournament(scope.tournamentId).filter((m) => m.publishedAt);
      const rows = medalTally(published).map((t) => [t.rank, t.unitId, t.gold, t.silver, t.bronze, t.total]);
      const unpublished = store.listMedalsForTournament(scope.tournamentId).filter((m) => !m.publishedAt && m.medal !== 'none').length;
      if (unpublished) notes.push(`${unpublished} medal row(s) are not yet published and are excluded from the tally (§5.8)`);
      notes.push('Tally rank is by gold, then silver, then bronze; units level on all three share a rank.');
      return out(['Rank', 'Unit', 'Gold', 'Silver', 'Bronze', 'Total'], rows);
    }

    // §10.11 — event-wise entries, seeds, scratches with reasons, late entries.
    case 'entry-scratch': {
      const rows: (string | number)[][] = [];
      for (const e of events) {
        for (const en of store.listEntries(e.eventId)) {
          const failures = en.eligibilityResult.checks.filter((c) => !c.passed);
          rows.push([
            e.discipline, en.entryId, en.participantRef.displayName, en.unitId,
            en.seedNo ?? '', en.entryStatus, en.scratchReason ?? '',
            en.overrideFlag ? `OVERRIDE by ${en.overrideBy}: ${en.overrideReason}` : '',
            failures.map((f) => `${f.rule}${f.severity === 'soft' ? ' (advisory)' : ''}`).join('; '),
            en.rosterRefs?.length ?? 0, en.enteredBy, en.enteredAt,
          ]);
        }
      }
      return out(['Event', 'Entry', 'Participant', 'Unit', 'Seed', 'Status', 'Scratch reason', 'Override', 'Eligibility failures', 'Squad', 'Entered by', 'Entered at'], rows);
    }

    // §10.12 — walkovers, DQs, protests with rulings, corrections before/after.
    case 'exception-register': {
      const rows: (string | number)[][] = [];
      for (const x of store.listExceptions(scope.tournamentId)) {
        rows.push(['exception', x.scenario, x.exceptionId, x.matchId ?? '', x.reasonCode, x.detail, x.decidedBy, x.decidedByRole, x.ratifiedBy ?? '', x.at]);
      }
      for (const p of store.listProtests()) {
        rows.push(['protest', p.status, p.protestId, p.matchId, `fee ${p.feePaid}${p.feeForfeited ? ' (forfeited)' : ''}`, `${p.grounds}${p.ruling ? ` | RULING: ${p.ruling}` : ''}`, p.filedBy, 'Team Manager', p.ruledBy ?? '', p.filedAt]);
      }
      for (const e of events) {
        for (const r of store.listResults(e.eventId)) {
          for (const c of r.correctionHistory) {
            rows.push(['correction', c.field, r.resultId, r.matchId, c.reasonCode, `${c.oldValue} → ${c.newValue}`, c.unlockedBy, 'unlocked by', c.approvedBy, c.unlockedAt]);
          }
        }
      }
      return out(['Kind', 'Type/Status', 'Ref', 'Match', 'Reason / fee', 'Detail', 'Decided by', 'Role', 'Ratified by', 'At'], rows.sort((a, b) => String(b[9]).localeCompare(String(a[9]))));
    }

    // §10.13 — filtered log: user, role, action, entity, old/new values, timestamp.
    case 'audit-extract': {
      const rows = store
        .queryAudit({ tournamentId: scope.tournamentId, limit: 5000 })
        .map((a) => [
          a.timestamp, a.userName, a.role, a.action, a.entityType, a.entityId,
          a.oldValue ?? '', a.newValue ?? '', a.reasonCode ?? '',
        ]);
      notes.push('The audit log is append-only; no role, including Super Admin, can edit or delete an entry (§7.6.27).');
      return out(['Timestamp', 'User', 'Role', 'Action', 'Entity type', 'Entity', 'Old value', 'New value', 'Reason code'], rows);
    }

    // §10.14 — participation stats, results summary, tally, exceptions, officials, utilisation.
    case 'final-tournament': {
      const t = store.getTournament(scope.tournamentId);
      const allMatches = store.listMatchesForTournament(scope.tournamentId);
      const allResults = store.listResultsForTournament(scope.tournamentId);
      const allEntries = events.flatMap((e) => store.listEntries(e.eventId));
      const tally = medalTally(store.listMedalsForTournament(scope.tournamentId).filter((m) => m.publishedAt));
      const rows: (string | number)[][] = [
        ['Tournament', t?.name ?? scope.tournamentId],
        ['Code', t?.code ?? ''],
        ['Level', t?.level ?? ''],
        ['Dates', `${t?.startDate ?? ''} to ${t?.endDate ?? ''}`],
        ['Host city', t?.hostCity ?? ''],
        ['Status', t?.status ?? ''],
        ['Events', events.length],
        ['Events completed', events.filter((e) => e.status === 'Completed').length],
        ['Participating units', new Set(allEntries.map((e) => e.unitId)).size],
        ['Entries', allEntries.length],
        ['Entries confirmed', allEntries.filter((e) => e.entryStatus === 'Confirmed').length],
        ['Entries scratched', allEntries.filter((e) => e.entryStatus === 'Scratched').length],
        ['Fixtures', allMatches.filter((m) => !m.byeFlag).length],
        ['Byes', allMatches.filter((m) => m.byeFlag).length],
        ['Results approved', allResults.filter((r) => r.resultStatus === 'Approved').length],
        ['Walkovers', allResults.filter((r) => r.outcomeType === 'walkover').length],
        ['Corrections applied', allResults.reduce((n, r) => n + r.correctionHistory.length, 0)],
        ['Protests filed', store.listProtests().length],
        ['Protests upheld', store.listProtests().filter((p) => p.status === 'Upheld').length],
        ['Exceptions recorded', store.listExceptions(scope.tournamentId).length],
        ['Officials deployed', new Set(store.listAssignments().map((a) => a.officialId)).size],
        ['Duty assignments', store.listAssignments().length],
        ['Venues used', store.listVenues(scope.tournamentId).length],
        ['Audit entries', store.queryAudit({ tournamentId: scope.tournamentId, limit: 100000 }).length],
        ['Medal tally leader', tally[0] ? `${tally[0].unitId} (${tally[0].gold}G ${tally[0].silver}S ${tally[0].bronze}B)` : '—'],
      ];
      return out(['Measure', 'Value'], rows);
    }

    default:
      throw new Error(`report "${key}" has no renderer`);
  }
}

/** CSV with RFC-4180 quoting, for the Excel and CSV export formats. */
export function toCsv(r: ReportOutput): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    `# ${r.name}`,
    `# generated ${r.generatedAt}`,
    ...r.notes.map((n) => `# note: ${n}`),
    r.columns.map(esc).join(','),
    ...r.rows.map((row) => row.map(esc).join(',')),
  ];
  return lines.join('\n');
}

/**
 * Print-ready HTML, which is how the PDF and print formats are produced: the
 * browser's own print-to-PDF renders this without adding a PDF dependency to a
 * module that otherwise has none.
 */
export function toPrintableHtml(r: ReportOutput, subtitle = ''): string {
  const esc = (v: string | number): string =>
    String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(r.name)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11px/1.45 "Helvetica Neue", Arial, sans-serif; color: #111; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .sub { color: #555; font-size: 11px; margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; font-weight: 600; }
  tbody tr:nth-child(even) { background: #fafafa; }
  .notes { margin-top: 10px; font-size: 10px; color: #444; }
  .notes li { margin-bottom: 2px; }
  @media print { .noprint { display: none; } }
</style></head><body>
<h1>${esc(r.name)}</h1>
<div class="sub">${esc(subtitle)}${subtitle ? ' · ' : ''}Generated ${esc(r.generatedAt)}</div>
<table><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${r.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
${r.notes.length ? `<div class="notes"><strong>Notes</strong><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
<p class="noprint"><button onclick="window.print()">Print / Save as PDF</button></p>
</body></html>`;
}

/** §12.15 Reports Hub catalogue, filtered to what a role may run. */
export function catalogueFor(role: Role): ReportDefinition[] {
  return REPORTS.filter((r) => r.roles.includes(role));
}
