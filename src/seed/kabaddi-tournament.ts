/**
 * Demo seed: a National Kabaddi Championship driven through all ten phases.
 *
 * The point is not the data but the path: the seeder calls the same service
 * methods the UI and API call, in the order §4 prescribes, so running it proves
 * the whole lifecycle actually connects — configuration, entries with real
 * eligibility failures, an approved format, a reproducible draw, a
 * conflict-free schedule, officials with neutrality enforced, live Kabaddi
 * scoring, the maker–checker result chain, standings, progression and medals.
 *
 * Two events are seeded at different stages on purpose: Senior Men runs to
 * completion with medals published, Senior Women stops mid-competition, so
 * every screen has something meaningful to show.
 */

import type { AttendanceRecord, Role, User, Venue } from '../domain/types.ts';
import { resetSeq } from '../domain/ids.ts';
import type { ParticipantSnapshot } from '../engines/eligibility.ts';
import type { OfficialSnapshot } from '../engines/officials.ts';
import { KABADDI_EVENTS, kabaddi } from '../sports/index.ts';
import type { TmsStore } from '../store/db.ts';
import { TmsService } from '../api/service.ts';

/** Units taking part, with a readable team name for each. */
const UNITS: { id: string; name: string }[] = [
  { id: 'MH', name: 'Maharashtra' },
  { id: 'HR', name: 'Haryana' },
  { id: 'PB', name: 'Punjab' },
  { id: 'UP', name: 'Uttar Pradesh' },
  { id: 'RJ', name: 'Rajasthan' },
  { id: 'TN', name: 'Tamil Nadu' },
  { id: 'KA', name: 'Karnataka' },
  { id: 'DL', name: 'Delhi' },
  { id: 'GJ', name: 'Gujarat' },
  { id: 'KL', name: 'Kerala' },
];

/**
 * Units that enter only the women's event, and only to produce the two
 * deliberate eligibility failures the demo needs.
 */
const EXTRA_UNITS: { id: string; name: string }[] = [
  { id: 'WB', name: 'West Bengal' },
  { id: 'OD', name: 'Odisha' },
];

const START = '2026-03-10';
const END = '2026-03-14';
const CUT_OFF = '2026-01-01';

function user(userId: string, name: string, role: Role, scope: User['scope'] = {}): User {
  return { userId, name, role, scope };
}

/** A 12-player squad; Kabaddi fields 7 with 5 substitutes. */
function squad(unitId: string, gender: 'M' | 'W', tournamentId: string, store: TmsStore): ParticipantSnapshot[] {
  const first = gender === 'M'
    ? ['Arjun', 'Rohit', 'Vikas', 'Sunil', 'Manoj', 'Deepak', 'Ajay', 'Ravi', 'Naveen', 'Sachin', 'Pardeep', 'Girish']
    : ['Priya', 'Kavita', 'Sunita', 'Anjali', 'Ritu', 'Nisha', 'Pooja', 'Meena', 'Shalu', 'Jyoti', 'Rekha', 'Sonia'];
  const out: ParticipantSnapshot[] = [];
  first.forEach((fn, i) => {
    const p: ParticipantSnapshot = {
      ref: {
        id: `ATH-${unitId}-${gender}-${String(i + 1).padStart(2, '0')}`,
        displayName: `${fn} (${unitId})`,
        module: 'athlete-registration',
      },
      upstreamStatus: 'Approved',
      // Comfortably senior-eligible; one deliberate failure is injected below.
      dateOfBirth: `${1999 + (i % 5)}-0${(i % 9) + 1}-1${i % 9}`,
      gender,
      declaredWeightKg: gender === 'M' ? 72 + (i % 10) : 62 + (i % 9),
      unitId,
      accreditation: { id: `ACC-${unitId}-${gender}${i + 1}`, validUntil: '2026-12-31', zones: ['FOP', 'WARMUP'] },
    };
    store.saveParticipant(tournamentId, p);
    out.push(p);
  });
  return out;
}

export interface SeedResult {
  tournamentId: string;
  menEventId: string;
  womenEventId: string;
  users: User[];
  notes: string[];
}

