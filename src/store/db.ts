/**
 * Persistence layer.
 *
 * `TmsStore` is the seam between the TMS domain and whatever database the host
 * GMS runs. This implementation uses Node's built-in SQLite so the module has
 * no runtime dependencies; replacing it with Postgres, Prisma or the GMS's own
 * ORM means reimplementing this one class.
 *
 * Aggregates are stored as JSON documents plus the columns the application
 * filters on — see schema.sql for why.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  ScheduleStatus,
  StandingsRow,
  Tournament,
  TournamentEvent,
  User,
  Venue,
} from '../domain/types.ts';
import type { OfficialSnapshot } from '../engines/officials.ts';
import type { ParticipantSnapshot } from '../engines/eligibility.ts';
import type { AuditQuery, ScheduleState, TmsStoreLike } from './store.ts';

export type { ScheduleState } from './store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export class TmsStore implements TmsStoreLike {
  #db: DatabaseSync;

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path);
    const schema = readFileSync(join(HERE, 'schema.sql'), 'utf8');
    this.#db.exec(schema);
  }

  close(): void {
    this.#db.close();
  }

  #txDepth = 0;

  /**
   * Run a set of writes atomically.
   *
   * Reentrant: a service method that wraps several store calls in a
   * transaction may itself call one (like `saveMatches`) that opens its own.
   * SQLite rejects a nested BEGIN, so only the outermost call starts and
   * commits, and an inner failure still rolls the whole outer unit back
   * because the exception propagates to it.
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
    this.#db.exec('BEGIN');
    this.#txDepth = 1;
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    } finally {
      this.#txDepth = 0;
    }
  }

  #put(sql: string, params: (string | number | null)[]): void {
    this.#db.prepare(sql).run(...params);
  }

  #all<T>(sql: string, params: (string | number | null)[] = []): T[] {
    return this.#db
      .prepare(sql)
      .all(...params)
      .map((r) => JSON.parse((r as { doc: string }).doc) as T);
  }

  #one<T>(sql: string, params: (string | number | null)[]): T | undefined {
    const r = this.#db.prepare(sql).get(...params) as { doc: string } | undefined;
    return r ? (JSON.parse(r.doc) as T) : undefined;
  }

  // ── Tournaments ───────────────────────────────────────────────────────────

  saveTournament(t: Tournament): void {
    this.#put(
      `INSERT INTO tournaments (tournament_id, code, status, start_date, doc) VALUES (?,?,?,?,?)
       ON CONFLICT(tournament_id) DO UPDATE SET code=excluded.code, status=excluded.status,
         start_date=excluded.start_date, doc=excluded.doc`,
      [t.tournamentId, t.code, t.status, t.startDate, JSON.stringify(t)],
    );
  }

  getTournament(id: string): Tournament | undefined {
    return this.#one<Tournament>('SELECT doc FROM tournaments WHERE tournament_id = ?', [id]);
  }

  listTournaments(): Tournament[] {
    return this.#all<Tournament>('SELECT doc FROM tournaments ORDER BY start_date DESC');
  }

  tournamentCodes(): string[] {
    return (this.#db.prepare('SELECT code FROM tournaments').all() as { code: string }[]).map((r) => r.code);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  saveEvent(e: TournamentEvent): void {
    this.#put(
      `INSERT INTO events (event_id, tournament_id, sport, status, draw_status, doc) VALUES (?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET status=excluded.status, draw_status=excluded.draw_status, doc=excluded.doc`,
      [e.eventId, e.tournamentId, e.sport, e.status, e.drawStatus, JSON.stringify(e)],
    );
  }

  getEvent(id: string): TournamentEvent | undefined {
    return this.#one<TournamentEvent>('SELECT doc FROM events WHERE event_id = ?', [id]);
  }

  listEvents(tournamentId: string): TournamentEvent[] {
    return this.#all<TournamentEvent>('SELECT doc FROM events WHERE tournament_id = ? ORDER BY event_id', [
      tournamentId,
    ]);
  }

  // ── Entries ───────────────────────────────────────────────────────────────

  saveEntry(e: Entry): void {
    this.#put(
      `INSERT INTO entries (entry_id, event_id, unit_id, status, doc) VALUES (?,?,?,?,?)
       ON CONFLICT(entry_id) DO UPDATE SET status=excluded.status, doc=excluded.doc`,
      [e.entryId, e.eventId, e.unitId, e.entryStatus, JSON.stringify(e)],
    );
  }

  getEntry(id: string): Entry | undefined {
    return this.#one<Entry>('SELECT doc FROM entries WHERE entry_id = ?', [id]);
  }

  listEntries(eventId: string): Entry[] {
    return this.#all<Entry>('SELECT doc FROM entries WHERE event_id = ? ORDER BY entry_id', [eventId]);
  }

  /** Every entry a participant holds in a tournament — §7.1.3 cross-event limit. */
  listEntriesForParticipant(tournamentId: string, participantId: string): Entry[] {
    return this.#all<Entry>(
      `SELECT e.doc FROM entries e JOIN events ev ON ev.event_id = e.event_id
       WHERE ev.tournament_id = ? AND json_extract(e.doc, '$.participantRef.id') = ?`,
      [tournamentId, participantId],
    );
  }

  // ── Formats, draws ────────────────────────────────────────────────────────

  saveFormat(f: Format): void {
    this.#put(
      `INSERT INTO formats (format_id, event_id, doc) VALUES (?,?,?)
       ON CONFLICT(format_id) DO UPDATE SET doc=excluded.doc`,
      [f.formatId, f.eventId, JSON.stringify(f)],
    );
  }

  getFormatForEvent(eventId: string): Format | undefined {
    return this.#one<Format>('SELECT doc FROM formats WHERE event_id = ? ORDER BY format_id DESC', [eventId]);
  }

  saveDraw(d: DrawRecord): void {
    this.#put(
      `INSERT INTO draws (draw_id, event_id, status, doc) VALUES (?,?,?,?)
       ON CONFLICT(draw_id) DO UPDATE SET status=excluded.status, doc=excluded.doc`,
      [d.drawId, d.eventId, d.status, JSON.stringify(d)],
    );
  }

  getDrawForEvent(eventId: string): DrawRecord | undefined {
    return this.#one<DrawRecord>(
      `SELECT doc FROM draws WHERE event_id = ? ORDER BY json_extract(doc, '$.generatedAt') DESC`,
      [eventId],
    );
  }

  /** Every draw ever generated for the event, newest first — redraw history. */
  listDraws(eventId: string): DrawRecord[] {
    return this.#all<DrawRecord>(
      `SELECT doc FROM draws WHERE event_id = ? ORDER BY json_extract(doc, '$.generatedAt') DESC`,
      [eventId],
    );
  }

  // ── Matches ───────────────────────────────────────────────────────────────

  saveMatch(m: Match): void {
    this.#put(
      `INSERT INTO matches (match_id, event_id, match_no, stage, status, scheduled_date, fop_id, doc)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(match_id) DO UPDATE SET status=excluded.status, scheduled_date=excluded.scheduled_date,
         fop_id=excluded.fop_id, doc=excluded.doc`,
      [
        m.matchId,
        m.eventId,
        m.matchNo,
        m.stage,
        m.matchStatus,
        m.scheduledDate ?? null,
        m.fopId ?? null,
        JSON.stringify(m),
      ],
    );
  }

  saveMatches(ms: Match[]): void {
    this.transaction(() => {
      for (const m of ms) this.saveMatch(m);
    });
  }

  getMatch(id: string): Match | undefined {
    return this.#one<Match>('SELECT doc FROM matches WHERE match_id = ?', [id]);
  }

  getMatchByNo(eventId: string, matchNo: string): Match | undefined {
    return this.#one<Match>('SELECT doc FROM matches WHERE event_id = ? AND match_no = ?', [eventId, matchNo]);
  }

  listMatches(eventId: string): Match[] {
    return this.#all<Match>('SELECT doc FROM matches WHERE event_id = ? ORDER BY match_no', [eventId]);
  }

  listMatchesForTournament(tournamentId: string): Match[] {
    return this.#all<Match>(
      `SELECT m.doc FROM matches m JOIN events e ON e.event_id = m.event_id
       WHERE e.tournament_id = ? ORDER BY m.scheduled_date, m.match_no`,
      [tournamentId],
    );
  }

  listMatchesOnDate(tournamentId: string, date: string): Match[] {
    return this.#all<Match>(
      `SELECT m.doc FROM matches m JOIN events e ON e.event_id = m.event_id
       WHERE e.tournament_id = ? AND m.scheduled_date = ? ORDER BY m.doc`,
      [tournamentId, date],
    );
  }

  // ── Match operations ──────────────────────────────────────────────────────

  saveOperations(o: MatchOperations): void {
    this.#put(
      `INSERT INTO match_operations (match_id, doc) VALUES (?,?)
       ON CONFLICT(match_id) DO UPDATE SET doc=excluded.doc`,
      [o.matchId, JSON.stringify(o)],
    );
  }

  getOperations(matchId: string): MatchOperations | undefined {
    return this.#one<MatchOperations>('SELECT doc FROM match_operations WHERE match_id = ?', [matchId]);
  }

  // ── Results ───────────────────────────────────────────────────────────────

  saveResult(r: Result): void {
    this.#put(
      `INSERT INTO results (result_id, match_id, event_id, status, doc) VALUES (?,?,?,?,?)
       ON CONFLICT(result_id) DO UPDATE SET status=excluded.status, doc=excluded.doc`,
      [r.resultId, r.matchId, r.eventId, r.resultStatus, JSON.stringify(r)],
    );
  }

  getResultForMatch(matchId: string): Result | undefined {
    return this.#one<Result>('SELECT doc FROM results WHERE match_id = ?', [matchId]);
  }

  listResults(eventId: string): Result[] {
    return this.#all<Result>('SELECT doc FROM results WHERE event_id = ?', [eventId]);
  }

  listResultsForTournament(tournamentId: string): Result[] {
    return this.#all<Result>(
      `SELECT r.doc FROM results r JOIN events e ON e.event_id = r.event_id WHERE e.tournament_id = ?`,
      [tournamentId],
    );
  }

  // ── Officials ─────────────────────────────────────────────────────────────

  saveAssignment(a: OfficialAssignment): void {
    this.#put(
      `INSERT INTO assignments (assignment_id, match_id, official_id, status, doc) VALUES (?,?,?,?,?)
       ON CONFLICT(assignment_id) DO UPDATE SET status=excluded.status, doc=excluded.doc`,
      [a.assignmentId, a.matchId, a.officialId, a.status, JSON.stringify(a)],
    );
  }

  listAssignments(matchId?: string): OfficialAssignment[] {
    return matchId
      ? this.#all<OfficialAssignment>('SELECT doc FROM assignments WHERE match_id = ?', [matchId])
      : this.#all<OfficialAssignment>('SELECT doc FROM assignments');
  }

  listAssignmentsForOfficial(officialId: string): OfficialAssignment[] {
    return this.#all<OfficialAssignment>('SELECT doc FROM assignments WHERE official_id = ?', [officialId]);
  }

  // ── Standings, medals ─────────────────────────────────────────────────────

  saveStandings(rows: StandingsRow[]): void {
    this.transaction(() => {
      for (const r of rows) {
        this.#put(
          `INSERT INTO standings (event_id, group_id, participant_ref, doc) VALUES (?,?,?,?)
           ON CONFLICT(event_id, group_id, participant_ref) DO UPDATE SET doc=excluded.doc`,
          [r.eventId, r.groupId, r.participantRef, JSON.stringify(r)],
        );
      }
    });
  }

  listStandings(eventId: string): StandingsRow[] {
    return this.#all<StandingsRow>('SELECT doc FROM standings WHERE event_id = ?', [eventId]).sort(
      (a, b) => a.groupId.localeCompare(b.groupId) || a.rank - b.rank,
    );
  }

  saveMedals(rows: MedalRow[]): void {
    this.transaction(() => {
      for (const r of rows) {
        this.#put(
          `INSERT INTO medals (event_id, participant_ref, doc) VALUES (?,?,?)
           ON CONFLICT(event_id, participant_ref) DO UPDATE SET doc=excluded.doc`,
          [r.eventId, r.participantRef, JSON.stringify(r)],
        );
      }
    });
  }

  listMedals(eventId?: string): MedalRow[] {
    return (
      eventId
        ? this.#all<MedalRow>('SELECT doc FROM medals WHERE event_id = ?', [eventId])
        : this.#all<MedalRow>('SELECT doc FROM medals')
    ).sort((a, b) => a.position - b.position);
  }

  listMedalsForTournament(tournamentId: string): MedalRow[] {
    return this.#all<MedalRow>(
      `SELECT m.doc FROM medals m JOIN events e ON e.event_id = m.event_id WHERE e.tournament_id = ?`,
      [tournamentId],
    );
  }

  // ── Protests, exceptions ──────────────────────────────────────────────────

  saveProtest(p: Protest): void {
    this.#put(
      `INSERT INTO protests (protest_id, match_id, event_id, status, doc) VALUES (?,?,?,?,?)
       ON CONFLICT(protest_id) DO UPDATE SET status=excluded.status, doc=excluded.doc`,
      [p.protestId, p.matchId, p.eventId, p.status, JSON.stringify(p)],
    );
  }

  listProtests(eventId?: string): Protest[] {
    return eventId
      ? this.#all<Protest>('SELECT doc FROM protests WHERE event_id = ?', [eventId])
      : this.#all<Protest>('SELECT doc FROM protests');
  }

  saveException(e: ExceptionRecord): void {
    this.#put(
      `INSERT INTO exceptions (exception_id, tournament_id, event_id, scenario, doc) VALUES (?,?,?,?,?)
       ON CONFLICT(exception_id) DO UPDATE SET doc=excluded.doc`,
      [e.exceptionId, e.tournamentId, e.eventId ?? null, e.scenario, JSON.stringify(e)],
    );
  }

  listExceptions(tournamentId: string): ExceptionRecord[] {
    return this.#all<ExceptionRecord>('SELECT doc FROM exceptions WHERE tournament_id = ?', [
      tournamentId,
    ]).sort((a, b) => b.at.localeCompare(a.at));
  }

  // ── Upstream snapshots (§11 inbound, read by reference) ───────────────────

  saveVenue(tournamentId: string, v: Venue): void {
    this.#put(
      `INSERT INTO venues (venue_id, tournament_id, doc) VALUES (?,?,?)
       ON CONFLICT(venue_id) DO UPDATE SET doc=excluded.doc`,
      [v.venueId, tournamentId, JSON.stringify(v)],
    );
  }

  listVenues(tournamentId: string): Venue[] {
    return this.#all<Venue>('SELECT doc FROM venues WHERE tournament_id = ?', [tournamentId]);
  }

  saveOfficial(tournamentId: string, o: OfficialSnapshot): void {
    this.#put(
      `INSERT INTO officials_pool (official_id, tournament_id, doc) VALUES (?,?,?)
       ON CONFLICT(official_id) DO UPDATE SET doc=excluded.doc`,
      [o.officialId, tournamentId, JSON.stringify(o)],
    );
  }

  listOfficials(tournamentId: string): OfficialSnapshot[] {
    return this.#all<OfficialSnapshot>('SELECT doc FROM officials_pool WHERE tournament_id = ?', [
      tournamentId,
    ]);
  }

  saveParticipant(tournamentId: string, p: ParticipantSnapshot): void {
    this.#put(
      `INSERT INTO participants_pool (participant_id, tournament_id, unit_id, doc) VALUES (?,?,?,?)
       ON CONFLICT(participant_id) DO UPDATE SET doc=excluded.doc`,
      [p.ref.id, tournamentId, p.unitId, JSON.stringify(p)],
    );
  }

  /** §3.2 — a Team Manager sees only their own unit's pool. */
  listParticipants(tournamentId: string, unitId?: string): ParticipantSnapshot[] {
    return unitId
      ? this.#all<ParticipantSnapshot>(
          'SELECT doc FROM participants_pool WHERE tournament_id = ? AND unit_id = ?',
          [tournamentId, unitId],
        )
      : this.#all<ParticipantSnapshot>('SELECT doc FROM participants_pool WHERE tournament_id = ?', [
          tournamentId,
        ]);
  }

  getParticipant(id: string): ParticipantSnapshot | undefined {
    return this.#one<ParticipantSnapshot>('SELECT doc FROM participants_pool WHERE participant_id = ?', [id]);
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  saveUser(u: User): void {
    this.#put(
      `INSERT INTO users (user_id, role, doc) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, doc=excluded.doc`,
      [u.userId, u.role, JSON.stringify(u)],
    );
  }

  getUser(id: string): User | undefined {
    return this.#one<User>('SELECT doc FROM users WHERE user_id = ?', [id]);
  }

  listUsers(): User[] {
    return this.#all<User>('SELECT doc FROM users');
  }

  // ── Notifications (§11 outbound) ──────────────────────────────────────────

  saveNotification(n: NotificationEvent): void {
    this.#put(
      'INSERT INTO notifications (notification_id, tournament_id, type, sent_at, doc) VALUES (?,?,?,?,?)',
      [n.notificationId, n.tournamentId, n.type, n.sentAt, JSON.stringify(n)],
    );
  }

  listNotifications(tournamentId: string, limit = 100): NotificationEvent[] {
    return this.#all<NotificationEvent>(
      'SELECT doc FROM notifications WHERE tournament_id = ? ORDER BY sent_at DESC LIMIT ?',
      [tournamentId, limit],
    );
  }

  // ── Audit log — insert and select only (§7.6.27) ───────────────────────────

  /**
   * Append an audit entry. There is deliberately no update or delete: rule
   * 7.6.27 forbids editing or deleting audit entries for every role, including
   * Super Admin, so the capability does not exist in the store.
   */
  appendAudit(e: AuditLogEntry): void {
    this.#put(
      `INSERT INTO audit_log (log_id, timestamp, tournament_id, entity_type, entity_id, user_id, action, doc)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        e.logId,
        e.timestamp,
        e.tournamentId ?? null,
        e.entityType,
        e.entityId,
        e.userId,
        e.action,
        JSON.stringify(e),
      ],
    );
  }

  /** Highest numeric suffix in a column, so ID counters resume after a restart. */
  maxIdSuffix(table: string, column: string): number {
    const allowed: Record<string, string> = {
      audit_log: 'log_id',
      notifications: 'notification_id',
    };
    if (allowed[table] !== column) {
      throw new Error(`maxIdSuffix is not available for ${table}.${column}`);
    }
    const row = this.#db
      .prepare(`SELECT MAX(CAST(substr(${column}, instr(${column}, '-') + 1) AS INTEGER)) AS n FROM ${table}`)
      .get() as { n: number | null } | undefined;
    return row?.n ?? 0;
  }

  queryAudit(q: AuditQuery): AuditLogEntry[] {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (q.tournamentId) {
      where.push('tournament_id = ?');
      params.push(q.tournamentId);
    }
    if (q.entityType) {
      where.push('entity_type = ?');
      params.push(q.entityType);
    }
    if (q.entityId) {
      where.push('entity_id = ?');
      params.push(q.entityId);
    }
    if (q.userId) {
      where.push('user_id = ?');
      params.push(q.userId);
    }
    if (q.action) {
      where.push('action = ?');
      params.push(q.action);
    }
    const sql = `SELECT doc FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp DESC, log_id DESC LIMIT ?`;
    params.push(q.limit ?? 200);
    return this.#all<AuditLogEntry>(sql, params);
  }

  // ── Schedule publication state ────────────────────────────────────────────

  getScheduleState(eventId: string): ScheduleState {
    const row = this.#db
      .prepare('SELECT * FROM schedule_state WHERE event_id = ?')
      .get(eventId) as
      | { event_id: string; status: string; acknowledged_soft: string; published_at: string | null; version_no: number }
      | undefined;
    if (!row) {
      return { eventId, status: 'Draft', acknowledgedSoft: [], versionNo: 1 };
    }
    return {
      eventId: row.event_id,
      status: row.status as ScheduleStatus,
      acknowledgedSoft: JSON.parse(row.acknowledged_soft) as string[],
      publishedAt: row.published_at ?? undefined,
      versionNo: row.version_no,
    };
  }

  saveScheduleState(s: ScheduleState): void {
    this.#put(
      `INSERT INTO schedule_state (event_id, status, acknowledged_soft, published_at, version_no)
       VALUES (?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET status=excluded.status,
         acknowledged_soft=excluded.acknowledged_soft, published_at=excluded.published_at,
         version_no=excluded.version_no`,
      [s.eventId, s.status, JSON.stringify(s.acknowledgedSoft), s.publishedAt ?? null, s.versionNo],
    );
  }

  /** Wipe every table — used by the seeder's --reset and by tests. */
  reset(): void {
    const tables = [
      'audit_log', 'notifications', 'users', 'participants_pool', 'officials_pool', 'venues',
      'exceptions', 'protests', 'medals', 'standings', 'assignments', 'results',
      'match_operations', 'matches', 'draws', 'formats', 'entries', 'events', 'tournaments',
      'schedule_state',
    ];
    this.transaction(() => {
      for (const t of tables) this.#db.exec(`DELETE FROM ${t}`);
    });
  }
}
