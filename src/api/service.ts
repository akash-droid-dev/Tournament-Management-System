/**
 * Application service layer.
 *
 * The engines and workflow modules are pure. This layer is where they meet the
 * store, the audit log and the notification fan-out. Every method that changes
 * state does three things in one transaction: apply the domain function, persist
 * the result, and write the audit entries the domain function handed back.
 *
 * Authorization: every method takes the acting `User` and checks the §3.2
 * matrix before touching anything. Authentication is the host GMS's job — see
 * `resolveUser` in server.ts.
 */

import type {
  DrawRecord,
  Entry,
  Format,
  Match,
  MatchOperations,
  NotificationEvent,
  NotificationType,
  Protest,
  Result,
  Role,
  StandingsRow,
  Tournament,
  TournamentEvent,
  User,
} from '../domain/types.ts';
import { AuditLog, type AuditWrite } from '../domain/audit.ts';
import {
  newEntryId,
  newEventId,
  newFormatId,
  newNotificationId,
  newProtestId,
  newTournamentId,
  nowISO,
  primeSeq,
} from '../domain/ids.ts';
import { can, canPublish, type Permission, type TmsFunction } from '../domain/rbac.ts';
import { DRAW_MACHINE, MATCH_MACHINE, TOURNAMENT_MACHINE, canCancelTournament, transition } from '../domain/status.ts';
import { getSport } from '../sports/registry.ts';
import { evaluateEligibility, type ParticipantSnapshot } from '../engines/eligibility.ts';
import { applyManualAdjustment, generateDraw, verifyReproducible, type DrawParameters } from '../engines/draw.ts';
import {
  autoSchedule,
  detectConflicts,
  proposeReschedule,
  utilisation,
  type SchedulingContext,
  type TimeGrid,
} from '../engines/scheduler.ts';
import { autoAssignOfficials, coverageGaps, dutyRoster, meetsMinimumPanel } from '../engines/officials.ts';
import { computeStandings } from '../engines/standings.ts';
import { downstreamImpact, progressionStatus, propagate } from '../engines/progression.ts';
import { approveAndPublishMedals, generateRankings, medalTally, verifyMedals } from '../engines/medals.ts';
import * as phases from '../workflow/phases.ts';
import * as approval from '../workflow/result-approval.ts';
import * as exceptions from '../workflow/exceptions.ts';
import { TmsStore } from '../store/db.ts';

export class ServiceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = 'ServiceError';
  }
}

// Annotated on the variable, not just the arrow: TypeScript only narrows
// control flow after a call when the *identifier's* declared type returns never.
const deny: (reason: string) => never = (reason) => {
  throw new ServiceError(reason, 403);
};
const bad: (reason: string) => never = (reason) => {
  throw new ServiceError(reason, 400);
};
const missing: (what: string) => never = (what) => {
  throw new ServiceError(`${what} not found`, 404);
};

export class TmsService {
  readonly store: TmsStore;
  readonly audit = new AuditLog();

  constructor(store: TmsStore) {
    this.store = store;
    // Mirror every in-process audit write into the append-only store table.
    this.audit.addSink((e) => this.store.appendAudit(e));
    this.#primeIdCounters();
  }

  /** Keep generated IDs climbing past whatever is already persisted. */
  #primeIdCounters(): void {
    const bump = (prefix: string, ids: string[]) => {
      let max = 0;
      for (const id of ids) {
        const n = Number(id.split('-')[1]);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
      if (max) primeSeq(prefix, max);
    };
    const ts = this.store.listTournaments();
    bump('TRN', ts.map((t) => t.tournamentId));
    for (const t of ts) {
      const events = this.store.listEvents(t.tournamentId);
      bump('EVT', events.map((e) => e.eventId));
      for (const e of events) {
        bump('ENT', this.store.listEntries(e.eventId).map((x) => x.entryId));
        bump('MCH', this.store.listMatches(e.eventId).map((x) => x.matchId));
        bump('RES', this.store.listResults(e.eventId).map((x) => x.resultId));
      }
      bump('PRT', this.store.listProtests().map((p) => p.protestId));
      bump('EXC', this.store.listExceptions(t.tournamentId).map((x) => x.exceptionId));
    }
    // Audit and notification IDs are the high-volume ones, and both have a
    // unique constraint: without priming them a restarted process would
    // re-issue LOG-000001 and every write would fail.
    primeSeq('LOG', this.store.maxIdSuffix('audit_log', 'log_id'));
    primeSeq('NTF', this.store.maxIdSuffix('notifications', 'notification_id'));
  }

