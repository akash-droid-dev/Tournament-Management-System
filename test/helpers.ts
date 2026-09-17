/**
 * Test fixtures.
 *
 * Builders rather than shared mutable objects, so no test can perturb another.
 */

import type {
  Entry,
  Format,
  Match,
  Result,
  Tournament,
  TournamentEvent,
  User,
  Venue,
} from '../src/domain/types.ts';
import type { ParticipantSnapshot } from '../src/engines/eligibility.ts';
import type { OfficialSnapshot } from '../src/engines/officials.ts';
import { kabaddi } from '../src/sports/index.ts';

export function user(userId: string, role: User['role'], scope: User['scope'] = {}): User {
  return { userId, name: userId.toUpperCase(), role, scope };
}

export function tournament(over: Partial<Tournament> = {}): Tournament {
  return {
    tournamentId: 'TRN-T',
    code: 'TST',
    name: 'Test Championship',
    organizingBody: 'AKFI',
    level: 'national',
    season: '2026',
    startDate: '2026-03-10',
    endDate: '2026-03-14',
    hostCity: 'Pune',
    venues: [],
    ageCategories: ['SENIOR'],
    genderCategories: ['M'],
    participatingUnits: ['MH', 'HR', 'PB', 'UP'],
    entryDeadline: '2026-02-20',
    withdrawalDeadline: '2026-02-25',
    protestWindowMins: 30,
    protestFee: 5000,
    approvalChainType: '2-step',
    categoryCutOffDate: '2026-01-01',
    maxEventsPerAthlete: 1,
    minEntriesToRun: 4,
    maxEntriesPerUnit: 1,
    autoPublishResults: false,
    enforceOfficialNeutrality: true,
    status: 'Active',
    createdBy: 'ta1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function event(over: Partial<TournamentEvent> = {}): TournamentEvent {
  return {
    eventId: 'EVT-T',
    tournamentId: 'TRN-T',
    sport: 'kabaddi',
    discipline: 'Team Kabaddi',
    participationType: 'team',
    ageCategory: 'SENIOR',
    genderCategory: 'M',
    scoringTemplateId: 'kabaddi',
    maxEntriesPerUnit: 1,
    minEntriesToRun: 4,
    seedingSource: 'previous-ranking',
    medalRule: 'joint-bronze',
    status: 'Format Approved',
    drawStatus: 'Not Generated',
    ...over,
  };
}

export function format(over: Partial<Format> = {}): Format {
  return {
    formatId: 'FMT-T',
    eventId: 'EVT-T',
    type: 'knockout',
    groupCount: 1,
    teamsPerGroup: 0,
    matchesPerPairing: 1,
    progressionRules: [],
    matchParams: { ...kabaddi.matchDefaults },
    approvalStatus: 'Approved',
    lockedByDraw: false,
    ...over,
  };
}

export function entry(n: number, unitId: string, seedNo?: number, over: Partial<Entry> = {}): Entry {
  return {
    entryId: `ENT-${String(n).padStart(4, '0')}`,
    eventId: 'EVT-T',
    participantRef: { id: `TEAM-${unitId}`, displayName: `${unitId} Kabaddi`, module: 'team-management' },
    unitId,
    seedNo,
    entryStatus: 'Confirmed',
    eligibilityResult: { eligible: true, checks: [], evaluatedAt: '2026-02-01T00:00:00.000Z' },
    overrideFlag: false,
    rosterRefs: Array.from({ length: 12 }, (_, i) => ({
      id: `ATH-${unitId}-${i}`,
      displayName: `Player ${i + 1} (${unitId})`,
      module: 'athlete-registration' as const,
    })),
    enteredBy: 'tm1',
    enteredAt: '2026-02-01T00:00:00.000Z',
    ...over,
  };
}

export function entries(units: string[], seeded = 0): Entry[] {
  return units.map((u, i) => entry(i + 1, u, i < seeded ? i + 1 : undefined));
}

export function entryMeta(list: Entry[]): Record<string, { displayName: string; unitId: string }> {
  return Object.fromEntries(list.map((e) => [e.entryId, { displayName: e.participantRef.displayName, unitId: e.unitId }]));
}

export function match(over: Partial<Match> = {}): Match {
  return {
    matchId: 'MCH-T',
    eventId: 'EVT-T',
    stage: 'group',
    roundNo: 1,
    matchNo: 'M01',
    sideA: { kind: 'entry', entryId: 'ENT-0001', displayName: 'MH Kabaddi' },
    sideB: { kind: 'entry', entryId: 'ENT-0002', displayName: 'HR Kabaddi' },
    byeFlag: false,
    officials: [],
    matchStatus: 'Completed (Provisional)',
    versionNo: 1,
    rescheduleHistory: [],
    ...over,
  };
}

export function result(over: Partial<Result> = {}): Result {
  return {
    resultId: 'RES-T',
    matchId: 'MCH-T',
    eventId: 'EVT-T',
    finalScore: { a: 30, b: 25 },
    winnerRef: 'ENT-0001',
    outcomeType: 'played',
    resultStatus: 'Approved',
    correctionHistory: [],
    ...over,
  };
}

export function participant(unitId: string, over: Partial<ParticipantSnapshot> = {}): ParticipantSnapshot {
  return {
    ref: { id: `TEAM-${unitId}`, displayName: `${unitId} Kabaddi`, module: 'team-management' },
    upstreamStatus: 'Approved',
    unitId,
    accreditation: { id: `ACC-${unitId}`, validUntil: '2026-12-31', zones: ['FOP'] },
    rosterRefs: Array.from({ length: 12 }, (_, i) => ({
      id: `ATH-${unitId}-${i}`,
      displayName: `Player ${i + 1}`,
      module: 'athlete-registration' as const,
    })),
    ...over,
  };
}

export function official(id: string, unitId: string, roles: string[], grade = 'A', over: Partial<OfficialSnapshot> = {}): OfficialSnapshot {
  return {
    officialId: id,
    name: `Official ${id}`,
    sports: ['kabaddi'],
    roles,
    grade,
    unitId,
    accreditation: { id: `ACCO-${id}`, validUntil: '2026-12-31' },
    ...over,
  };
}

export function venue(over: Partial<Venue> = {}): Venue {
  return {
    venueId: 'V1',
    name: 'Test Complex',
    address: 'Pune',
    fopList: [
      { fopId: 'V1-MAT-1', venueId: 'V1', type: 'mat', name: 'Mat 1' },
      { fopId: 'V1-MAT-2', venueId: 'V1', type: 'mat', name: 'Mat 2' },
    ],
    operatingHours: { open: '08:00', close: '22:00' },
    maintenanceBlocks: [],
    capacity: 2000,
    ...over,
  };
}

export const GRID = {
  dates: ['2026-03-10', '2026-03-11', '2026-03-12'],
  sessions: [
    { session: 'morning' as const, from: '09:00', to: '13:00' },
    { session: 'afternoon' as const, from: '14:00', to: '18:00' },
    { session: 'evening' as const, from: '18:30', to: '22:00' },
  ],
  turnaroundMins: 15,
  warmUpMins: 15,
};
