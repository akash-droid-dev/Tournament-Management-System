/**
 * In-memory store.
 *
 * The same `TmsStoreLike` contract as the SQLite store, over plain Maps. It
 * exists for two reasons, and the second is the interesting one:
 *
 *   1. Tests get a store with no file, no schema load and no cleanup.
 *   2. It has no platform imports at all, so the whole module — domain, sport
 *      rules, engines, workflow, service — runs unchanged in a browser. That
 *      is what the GitHub Pages build is: not a mock-up of the screens, but
 *      the real rules with this class in place of SQLite.
 *
 * Ordering matters more than it looks. Callers rely on "newest first" and on
 * fixtures arriving in match-number order, so every list method reproduces
 * the SQL `ORDER BY` of its counterpart in db.ts rather than returning
 * whatever order insertion happened to give.
 */

import type {
  AuditLogEntry,
  DrawRecord,
  Entry,
  ExceptionRecord,
  Format,
  Match,
  MatchOperations,
  MedalRow,
  NotificationEvent,
  OfficialAssignment,
  Protest,
  Result,
  StandingsRow,
  Tournament,
  TournamentEvent,
  User,
  Venue,
} from '../domain/types.ts';
import type { OfficialSnapshot } from '../engines/officials.ts';
import type { ParticipantSnapshot } from '../engines/eligibility.ts';
import type { AuditQuery, ScheduleState, TmsStoreLike } from './store.ts';

/** Every collection, captured for transaction rollback. */
interface Snapshot {
  tournaments: Map<string, Tournament>;
  events: Map<string, TournamentEvent>;
  entries: Map<string, Entry>;
  formats: Map<string, Format>;
  draws: Map<string, DrawRecord>;
  matches: Map<string, Match>;
  operations: Map<string, MatchOperations>;
  results: Map<string, Result>;
  assignments: Map<string, OfficialAssignment>;
  standings: Map<string, StandingsRow>;
  medals: Map<string, MedalRow>;
  protests: Map<string, Protest>;
  exceptions: Map<string, { tournamentId: string; rec: ExceptionRecord }>;
  venues: Map<string, { tournamentId: string; venue: Venue }>;
  officials: Map<string, { tournamentId: string; official: OfficialSnapshot }>;
  participants: Map<string, { tournamentId: string; participant: ParticipantSnapshot }>;
  users: Map<string, User>;
  notifications: NotificationEvent[];
  audit: AuditLogEntry[];
  scheduleState: Map<string, ScheduleState>;
}

/** Ascending by a string key. */
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));
/** Descending by a string key. */
const byKeyDesc = <T>(key: (x: T) => string) => (a: T, b: T) => key(b).localeCompare(key(a));

export class MemoryStore implements TmsStoreLike {
  #tournaments = new Map<string, Tournament>();
  #events = new Map<string, TournamentEvent>();
  #entries = new Map<string, Entry>();
  #formats = new Map<string, Format>();
  #draws = new Map<string, DrawRecord>();
  #matches = new Map<string, Match>();
  #operations = new Map<string, MatchOperations>();
  #results = new Map<string, Result>();
  #assignments = new Map<string, OfficialAssignment>();
  /** Keyed `eventId|groupId|participantRef`, matching the SQL unique index. */
  #standings = new Map<string, StandingsRow>();
  /** Keyed `eventId|participantRef`. */
  #medals = new Map<string, MedalRow>();
  #protests = new Map<string, Protest>();
  #exceptions = new Map<string, { tournamentId: string; rec: ExceptionRecord }>();
  #venues = new Map<string, { tournamentId: string; venue: Venue }>();
  #officials = new Map<string, { tournamentId: string; official: OfficialSnapshot }>();
  #participants = new Map<string, { tournamentId: string; participant: ParticipantSnapshot }>();
  #users = new Map<string, User>();
  #notifications: NotificationEvent[] = [];
  #audit: AuditLogEntry[] = [];
  #scheduleState = new Map<string, ScheduleState>();

  close(): void {
    /* nothing to release */
  }

  #txDepth = 0;

