/**
 * The persistence contract.
 *
 * `docs/02-architecture.md` calls the store "the seam a host GMS replaces".
 * This file is that seam written down. Extracting it costs nothing and buys
 * two things:
 *
 *   1. The compiler now enforces that every implementation stays in step. A
 *      method added to the SQLite store without a counterpart elsewhere is a
 *      type error, not a runtime surprise six screens later.
 *   2. `TmsService` depends on this interface rather than on `node:sqlite`,
 *      which is what lets the identical rules run in a browser against
 *      `MemoryStore` — no server, no mocks, no second copy of the logic.
 *
 * Two implementations ship:
 *   · `TmsStore`    (db.ts)     — node:sqlite, the production path
 *   · `MemoryStore` (memory.ts) — plain Maps, for tests and the static build
 *
 * Note what is absent: there is no `updateAudit` and no `deleteAudit`. The
 * append-only guarantee of §5.8 is a property of this contract, not a
 * permission that some caller could be granted.
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
  ScheduleStatus,
  StandingsRow,
  Tournament,
  TournamentEvent,
  User,
  Venue,
} from '../domain/types.ts';
import type { OfficialSnapshot } from '../engines/officials.ts';
import type { ParticipantSnapshot } from '../engines/eligibility.ts';

/** §6.4 — publication state of an event's schedule. */
export interface ScheduleState {
  eventId: string;
  status: ScheduleStatus;
  acknowledgedSoft: string[];
  publishedAt?: string;
  versionNo: number;
}

export interface AuditQuery {
  tournamentId?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  action?: string;
  limit?: number;
}

export interface TmsStoreLike {
  close(): void;

  /**
   * Run a set of writes atomically.
   *
   * Must be reentrant: a service method that wraps several store calls may
   * itself call one (like `saveMatches`) that opens its own transaction. Only
   * the outermost call commits, and an inner failure still rolls the whole
   * outer unit back.
   */
  transaction<T>(fn: () => T): T;

  // ── Tournaments ───────────────────────────────────────────────────────────
  saveTournament(t: Tournament): void;
  getTournament(id: string): Tournament | undefined;
  /** Newest first, by start date. */
  listTournaments(): Tournament[];
  tournamentCodes(): string[];

  // ── Events ────────────────────────────────────────────────────────────────
  saveEvent(e: TournamentEvent): void;
  getEvent(id: string): TournamentEvent | undefined;
  listEvents(tournamentId: string): TournamentEvent[];

  // ── Entries ───────────────────────────────────────────────────────────────
  saveEntry(e: Entry): void;
  getEntry(id: string): Entry | undefined;
  listEntries(eventId: string): Entry[];
  /** §7.1.8 — one participant may not be entered twice in a tournament. */
  listEntriesForParticipant(tournamentId: string, participantId: string): Entry[];

  // ── Format ────────────────────────────────────────────────────────────────
  saveFormat(f: Format): void;
  /** The latest format for the event. */
  getFormatForEvent(eventId: string): Format | undefined;

  // ── Draw ──────────────────────────────────────────────────────────────────
  saveDraw(d: DrawRecord): void;
  /** The most recently generated draw for the event. */
  getDrawForEvent(eventId: string): DrawRecord | undefined;
  /** Every draw generated for the event, newest first — the amendment history. */
  listDraws(eventId: string): DrawRecord[];

  // ── Matches ───────────────────────────────────────────────────────────────
  saveMatch(m: Match): void;
  saveMatches(ms: Match[]): void;
  getMatch(id: string): Match | undefined;
  getMatchByNo(eventId: string, matchNo: string): Match | undefined;
  listMatches(eventId: string): Match[];
  listMatchesForTournament(tournamentId: string): Match[];
  listMatchesOnDate(tournamentId: string, date: string): Match[];

  // ── Match operations ──────────────────────────────────────────────────────
  saveOperations(o: MatchOperations): void;
  getOperations(matchId: string): MatchOperations | undefined;

  // ── Results ───────────────────────────────────────────────────────────────
  saveResult(r: Result): void;
  getResultForMatch(matchId: string): Result | undefined;
  listResults(eventId: string): Result[];
  listResultsForTournament(tournamentId: string): Result[];

  // ── Officials ─────────────────────────────────────────────────────────────
  saveAssignment(a: OfficialAssignment): void;
  listAssignments(matchId?: string): OfficialAssignment[];
  listAssignmentsForOfficial(officialId: string): OfficialAssignment[];

  // ── Standings and medals ──────────────────────────────────────────────────
  /** Upserts by (eventId, groupId, participantRef). */
  saveStandings(rows: StandingsRow[]): void;
  listStandings(eventId: string): StandingsRow[];
  /** Upserts by (eventId, participantRef). */
  saveMedals(rows: MedalRow[]): void;
  listMedals(eventId?: string): MedalRow[];
  listMedalsForTournament(tournamentId: string): MedalRow[];

  // ── Governance ────────────────────────────────────────────────────────────
  saveProtest(p: Protest): void;
  listProtests(eventId?: string): Protest[];
  saveException(e: ExceptionRecord): void;
  listExceptions(tournamentId: string): ExceptionRecord[];

  // ── Upstream snapshots (§11) ───────────────────────────────────────────────
  saveVenue(tournamentId: string, v: Venue): void;
  listVenues(tournamentId: string): Venue[];
  saveOfficial(tournamentId: string, o: OfficialSnapshot): void;
  listOfficials(tournamentId: string): OfficialSnapshot[];
  saveParticipant(tournamentId: string, p: ParticipantSnapshot): void;
  listParticipants(tournamentId: string, unitId?: string): ParticipantSnapshot[];
  getParticipant(id: string): ParticipantSnapshot | undefined;

  // ── Users ─────────────────────────────────────────────────────────────────
  saveUser(u: User): void;
  getUser(id: string): User | undefined;
  listUsers(): User[];

  // ── Notifications (§11 outbound) ──────────────────────────────────────────
  saveNotification(n: NotificationEvent): void;
  /** Newest first. */
  listNotifications(tournamentId: string, limit?: number): NotificationEvent[];

  // ── Audit (§5.8) — append and read only, by design ────────────────────────
  appendAudit(e: AuditLogEntry): void;
  /** Newest first. */
  queryAudit(q: AuditQuery): AuditLogEntry[];
  /**
   * Highest numeric suffix already issued for an ID column, so generated IDs
   * keep climbing across a restart. Allow-listed to the two high-volume
   * tables that carry a unique constraint.
   */
  maxIdSuffix(table: string, column: string): number;

  // ── Schedule publication state ────────────────────────────────────────────
  getScheduleState(eventId: string): ScheduleState;
  saveScheduleState(s: ScheduleState): void;

  /** Wipe everything — the seeder's `--reset` and the tests. */
  reset(): void;
}
