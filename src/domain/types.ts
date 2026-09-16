/**
 * TMS domain entities.
 *
 * Mirrors Section 13 ("Data Fields — Key Entities") of the TMS Functional
 * Workflow Document. Field names follow the document so a Business Analyst can
 * read this file side-by-side with the spec.
 *
 * Design principle #1 (single source of truth): athletes, teams, officials and
 * venues live in other GMS modules. Everything here that points at them is a
 * *reference* (`*_ref` / `*_id`) plus a cached display name, never a copy of the
 * record. `revalidatedAt` records when the upstream status was last confirmed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

export type ISODate = string; // YYYY-MM-DD
export type ISOTime = string; // HH:MM (24h)
export type ISODateTime = string; // full ISO-8601 instant

/** A pointer into another GMS module. Never widened into an owned copy. */
export interface UpstreamRef {
  /** Primary key in the owning module (Athlete Registration, Team Management…). */
  id: string;
  /** Cached for display only — re-validated at every gate (entry, draw, check-in). */
  displayName: string;
  /** Owning GMS module, so a failed lookup names the right system. */
  module: 'athlete-registration' | 'team-management' | 'officials' | 'venue' | 'accreditation';
  /** Last time TMS confirmed this record is still Approved upstream. */
  revalidatedAt?: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status lifecycles — Section 6
// ─────────────────────────────────────────────────────────────────────────────

/** §6.1 Tournament status. */
export const TOURNAMENT_STATUSES = [
  'Draft',
  'Configured',
  'Entries Open',
  'Entries Locked',
  'Draw Published',
  'Active',
  'Completed',
  'Archived',
  'Cancelled',
] as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];