  #require(user: User, fn: TmsFunction, perm: Permission, ctx: Parameters<typeof can>[3] = {}): void {
    const d = can(user, fn, perm, ctx);
    if (!d.allowed) deny(d.reason);
  }

  #commit(writes: AuditWrite[]): void {
    for (const w of writes) this.audit.record(w);
  }

  /** §11 outbound — emit a notification event for the Notification module. */
  #notify(
    tournamentId: string,
    type: NotificationType,
    audience: NotificationEvent['audience'],
    payload: Record<string, unknown>,
  ): NotificationEvent {
    const n: NotificationEvent = {
      notificationId: newNotificationId(),
      tournamentId,
      type,
      audience,
      channels: ['app', 'email'],
      payload,
      sentAt: nowISO(),
      deliveryStatus: 'sent',
    };
    this.store.saveNotification(n);
    return n;
  }

  #tournament(id: string): Tournament {
    return this.store.getTournament(id) ?? missing(`tournament ${id}`);
  }

  #event(id: string): TournamentEvent {
    return this.store.getEvent(id) ?? missing(`event ${id}`);
  }

  #match(id: string): Match {
    return this.store.getMatch(id) ?? missing(`match ${id}`);
  }

  /** Entry ID → display name and unit, needed by standings, medals, scheduler. */
  #entryMeta(eventId: string): Record<string, { displayName: string; unitId: string }> {
    const out: Record<string, { displayName: string; unitId: string }> = {};
    for (const e of this.store.listEntries(eventId)) {
      out[e.entryId] = { displayName: e.participantRef.displayName, unitId: e.unitId };
    }
    return out;
  }

  // ═══ Phase 1: Tournament creation ═══════════════════════════════════════

  createTournament(user: User, input: Omit<Tournament, 'tournamentId' | 'status' | 'createdBy' | 'createdAt'>): Tournament {
    this.#require(user, 'tournament.config', 'C');
    if (this.store.tournamentCodes().includes(input.code)) {
      bad(`tournament code "${input.code}" is already in use`);
    }
    const t: Tournament = {
      ...input,
      tournamentId: newTournamentId(),
      status: 'Draft',
      createdBy: user.userId,
      createdAt: nowISO(),
    };
    this.store.saveTournament(t);
    this.#commit([
      {
        userId: user.userId,
        userName: user.name,
        role: user.role,
        tournamentId: t.tournamentId,
        entityType: 'tournament',
        entityId: t.tournamentId,
        action: 'tournament.create',
        newValue: { code: t.code, name: t.name, level: t.level },
      },
    ]);
    return t;
  }

  /** §1.6 — validate and move Draft → Configured. */
  activateTournament(user: User, tournamentId: string): { tournament: Tournament; gate: phases.GateResult } {
    this.#require(user, 'tournament.config', 'E', { tournamentId });
    const t = this.#tournament(tournamentId);
    const events = this.store.listEvents(tournamentId);
    const gate = phases.validateTournament(t, {
      existingCodes: this.store.tournamentCodes(),
      organizingBodyExists: Boolean(t.organizingBody),
      competitionManagerCount: this.store.listUsers().filter(
        (u) => u.role === 'Competition Manager' && (u.scope.tournamentIds ?? []).includes(tournamentId),
      ).length,
      intendedSportCount: new Set(events.map((e) => e.sport)).size || (t.venues.length ? 1 : 0),
    });
    if (!gate.open) bad(`tournament cannot be configured yet: ${gate.blockers.join('; ')}`);
    const tr = transition(TOURNAMENT_MACHINE, { from: t.status, to: 'Configured' });
    if (!tr.ok) bad(tr.error as string);
    const next = { ...t, status: 'Configured' as const };
    this.store.saveTournament(next);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId,
        entityType: 'tournament', entityId: tournamentId, action: 'tournament.configure',
        oldValue: t.status, newValue: 'Configured',
      },
    ]);
    return { tournament: next, gate };
  }

  setTournamentStatus(user: User, tournamentId: string, to: Tournament['status'], reasonCode?: string): Tournament {
    this.#require(user, 'tournament.config', 'E', { tournamentId });
    const t = this.#tournament(tournamentId);
    if (to === 'Cancelled') {
      const c = canCancelTournament(t.status, user.role);
      if (!c.allowed) deny(c.reason);
    }
    if (to === 'Entries Open' || to === 'Entries Locked' || to === 'Draw Published') {
      const p = canPublish(user);
      if (!p.allowed) deny(p.reason);
    }
    const tr = transition(TOURNAMENT_MACHINE, { from: t.status, to, reasonCode });
    if (!tr.ok) bad(tr.error as string);
    const next = { ...t, status: to };
    this.store.saveTournament(next);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId,
        entityType: 'tournament', entityId: tournamentId, action: 'tournament.status',
        oldValue: t.status, newValue: to, reasonCode,
      },
    ]);
    if (to === 'Entries Open') {
      // §3.1 — Team Managers are notified when the entry window opens.
      this.#notify(tournamentId, 'entry_window_open', { roles: ['Team Manager'] }, { tournamentId, deadline: t.entryDeadline });
      for (const e of this.store.listEvents(tournamentId)) {
        if (e.confirmedAt) this.store.saveEvent({ ...e, status: 'Entries Open' });
      }
    }
    if (to === 'Entries Locked') {
      this.#notify(tournamentId, 'entries_locked', { roles: ['Team Manager', 'Competition Manager'] }, { tournamentId });
      for (const e of this.store.listEvents(tournamentId)) {
        if (e.status === 'Entries Open') this.store.saveEvent({ ...e, status: 'Entries Locked' });
      }
    }
    return next;
  }

  // ═══ Phase 2: Sport and event configuration ═════════════════════════════

  addEvent(user: User, tournamentId: string, input: Omit<TournamentEvent, 'eventId' | 'tournamentId' | 'status' | 'drawStatus'>): TournamentEvent {
    this.#require(user, 'sport.config', 'C', { tournamentId, sportId: input.sport });
    this.#tournament(tournamentId);
    // §11 integration rule: an unknown sport blocks the action rather than
    // proceeding on a guess.
    getSport(input.sport);
    const e: TournamentEvent = {
      ...input,
      eventId: newEventId(),
      tournamentId,
      status: 'Draft',
      drawStatus: 'Not Generated',
    };
    this.store.saveEvent(e);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId,
        entityType: 'event', entityId: e.eventId, action: 'event.create',
        newValue: { sport: e.sport, discipline: e.discipline, age: e.ageCategory, gender: e.genderCategory },
      },
    ]);
    return e;
  }

  /** §2.7 — the Tournament Admin locks the event catalogue. */
  confirmEvent(user: User, eventId: string): TournamentEvent {
    const e = this.#event(eventId);
    this.#require(user, 'sport.config', 'E', { tournamentId: e.tournamentId, sportId: e.sport });
    if (user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
      deny('confirming the event catalogue is a Tournament Admin act (§2.7)');
    }
    if (!e.scoringTemplateId) bad('an event cannot be confirmed without a scoring template (§2.5)');
    const next: TournamentEvent = { ...e, status: 'Confirmed', confirmedAt: nowISO() };
    this.store.saveEvent(next);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'event', entityId: eventId, action: 'event.confirm', oldValue: e.status, newValue: 'Confirmed',
      },
    ]);
    return next;
  }

  // ═══ Phase 3: Entries ═══════════════════════════════════════════════════

  /** §3.2 — the eligible pool, scoped to the caller's unit for Team Managers. */
  eligiblePool(user: User, eventId: string): ParticipantSnapshot[] {
    const e = this.#event(eventId);
    this.#require(user, 'entry.mapping', user.role === 'Team Manager' ? 'C' : 'E', {
      tournamentId: e.tournamentId,
      ownerUnitId: user.scope.unitId,
    });
    const unit = user.role === 'Team Manager' ? user.scope.unitId : undefined;
    // §3.2 — only Approved records with valid accreditation are offered.
    return this.store
      .listParticipants(e.tournamentId, unit)
      .filter((p) => p.upstreamStatus === 'Approved');
  }

  /** §3.3–3.5 — map an entry, running the eligibility engine in real time. */
  addEntry(
    user: User,
    eventId: string,
    input: { participantId: string; seedNo?: number; rosterIds?: string[] },
  ): Entry {
    const e = this.#event(eventId);
    const t = this.#tournament(e.tournamentId);
    const participant = this.store.getParticipant(input.participantId) ?? missing(`participant ${input.participantId}`);
    this.#require(user, 'entry.mapping', user.role === 'Team Manager' ? 'C' : 'E', {
      tournamentId: e.tournamentId,
      ownerUnitId: participant.unitId,
    });
    if (e.status !== 'Entries Open' && e.status !== 'Confirmed') {
      bad(`entries are not open for this event (status ${e.status})`);
    }

    const existing = this.store.listEntries(eventId);
    const across = this.store
      .listEntriesForParticipant(e.tournamentId, input.participantId)
      .map((x) => ({ eventId: x.eventId, eventLabel: this.store.getEvent(x.eventId)?.discipline ?? x.eventId }));

    const roster = input.rosterIds?.length
      ? input.rosterIds.map((id) => this.store.getParticipant(id)?.ref).filter((r): r is NonNullable<typeof r> => Boolean(r))
      : participant.rosterRefs;

    const eligibility = evaluateEligibility({
      tournament: t,
      event: e,
      participant: { ...participant, rosterRefs: roster },
      existingEntries: existing,
      participantEntriesInTournament: across,
    });

    const entry: Entry = {
      entryId: newEntryId(),
      eventId,
      participantRef: { ...participant.ref, revalidatedAt: nowISO() },
      unitId: participant.unitId,
      seedNo: input.seedNo,
      entryStatus: eligibility.eligible ? 'Submitted' : 'Blocked',
      eligibilityResult: eligibility,
      overrideFlag: false,
      rosterRefs: roster,
      enteredBy: user.userId,
      enteredAt: nowISO(),
    };
    this.store.saveEntry(entry);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'entry', entityId: entry.entryId, action: 'entry.create',
        newValue: { participant: participant.ref.displayName, status: entry.entryStatus },
      },
    ]);
    return entry;
  }

  /** §3.5 / §7.1.4 — Tournament Admin override, reason code mandatory. */
  overrideEntry(user: User, entryId: string, reason: string): Entry {
    const entry = this.store.getEntry(entryId) ?? missing(`entry ${entryId}`);
    const e = this.#event(entry.eventId);
    if (user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
      deny('only a Tournament Admin may override a failed eligibility check, with a reason (§7.1.4)');
    }
    if (!reason?.trim()) bad('an override requires a reason code (§3.5)');
    const next: Entry = {
      ...entry,
      entryStatus: 'Confirmed',
      overrideFlag: true,
      overrideReason: reason,
      overrideBy: user.userId,
    };
    this.store.saveEntry(next);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'entry', entityId: entryId, action: 'entry.override',
        oldValue: entry.entryStatus, newValue: 'Confirmed', reasonCode: reason,
      },
    ]);
    return next;
  }

  confirmEntry(user: User, entryId: string): Entry {
    const entry = this.store.getEntry(entryId) ?? missing(`entry ${entryId}`);
    const e = this.#event(entry.eventId);
    this.#require(user, 'entry.mapping', 'A', { tournamentId: e.tournamentId });
    if (entry.entryStatus === 'Blocked') {
      bad('a blocked entry must be corrected or overridden with a reason before it can be confirmed (§3.5)');
    }
    const next: Entry = { ...entry, entryStatus: 'Confirmed' };
    this.store.saveEntry(next);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'entry', entityId: entryId, action: 'entry.confirm',
        oldValue: entry.entryStatus, newValue: 'Confirmed',
      },
    ]);
    return next;
  }

  /** §5.2 — a withdrawal after lock is kept on record as a scratch. */
  scratchEntry(user: User, entryId: string, reason: string): Entry {
    const entry = this.store.getEntry(entryId) ?? missing(`entry ${entryId}`);
    const e = this.#event(entry.eventId);
    this.#require(user, 'entry.mapping', 'E', { tournamentId: e.tournamentId, ownerUnitId: entry.unitId });
    if (!reason?.trim()) bad('a scratch requires a reason (§5.2)');
    const drawPublished = e.drawStatus === 'Published';
    const next: Entry = { ...entry, entryStatus: 'Scratched', scratchReason: reason };
    this.store.saveEntry(next);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'entry', entityId: entryId, action: 'entry.scratch',
        oldValue: entry.entryStatus, newValue: 'Scratched', reasonCode: reason,
      },
    ]);
    if (drawPublished) {
      // §5.2 — a withdrawal after the draw is treated as a walkover, not a
      // silent removal from the bracket.
      this.#notify(
        e.tournamentId, 'reschedule', { roles: ['Competition Manager', 'Tournament Admin'] },
        { entryId, note: 'withdrawal after draw publication — affected fixtures must be handled as walkovers (§5.2)' },
      );
    }
    return next;
  }

  entryGate(eventId: string): phases.GateResult {
    return phases.gateToFormat(this.#event(eventId), this.store.listEntries(eventId));
  }

  // ═══ Phase 4: Format ════════════════════════════════════════════════════

  setFormat(user: User, eventId: string, input: Omit<Format, 'formatId' | 'eventId' | 'approvalStatus' | 'lockedByDraw'>): Format {
    const e = this.#event(eventId);
    this.#require(user, 'format.rules', 'C', { tournamentId: e.tournamentId, sportId: e.sport });
    const existing = this.store.getFormatForEvent(eventId);
    // §7.2.7 — the format cannot change after the draw is published.
    if (existing?.lockedByDraw || e.drawStatus === 'Published') {
      bad('the format cannot change after draw publication; a change forces a formal redraw with Admin approval (§7.2.7)');
    }
    const f: Format = {
      ...input,
      formatId: existing?.formatId ?? newFormatId(),
      eventId,
      approvalStatus: 'Submitted',
      lockedByDraw: false,
    };
    this.store.saveFormat(f);
    this.store.saveEvent({ ...e, formatId: f.formatId });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'format', entityId: f.formatId, action: 'format.set',
        oldValue: existing ? { type: existing.type, groups: existing.groupCount } : undefined,
        newValue: { type: f.type, groups: f.groupCount, perGroup: f.teamsPerGroup },
      },
    ]);
    return f;
  }

  /** §4.6 — Tournament Admin approves; the format then locks. */
  approveFormat(user: User, eventId: string): { format: Format; gate: phases.GateResult } {
    const e = this.#event(eventId);
    this.#require(user, 'format.rules', 'A', { tournamentId: e.tournamentId });
    const f = this.store.getFormatForEvent(eventId) ?? missing(`format for event ${eventId}`);
    const entries = this.store.listEntries(eventId);
    const gate = phases.gateToDraw(e, { ...f, approvalStatus: 'Approved' }, entries);
    if (!gate.open) bad(`format cannot be approved: ${gate.blockers.join('; ')}`);
    const next: Format = { ...f, approvalStatus: 'Approved', approvedBy: user.userId, approvedAt: nowISO() };
    this.store.saveFormat(next);
    this.store.saveEvent({ ...e, status: 'Format Approved' });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'format', entityId: f.formatId, action: 'format.approve',
        oldValue: f.approvalStatus, newValue: 'Approved',
      },
    ]);
    return { format: next, gate };
  }

  // ═══ Phase 5: Draw ══════════════════════════════════════════════════════

  generateDraw(user: User, eventId: string, params: Omit<DrawParameters, 'generatedBy'>): { draw: DrawRecord; matches: Match[]; warnings: string[] } {
    const e = this.#event(eventId);
    this.#require(user, 'draw.generation', 'C', { tournamentId: e.tournamentId, sportId: e.sport });
    const f = this.store.getFormatForEvent(eventId) ?? missing(`format for event ${eventId}`);
    const entries = this.store.listEntries(eventId);
    const gate = phases.gateToDraw(e, f, entries);
    if (!gate.open) bad(`draw cannot be generated: ${gate.blockers.join('; ')}`);

    const out = generateDraw(e, f, entries, { ...params, generatedBy: user.userId });
    this.store.transaction(() => {
      this.store.saveDraw(out.draw);
      this.store.saveMatches(out.matches);
      this.store.saveEvent({ ...e, drawStatus: out.draw.status });
      this.store.saveFormat({ ...f, lockedByDraw: true });
    });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'draw', entityId: out.draw.drawId, action: 'draw.generate',
        newValue: {
          seed: out.draw.rngSeed, algorithm: out.draw.rngAlgorithm, bracket: out.draw.bracketSize,
          entries: out.draw.entryCount, byes: out.draw.byeCount, fixtures: out.matches.length,
          validationErrors: out.draw.validationErrors,
        },
      },
    ]);
    return out;
  }

  /** §5.4 — a logged, re-validated manual swap, allowed only in Draft Draw. */
  adjustDraw(user: User, eventId: string, fromSlot: number, toSlot: number): DrawRecord {
    const e = this.#event(eventId);
    this.#require(user, 'draw.generation', 'E', { tournamentId: e.tournamentId, sportId: e.sport });
    const draw = this.store.getDrawForEvent(eventId) ?? missing(`draw for event ${eventId}`);
    const matches = this.store.listMatches(eventId);
    const res = applyManualAdjustment({ draw, matches, warnings: [] }, fromSlot, toSlot, user.userId);
    if (res.error) bad(res.error);
    this.store.transaction(() => {
      this.store.saveDraw(res.output.draw);
      this.store.saveMatches(res.output.matches);
    });
    const adj = res.output.draw.manualAdjustments.at(-1);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'draw', entityId: draw.drawId, action: 'draw.manual-adjust',
        oldValue: adj?.before, newValue: adj?.after,
      },
    ]);
    return res.output.draw;
  }

  /** §5.6 — Tournament Admin approves and publishes; notifications fire. */
  publishDraw(user: User, eventId: string): { draw: DrawRecord; notification: NotificationEvent } {
    const e = this.#event(eventId);
    this.#require(user, 'draw.generation', 'P', { tournamentId: e.tournamentId });
    const p = canPublish(user);
    if (!p.allowed) deny(p.reason);
    const draw = this.store.getDrawForEvent(eventId) ?? missing(`draw for event ${eventId}`);
    if (draw.validationErrors.length) {
      bad(`the draw failed validation and cannot be published: ${draw.validationErrors.join('; ')}`);
    }
    const tr = transition(DRAW_MACHINE, { from: draw.status, to: 'Validated' });
    if (!tr.ok && draw.status !== 'Validated') bad(tr.error as string);
    const tr2 = transition(DRAW_MACHINE, { from: 'Validated', to: 'Published' });
    if (!tr2.ok) bad(tr2.error as string);

    const next: DrawRecord = { ...draw, status: 'Published', approvedBy: user.userId, publishedAt: nowISO() };
    // A bye advances its occupant the moment the draw is published.
    const propagated = propagate({
      matches: this.store.listMatches(eventId),
      results: this.store.listResults(eventId),
      entryMeta: this.#entryMeta(eventId),
    });
    this.store.transaction(() => {
      this.store.saveDraw(next);
      this.store.saveMatches(propagated.matches);
      this.store.saveEvent({ ...e, drawStatus: 'Published', status: 'Draw Published' });
    });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'draw', entityId: draw.drawId, action: 'draw.publish',
        oldValue: draw.status, newValue: 'Published',
      },
    ]);
    const notification = this.#notify(
      e.tournamentId, 'draw_published',
      { roles: ['Team Manager', 'Viewer', 'Technical Official', 'Referee'] },
      { eventId, discipline: e.discipline, fixtures: propagated.matches.length },
    );
    return { draw: next, notification };
  }

  /** §7.2.9 — prove a stored draw replays exactly from its seed. */
  verifyDraw(user: User, eventId: string): { reproducible: boolean; detail: string } {
    const e = this.#event(eventId);
    this.#require(user, 'draw.generation', 'V', { tournamentId: e.tournamentId, isPublished: e.drawStatus === 'Published' });
    const draw = this.store.getDrawForEvent(eventId) ?? missing(`draw for event ${eventId}`);
    const f = this.store.getFormatForEvent(eventId) ?? missing(`format for event ${eventId}`);
    return verifyReproducible(e, f, this.store.listEntries(eventId), draw);
  }

  // ═══ Phase 6: Schedule and officials ════════════════════════════════════

  #schedulingContext(eventId: string, grid?: TimeGrid): SchedulingContext {
    const e = this.#event(eventId);
    const t = this.#tournament(e.tournamentId);
    const venues = this.store.listVenues(e.tournamentId);
    return {
      matches: this.store.listMatches(eventId),
      venues,
      grid: grid ?? this.defaultGrid(t),
      entryUnits: Object.fromEntries(
        Object.entries(this.#entryMeta(eventId)).map(([k, v]) => [k, v.unitId]),
      ),
      sportId: e.sport,
      assignments: this.store.listAssignments(),
    };
  }

  /** §6.2 — the default session grid, derived from the tournament dates. */
  defaultGrid(t: Tournament): TimeGrid {
    const dates: string[] = [];
    for (let d = new Date(t.startDate); d <= new Date(t.endDate); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    return {
      dates,
      sessions: [
        { session: 'morning', from: '09:00', to: '13:00' },
        { session: 'afternoon', from: '14:00', to: '18:00' },
        { session: 'evening', from: '18:30', to: '22:00' },
      ],
      turnaroundMins: 15,
      warmUpMins: 15,
    };
  }

  autoSchedule(user: User, eventId: string, primeMatchNos?: string[]): ReturnType<typeof autoSchedule> {
    const e = this.#event(eventId);
    this.#require(user, 'schedule.allocation', 'C', { tournamentId: e.tournamentId, sportId: e.sport });
    if (e.drawStatus !== 'Published') {
      const gate = phases.gateToSchedule(this.store.getDrawForEvent(eventId), this.store.listMatches(eventId));
      bad(`scheduling cannot start: ${gate.blockers.join('; ')}`);
    }
    const ctx = this.#schedulingContext(eventId);
    const out = autoSchedule({ ...ctx, primeMatchNos });
    this.store.saveMatches(out.matches);
    const st = this.store.getScheduleState(eventId);
    this.store.saveScheduleState({
      ...st,
      status: out.conflicts.publishable ? 'Validated' : 'Draft',
    });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'schedule', entityId: eventId, action: 'schedule.auto',
        newValue: {
          scheduled: out.matches.filter((m) => m.scheduledDate).length,
          unplaced: out.unplaced.length,
          hard: out.conflicts.hard.length,
          soft: out.conflicts.soft.length,
        },
      },
    ]);
    return out;
  }

  conflicts(eventId: string): ReturnType<typeof detectConflicts> {
    return detectConflicts(this.#schedulingContext(eventId));
  }

  /** §7.2.11 — soft conflicts need explicit acknowledgment before publishing. */
  acknowledgeSoftConflicts(user: User, eventId: string, codes: string[]): void {
    const e = this.#event(eventId);
    this.#require(user, 'schedule.allocation', 'E', { tournamentId: e.tournamentId });
    const st = this.store.getScheduleState(eventId);
    this.store.saveScheduleState({
      ...st,
      acknowledgedSoft: [...new Set([...st.acknowledgedSoft, ...codes])],
    });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'schedule', entityId: eventId, action: 'schedule.acknowledge-soft',
        newValue: codes,
      },
    ]);
  }

  publishSchedule(user: User, eventId: string): { state: ReturnType<TmsStore['getScheduleState']>; notification: NotificationEvent } {
    const e = this.#event(eventId);
    this.#require(user, 'schedule.allocation', 'P', { tournamentId: e.tournamentId });
    const p = canPublish(user);
    if (!p.allowed) deny(p.reason);
    const st = this.store.getScheduleState(eventId);
    const gate = phases.gateToPublishSchedule(this.#schedulingContext(eventId), st.acknowledgedSoft);
    if (!gate.open) bad(`schedule cannot be published: ${gate.blockers.join('; ')}`);
    const next = {
      ...st,
      status: 'Published' as const,
      publishedAt: nowISO(),
      versionNo: st.publishedAt ? st.versionNo + 1 : st.versionNo,
    };
    this.store.saveScheduleState(next);
    this.store.saveEvent({ ...e, status: 'Scheduled' });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'schedule', entityId: eventId, action: 'schedule.publish',
        oldValue: st.status, newValue: `Published v${next.versionNo}`,
      },
    ]);
    const notification = this.#notify(
      e.tournamentId, 'schedule_published',
      { roles: ['Team Manager', 'Viewer', 'Referee', 'Technical Official', 'Scorer', 'Venue Manager'] },
      { eventId, version: next.versionNo },
    );
    return { state: next, notification };
  }

  reschedule(user: User, matchId: string, input: { toDate: string; toTime: string; toFopId: string; reasonCode: string }): Match {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'schedule.allocation', 'E', { tournamentId: e.tournamentId });
    // §6.8 — a Competition Manager proposes; a Tournament Admin approves.
    if (user.role === 'Competition Manager') {
      deny('a Competition Manager proposes a reschedule; a Tournament Admin must approve and apply it (§6.8)');
    }
    const ctx = this.#schedulingContext(m.eventId);
    const out = proposeReschedule(ctx, { matchNo: m.matchNo, ...input, requestedBy: user.userId }, user.userId);
    if (!out.accepted) bad(out.error ?? 'reschedule rejected');
    this.store.saveMatches(out.matches);
    const st = this.store.getScheduleState(m.eventId);
    if (st.status === 'Published') {
      this.store.saveScheduleState({ ...st, status: 'Amended', versionNo: st.versionNo + 1 });
    }
    const next = out.matches.find((x) => x.matchId === matchId) as Match;
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'match', entityId: matchId, action: 'match.reschedule',
        oldValue: { date: m.scheduledDate, time: m.scheduledTime, fop: m.fopId },
        newValue: { date: input.toDate, time: input.toTime, fop: input.toFopId, version: next.versionNo },
        reasonCode: input.reasonCode,
      },
    ]);
    // §6.8 — affected parties only.
    this.#notify(
      e.tournamentId, 'reschedule',
      { roles: ['Team Manager', 'Referee', 'Scorer', 'Venue Manager'], officialIds: m.officials.map((o) => o.officialId) },
      { matchNo: m.matchNo, from: `${m.scheduledDate} ${m.scheduledTime}`, to: `${input.toDate} ${input.toTime}`, reasonCode: input.reasonCode },
    );
    return next;
  }

  assignOfficials(user: User, matchId: string): ReturnType<typeof autoAssignOfficials> {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    const t = this.#tournament(e.tournamentId);
    this.#require(user, 'officials.assignment', 'C', { tournamentId: e.tournamentId, sportId: e.sport });
    const meta = this.#entryMeta(m.eventId);
    const out = autoAssignOfficials({
      tournament: t,
      match: m,
      sideUnits: {
        a: m.sideA.kind === 'entry' ? meta[m.sideA.entryId]?.unitId : undefined,
        b: m.sideB.kind === 'entry' ? meta[m.sideB.entryId]?.unitId : undefined,
      },
      pool: this.store.listOfficials(e.tournamentId),
      existing: this.store.listAssignments(),
      allMatches: this.store.listMatchesForTournament(e.tournamentId),
      venues: this.store.listVenues(e.tournamentId),
      sportId: e.sport,
      assignedBy: user.userId,
    });
    this.store.transaction(() => {
      for (const a of out.assignments) this.store.saveAssignment(a);
      this.store.saveMatch({
        ...m,
        officials: out.assignments.map((a) => ({
          officialId: a.officialId, officialName: a.officialName, role: a.role, unitId: a.unitId,
        })),
      });
    });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'match', entityId: matchId, action: 'officials.assign',
        newValue: { assigned: out.assignments.map((a) => `${a.role}:${a.officialName}`), unfilled: out.unfilled },
      },
    ]);
    if (out.assignments.length) {
      this.#notify(
        e.tournamentId, 'duty_assigned',
        { officialIds: out.assignments.map((a) => a.officialId) },
        { matchNo: m.matchNo, date: m.scheduledDate, time: m.scheduledTime, venue: m.venueId },
      );
    }
    return out;
  }

  dutyRoster(tournamentId: string): ReturnType<typeof dutyRoster> {
    return dutyRoster(this.store.listAssignments(), this.store.listMatchesForTournament(tournamentId));
  }

  officialsCoverage(tournamentId: string, withinHours = 48): ReturnType<typeof coverageGaps> {
    const events = this.store.listEvents(tournamentId);
    const out: ReturnType<typeof coverageGaps> = [];
    for (const e of events) {
      out.push(
        ...coverageGaps(e.sport, this.store.listMatches(e.eventId), this.store.listAssignments(), withinHours),
      );
    }
    return out;
  }

  venueUtilisation(eventId: string): ReturnType<typeof utilisation> {
    return utilisation(this.#schedulingContext(eventId));
  }

  // ═══ Phase 7: Match operations ══════════════════════════════════════════

  #operations(matchId: string): MatchOperations {
    return (
      this.store.getOperations(matchId) ?? {
        matchId,
        attendance: [],
        scoreEvents: [],
        periodScores: [],
        sanctions: [],
        suspensionLog: [],
      }
    );
  }

  /** §7.1 — open the match console; Scheduled → Check-in. */
  openConsole(user: User, matchId: string): { match: Match; operations: MatchOperations; gate: phases.GateResult } {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'match.start', 'E', { tournamentId: e.tournamentId, matchId });
    const st = this.store.getScheduleState(m.eventId);
    const gate = phases.gateToMatchOperations(
      m, this.store.listAssignments(matchId), e.sport, st.status === 'Published' || st.status === 'Amended',
    );
    if (!gate.open) bad(`match console cannot open: ${gate.blockers.join('; ')}`);
    if (m.sideA.kind !== 'entry' || m.sideB.kind !== 'entry') {
      bad(`${m.matchNo} still has an unresolved side; both participants must be known before check-in`);
    }
    const tr = transition(MATCH_MACHINE, { from: m.matchStatus, to: 'Check-in' });
    if (!tr.ok) bad(tr.error as string);
    const next = { ...m, matchStatus: 'Check-in' as const };
    const ops = exceptions.startNoShowTimer(this.#operations(matchId), NO_SHOW_GRACE_MINS);
    this.store.transaction(() => {
      this.store.saveMatch(next);
      this.store.saveOperations(ops);
    });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'match', entityId: matchId, action: 'match.checkin-open',
        oldValue: m.matchStatus, newValue: 'Check-in',
      },
    ]);
    return { match: next, operations: ops, gate };
  }

  /** §7.2 — attendance and line-up, with accreditation verified. */
  recordAttendance(user: User, matchId: string, rows: MatchOperations['attendance']): MatchOperations {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'match.start', 'E', { tournamentId: e.tournamentId, matchId });
    const sport = getSport(e.sport);
    for (const side of ['A', 'B'] as const) {
      const lineup = rows.filter((r) => r.side === side && r.present && r.startingLineup);
      if (lineup.length > sport.roster.onField) {
        bad(`side ${side} has ${lineup.length} players in the starting line-up; ${sport.name} allows ${sport.roster.onField} on the ${sport.fopType}`);
      }
      const invalid = rows.filter((r) => r.side === side && r.present && !r.accreditationValid);
      if (invalid.length) {
        // §11 — invalid or expired accreditation blocks attendance confirmation.
        bad(`accreditation is invalid for ${invalid.map((r) => r.participantName).join(', ')}; attendance cannot be confirmed (§11 Accreditation)`);
      }
    }
    const ops: MatchOperations = { ...this.#operations(matchId), attendance: rows };
    this.store.saveOperations(ops);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'match', entityId: matchId, action: 'match.attendance',
        newValue: { present: rows.filter((r) => r.present).length, absent: rows.filter((r) => !r.present).length },
      },
    ]);
    return ops;
  }

  /** §7.3 — pre-match formalities. In Kabaddi the toss winner picks court or raid. */
  recordToss(user: User, matchId: string, winner: 'A' | 'B', choice: 'court' | 'raid'): MatchOperations {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    if (user.role !== 'Referee' && user.role !== 'Scorer' && user.role !== 'Technical Official' && user.role !== 'Tournament Admin' && user.role !== 'Super Admin') {
      deny('the toss is recorded by the Referee or the Scorer on their behalf (§7.3)');
    }
    const ops: MatchOperations = { ...this.#operations(matchId), tossWinner: winner, tossChoice: choice };
    this.store.saveOperations(ops);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'match', entityId: matchId, action: 'match.toss',
        newValue: { winner, choice },
      },
    ]);
    return ops;
  }

  /** §7.4 — start the match; Check-in → Live. */
  startMatch(user: User, matchId: string): Match {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'match.start', 'E', { tournamentId: e.tournamentId, matchId });
    const panel = meetsMinimumPanel(e.sport, this.store.listAssignments(matchId));
    if (!panel.ok) {
      bad(`${m.matchNo} cannot start: minimum officials panel incomplete — ${panel.missing.map((x) => `${x.role} ${x.have}/${x.needed}`).join(', ')} (§7.3.15)`);
    }
    const ops = this.#operations(matchId);
    const absent = ops.attendance.filter((a) => !a.present);
    if (absent.length) {
      bad(`${absent.map((a) => a.participantName).join(', ')} are not marked present; resolve attendance or rule a no-show first (§7.2)`);
    }
    if (!ops.attendance.length) bad('attendance must be confirmed before the match can start (§7.2)');
    const tr = transition(MATCH_MACHINE, { from: m.matchStatus, to: 'Live' });
    if (!tr.ok) bad(tr.error as string);
    const next = { ...m, matchStatus: 'Live' as const };
    this.store.transaction(() => {
      this.store.saveMatch(next);
      this.store.saveOperations({ ...ops, startTimeActual: nowISO() });
    });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'match', entityId: matchId, action: 'match.start',
        oldValue: m.matchStatus, newValue: 'Live',
      },
    ]);
    return next;
  }

  /**
   * §7.5 — record one scoring action. The sport template validates legality,
   * derives what the rules imply, and the whole event log is persisted so the
   * console can rebuild state after a reload.
   */
  recordScore(
    user: User,
    matchId: string,
    ev: { type: string; side: 'A' | 'B'; value?: number; participantId?: string; clockSecs: number; detail?: Record<string, string | number | boolean> },
  ): { operations: MatchOperations; state: unknown; summary: { a: number; b: number; statistics: Record<string, number> }; issues: { severity: string; code: string; message: string }[]; describe: string } {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'match.score', 'E', { tournamentId: e.tournamentId, matchId });
    if (m.matchStatus !== 'Live') {
      bad(`${m.matchNo} is ${m.matchStatus}; scores can only be recorded while the match is Live`);
    }
    const sport = getSport(e.sport);
    const f = this.store.getFormatForEvent(m.eventId);
    const params = f?.matchParams ?? sport.matchDefaults;
    const ops = this.#operations(matchId);

    let state = sport.scoring.replay(params, ops.scoreEvents);
    const validation = sport.scoring.validate(state, ev);
    if (!validation.legal) {
      // §7.4.16 — impossible scores are rejected at entry.
      bad(validation.issues.filter((i) => i.severity === 'hard').map((i) => i.message).join('; '));
    }
    const applied = sport.scoring.apply(state, ev);
    state = applied.state;

    let seq = ops.scoreEvents.length;
    const toStore = [ev, ...applied.derived].map((x) => ({
      seq: ++seq,
      timestamp: nowISO(),
      clockSecs: x.clockSecs,
      type: x.type,
      side: x.side,
      value: x.value ?? 0,
      participantId: x.participantId,
      detail: x.detail,
      enteredBy: user.userId,
    }));
    const summary = sport.scoring.summarize(state);
    const nextOps: MatchOperations = {
      ...ops,
      scoreEvents: [...ops.scoreEvents, ...toStore],
      periodScores: [
        ...ops.periodScores.filter((p) => p.period !== (state as { period: number }).period),
        { period: (state as { period: number }).period, a: summary.a, b: summary.b },
      ].sort((a, b) => a.period - b.period),
      sanctions:
        ev.type.startsWith('card-') && ev.participantId
          ? [
              ...ops.sanctions,
              {
                participantId: ev.participantId,
                participantName: ops.attendance.find((a) => a.participantId === ev.participantId)?.participantName ?? ev.participantId,
                card: ev.type.replace('card-', '') as 'green' | 'yellow' | 'red',
                reason: String(ev.detail?.reason ?? ''),
                clockSecs: ev.clockSecs,
                issuedBy: user.userId,
              },
            ]
          : ops.sanctions,
    };
    this.store.saveOperations(nextOps);
    return {
      operations: nextOps,
      state,
      summary,
      issues: validation.issues,
      describe: sport.scoring.describeState(state),
    };
  }

  /** §7.7 — end the match; Live → Completed (Provisional). */
  endMatch(user: User, matchId: string): { match: Match; summary: { a: number; b: number; statistics: Record<string, number> } } {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'match.start', 'E', { tournamentId: e.tournamentId, matchId });
    const sport = getSport(e.sport);
    const f = this.store.getFormatForEvent(m.eventId);
    const params = f?.matchParams ?? sport.matchDefaults;
    const ops = this.#operations(matchId);
    const state = sport.scoring.replay(params, ops.scoreEvents);
    const summary = sport.scoring.summarize(state);
    const tr = transition(MATCH_MACHINE, { from: m.matchStatus, to: 'Completed (Provisional)' });
    if (!tr.ok) bad(tr.error as string);
    const next = { ...m, matchStatus: 'Completed (Provisional)' as const };
    this.store.transaction(() => {
      this.store.saveMatch(next);
      this.store.saveOperations({ ...ops, endTimeActual: nowISO() });
    });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'match', entityId: matchId, action: 'match.end',
        oldValue: 'Live', newValue: { status: 'Completed (Provisional)', score: `${summary.a}-${summary.b}` },
      },
    ]);
    return { match: next, summary };
  }

  /** §7.7 — the Referee digitally signs the match report. */
  refereeSignoff(user: User, matchId: string): MatchOperations {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    if (user.role !== 'Referee' && user.role !== 'Technical Official' && user.role !== 'Super Admin') {
      deny('the match report is signed off by the Referee (§7.7)');
    }
    const assigned = this.store.listAssignments(matchId);
    if (user.role === 'Referee' && !assigned.some((a) => a.officialId === user.userId && a.status !== 'replaced')) {
      deny(`${user.name} is not assigned to ${m.matchNo} and cannot sign its match report`);
    }
    const ops: MatchOperations = {
      ...this.#operations(matchId),
      refereeSignoff: { officialId: user.userId, officialName: user.name, timestamp: nowISO() },
    };
    this.store.saveOperations(ops);
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'match', entityId: matchId, action: 'match.referee-signoff',
        newValue: ops.refereeSignoff,
      },
    ]);
    return ops;
  }

  matchConsole(user: User, matchId: string): Record<string, unknown> {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    const sport = getSport(e.sport);
    const f = this.store.getFormatForEvent(m.eventId);
    const params = f?.matchParams ?? sport.matchDefaults;
    const ops = this.#operations(matchId);
    const state = sport.scoring.replay(params, ops.scoreEvents);
    const st = this.store.getScheduleState(m.eventId);
    return {
      match: m,
      event: e,
      operations: ops,
      state,
      summary: sport.scoring.summarize(state),
      describe: sport.scoring.describeState(state),
      consoleActions: sport.consoleActions,
      officials: this.store.listAssignments(matchId),
      panel: meetsMinimumPanel(e.sport, this.store.listAssignments(matchId)),
      result: this.store.getResultForMatch(matchId),
      roster: sport.roster,
      gate: phases.gateToMatchOperations(m, this.store.listAssignments(matchId), e.sport, st.status === 'Published' || st.status === 'Amended'),
      canScore: can(user, 'match.score', 'E', { tournamentId: e.tournamentId, matchId }).allowed,
    };
  }

  // ═══ Phase 8: Results ═══════════════════════════════════════════════════

  /** Apply a workflow outcome: persist, audit, and recompute downstream. */
  #applyResult(
    outcome: approval.WorkflowOutcome<Result>,
    tournamentId: string,
    recompute = false,
  ): Result {
    if (!outcome.ok || !outcome.value) bad(outcome.error ?? 'workflow rejected the change');
    const r = outcome.value;
    this.store.saveResult(r);
    this.#commit(outcome.audit);
    if (recompute) this.recomputeEvent(r.eventId);
    void tournamentId;
    return r;
  }

  enterResult(
    user: User,
    matchId: string,
    input: { finalScore?: { a: number; b: number }; winnerRef?: string; outcomeType?: Result['outcomeType']; offlineEntry?: boolean },
  ): Result {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    const t = this.#tournament(e.tournamentId);
    this.#require(user, 'result.provisional', 'C', { tournamentId: e.tournamentId, matchId });
    const sport = getSport(e.sport);
    const f = this.store.getFormatForEvent(m.eventId);
    const ops = this.#operations(matchId);
    // §8.1 — auto-fill from live scoring where it was used.
    const state = sport.scoring.replay(f?.matchParams ?? sport.matchDefaults, ops.scoreEvents);
    const live = sport.scoring.summarize(state);
    const score = input.finalScore ?? { a: live.a, b: live.b };
    const derivedWinner =
      score.a > score.b
        ? m.sideA.kind === 'entry' ? m.sideA.entryId : undefined
        : score.b > score.a
          ? m.sideB.kind === 'entry' ? m.sideB.entryId : undefined
          : undefined;
    const out = approval.enterResult(
      user,
      {
        match: m,
        tournament: t,
        finalScore: score,
        winnerRef: input.winnerRef ?? derivedWinner,
        outcomeType: input.outcomeType ?? 'played',
        statistics: live.statistics,
        offlineEntry: input.offlineEntry,
      },
      this.store.getResultForMatch(matchId),
    );
    return this.#applyResult(out, e.tournamentId);
  }

  verifyResult(user: User, matchId: string): Result {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'result.provisional', 'E', { tournamentId: e.tournamentId, matchId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    return this.#applyResult(approval.verifyResult(user, r, this.#tournament(e.tournamentId)), e.tournamentId);
  }

  returnResult(user: User, matchId: string, remarks: string): Result {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'result.provisional', 'E', { tournamentId: e.tournamentId, matchId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    return this.#applyResult(approval.returnToScorer(user, r, this.#tournament(e.tournamentId), remarks), e.tournamentId);
  }

  approveResult(user: User, matchId: string, overrideProtestWindowReason?: string): Result {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'result.approval', 'A', { tournamentId: e.tournamentId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    const out = approval.approveResult(user, r, this.#tournament(e.tournamentId), {
      overrideProtestWindow: overrideProtestWindowReason ? { reasonCode: overrideProtestWindowReason } : undefined,
    });
    const saved = this.#applyResult(out, e.tournamentId, true);
    this.#notify(
      e.tournamentId, 'result_approved',
      { roles: ['Team Manager', 'Viewer', 'Competition Manager'] },
      { matchNo: m.matchNo, score: `${saved.finalScore.a}-${saved.finalScore.b}`, winner: saved.winnerRef },
    );
    return saved;
  }

  publishResult(user: User, matchId: string): Result {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'result.approval', 'A', { tournamentId: e.tournamentId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    const saved = this.#applyResult(approval.publishResult(user, r, this.#tournament(e.tournamentId)), e.tournamentId);
    this.#notify(e.tournamentId, 'result_published', { roles: ['Viewer', 'Team Manager'] }, { matchNo: m.matchNo });
    return saved;
  }

  unlockResult(user: User, matchId: string, reasonCode: string, initiatedBy: string): Result {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'result.correction', 'A', { tournamentId: e.tournamentId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    return this.#applyResult(
      approval.unlockResult(user, r, this.#tournament(e.tournamentId), { reasonCode, initiatedBy }),
      e.tournamentId,
    );
  }

  correctResult(
    user: User,
    matchId: string,
    input: { reasonCode: string; initiatedBy: string; unlockedBy: string; newFinalScore?: { a: number; b: number }; newWinnerRef?: string; newOutcomeType?: Result['outcomeType'] },
  ): { result: Result; downstream: ReturnType<typeof downstreamImpact> } {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'result.correction', 'A', { tournamentId: e.tournamentId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    const saved = this.#applyResult(
      approval.applyCorrection(user, r, this.#tournament(e.tournamentId), input, input.unlockedBy),
      e.tournamentId,
    );
    return { result: saved, downstream: downstreamImpact(this.store.listMatches(m.eventId), m.matchNo) };
  }

  reVerifyResult(user: User, matchId: string): Result {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'result.correction', 'A', { tournamentId: e.tournamentId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    return this.#applyResult(approval.reVerifyCorrection(user, r, this.#tournament(e.tournamentId)), e.tournamentId);
  }

  reApproveResult(user: User, matchId: string): Result {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'result.correction', 'A', { tournamentId: e.tournamentId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    return this.#applyResult(approval.reApproveCorrection(user, r, this.#tournament(e.tournamentId)), e.tournamentId, true);
  }

  /**
   * §8.5 — recompute standings, resolve progression. Called after every
   * approval and every correction, which is what makes rule 7.5.21 true.
   */
  recomputeEvent(eventId: string): { standings: StandingsRow[]; progression: ReturnType<typeof progressionStatus> } {
    const e = this.#event(eventId);
    const f = this.store.getFormatForEvent(eventId);
    const matches = this.store.listMatches(eventId);
    const results = this.store.listResults(eventId);
    const meta = this.#entryMeta(eventId);

    const standings = f
      ? computeStandings({ eventId, sportId: e.sport, format: f, matches, results, entryMeta: meta })
      : [];
    if (standings.length) this.store.saveStandings(standings);

    const prop = propagate({ matches, results, standings, entryMeta: meta });
    if (prop.filled.length) this.store.saveMatches(prop.matches);

    const playable = matches.filter((m) => !m.byeFlag);
    const allApproved =
      playable.length > 0 &&
      playable.every((m) => results.find((r) => r.matchId === m.matchId)?.resultStatus === 'Approved');
    if (allApproved && e.status !== 'Completed') {
      this.store.saveEvent({ ...e, status: 'Completed' });
    } else if (!allApproved && e.status === 'Scheduled' && results.length) {
      this.store.saveEvent({ ...e, status: 'In Progress' });
    }

    return { standings, progression: progressionStatus({ matches: prop.matches, results, standings, entryMeta: meta }) };
  }

  approvalQueue(user: User, tournamentId: string): ReturnType<typeof approval.approvalQueue> {
    // Reading the queue is a view action. The Technical Official who verifies
    // and the Competition Manager who recommends both need it, and neither
    // holds approve rights.
    this.#require(user, 'result.approval', 'V', { tournamentId });
    const t = this.#tournament(tournamentId);
    return approval.approvalQueue(
      this.store.listMatchesForTournament(tournamentId),
      this.store.listResultsForTournament(tournamentId),
      t,
    );
  }

  // ═══ Protests ═══════════════════════════════════════════════════════════

  fileProtest(user: User, matchId: string, input: { grounds: string; feePaid: number }): { protest: Protest; result: Result } {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    this.#require(user, 'protests', 'C', { tournamentId: e.tournamentId, ownerUnitId: user.scope.unitId });
    const r = this.store.getResultForMatch(matchId) ?? missing(`result for match ${matchId}`);
    const out = approval.fileProtest(user, r, this.#tournament(e.tournamentId), {
      ...input,
      protestId: newProtestId(),
      matchId,
    });
    if (!out.ok || !out.value) bad(out.error ?? 'protest rejected');
    this.store.transaction(() => {
      this.store.saveProtest(out.value!.protest);
      this.store.saveResult(out.value!.result);
    });
    this.#commit(out.audit);
    this.#notify(
      e.tournamentId, 'protest_filed',
      { roles: ['Tournament Admin', 'Jury of Appeal', 'Technical Official'] },
      { matchNo: m.matchNo, protestId: out.value.protest.protestId, unit: user.scope.unitId },
    );
    return out.value;
  }

  ruleProtest(
    user: User,
    protestId: string,
    ruling: { outcome: 'Upheld' | 'Rejected'; action: Protest['rulingAction']; text: string },
  ): { protest: Protest; result: Result } {
    const p = this.store.listProtests().find((x) => x.protestId === protestId) ?? missing(`protest ${protestId}`);
    const e = this.#event(p.eventId);
    const r = this.store.getResultForMatch(p.matchId) ?? missing(`result for match ${p.matchId}`);
    const out = approval.ruleProtest(user, p, r, this.#tournament(e.tournamentId), ruling);
    if (!out.ok || !out.value) bad(out.error ?? 'ruling rejected');
    this.store.transaction(() => {
      this.store.saveProtest(out.value!.protest);
      this.store.saveResult(out.value!.result);
    });
    this.#commit(out.audit);
    this.#notify(
      e.tournamentId, 'protest_ruling',
      { roles: ['Team Manager', 'Competition Manager', 'Tournament Admin'] },
      { protestId, outcome: ruling.outcome, action: ruling.action },
    );
    this.recomputeEvent(p.eventId);
    return out.value;
  }

  // ═══ Phase 9: Medals ════════════════════════════════════════════════════

  #medalInput(eventId: string) {
    const e = this.#event(eventId);
    return {
      event: e,
      matches: this.store.listMatches(eventId),
      results: this.store.listResults(eventId),
      standings: this.store.listStandings(eventId),
      entryMeta: this.#entryMeta(eventId),
      integrityFlags: Object.fromEntries(
        this.store
          .listEntries(eventId)
          .map((en) => {
            const p = this.store.getParticipant(en.participantRef.id);
            return p?.dopingFlag ? [en.entryId, 'open doping flag from Athlete Registration'] : undefined;
          })
          .filter((x): x is [string, string] => Boolean(x)),
      ),
    };
  }

  #openProtestMatchIds(eventId: string): string[] {
    return this.store
      .listProtests(eventId)
      .filter((p) => p.status === 'Filed' || p.status === 'Under Review')
      .map((p) => p.matchId);
  }

  /**
   * §9.3 checklist without side effects.
   *
   * The Medal Management screen needs the verification result every time it
   * renders. Reading must never write: `generateMedals` persists rows, so a
   * screen that called it on render would overwrite the published medal list
   * with a freshly derived, unpublished one.
   */
  verifyMedalList(user: User, eventId: string): ReturnType<typeof verifyMedals> {
    const e = this.#event(eventId);
    this.#require(user, 'medals', 'V', { tournamentId: e.tournamentId, sportId: e.sport });
    return verifyMedals(this.#medalInput(eventId), this.#openProtestMatchIds(eventId));
  }

  generateMedals(user: User, eventId: string): ReturnType<typeof verifyMedals> {
    const e = this.#event(eventId);
    this.#require(user, 'medals', 'C', { tournamentId: e.tournamentId, sportId: e.sport });
    const v = verifyMedals(this.#medalInput(eventId), this.#openProtestMatchIds(eventId));
    if (v.rows.length) {
      // Regenerating must not silently un-publish an already published medal
      // list: carry the verification, approval and publication stamps forward
      // for any participant whose position and medal are unchanged. A row that
      // genuinely moved loses them, which is correct — it needs re-verifying.
      const existing = new Map(this.store.listMedals(eventId).map((m) => [m.participantRef, m]));
      const merged = v.rows.map((row) => {
        const prior = existing.get(row.participantRef);
        if (!prior?.publishedAt) return row;
        const unchanged = prior.position === row.position && prior.medal === row.medal;
        return unchanged
          ? { ...row, verifiedBy: prior.verifiedBy, approvedBy: prior.approvedBy, publishedAt: prior.publishedAt }
          : row;
      });
      this.store.saveMedals(merged);
      v.rows = merged;
    }
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'medals', entityId: eventId, action: 'medals.generate',
        newValue: { ok: v.ok, blockers: v.blockers.length, positions: v.rows.length },
      },
    ]);
    return v;
  }

  publishMedals(user: User, eventId: string, verifiedBy: string): ReturnType<typeof approveAndPublishMedals> {
    const e = this.#event(eventId);
    this.#require(user, 'medals', 'P', { tournamentId: e.tournamentId });
    const p = canPublish(user);
    if (!p.allowed) deny(p.reason);
    const v = verifyMedals(this.#medalInput(eventId), this.#openProtestMatchIds(eventId));
    if (!v.ok) bad(`medals cannot be published: ${v.blockers.join('; ')}`);
    const out = approveAndPublishMedals(v.rows, verifiedBy, user.userId);
    if (out.error) bad(out.error);
    this.store.saveMedals(out.rows);
    this.store.saveEvent({ ...e, status: 'Completed' });
    this.#commit([
      {
        userId: user.userId, userName: user.name, role: user.role, tournamentId: e.tournamentId,
        entityType: 'medals', entityId: eventId, action: 'medals.publish',
        newValue: out.rows.filter((r) => r.medal !== 'none').map((r) => `${r.medal}:${r.participantName}`),
      },
    ]);
    this.#notify(e.tournamentId, 'medals_published', { roles: ['Viewer', 'Team Manager'] }, { eventId, discipline: e.discipline });
    return out;
  }

  medalTally(tournamentId: string): ReturnType<typeof medalTally> {
    return medalTally(this.store.listMedalsForTournament(tournamentId).filter((m) => m.publishedAt));
  }

  rankings(eventId: string): ReturnType<typeof generateRankings> {
    return generateRankings(this.#medalInput(eventId));
  }

  // ═══ Exceptions ═════════════════════════════════════════════════════════

  applyException(user: User, matchId: string, kind: string, payload: Record<string, unknown>): Record<string, unknown> {
    const m = this.#match(matchId);
    const e = this.#event(m.eventId);
    const t = this.#tournament(e.tournamentId);
    const str = (k: string) => String(payload[k] ?? '');
    const ops = this.#operations(matchId);

    let out: exceptions.ExceptionOutcome;
    switch (kind) {
      case 'walkover':
        out = exceptions.walkover(user, m, t, str('winningSide') === 'B' ? 'B' : 'A', str('reasonCode'), str('detail'));
        break;
      case 'no-show':
        out = exceptions.noShow(user, m, ops, t, str('absentSide') === 'B' ? 'B' : 'A');
        break;
      case 'disqualification':
        out = exceptions.disqualification(user, m, t, {
          disqualifiedEntryId: str('disqualifiedEntryId'),
          reasonCode: str('reasonCode'),
          detail: str('detail'),
          cascadePriorResults: payload.cascadePriorResults === true,
          ratifiedBy: payload.ratifiedBy ? str('ratifiedBy') : undefined,
        });
        break;
      case 'postpone':
        out = exceptions.postpone(user, m, t, str('reasonCode'), str('detail'), payload.approvedBy ? str('approvedBy') : undefined);
        break;
      case 'cancel':
        out = exceptions.cancelMatch(user, m, t, str('reasonCode'), str('detail'), str('pointsHandling') === 'shared' ? 'shared' : 'void', payload.ratifiedBy ? str('ratifiedBy') : undefined);
        break;
      case 'suspend':
        out = exceptions.suspend(user, m, ops, t, Number(payload.atClockSecs ?? 0), str('reasonCode'), str('detail'));
        break;
      case 'resume':
        out = exceptions.resume(user, m, ops, t, Number(payload.atClockSecs ?? 0));
        break;
      case 'abandon':
        out = exceptions.abandon(user, m, t, {
          reasonCode: str('reasonCode'),
          detail: str('detail'),
          committeeDecision: (str('committeeDecision') || 'void') as 'replay' | 'award-result' | 'void',
          awardedTo: payload.awardedTo === 'B' ? 'B' : payload.awardedTo === 'A' ? 'A' : undefined,
          ratifiedBy: payload.ratifiedBy ? str('ratifiedBy') : undefined,
        });
        break;
      case 'offline-entry':
        out = exceptions.offlineEntry(user, m, ops, t, {
          reasonCode: str('reasonCode'), detail: str('detail'), scoresheetRef: str('scoresheetRef'),
        });
        break;
      default:
        return bad(`unknown exception "${kind}"`);
    }

    if (!out.ok) bad(out.error ?? 'exception rejected');
    this.store.transaction(() => {
      if (out.match) this.store.saveMatch(out.match);
      if (out.operations) this.store.saveOperations(out.operations);
      if (out.exception) this.store.saveException(out.exception);
    });
    this.#commit(out.audit);

    // §7.4.20 — a walkover or no-show auto-generates the sport's result.
    let autoResult: Result | undefined;
    if (kind === 'walkover' || kind === 'no-show') {
      const winning = kind === 'walkover' ? (str('winningSide') === 'B' ? 'B' : 'A') : str('absentSide') === 'B' ? 'A' : 'B';
      const wr = approval.buildWalkoverResult(user, out.match ?? m, t, winning, str('reasonCode') || 'NO_SHOW', e.sport);
      if (wr.ok && wr.value) {
        this.store.saveResult(wr.value);
        this.#commit(wr.audit);
        autoResult = wr.value;
      }
    }
    return {
      match: out.match ?? m,
      operations: out.operations,
      exception: out.exception,
      followUps: out.followUps ?? [],
      autoResult,
    };
  }

  // ═══ Dashboards ═════════════════════════════════════════════════════════

  /** §9.1–9.6 — one payload per role, containing only what that role may see. */
  dashboard(user: User, tournamentId: string): Record<string, unknown> {
    const t = this.#tournament(tournamentId);
    const events = this.store.listEvents(tournamentId);
    const matches = this.store.listMatchesForTournament(tournamentId);
    const results = this.store.listResultsForTournament(tournamentId);
    const protests = this.store.listProtests();
    const phase = phases.currentPhase(t, events, matches, results);
    const today = new Date().toISOString().slice(0, 10);
    const byStatus = (s: string) => matches.filter((m) => m.matchStatus === s).length;

    const common = {
      tournament: t,
      phase,
      daysRemaining: Math.max(
        0,
        Math.ceil((new Date(t.endDate).getTime() - Date.now()) / 86_400_000),
      ),
      eventsTotal: events.length,
      eventsCompleted: events.filter((e) => e.status === 'Completed').length,
      today: {
        scheduled: matches.filter((m) => m.scheduledDate === today).length,
        ongoing: byStatus('Live'),
        completed: byStatus('Completed (Provisional)'),
        delayed: byStatus('Postponed') + byStatus('Suspended'),
      },
    };

    switch (user.role) {
      case 'Super Admin':
      case 'Tournament Admin': {
        // §9.1 — the pending-actions queue is the primary widget.
        const queue = approval.approvalQueue(matches, results, t);
        const conflictsByEvent = events.map((e) => ({
          eventId: e.eventId,
          discipline: e.discipline,
          ...(() => {
            try {
              const c = this.conflicts(e.eventId);
              return { hard: c.hard.length, soft: c.soft.length, publishable: c.publishable };
            } catch {
              return { hard: 0, soft: 0, publishable: true };
            }
          })(),
        }));
        return {
          ...common,
          pendingActions: {
            resultsAwaitingApproval: queue.filter((q) => q.awaiting === 'approval').length,
            resultsAwaitingVerification: queue.filter((q) => q.awaiting === 'verification').length,
            resultsAwaitingEntry: queue.filter((q) => q.awaiting === 'entry').length,
            openProtests: protests.filter((p) => p.status === 'Filed' || p.status === 'Under Review').length,
            correctionsInProgress: queue.filter((q) => q.awaiting === 'correction').length,
            entryOverridesPending: this.#pendingOverrides(tournamentId).length,
          },
          queue,
          alerts: {
            hardConflicts: conflictsByEvent.filter((c) => c.hard > 0),
            eventsBelowMinimumEntries: events
              .map((e) => ({ e, n: this.store.listEntries(e.eventId).filter((x) => x.entryStatus === 'Confirmed').length }))
              .filter((x) => x.n < x.e.minEntriesToRun)
              .map((x) => ({ eventId: x.e.eventId, discipline: x.e.discipline, confirmed: x.n, required: x.e.minEntriesToRun })),
            officialsCoverageGaps: this.officialsCoverage(tournamentId, 48),
            overdueResults: queue.filter((q) => q.overdue),
          },
          medalTally: this.medalTally(tournamentId).slice(0, 10),
          publishStatus: events.map((e) => ({
            eventId: e.eventId,
            discipline: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : e.genderCategory === 'W' ? 'Women' : e.genderCategory}`,
            drawStatus: e.drawStatus,
            scheduleStatus: this.store.getScheduleState(e.eventId).status,
            medalsPublished: this.store.listMedals(e.eventId).some((m) => m.publishedAt),
          })),
        };
      }

      case 'Competition Manager': {
        // §9.2 — event pipeline board and progression tracker.
        const scoped = events.filter((e) => !user.scope.sportIds?.length || user.scope.sportIds.includes(e.sport));
        return {
          ...common,
          pipeline: scoped.map((e) => {
            const ms = this.store.listMatches(e.eventId);
            const rs = this.store.listResults(e.eventId);
            return {
              eventId: e.eventId,
              discipline: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : e.genderCategory === 'W' ? 'Women' : e.genderCategory}`,
              status: e.status,
              entries: this.store.listEntries(e.eventId).filter((x) => x.entryStatus === 'Confirmed').length,
              formatApproved: this.store.getFormatForEvent(e.eventId)?.approvalStatus === 'Approved',
              drawStatus: e.drawStatus,
              scheduled: ms.filter((m) => m.scheduledDate).length,
              inPlay: ms.filter((m) => m.matchStatus === 'Live').length,
              completed: rs.filter((r) => r.resultStatus === 'Approved').length,
              total: ms.filter((m) => !m.byeFlag).length,
              validationFlags: this.store.getDrawForEvent(e.eventId)?.validationErrors ?? [],
            };
          }),
          progression: scoped.map((e) => ({
            eventId: e.eventId,
            ...progressionStatus({
              matches: this.store.listMatches(e.eventId),
              results: this.store.listResults(e.eventId),
              standings: this.store.listStandings(e.eventId),
              entryMeta: this.#entryMeta(e.eventId),
            }),
          })),
          officialsCoverage: this.officialsCoverage(tournamentId, 48),
          softWarnings: scoped.flatMap((e) => {
            try {
              return this.conflicts(e.eventId).soft.map((c) => ({ eventId: e.eventId, ...c }));
            } catch {
              return [];
            }
          }),
        };
      }

      case 'Venue Manager': {
        // §9.3 — utilisation heatmap and today's run sheet per field of play.
        const mine = this.store.listVenues(tournamentId).filter(
          (v) => !user.scope.venueIds?.length || user.scope.venueIds.includes(v.venueId),
        );
        const fops = mine.flatMap((v) => v.fopList.map((f) => f.fopId));
        return {
          ...common,
          venues: mine,
          heatmap: events.flatMap((e) => {
            try {
              return this.venueUtilisation(e.eventId).filter((u) => fops.includes(u.fopId));
            } catch {
              return [];
            }
          }),
          runSheet: matches
            .filter((m) => m.scheduledDate === today && m.fopId && fops.includes(m.fopId))
            .map((m) => ({
              matchNo: m.matchNo, time: m.scheduledTime, fopId: m.fopId, status: m.matchStatus,
              sideA: m.sideA.displayName, sideB: m.sideB.displayName,
              officials: m.officials.map((o) => `${o.role}: ${o.officialName}`),
            })),
          maintenanceBlocks: mine.flatMap((v) => v.maintenanceBlocks),
        };
      }

      case 'Technical Official':
      case 'Referee':
      case 'Scorer': {
        // §9.4 — my duty schedule and pending verifications.
        const mine = this.store.listAssignmentsForOfficial(user.userId);
        const mineIds = new Set(mine.map((a) => a.matchId));
        return {
          ...common,
          duties: this.dutyRoster(tournamentId).find((d) => d.officialId === user.userId)?.duties ?? [],
          myMatches: matches.filter((m) => mineIds.has(m.matchId)).map((m) => ({
            matchId: m.matchId, matchNo: m.matchNo, date: m.scheduledDate, time: m.scheduledTime,
            fopId: m.fopId, status: m.matchStatus, sideA: m.sideA.displayName, sideB: m.sideB.displayName,
            role: mine.find((a) => a.matchId === m.matchId)?.role,
            acknowledged: mine.find((a) => a.matchId === m.matchId)?.status === 'acknowledged',
          })),
          pendingVerifications:
            user.role === 'Technical Official'
              ? approval.approvalQueue(matches, results, t).filter((q) => q.awaiting === 'verification')
              : [],
        };
      }

      case 'Team Manager': {
        // §9.5 — my team's schedule, results, standings, protest timers.
        const unit = user.scope.unitId;
        const myEntries = events.flatMap((e) =>
          this.store.listEntries(e.eventId).filter((x) => x.unitId === unit).map((x) => ({ event: e, entry: x })),
        );
        const myEntryIds = new Set(myEntries.map((x) => x.entry.entryId));
        const published = (eventId: string) =>
          ['Published', 'Amended', 'Final'].includes(this.store.getScheduleState(eventId).status);
        const myMatches = matches.filter(
          (m) =>
            published(m.eventId) &&
            [m.sideA, m.sideB].some((s) => s.kind === 'entry' && myEntryIds.has(s.entryId)),
        );
        const next = myMatches
          .filter((m) => m.scheduledDate && m.matchStatus === 'Scheduled')
          .sort((a, b) => `${a.scheduledDate}${a.scheduledTime}`.localeCompare(`${b.scheduledDate}${b.scheduledTime}`))[0];
        return {
          ...common,
          unit,
          entries: myEntries.map((x) => ({
            eventId: x.event.eventId, discipline: x.event.discipline, entryId: x.entry.entryId,
            status: x.entry.entryStatus, participant: x.entry.participantRef.displayName,
            eligibility: x.entry.eligibilityResult.checks.filter((c) => !c.passed),
          })),
          nextMatch: next
            ? { matchNo: next.matchNo, date: next.scheduledDate, time: next.scheduledTime, fopId: next.fopId, opponent: [next.sideA, next.sideB].find((s) => !(s.kind === 'entry' && myEntryIds.has(s.entryId)))?.displayName }
            : undefined,
          schedule: myMatches.map((m) => ({
            matchNo: m.matchNo, date: m.scheduledDate, time: m.scheduledTime, fopId: m.fopId,
            status: m.matchStatus, sideA: m.sideA.displayName, sideB: m.sideB.displayName,
          })),
          // §9.5 — protest window timers for recent matches.
          protestTimers: myMatches
            .map((m) => {
              const r = results.find((x) => x.matchId === m.matchId);
              if (!r) return undefined;
              const w = approval.protestWindow(t, r);
              return w.open ? { matchNo: m.matchNo, matchId: m.matchId, remainingMins: w.remainingMins, closesAt: w.closesAt } : undefined;
            })
            .filter(Boolean),
          standings: events.flatMap((e) => this.store.listStandings(e.eventId).filter((s) => s.unitId === unit)),
          notifications: this.store.listNotifications(tournamentId, 20),
        };
      }

      default: {
        // §9.6 — Viewer sees published data only.
        const publishedEvents = events.filter((e) => e.drawStatus === 'Published');
        return {
          ...common,
          events: publishedEvents.map((e) => ({ eventId: e.eventId, discipline: e.discipline, status: e.status })),
          fixtures: matches
            .filter((m) => ['Published', 'Amended', 'Final'].includes(this.store.getScheduleState(m.eventId).status))
            .map((m) => ({
              matchNo: m.matchNo, eventId: m.eventId, date: m.scheduledDate, time: m.scheduledTime,
              fopId: m.fopId, status: m.matchStatus, sideA: m.sideA.displayName, sideB: m.sideB.displayName,
            })),
          results: results
            .filter((r) => r.publishedAt)
            .map((r) => ({ matchId: r.matchId, score: r.finalScore, winner: r.winnerRef, outcome: r.outcomeType })),
          standings: publishedEvents.flatMap((e) => this.store.listStandings(e.eventId)),
          medalTally: this.medalTally(tournamentId),
        };
      }
    }
  }

  #pendingOverrides(tournamentId: string): Entry[] {
    return this.store
      .listEvents(tournamentId)
      .flatMap((e) => this.store.listEntries(e.eventId))
      .filter((x) => x.entryStatus === 'Blocked');
  }

  /** §10.2 / §10.3 — close and archive. */
  closeTournament(user: User, tournamentId: string): { tournament: Tournament; gate: phases.GateResult } {
    this.#require(user, 'tournament.config', 'E', { tournamentId });
    const t = this.#tournament(tournamentId);
    const gate = phases.gateToClosure(
      this.store.listEvents(tournamentId),
      this.store.listResultsForTournament(tournamentId),
      this.store.listProtests(),
      this.store.listMedalsForTournament(tournamentId),
    );
    if (!gate.open) bad(`tournament cannot be closed: ${gate.blockers.join('; ')}`);
    const next = this.setTournamentStatus(user, tournamentId, 'Completed');
    void t;
    return { tournament: next, gate };
  }
}

/** §7.2 — no-show grace period. Configurable per sport in a later iteration. */
export const NO_SHOW_GRACE_MINS = 15;

export type { Role };