export function seedKabaddiTournament(store: TmsStore): SeedResult {
  resetSeq();
  const notes: string[] = [];
  const service = new TmsService(store);

  // ── Users, one per role, plus per-unit Team Managers ────────────────────
  const superAdmin = user('sa1', 'S. Menon', 'Super Admin');
  const admin = user('ta1', 'R. Kulkarni', 'Tournament Admin');
  const admin2 = user('ta2', 'A. Bhatt', 'Tournament Admin');
  const compMgr = user('cm1', 'P. Shinde', 'Competition Manager', { sportIds: ['kabaddi'] });
  const venueMgr = user('vm1', 'D. Pawar', 'Venue Manager', { venueIds: ['V1'] });
  const techOff = user('to1', 'K. Subramanian', 'Technical Official');
  const techOff2 = user('to2', 'B. Chauhan', 'Technical Official');
  const referee = user('rf1', 'M. Gaikwad', 'Referee');
  const scorer = user('sc1', 'N. Joshi', 'Scorer');
  const jury = user('ju1', 'V. Rathore', 'Jury of Appeal');
  const viewer = user('vw1', 'Public / Media', 'Viewer');
  const teamManagers = [...UNITS, ...EXTRA_UNITS].map((u) =>
    user(`tm-${u.id.toLowerCase()}`, `${u.name} Team Manager`, 'Team Manager', { unitId: u.id }),
  );
  const users = [superAdmin, admin, admin2, compMgr, venueMgr, techOff, techOff2, referee, scorer, jury, viewer, ...teamManagers];
  for (const u of users) store.saveUser(u);

  // ── Phase 1: tournament creation ────────────────────────────────────────
  const tournament = service.createTournament(admin, {
    code: 'NKC-2026',
    name: 'National Kabaddi Championship 2026',
    organizingBody: 'Amateur Kabaddi Federation of India',
    level: 'national',
    season: '2026',
    startDate: START,
    endDate: END,
    hostCity: 'Pune',
    venues: [],
    ageCategories: ['SENIOR'],
    genderCategories: ['M', 'W'],
    participatingUnits: [...UNITS, ...EXTRA_UNITS].map((u) => u.id),
    entryDeadline: '2026-02-20',
    withdrawalDeadline: '2026-02-25',
    protestWindowMins: 30,
    protestFee: 5000,
    approvalChainType: '2-step',
    categoryCutOffDate: CUT_OFF,
    maxEventsPerAthlete: 1,
    minEntriesToRun: 4,
    maxEntriesPerUnit: 1,
    autoPublishResults: false,
    enforceOfficialNeutrality: true,
  });
  const tid = tournament.tournamentId;

  // Scope the tournament-specific roles now that the ID exists.
  for (const u of [admin, admin2, compMgr, venueMgr, techOff, techOff2, referee, scorer, jury, ...teamManagers]) {
    const scoped: User = { ...u, scope: { ...u.scope, tournamentIds: [tid] } };
    store.saveUser(scoped);
    Object.assign(u, scoped);
  }

  // ── Venue inventory (§6.1) — Kabaddi plays on mats ──────────────────────
  const venue: Venue = {
    venueId: 'V1',
    name: 'Shree Shiv Chhatrapati Sports Complex',
    address: 'Balewadi, Pune',
    fopList: [
      { fopId: 'V1-MAT-1', venueId: 'V1', type: kabaddi.fopType, name: 'Mat 1 (Main)' },
      { fopId: 'V1-MAT-2', venueId: 'V1', type: kabaddi.fopType, name: 'Mat 2' },
      { fopId: 'V1-MAT-3', venueId: 'V1', type: kabaddi.fopType, name: 'Mat 3' },
    ],
    operatingHours: { open: '08:00', close: '22:00' },
    maintenanceBlocks: [
      { fopId: 'V1-MAT-3', date: '2026-03-11', from: '13:00', to: '14:30', reason: 'Mat resurfacing' },
    ],
    capacity: 4000,
  };
  store.saveVenue(tid, venue);
  store.saveTournament({ ...tournament, venues: [{ id: 'V1', displayName: venue.name, module: 'venue' }] });

  // ── Officials pool (§11 inbound) ────────────────────────────────────────
  //
  // A three-mat national championship needs a large panel: the Kabaddi
  // template's full panel is eight seats per fixture, and §6.6 caps an
  // official at four matches a day. A token pool would simply leave fixtures
  // unstaffed, so the seed deploys a realistic complement drawn from units
  // that are not themselves competing wherever possible, which also lets the
  // §7.3.13 neutrality rule bind without starving the board.
  const OFFICIAL_UNITS = [
    'AS', 'BR', 'CG', 'GA', 'HP', 'JH', 'JK', 'MP', 'MN', 'ML', 'MZ', 'NL',
    'OD', 'PY', 'SK', 'TR', 'TS', 'UK', 'WB', 'AP', 'AN', 'CH', 'DN', 'LD',
  ];
  const SURNAMES = [
    'Deshmukh', 'Gowda', 'Sandhu', 'Iyer', 'Meena', 'Nair', 'Yadav', 'Barman',
    'Patel', 'Das', 'Reddy', 'Khan', 'Lakra', 'Bora', 'Thapa', 'Sarma',
    'Kashyap', 'Bhosale', 'Naik', 'Tomar', 'Chetri', 'Mahato', 'Rathi', 'Pillai',
  ];
  const INITIALS = 'ABCDEFGHJKLMNPRSTUVY';

  /** Certification mix: enough A-grade referees and commissioners to staff every mat. */
  const ROLE_SETS: { roles: string[]; grade: string }[] = [
    { roles: ['Referee', 'Umpire', 'Match Commissioner'], grade: 'A' },
    { roles: ['Referee', 'Umpire'], grade: 'A' },
    { roles: ['Umpire', 'Scorer', 'Assistant Scorer'], grade: 'B' },
    { roles: ['Umpire', 'Assistant Scorer', 'Time Keeper'], grade: 'B' },
    { roles: ['Scorer', 'Assistant Scorer', 'Time Keeper'], grade: 'C' },
    { roles: ['Assistant Scorer', 'Time Keeper'], grade: 'C' },
  ];

  const officials: OfficialSnapshot[] = [];
  for (let i = 0; i < 72; i++) {
    const set = ROLE_SETS[i % ROLE_SETS.length] as { roles: string[]; grade: string };
    const unitId = OFFICIAL_UNITS[i % OFFICIAL_UNITS.length] as string;
    officials.push({
      officialId: `OF-${String(i + 1).padStart(2, '0')}`,
      name: `${INITIALS[i % INITIALS.length]}. ${SURNAMES[i % SURNAMES.length]}`,
      sports: ['kabaddi'],
      roles: set.roles,
      grade: set.grade,
      unitId,
      accreditation: { id: `ACCO-${String(i + 1).padStart(2, '0')}`, validUntil: '2026-12-31' },
      maxMatchesPerDay: 4,
    });
  }
  // Two members are deliberately unusable, so the assignment board shows real
  // rejections rather than a board where everything always succeeds.
  officials.push(
    {
      officialId: 'OF-73',
      name: 'V. Kumar (volleyball only)',
      sports: ['volleyball'],
      roles: ['Referee'],
      grade: 'A',
      unitId: 'AP',
      accreditation: { id: 'ACCO-73', validUntil: '2026-12-31' },
    },
    {
      officialId: 'OF-74',
      name: 'O. Singh (accreditation lapsed)',
      sports: ['kabaddi'],
      roles: ['Referee', 'Umpire'],
      grade: 'A',
      unitId: 'BR',
      accreditation: { id: 'ACCO-74', validUntil: '2025-06-30' },
    },
  );

  for (const o of officials) store.saveOfficial(tid, o);
  // Officials also need TMS logins: the referee's signature on a match report
  // must come from the official actually on duty for that fixture (§7.7), so
  // every pool member gets a user whose ID matches their official ID.
  for (const o of officials) {
    const role: Role = o.roles.includes('Match Commissioner')
      ? 'Technical Official'
      : o.roles.includes('Referee')
        ? 'Referee'
        : 'Scorer';
    store.saveUser(user(o.officialId, o.name, role, { tournamentIds: [tid] }));
  }
  notes.push(
    `Officials pool holds ${officials.length} (${officials.filter((o) => o.roles.includes('Referee')).length} certified referees). Two are deliberately unusable — wrong sport and lapsed accreditation — so the assignment board shows real rejections.`,
  );

  service.activateTournament(admin, tid);

  // ── Phase 2: events ─────────────────────────────────────────────────────
  const men = service.addEvent(compMgr, tid, {
    sport: 'kabaddi',
    discipline: 'Team Kabaddi',
    participationType: 'team',
    ageCategory: 'SENIOR',
    genderCategory: 'M',
    weightCategory: 'SM-85',
    scoringTemplateId: 'kabaddi',
    maxEntriesPerUnit: 1,
    minEntriesToRun: 4,
    seedingSource: 'previous-ranking',
    medalRule: kabaddi.medalRuleDefault,
  });
  const women = service.addEvent(compMgr, tid, {
    sport: 'kabaddi',
    discipline: 'Team Kabaddi',
    participationType: 'team',
    ageCategory: 'SENIOR',
    genderCategory: 'W',
    weightCategory: 'SW-75',
    scoringTemplateId: 'kabaddi',
    maxEntriesPerUnit: 1,
    minEntriesToRun: 4,
    seedingSource: 'previous-ranking',
    medalRule: kabaddi.medalRuleDefault,
  });
  service.confirmEvent(admin, men.eventId);
  service.confirmEvent(admin, women.eventId);

  // ── Phase 3: entries ────────────────────────────────────────────────────
  service.setTournamentStatus(admin, tid, 'Entries Open');

  /** Register a unit's team and its squad, then enter it. */
  const enterTeam = (
    eventId: string,
    unit: { id: string; name: string },
    gender: 'M' | 'W',
    seedNo: number | undefined,
    tweak?: (p: ParticipantSnapshot) => ParticipantSnapshot,
  ) => {
    const roster = squad(unit.id, gender, tid, store);
    let team: ParticipantSnapshot = {
      ref: {
        id: `TEAM-${unit.id}-${gender}`,
        displayName: `${unit.name} ${gender === 'M' ? 'Men' : 'Women'}`,
        module: 'team-management',
      },
      upstreamStatus: 'Approved',
      unitId: unit.id,
      accreditation: { id: `ACCT-${unit.id}-${gender}`, validUntil: '2026-12-31', zones: ['FOP'] },
      rosterRefs: roster.map((r) => r.ref),
    };
    if (tweak) team = tweak(team);
    store.saveParticipant(tid, team);
    const tm = teamManagers.find((t) => t.scope.unitId === unit.id);
    if (!tm) throw new Error(`no Team Manager seeded for unit ${unit.id}`);
    return service.addEntry(tm, eventId, { participantId: team.ref.id, seedNo });
  };

  // Men: ten units, top four seeded from the previous ranking.
  UNITS.forEach((u, i) => enterTeam(men.eventId, u, 'M', i < 4 ? i + 1 : undefined));

  // Women: eight units, plus two deliberate eligibility failures so the
  // override queue and the blocked-entry path are populated in the demo.
  const womenUnits = UNITS.slice(0, 8);
  womenUnits.forEach((u, i) => enterTeam(women.eventId, u, 'W', i < 4 ? i + 1 : undefined));

  const shortSquad = enterTeam(women.eventId, EXTRA_UNITS[0] as { id: string; name: string }, 'W', undefined, (p) => ({
    ...p,
    // Six players: below the seven Kabaddi requires on the mat.
    rosterRefs: p.rosterRefs?.slice(0, 6),
  }));
  const notAccredited = enterTeam(women.eventId, EXTRA_UNITS[1] as { id: string; name: string }, 'W', undefined, (p) => ({
    ...p,
    accreditation: { id: 'ACCT-OD-W', validUntil: '2025-12-31', zones: ['FOP'] },
  }));
  notes.push(
    `Women's event carries two blocked entries by design: ${shortSquad.entryId} (squad of 6 against a minimum of ${kabaddi.roster.min}) and ${notAccredited.entryId} (accreditation expired) — both sit in the Tournament Admin's override queue.`,
  );

  // Confirm every entry that passed; the two blocked ones stay for the demo.
  for (const eventId of [men.eventId, women.eventId]) {
    for (const e of store.listEntries(eventId)) {
      if (e.entryStatus === 'Submitted') service.confirmEntry(admin, e.entryId);
    }
  }
  // One override, so the audit trail shows the reason-coded path being used.
  service.overrideEntry(admin, notAccredited.entryId, 'LATE_ENTRY: accreditation renewed on arrival, verified against passport at the desk');

  service.setTournamentStatus(admin, tid, 'Entries Locked');

  // ── Phase 4: format ─────────────────────────────────────────────────────
  // Men: two groups of five, top two into the semi-finals.
  service.setFormat(compMgr, men.eventId, {
    type: 'group-knockout',
    groupCount: 2,
    teamsPerGroup: 5,
    matchesPerPairing: 1,
    progressionRules: [{ fromGroupId: '*', positions: [1, 2], toStage: 'SF', seedApart: true }],
    matchParams: { ...kabaddi.matchDefaults },
  });
  service.approveFormat(admin, men.eventId);

  // Women: a straight knockout, to exercise byes and the bracket path.
  service.setFormat(compMgr, women.eventId, {
    type: 'knockout',
    groupCount: 1,
    teamsPerGroup: 0,
    matchesPerPairing: 1,
    progressionRules: [],
    matchParams: { ...kabaddi.matchDefaults, ...kabaddi.presets['knockout-golden-raid'] },
  });
  service.approveFormat(admin, women.eventId);

  // ── Phase 5: draws ──────────────────────────────────────────────────────
  // Fixed seeds so the demo is byte-for-byte reproducible (§7.2.9).
  service.generateDraw(compMgr, men.eventId, {
    seedCount: 4,
    separationRule: 'same-unit-apart-r1',
    byePolicy: 'top-seeds',
    rngSeed: `${men.eventId}:NKC2026-MEN-DRAW`,
  });
  service.publishDraw(admin, men.eventId);

  service.generateDraw(compMgr, women.eventId, {
    seedCount: 4,
    separationRule: 'same-unit-apart-r1',
    byePolicy: 'top-seeds',
    rngSeed: `${women.eventId}:NKC2026-WOMEN-DRAW`,
  });
  service.publishDraw(admin, women.eventId);

  // ── Phase 6: schedule and officials ─────────────────────────────────────
  for (const eventId of [men.eventId, women.eventId]) {
    const ev = store.getEvent(eventId);
    const finalNo = store.listMatches(eventId).find((m) => m.stage === 'F')?.matchNo;
    const sched = service.autoSchedule(compMgr, eventId, finalNo ? [finalNo] : undefined);
    if (sched.conflicts.soft.length) {
      // §7.2.11 — soft conflicts must be acknowledged explicitly, not ignored.
      service.acknowledgeSoftConflicts(admin, eventId, [...new Set(sched.conflicts.soft.map((c) => c.code))]);
      notes.push(
        `${ev?.genderCategory === 'M' ? "Men's" : "Women's"} schedule carried ${sched.conflicts.soft.length} soft conflict(s), acknowledged by the Tournament Admin before publishing.`,
      );
    }
    if (sched.unplaced.length) {
      notes.push(`${sched.unplaced.length} fixture(s) could not be placed automatically: ${sched.unplaced.map((u) => `${u.matchNo} (${u.reason})`).join('; ')}`);
    }
    for (const m of store.listMatches(eventId)) {
      if (!m.byeFlag && m.scheduledDate) service.assignOfficials(compMgr, m.matchId);
    }
    service.publishSchedule(admin, eventId);
  }

  const unfilled = store
    .listMatchesForTournament(tid)
    .filter((m) => !m.byeFlag)
    .map((m) => ({ m, panel: store.listAssignments(m.matchId).length }))
    .filter((x) => x.panel === 0).length;
  if (unfilled) notes.push(`${unfilled} fixture(s) have no officials assigned — the pool is exhausted at that time.`);

  // ── Phase 7 & 8: play the men's event out ───────────────────────────────
  /**
   * Play one match with plausible Kabaddi scoring, then run it through the full
   * result chain. The scoreline is driven by a per-team strength so results are
   * deterministic but not uniform.
   */
  const strength: Record<string, number> = {
    MH: 9, HR: 9, PB: 8, UP: 7, RJ: 6, TN: 6, KA: 7, DL: 5, GJ: 5, KL: 4, WB: 4, OD: 3,
  };

  const playMatch = (matchId: string, opts: { protest?: boolean; walkover?: boolean } = {}): void => {
    const m = store.getMatch(matchId);
    if (!m || m.byeFlag || m.sideA.kind !== 'entry' || m.sideB.kind !== 'entry') return;
    if (store.getResultForMatch(matchId)?.resultStatus === 'Approved') return;

    const unitOf = (entryId: string) => store.getEntry(entryId)?.unitId ?? '';
    const ua = unitOf(m.sideA.entryId);
    const ub = unitOf(m.sideB.entryId);

    if (opts.walkover) {
      service.applyException(techOff, matchId, 'walkover', {
        winningSide: 'A',
        reasonCode: 'CONCEDED',
        detail: `${m.sideB.displayName} conceded before the start; squad below the minimum after two withdrawals.`,
      });
      const r = store.getResultForMatch(matchId);
      if (r) {
        service.verifyResult(techOff2, matchId);
        service.approveResult(admin, matchId, 'WALKOVER_NO_PROTEST_WINDOW');
      }
      return;
    }

    service.openConsole(scorer, matchId);
    const attendance: AttendanceRecord[] = (['A', 'B'] as const).flatMap((side) => {
      const entryId = (side === 'A' ? m.sideA : m.sideB) as { entryId: string };
      const entry = store.getEntry(entryId.entryId);
      return (entry?.rosterRefs ?? []).slice(0, kabaddi.roster.max).map((r, i) => ({
        participantId: r.id,
        participantName: r.displayName,
        side,
        present: true,
        checkinTime: new Date().toISOString(),
        accreditationValid: true,
        startingLineup: i < kabaddi.roster.onField,
      }));
    });
    service.recordAttendance(scorer, matchId, attendance);
    service.recordToss(referee, matchId, 'A', 'raid');
    service.startMatch(referee, matchId);

    // Simulate the match: alternating raids, outcome weighted by strength.
    const sa = strength[ua] ?? 5;
    const sb = strength[ub] ?? 5;
    let clock = 0;
    let rng = [...`${m.matchNo}${ua}${ub}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) % 1000) / 1000;

    for (let raid = 0; raid < 44 && clock < 2400; raid++) {
      clock += 45 + Math.floor(rand() * 15);
      const console_ = service.matchConsole(scorer, matchId);
      const state = console_.state as { raidingSide: 'A' | 'B'; A: { onCourt: number }; B: { onCourt: number } };
      const raiding = state.raidingSide;
      const defending = raiding === 'A' ? 'B' : 'A';
      const attackerStrength = raiding === 'A' ? sa : sb;
      const defenderStrength = raiding === 'A' ? sb : sa;
      const roll = rand() * (attackerStrength + defenderStrength);

      try {
        if (roll < attackerStrength * 0.42) {
          const defendersOn = defending === 'A' ? state.A.onCourt : state.B.onCourt;
          const touched = Math.min(defendersOn, rand() < 0.12 ? 2 : 1);
          service.recordScore(scorer, matchId, { type: KABADDI_EVENTS.RAID_TOUCH, side: raiding, value: touched, clockSecs: clock });
        } else if (roll < attackerStrength * 0.62) {
          const defendersOn = defending === 'A' ? state.A.onCourt : state.B.onCourt;
          if (defendersOn >= 6) {
            service.recordScore(scorer, matchId, { type: KABADDI_EVENTS.RAID_BONUS, side: raiding, clockSecs: clock });
          } else {
            service.recordScore(scorer, matchId, { type: KABADDI_EVENTS.RAID_EMPTY, side: raiding, clockSecs: clock });
          }
        } else if (roll < attackerStrength + defenderStrength * 0.55) {
          service.recordScore(scorer, matchId, { type: KABADDI_EVENTS.TACKLE, side: defending, clockSecs: clock });
        } else {
          service.recordScore(scorer, matchId, { type: KABADDI_EVENTS.RAID_EMPTY, side: raiding, clockSecs: clock });
        }
      } catch {
        // A rejected event means the simulated action was illegal in this
        // state; record an empty raid instead and carry on.
        try {
          service.recordScore(scorer, matchId, { type: KABADDI_EVENTS.RAID_EMPTY, side: raiding, clockSecs: clock });
        } catch {
          break;
        }
      }
      // Half-time.
      if (raid === 21) {
        service.recordScore(scorer, matchId, { type: KABADDI_EVENTS.PERIOD_END, side: 'A', clockSecs: clock });
      }
    }

    service.endMatch(referee, matchId);
    // §7.7 — the match report is signed by the referee on duty for this
    // fixture, not by whichever referee happens to be logged in.
    const onDuty = store
      .listAssignments(matchId)
      .find((a) => a.role === 'Referee' && a.status !== 'replaced');
    const signer = onDuty ? store.getUser(onDuty.officialId) : undefined;
    if (signer) service.refereeSignoff(signer, matchId);
    else notes.push(`${m.matchNo} has no referee on duty, so its match report is unsigned (§7.7).`);
    service.enterResult(scorer, matchId, {});
    service.verifyResult(techOff, matchId);

    if (opts.protest) {
      // Leave one match Under Protest so the register and the frozen bracket
      // path are both visible in the demo.
      const loser = store.getResultForMatch(matchId);
      const losingEntry = loser?.winnerRef === (m.sideA as { entryId: string }).entryId ? m.sideB : m.sideA;
      const unit = store.getEntry((losingEntry as { entryId: string }).entryId)?.unitId;
      const tm = teamManagers.find((t) => t.scope.unitId === unit);
      if (tm) {
        service.fileProtest(tm, matchId, {
          grounds: 'Substitution made after the two-minute suspension had expired; point awarded in the 34th minute should be reversed.',
          feePaid: 5000,
        });
      }
      return;
    }

    // Approving inside the protest window is refused, so the demo records the
    // documented override reason rather than waiting 30 real minutes.
    service.approveResult(admin, matchId, 'DEMO_SEED_PROTEST_WINDOW_WAIVED');
    // This tournament publishes as a separate explicit act (design principle
    // 3), so an approved result still needs publishing before the public
    // portal, the daily bulletin and the medal tally can show it.
    service.publishResult(admin, matchId);
  };

  const menMatches = store.listMatches(men.eventId);
  const groupMatches = menMatches.filter((m) => m.stage === 'group');
  // One walkover in the group stage, one protest, the rest played out.
  groupMatches.forEach((m, i) => {
    playMatch(m.matchId, { walkover: i === 3 });
  });
  service.recomputeEvent(men.eventId);

  // Semi-finals and final, once the group placeholders have resolved.
  for (const stage of ['SF', 'F'] as const) {
    for (const m of store.listMatches(men.eventId).filter((x) => x.stage === stage)) {
      const fresh = store.getMatch(m.matchId);
      if (fresh?.sideA.kind === 'entry' && fresh.sideB.kind === 'entry') {
        playMatch(m.matchId);
        service.recomputeEvent(men.eventId);
      }
    }
  }

  // ── Phase 9: medals for the men's event ─────────────────────────────────
  const menMedals = service.generateMedals(compMgr, men.eventId);
  if (menMedals.ok) {
    service.publishMedals(admin, men.eventId, techOff.userId);
    notes.push(
      `Men's medals published: ${menMedals.rows.filter((r) => r.medal !== 'none').map((r) => `${r.medal} ${r.participantName}`).join(', ')} (joint bronze, per the Kabaddi template).`,
    );
  } else {
    notes.push(`Men's medals held back: ${menMedals.blockers.join('; ')}`);
  }

  // ── Women's event: stop part-way, with a live protest ───────────────────
  const womenMatches = store.listMatches(women.eventId).filter((m) => !m.byeFlag);
  womenMatches.slice(0, 2).forEach((m) => playMatch(m.matchId));
  if (womenMatches[2]) playMatch(womenMatches[2].matchId, { protest: true });
  service.recomputeEvent(women.eventId);
  notes.push(
    "Women's event is deliberately mid-competition: early fixtures approved, one result Under Protest freezing its bracket path, later rounds still awaiting their feeders.",
  );

  store.saveTournament({ ...(store.getTournament(tid) as NonNullable<ReturnType<TmsStore['getTournament']>>), status: 'Active' });

  return { tournamentId: tid, menEventId: men.eventId, womenEventId: women.eventId, users, notes };
}