/** §6.2 Match status. */
export const MATCH_STATUSES = [
  'Scheduled',
  'Check-in',
  'Live',
  'Suspended',
  'Completed (Provisional)',
  'Postponed',
  'Cancelled',
  'Walkover',
  'Abandoned',
  'Disqualified',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** §6.3 Result status. */
export const RESULT_STATUSES = [
  'Pending',
  'Entered',
  'Verified',
  'Under Protest',
  'Approved',
  'Correction in Progress',
  'Re-verified',
] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** §6.4 Schedule status. */
export const SCHEDULE_STATUSES = ['Draft', 'Validated', 'Published', 'Amended', 'Final'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

/** §6.5 Generic approval status — applies to draw, schedule, result, medals. */
export const APPROVAL_STATUSES = [
  'Submitted',
  'Under Review',
  'Approved',
  'Rejected',
  'Sent Back for Correction',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Draw status — §5.3 gates publication behind an explicit approve step. */
export const DRAW_STATUSES = ['Not Generated', 'Draft Draw', 'Validated', 'Published'] as const;
export type DrawStatus = (typeof DRAW_STATUSES)[number];

export const EVENT_STATUSES = [
  'Draft',
  'Confirmed',
  'Entries Open',
  'Entries Locked',
  'Format Approved',
  'Draw Published',
  'Scheduled',
  'In Progress',
  'Completed',
  'Cancelled – Insufficient Entries',
  'Cancelled',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const ENTRY_STATUSES = [
  'Draft',
  'Submitted',
  'Confirmed',
  'Blocked',
  'Scratched',
  'Withdrawn',
] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Roles — Section 3.1
// ─────────────────────────────────────────────────────────────────────────────

export const ROLES = [
  'Super Admin',
  'Tournament Admin',
  'Competition Manager',
  'Venue Manager',
  'Technical Official',
  'Referee',
  'Scorer',
  'Team Manager',
  'Viewer',
  'Jury of Appeal',
] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  userId: string;
  name: string;
  role: Role;
  /** Scope narrows a role to specific objects — §3.1 "Scope" column. */
  scope: {
    tournamentIds?: string[];
    sportIds?: string[];
    venueIds?: string[];
    matchIds?: string[];
    /** Team Managers and neutrality checks both key off the unit. */
    unitId?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.1 Tournament
// ─────────────────────────────────────────────────────────────────────────────

export const TOURNAMENT_LEVELS = [
  'school',
  'district',
  'state',
  'national',
  'international',
] as const;
export type TournamentLevel = (typeof TOURNAMENT_LEVELS)[number];

export type ApprovalChainType = '1-step' | '2-step';

export interface Tournament {
  tournamentId: string;
  code: string;
  name: string;
  organizingBody: string;
  level: TournamentLevel;
  season: string;
  startDate: ISODate;
  endDate: ISODate;
  hostCity: string;
  venues: UpstreamRef[];
  ageCategories: string[];
  genderCategories: GenderCategory[];
  participatingUnits: string[];
  entryDeadline: ISODate;
  withdrawalDeadline: ISODate;
  /** §13.1 protest_window_mins — drives the §5.6 protest timer. */
  protestWindowMins: number;
  protestFee: number;
  approvalChainType: ApprovalChainType;
  /** §7.2 age eligibility is computed against this date, never "age today". */
  categoryCutOffDate: ISODate;
  /** §7.1.3 cross-event participation limits, configurable per tournament. */
  maxEventsPerAthlete: number;
  /** §7.1.6 below this, an event is auto-flagged for cancellation. */
  minEntriesToRun: number;
  maxEntriesPerUnit: number;
  /** §8.6 publish on approve, or as a separate explicit act. */
  autoPublishResults: boolean;
  /** §7.3.13 neutrality rule — configurable per tournament level. */
  enforceOfficialNeutrality: boolean;
  status: TournamentStatus;
  createdBy: string;
  createdAt: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.2 Event (sport/discipline instance)
// ─────────────────────────────────────────────────────────────────────────────

export const PARTICIPATION_TYPES = ['individual', 'team', 'pair', 'relay', 'mixed'] as const;
export type ParticipationType = (typeof PARTICIPATION_TYPES)[number];

export const GENDER_CATEGORIES = ['M', 'W', 'Mixed', 'Open'] as const;
export type GenderCategory = (typeof GENDER_CATEGORIES)[number];

export type MedalRule = 'playoff' | 'joint-bronze';

export interface TournamentEvent {
  eventId: string;
  tournamentId: string;
  /** Sport key into the sport-config registry — e.g. 'kabaddi'. */
  sport: string;
  discipline: string;
  participationType: ParticipationType;
  ageCategory: string;
  genderCategory: GenderCategory;
  weightCategory?: string;
  paraClass?: string;
  /** §2.5 scoring behaviour comes from a template, never hardcoded. */
  scoringTemplateId: string;
  maxEntriesPerUnit: number;
  minEntriesToRun: number;
  seedingSource: 'previous-ranking' | 'manual' | 'none';
  formatId?: string;
  medalRule: MedalRule;
  status: EventStatus;
  drawStatus: DrawStatus;
  /** Set once the event catalogue is locked — §2.7. */
  confirmedAt?: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.3 Entry
// ─────────────────────────────────────────────────────────────────────────────

export interface EligibilityCheck {
  /** Stable key so the UI and reports can label failures consistently. */
  rule:
    | 'upstream-approved'
    | 'accreditation-valid'
    | 'age-category'
    | 'gender-category'
    | 'weight-category'
    | 'unit-quota'
    | 'duplicate-entry'
    | 'max-events-per-athlete'
    | 'cross-event-clash'
    | 'roster-size';
  passed: boolean;
  /** 'hard' blocks the entry; 'soft' is an advisory the UI surfaces (§3.4 ⚠). */
  severity: 'hard' | 'soft';
  message: string;
}

export interface EligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
  evaluatedAt: ISODateTime;
}

export interface Entry {
  entryId: string;
  eventId: string;
  /** Athlete or team reference — §13.3 participant_ref. */
  participantRef: UpstreamRef;
  unitId: string;
  seedNo?: number;
  entryStatus: EntryStatus;
  eligibilityResult: EligibilityResult;
  /** §7.1.4 quota / eligibility override — Tournament Admin only, reason required. */
  overrideFlag: boolean;
  overrideReason?: string;
  overrideBy?: string;
  /** Squad for team events — Kabaddi needs 12 (7 on court + 5 subs). */
  rosterRefs?: UpstreamRef[];
  /** §5.2 withdrawals after lock are kept on record as scratches. */
  scratchReason?: string;
  enteredBy: string;
  enteredAt: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.4 Fixture / Match
// ─────────────────────────────────────────────────────────────────────────────

export const STAGES = ['group', 'R32', 'R16', 'QF', 'SF', 'F', 'bronze', 'repechage'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * A match side is either a concrete entry or an unresolved progression
 * placeholder ("Winner of M02"). §5.3 creates the bracket skeleton with
 * placeholders; §8.5 resolves them on result approval.
 */
export type MatchSide =
  | { kind: 'entry'; entryId: string; displayName: string }
  | { kind: 'placeholder'; source: 'winner' | 'loser'; matchNo: string; displayName: string }
  | { kind: 'placeholder-standing'; groupId: string; position: number; displayName: string }
  | { kind: 'bye'; displayName: string };

export interface OfficialAssignmentRef {
  officialId: string;
  officialName: string;
  role: string;
  unitId: string;
}

export interface RescheduleRecord {
  fromDate?: ISODate;
  fromTime?: ISOTime;
  fromFopId?: string;
  toDate: ISODate;
  toTime: ISOTime;
  toFopId: string;
  reasonCode: string;
  requestedBy: string;
  approvedBy: string;
  at: ISODateTime;
}

export interface Match {
  matchId: string;
  eventId: string;
  stage: Stage;
  roundNo: number;
  matchNo: string;
  groupId?: string;
  sideA: MatchSide;
  sideB: MatchSide;
  byeFlag: boolean;
  venueId?: string;
  fopId?: string;
  scheduledDate?: ISODate;
  scheduledTime?: ISOTime;
  session?: 'morning' | 'afternoon' | 'evening';
  durationMins?: number;
  officials: OfficialAssignmentRef[];
  matchStatus: MatchStatus;
  /** §7.2.10 a published fixture is immutable; changes create a new version. */
  versionNo: number;
  rescheduleHistory: RescheduleRecord[];
  /** Where the winner and loser of this match feed — drives §8.5 propagation. */
  progression?: {
    winnerTo?: { matchNo: string; side: 'A' | 'B' };
    loserTo?: { matchNo: string; side: 'A' | 'B' };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.5 Match operations
// ─────────────────────────────────────────────────────────────────────────────

export interface AttendanceRecord {
  participantId: string;
  participantName: string;
  side: 'A' | 'B';
  present: boolean;
  checkinTime?: ISODateTime;
  accreditationValid: boolean;
  /** Kabaddi: only 7 players may be on court at the start. */
  startingLineup?: boolean;
}

/** One atomic scoring event. Sport-specific `type` values come from the template. */
export interface ScoreEvent {
  seq: number;
  timestamp: ISODateTime;
  /** Clock position in seconds from match start — lets us rebuild a timeline. */
  clockSecs: number;
  type: string;
  side: 'A' | 'B';
  value: number;
  /** Kabaddi: raider / primary defender involved, for statistics. */
  participantId?: string;
  detail?: Record<string, string | number | boolean>;
  enteredBy: string;
  /** §8.14 post-facto entry from a paper scoresheet. */
  offlineEntry?: boolean;
}

export interface SanctionRecord {
  participantId: string;
  participantName: string;
  card: 'green' | 'yellow' | 'red';
  reason: string;
  clockSecs: number;
  issuedBy: string;
}

export interface SuspensionRecord {
  fromClockSecs: number;
  toClockSecs?: number;
  reasonCode: string;
  decidedBy: string;
}

export interface MatchOperations {
  matchId: string;
  attendance: AttendanceRecord[];
  tossWinner?: 'A' | 'B';
  /** Kabaddi: the toss winner picks the court, or the right to raid first. */
  tossChoice?: 'court' | 'raid';
  startTimeActual?: ISODateTime;
  endTimeActual?: ISODateTime;
  scoreEvents: ScoreEvent[];
  /** Per-half / per-period running score. */
  periodScores: { period: number; a: number; b: number }[];
  sanctions: SanctionRecord[];
  suspensionLog: SuspensionRecord[];
  refereeSignoff?: { officialId: string; officialName: string; timestamp: ISODateTime };
  /** No-show timer — §7.2 starts it, §8.2 rules on expiry. */
  noShowDeadline?: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.6 Result
// ─────────────────────────────────────────────────────────────────────────────

export const OUTCOME_TYPES = [
  'played',
  'walkover',
  'retired',
  'DQ',
  'abandoned',
  'void',
] as const;
export type OutcomeType = (typeof OUTCOME_TYPES)[number];

export interface CorrectionRecord {
  field: string;
  oldValue: string;
  newValue: string;
  reasonCode: string;
  unlockedBy: string;
  approvedBy: string;
  unlockedAt: ISODateTime;
  reapprovedAt?: ISODateTime;
}

export interface Result {
  resultId: string;
  matchId: string;
  eventId: string;
  finalScore: { a: number; b: number };
  winnerRef?: string;
  outcomeType: OutcomeType;
  resultStatus: ResultStatus;
  /** Kabaddi: raid/tackle/bonus/all-out split, for the match report. */
  statistics?: Record<string, number>;
  enteredBy?: string;
  enteredAt?: ISODateTime;
  verifiedBy?: string;
  verifiedAt?: ISODateTime;
  approvedBy?: string;
  approvedAt?: ISODateTime;
  lockedAt?: ISODateTime;
  publishedAt?: ISODateTime;
  protestRef?: string;
  correctionHistory: CorrectionRecord[];
  /** §5.6 the verifier's remarks when a result is sent back to the Scorer. */
  verificationRemarks?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.7 Standings row
// ─────────────────────────────────────────────────────────────────────────────

export interface StandingsRow {
  eventId: string;
  groupId: string;
  participantRef: string;
  participantName: string;
  unitId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  scoreFor: number;
  scoreAgainst: number;
  /** Sport metric — Kabaddi uses score difference. */
  sportMetric: number;
  sportMetricLabel: string;
  /** Kabaddi league bonus points (losing by ≤ configured margin). */
  bonusPoints: number;
  /** Which tie-breaker decided this row's position, for the §12 explainer. */
  tiebreakNotes: string[];
  rank: number;
  /** §5.7 'Q' qualified, 'E' eliminated, '' undecided. */
  qualificationFlag: 'Q' | 'E' | '';
  computedAt: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.8 Medal / ranking
// ─────────────────────────────────────────────────────────────────────────────

export interface MedalRow {
  eventId: string;
  position: number;
  participantRef: string;
  participantName: string;
  unitId: string;
  medal: 'G' | 'S' | 'B' | 'none';
  /** §7.5.24 joint bronze awards two bronzes and skips the play-off. */
  jointFlag: boolean;
  dqAnnotation?: string;
  verifiedBy?: string;
  approvedBy?: string;
  publishedAt?: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.9 Official assignment
// ─────────────────────────────────────────────────────────────────────────────

export interface OfficialAssignment {
  assignmentId: string;
  matchId: string;
  officialId: string;
  officialName: string;
  role: string;
  unitId: string;
  venueId?: string;
  reportTime?: ISODateTime;
  /** §7.3.13 neutrality: official's unit must differ from both participants'. */
  neutralityCheckResult: 'pass' | 'fail' | 'waived' | 'not-applicable';
  status: 'assigned' | 'acknowledged' | 'completed' | 'replaced';
  assignedBy: string;
  assignedAt: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.10 Venue / field of play
// ─────────────────────────────────────────────────────────────────────────────

export interface FieldOfPlay {
  fopId: string;
  venueId: string;
  /** Kabaddi calls its playing surface a "mat". */
  type: string;
  name: string;
}

export interface Venue {
  venueId: string;
  name: string;
  address: string;
  fopList: FieldOfPlay[];
  operatingHours: { open: ISOTime; close: ISOTime };
  maintenanceBlocks: { fopId: string; date: ISODate; from: ISOTime; to: ISOTime; reason: string }[];
  capacity: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.11 Audit log entry
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  logId: string;
  timestamp: ISODateTime;
  userId: string;
  userName: string;
  role: Role;
  tournamentId?: string;
  entityType: string;
  entityId: string;
  action: string;
  oldValue?: string;
  newValue?: string;
  /** §6 every terminal or exception status requires a reason code. */
  reasonCode?: string;
  device?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 13.12 Notification event
// ─────────────────────────────────────────────────────────────────────────────

export const NOTIFICATION_TYPES = [
  'fixture_published',
  'schedule_published',
  'reschedule',
  'result_approved',
  'result_published',
  'duty_assigned',
  'protest_filed',
  'protest_ruling',
  'entry_window_open',
  'entries_locked',
  'draw_published',
  'medals_published',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationEvent {
  notificationId: string;
  tournamentId: string;
  type: NotificationType;
  audience: { roles?: Role[]; unitIds?: string[]; officialIds?: string[]; userIds?: string[] };
  channels: ('app' | 'email' | 'sms' | 'whatsapp')[];
  payload: Record<string, unknown>;
  sentAt: ISODateTime;
  deliveryStatus: 'queued' | 'sent' | 'failed';
}

// ─────────────────────────────────────────────────────────────────────────────
// Format & progression — Section 4 (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────

export const FORMAT_TYPES = [
  'knockout',
  'league-single',
  'league-double',
  'group-knockout',
  'pool',
  'qualification-finals',
  'repechage',
  'heats-semis-finals',
] as const;
export type FormatType = (typeof FORMAT_TYPES)[number];

export interface ProgressionRule {
  /** Source group, or '*' for every group in the stage. */
  fromGroupId: string;
  /** Finishing positions that advance — e.g. [1, 2] for "top 2 per group". */
  positions: number[];
  toStage: Stage;
  /** §4.3 keep group winners apart in the next stage. */
  seedApart: boolean;
}

/**
 * Match parameters — §4.4. The sport template supplies the defaults and the
 * Format may override them per event. Defined here rather than in the sport
 * registry so there is exactly one definition: a second, near-identical shape
 * is how a format's period count and the scoring engine's period count drift
 * apart.
 */
export interface MatchParams {
  durationMins: number;
  periods: number;
  periodMins: number;
  breakMins: number;
  /** Kabaddi tie resolution in knockout: extra halves then a golden raid. */
  tieBreakMode: string;
  pointsWin: number;
  pointsDraw: number;
  pointsLoss: number;
  /** Kabaddi league bonus: 1 point for losing by this margin or less. */
  bonusPointMargin?: number;
  pointsBonus?: number;
  /** Slot length the scheduler books = play + break + turnaround. */
  slotMins: number;
}

export interface Format {
  formatId: string;
  eventId: string;
  type: FormatType;
  groupCount: number;
  teamsPerGroup: number;
  /** 1 = single meeting, 2 = home-and-away / double round-robin. */
  matchesPerPairing: 1 | 2;
  progressionRules: ProgressionRule[];
  matchParams: MatchParams;
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: ISODateTime;
  /** §7.2.7 format cannot change after draw publication. */
  lockedByDraw: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Draw record — §7.2.9 reproducibility
// ─────────────────────────────────────────────────────────────────────────────

/** One position in a knockout bracket or a group slate. */
export interface DrawSlot {
  slot: number;
  /** Bracket position expressed as the seed that conventionally occupies it. */
  nominalSeed: number;
  groupId?: string;
  occupant:
    | { kind: 'entry'; entryId: string; displayName: string; unitId: string; seedNo?: number }
    | { kind: 'bye' };
}

export interface DrawRecord {
  drawId: string;
  eventId: string;
  /** Full slot map — the basis for the §10.1 draw sheet and its bye markers. */
  slots: DrawSlot[];
  /** RNG algorithm identifier, stored with the seed so a replay is exact. */
  rngAlgorithm: string;
  /** §7.2.9 the RNG seed must be stored so any draw is reproducible. */
  rngSeed: string;
  bracketSize: number;
  entryCount: number;
  byeCount: number;
  seedCount: number;
  separationRule: 'none' | 'same-unit-apart-r1' | 'same-unit-apart-r1-r2';
  byePolicy: 'top-seeds' | 'random';
  status: DrawStatus;
  /** Every pre-publish manual swap, with before/after — §5.4. */
  manualAdjustments: {
    fromSlot: number;
    toSlot: number;
    before: string;
    after: string;
    by: string;
    at: ISODateTime;
  }[];
  validationErrors: string[];
  generatedBy: string;
  generatedAt: ISODateTime;
  approvedBy?: string;
  publishedAt?: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// Protest / exception register — Sections 8 & 12.14
// ─────────────────────────────────────────────────────────────────────────────

export interface Protest {
  protestId: string;
  matchId: string;
  eventId: string;
  filedBy: string;
  filedByUnit: string;
  filedAt: ISODateTime;
  grounds: string;
  feePaid: number;
  status: 'Filed' | 'Under Review' | 'Upheld' | 'Rejected' | 'Withdrawn';
  ruling?: string;
  /** §8.9 upheld → amend the result or replay the match. */
  rulingAction?: 'amend-result' | 'replay-match' | 'no-change';
  ruledBy?: string;
  ruledAt?: ISODateTime;
  feeForfeited?: boolean;
}

export interface ExceptionRecord {
  exceptionId: string;
  /** Row number from Section 8, so ops staff can cite the playbook. */
  scenario:
    | 'walkover'
    | 'no-show'
    | 'disqualification'
    | 'postponed'
    | 'cancelled'
    | 'tie'
    | 'suspended'
    | 'abandoned'
    | 'protest'
    | 'result-correction'
    | 'participant-change'
    | 'venue-change'
    | 'weather-delay'
    | 'system-outage';
  matchId?: string;
  eventId?: string;
  tournamentId: string;
  reasonCode: string;
  detail: string;
  decidedBy: string;
  decidedByRole: Role;
  /** §7.6.26 high-impact actions need a second-role approval. */
  ratifiedBy?: string;
  at: ISODateTime;
}