  /**
   * Reentrant, and a real rollback rather than a pretend one.
   *
   * The outermost call snapshots every collection and restores it if the body
   * throws. That matters because the service layer relies on atomicity — a
   * failed protest ruling must not leave the protest saved and the result
   * unsaved — and a store that silently kept partial writes would pass every
   * happy-path test while corrupting state on the first refusal.
   */
  transaction<T>(fn: () => T): T {
    if (this.#txDepth > 0) {
      this.#txDepth++;
      try {
        return fn();
      } finally {
        this.#txDepth--;
      }
    }
    const snapshot = this.#snapshot();
    this.#txDepth = 1;
    try {
      return fn();
    } catch (e) {
      this.#restore(snapshot);
      throw e;
    } finally {
      this.#txDepth = 0;
    }
  }

  #snapshot(): Snapshot {
    return {
      tournaments: new Map(this.#tournaments),
      events: new Map(this.#events),
      entries: new Map(this.#entries),
      formats: new Map(this.#formats),
      draws: new Map(this.#draws),
      matches: new Map(this.#matches),
      operations: new Map(this.#operations),
      results: new Map(this.#results),
      assignments: new Map(this.#assignments),
      standings: new Map(this.#standings),
      medals: new Map(this.#medals),
      protests: new Map(this.#protests),
      exceptions: new Map(this.#exceptions),
      venues: new Map(this.#venues),
      officials: new Map(this.#officials),
      participants: new Map(this.#participants),
      users: new Map(this.#users),
      notifications: [...this.#notifications],
      audit: [...this.#audit],
      scheduleState: new Map(this.#scheduleState),
    };
  }

  #restore(s: Snapshot): void {
    this.#tournaments = s.tournaments;
    this.#events = s.events;
    this.#entries = s.entries;
    this.#formats = s.formats;
    this.#draws = s.draws;
    this.#matches = s.matches;
    this.#operations = s.operations;
    this.#results = s.results;
    this.#assignments = s.assignments;
    this.#standings = s.standings;
    this.#medals = s.medals;
    this.#protests = s.protests;
    this.#exceptions = s.exceptions;
    this.#venues = s.venues;
    this.#officials = s.officials;
    this.#participants = s.participants;
    this.#users = s.users;
    this.#notifications = s.notifications;
    this.#audit = s.audit;
    this.#scheduleState = s.scheduleState;
  }

  // ── Tournaments ───────────────────────────────────────────────────────────

  saveTournament(t: Tournament): void {
    this.#tournaments.set(t.tournamentId, t);
  }

  getTournament(id: string): Tournament | undefined {
    return this.#tournaments.get(id);
  }

  listTournaments(): Tournament[] {
    return [...this.#tournaments.values()].sort(byKeyDesc((t) => t.startDate));
  }

  tournamentCodes(): string[] {
    return [...this.#tournaments.values()].map((t) => t.code);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  saveEvent(e: TournamentEvent): void {
    this.#events.set(e.eventId, e);
  }

  getEvent(id: string): TournamentEvent | undefined {
    return this.#events.get(id);
  }

  listEvents(tournamentId: string): TournamentEvent[] {
    return [...this.#events.values()]
      .filter((e) => e.tournamentId === tournamentId)
      .sort(byKey((e) => e.eventId));
  }

  // ── Entries ───────────────────────────────────────────────────────────────

  saveEntry(e: Entry): void {
    this.#entries.set(e.entryId, e);
  }

  getEntry(id: string): Entry | undefined {
    return this.#entries.get(id);
  }

  listEntries(eventId: string): Entry[] {
    return [...this.#entries.values()]
      .filter((e) => e.eventId === eventId)
      .sort(byKey((e) => e.entryId));
  }

  listEntriesForParticipant(tournamentId: string, participantId: string): Entry[] {
    // The SQL joins entries to events to reach the tournament; an Entry itself
    // only knows its event.
    const ids = this.#eventIdsOf(tournamentId);
    return [...this.#entries.values()].filter(
      (e) => ids.has(e.eventId) && e.participantRef.id === participantId,
    );
  }

  // ── Format ────────────────────────────────────────────────────────────────

  saveFormat(f: Format): void {
    this.#formats.set(f.formatId, f);
  }

  getFormatForEvent(eventId: string): Format | undefined {
    return [...this.#formats.values()]
      .filter((f) => f.eventId === eventId)
      .sort(byKeyDesc((f) => f.formatId))[0];
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  saveDraw(d: DrawRecord): void {
    this.#draws.set(d.drawId, d);
  }

  getDrawForEvent(eventId: string): DrawRecord | undefined {
    return this.listDraws(eventId)[0];
  }

  listDraws(eventId: string): DrawRecord[] {
    return [...this.#draws.values()]
      .filter((d) => d.eventId === eventId)
      .sort(byKeyDesc((d) => d.generatedAt));
  }

  // ── Matches ───────────────────────────────────────────────────────────────

  saveMatch(m: Match): void {
    this.#matches.set(m.matchId, m);
  }

  saveMatches(ms: Match[]): void {
    this.transaction(() => {
      for (const m of ms) this.saveMatch(m);
    });
  }

  getMatch(id: string): Match | undefined {
    return this.#matches.get(id);
  }

  getMatchByNo(eventId: string, matchNo: string): Match | undefined {
    return [...this.#matches.values()].find((m) => m.eventId === eventId && m.matchNo === matchNo);
  }

  listMatches(eventId: string): Match[] {
    return [...this.#matches.values()]
      .filter((m) => m.eventId === eventId)
      .sort(byKey((m) => m.matchNo));
  }

  #eventIdsOf(tournamentId: string): Set<string> {
    return new Set(this.listEvents(tournamentId).map((e) => e.eventId));
  }

  listMatchesForTournament(tournamentId: string): Match[] {
    const ids = this.#eventIdsOf(tournamentId);
    return [...this.#matches.values()]
      .filter((m) => ids.has(m.eventId))
      // The SQL orders by (scheduled_date, match_no); an unscheduled fixture
      // has no date and sorts first, as a NULL does in SQLite.
      .sort((a, b) =>
        (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? '') ||
        a.matchNo.localeCompare(b.matchNo),
      );
  }

  listMatchesOnDate(tournamentId: string, date: string): Match[] {
    const ids = this.#eventIdsOf(tournamentId);
    return [...this.#matches.values()]
      .filter((m) => ids.has(m.eventId) && m.scheduledDate === date)
      // db.ts orders this one by the stored JSON document, which in practice
      // orders by matchId because that is the first key. Reproduced literally
      // so both stores agree.
      .sort(byKey((m) => JSON.stringify(m)));
  }

  // ── Match operations ──────────────────────────────────────────────────────

  saveOperations(o: MatchOperations): void {
    this.#operations.set(o.matchId, o);
  }

  getOperations(matchId: string): MatchOperations | undefined {
    return this.#operations.get(matchId);
  }

  // ── Results ───────────────────────────────────────────────────────────────

  saveResult(r: Result): void {
    this.#results.set(r.resultId, r);
  }

  getResultForMatch(matchId: string): Result | undefined {
    return [...this.#results.values()].find((r) => r.matchId === matchId);
  }

  listResults(eventId: string): Result[] {
    return [...this.#results.values()].filter((r) => r.eventId === eventId);
  }

  listResultsForTournament(tournamentId: string): Result[] {
    const ids = this.#eventIdsOf(tournamentId);
    return [...this.#results.values()].filter((r) => ids.has(r.eventId));
  }

  // ── Officials ─────────────────────────────────────────────────────────────

  saveAssignment(a: OfficialAssignment): void {
    this.#assignments.set(a.assignmentId, a);
  }

  listAssignments(matchId?: string): OfficialAssignment[] {
    const all = [...this.#assignments.values()];
    return matchId ? all.filter((a) => a.matchId === matchId) : all;
  }

  listAssignmentsForOfficial(officialId: string): OfficialAssignment[] {
    return [...this.#assignments.values()].filter((a) => a.officialId === officialId);
  }

  // ── Standings and medals ──────────────────────────────────────────────────

  saveStandings(rows: StandingsRow[]): void {
    this.transaction(() => {
      for (const r of rows) {
        this.#standings.set(`${r.eventId}|${r.groupId}|${r.participantRef}`, r);
      }
    });
  }

  listStandings(eventId: string): StandingsRow[] {
    return [...this.#standings.values()].filter((r) => r.eventId === eventId);
  }

  saveMedals(rows: MedalRow[]): void {
    this.transaction(() => {
      for (const r of rows) {
        this.#medals.set(`${r.eventId}|${r.participantRef}`, r);
      }
    });
  }

  listMedals(eventId?: string): MedalRow[] {
    const all = [...this.#medals.values()];
    return eventId ? all.filter((r) => r.eventId === eventId) : all;
  }

  listMedalsForTournament(tournamentId: string): MedalRow[] {
    const ids = this.#eventIdsOf(tournamentId);
    return [...this.#medals.values()].filter((r) => ids.has(r.eventId));
  }

  // ── Governance ────────────────────────────────────────────────────────────

  saveProtest(p: Protest): void {
    this.#protests.set(p.protestId, p);
  }

  listProtests(eventId?: string): Protest[] {
    const all = [...this.#protests.values()];
    return eventId ? all.filter((p) => p.eventId === eventId) : all;
  }

  saveException(e: ExceptionRecord): void {
    this.#exceptions.set(e.exceptionId, { tournamentId: e.tournamentId, rec: e });
  }

  listExceptions(tournamentId: string): ExceptionRecord[] {
    return [...this.#exceptions.values()]
      .filter((x) => x.tournamentId === tournamentId)
      .map((x) => x.rec);
  }

  // ── Upstream snapshots ────────────────────────────────────────────────────

  saveVenue(tournamentId: string, v: Venue): void {
    this.#venues.set(v.venueId, { tournamentId, venue: v });
  }

  listVenues(tournamentId: string): Venue[] {
    return [...this.#venues.values()]
      .filter((x) => x.tournamentId === tournamentId)
      .map((x) => x.venue);
  }

  saveOfficial(tournamentId: string, o: OfficialSnapshot): void {
    this.#officials.set(o.officialId, { tournamentId, official: o });
  }

  listOfficials(tournamentId: string): OfficialSnapshot[] {
    return [...this.#officials.values()]
      .filter((x) => x.tournamentId === tournamentId)
      .map((x) => x.official);
  }

  saveParticipant(tournamentId: string, p: ParticipantSnapshot): void {
    this.#participants.set(p.ref.id, { tournamentId, participant: p });
  }

  listParticipants(tournamentId: string, unitId?: string): ParticipantSnapshot[] {
    return [...this.#participants.values()]
      .filter((x) => x.tournamentId === tournamentId)
      .map((x) => x.participant)
      .filter((p) => !unitId || p.unitId === unitId);
  }

  getParticipant(id: string): ParticipantSnapshot | undefined {
    return this.#participants.get(id)?.participant;
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  saveUser(u: User): void {
    this.#users.set(u.userId, u);
  }

  getUser(id: string): User | undefined {
    return this.#users.get(id);
  }

  listUsers(): User[] {
    return [...this.#users.values()];
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  saveNotification(n: NotificationEvent): void {
    this.#notifications.push(n);
  }

  listNotifications(tournamentId: string, limit = 100): NotificationEvent[] {
    return this.#notifications
      .filter((n) => n.tournamentId === tournamentId)
      .sort(byKeyDesc((n) => n.sentAt))
      .slice(0, limit);
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  appendAudit(e: AuditLogEntry): void {
    this.#audit.push(e);
  }

  queryAudit(q: AuditQuery): AuditLogEntry[] {
    return this.#audit
      .filter(
        (e) =>
          (!q.tournamentId || e.tournamentId === q.tournamentId) &&
          (!q.entityType || e.entityType === q.entityType) &&
          (!q.entityId || e.entityId === q.entityId) &&
          (!q.userId || e.userId === q.userId) &&
          (!q.action || e.action === q.action),
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.logId.localeCompare(a.logId))
      .slice(0, q.limit ?? 200);
  }

  maxIdSuffix(table: string, column: string): number {
    // Same allow-list as the SQLite store: these two are the high-volume IDs
    // with a unique constraint, and priming them is what stops a restarted
    // process re-issuing LOG-000001.
    const allowed: Record<string, string> = {
      audit_log: 'log_id',
      notifications: 'notification_id',
    };
    if (allowed[table] !== column) {
      throw new Error(`maxIdSuffix is not available for ${table}.${column}`);
    }
    const ids =
      table === 'audit_log'
        ? this.#audit.map((e) => e.logId)
        : this.#notifications.map((n) => n.notificationId);
    let max = 0;
    for (const id of ids) {
      const n = Number(id.slice(id.indexOf('-') + 1));
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
    return max;
  }

  // ── Schedule publication state ────────────────────────────────────────────

  getScheduleState(eventId: string): ScheduleState {
    return (
      this.#scheduleState.get(eventId) ?? {
        eventId,
        status: 'Draft',
        acknowledgedSoft: [],
        versionNo: 1,
      }
    );
  }

  saveScheduleState(s: ScheduleState): void {
    this.#scheduleState.set(s.eventId, s);
  }

  reset(): void {
    this.#restore({
      tournaments: new Map(),
      events: new Map(),
      entries: new Map(),
      formats: new Map(),
      draws: new Map(),
      matches: new Map(),
      operations: new Map(),
      results: new Map(),
      assignments: new Map(),
      standings: new Map(),
      medals: new Map(),
      protests: new Map(),
      exceptions: new Map(),
      venues: new Map(),
      officials: new Map(),
      participants: new Map(),
      users: new Map(),
      notifications: [],
      audit: [],
      scheduleState: new Map(),
    });
  }

  // ── Serialisation, for the static build ───────────────────────────────────

  /**
   * Dump every collection as plain JSON.
   *
   * The Pages build runs the real seeder in Node, dumps the resulting store
   * with this, and ships the JSON. The browser hydrates it and carries on
   * writing — so the demo starts from a genuinely seeded tournament instead
   * of spending three seconds re-seeding on every page load.
   */
  toJSON(): Record<string, unknown> {
    const m = <V>(map: Map<string, V>) => [...map.entries()];
    return {
      tournaments: m(this.#tournaments),
      events: m(this.#events),
      entries: m(this.#entries),
      formats: m(this.#formats),
      draws: m(this.#draws),
      matches: m(this.#matches),
      operations: m(this.#operations),
      results: m(this.#results),
      assignments: m(this.#assignments),
      standings: m(this.#standings),
      medals: m(this.#medals),
      protests: m(this.#protests),
      exceptions: m(this.#exceptions),
      venues: m(this.#venues),
      officials: m(this.#officials),
      participants: m(this.#participants),
      users: m(this.#users),
      notifications: this.#notifications,
      audit: this.#audit,
      scheduleState: m(this.#scheduleState),
    };
  }

  /** Inverse of `toJSON`. */
  static fromJSON(data: Record<string, unknown>): MemoryStore {
    const s = new MemoryStore();
    const load = <V>(key: string, into: Map<string, V>) => {
      for (const [k, v] of (data[key] as [string, V][] | undefined) ?? []) into.set(k, v);
    };
    load('tournaments', s.#tournaments);
    load('events', s.#events);
    load('entries', s.#entries);
    load('formats', s.#formats);
    load('draws', s.#draws);
    load('matches', s.#matches);
    load('operations', s.#operations);
    load('results', s.#results);
    load('assignments', s.#assignments);
    load('standings', s.#standings);
    load('medals', s.#medals);
    load('protests', s.#protests);
    load('exceptions', s.#exceptions);
    load('venues', s.#venues);
    load('officials', s.#officials);
    load('participants', s.#participants);
    load('users', s.#users);
    load('scheduleState', s.#scheduleState);
    s.#notifications = (data.notifications as NotificationEvent[] | undefined) ?? [];
    s.#audit = (data.audit as AuditLogEntry[] | undefined) ?? [];
    return s;
  }
}
