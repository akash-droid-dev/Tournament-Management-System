/**
 * Eligibility engine — §5.2 and business rules §7.1.
 *
 * Runs in real time as a Team Manager adds an entry, and again at every later
 * gate (§11 integration rule: "re-validates status at every gate — entry,
 * draw, check-in"). Hard failures block the entry; soft failures are advisories
 * the UI shows with a ⚠ marker.
 */

import type {
  EligibilityCheck,
  EligibilityResult,
  Entry,
  ISODate,
  Tournament,
  TournamentEvent,
  UpstreamRef,
} from '../domain/types.ts';
import { nowISO } from '../domain/ids.ts';
import { getSport } from '../sports/registry.ts';

/** The upstream facts TMS needs to judge an entry. Read by reference (§11). */
export interface ParticipantSnapshot {
  ref: UpstreamRef;
  /** Upstream status in the owning GMS module. Only 'Approved' may enter. */
  upstreamStatus: 'Approved' | 'Pending' | 'Rejected' | 'Suspended';
  dateOfBirth?: ISODate;
  gender?: 'M' | 'W' | 'Other';
  /** Declared weight at entry — confirmed at the official weigh-in (§7.1.5). */
  declaredWeightKg?: number;
  unitId: string;
  accreditation?: { id: string; validUntil: ISODate; zones: string[] };
  /** Real-time flags pushed from Athlete Registration (§11 inbound). */
  dopingFlag?: boolean;
  /** Squad for team entries. */
  rosterRefs?: UpstreamRef[];
}

export interface EligibilityContext {
  tournament: Tournament;
  event: TournamentEvent;
  participant: ParticipantSnapshot;
  /** Confirmed entries already in this event — for duplicate and quota checks. */
  existingEntries: Entry[];
  /** This participant's entries across the whole tournament — §7.1.3. */
  participantEntriesInTournament: { eventId: string; eventLabel: string }[];
  /** Events whose sessions overlap this one — drives the clash advisory. */
  overlappingEventIds?: string[];
  /** Defaults to today; tests and back-dated entries pass it explicitly. */
  asOf?: ISODate;
}

const pass = (
  rule: EligibilityCheck['rule'],
  message: string,
  severity: EligibilityCheck['severity'] = 'hard',
): EligibilityCheck => ({ rule, passed: true, severity, message });

const fail = (
  rule: EligibilityCheck['rule'],
  message: string,
  severity: EligibilityCheck['severity'] = 'hard',
): EligibilityCheck => ({ rule, passed: false, severity, message });

/**
 * Age in whole years on the category cut-off date.
 *
 * §7.1.2: "Age eligibility is computed against the tournament's category
 * cut-off date, not 'age today'." Using today's date would make the same
 * athlete eligible or not depending on when the clerk opened the screen.
 */
export function ageOnCutOff(dob: ISODate, cutOff: ISODate): number {
  const d = new Date(dob);
  const c = new Date(cutOff);
  let age = c.getUTCFullYear() - d.getUTCFullYear();
  const m = c.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && c.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

export function evaluateEligibility(ctx: EligibilityContext): EligibilityResult {
  const { tournament, event, participant } = ctx;
  const checks: EligibilityCheck[] = [];
  const asOf = ctx.asOf ?? new Date().toISOString().slice(0, 10);
  const sport = getSport(event.sport);

  // §7.1.1 — only Approved upstream records. No manual/free-text participants.
  checks.push(
    participant.upstreamStatus === 'Approved'
      ? pass('upstream-approved', `${participant.ref.displayName} is Approved in ${participant.ref.module}`)
      : fail(
          'upstream-approved',
          `${participant.ref.displayName} is ${participant.upstreamStatus} in ${participant.ref.module}; only Approved records may be entered (§7.1.1)`,
        ),
  );

  if (participant.dopingFlag) {
    checks.push(
      fail('upstream-approved', `${participant.ref.displayName} carries an open doping flag (§11 real-time eligibility alert)`),
    );
  }

  // Accreditation — §11 inbound; invalid/expired blocks attendance at check-in.
  if (!participant.accreditation) {
    checks.push(fail('accreditation-valid', 'no accreditation record found (§11 Accreditation module)'));
  } else if (participant.accreditation.validUntil < asOf) {
    checks.push(
      fail(
        'accreditation-valid',
        `accreditation ${participant.accreditation.id} expired on ${participant.accreditation.validUntil}`,
      ),
    );
  } else {
    checks.push(pass('accreditation-valid', `accreditation ${participant.accreditation.id} valid`));
  }

  // §7.1.2 — age against the cut-off date.
  const ageSpec = sport.categories.age.find((a) => a.key === event.ageCategory);
  if (participant.dateOfBirth && ageSpec) {
    const age = ageOnCutOff(participant.dateOfBirth, tournament.categoryCutOffDate);
    const tooOld = ageSpec.maxAgeYears !== undefined && age > ageSpec.maxAgeYears;
    const tooYoung = ageSpec.minAgeYears !== undefined && age < ageSpec.minAgeYears;
    checks.push(
      tooOld || tooYoung
        ? fail(
            'age-category',
            `age ${age} on cut-off ${tournament.categoryCutOffDate} is outside ${ageSpec.label}` +
              (tooOld ? ` (max ${ageSpec.maxAgeYears})` : ` (min ${ageSpec.minAgeYears})`),
          )
        : pass('age-category', `age ${age} fits ${ageSpec.label}`),
    );
  } else if (!participant.dateOfBirth && event.participationType !== 'team') {
    checks.push(fail('age-category', 'date of birth missing upstream; age cannot be verified'));
  }

  // §2.4 / §3.4 — gender vs. event category.
  if (participant.gender && event.genderCategory !== 'Mixed' && event.genderCategory !== 'Open') {
    checks.push(
      participant.gender === event.genderCategory
        ? pass('gender-category', `gender ${participant.gender} matches event category`)
        : fail(
            'gender-category',
            `gender ${participant.gender} does not match event category ${event.genderCategory}`,
          ),
    );
  }

  // §7.1.5 — weight is provisional at entry, confirmed at the weigh-in.
  const weightSpec = sport.categories.weight.find((w) => w.key === event.weightCategory);
  if (weightSpec?.maxWeightKg !== undefined) {
    if (participant.declaredWeightKg === undefined) {
      checks.push(
        fail(
          'weight-category',
          `no declared weight; ${weightSpec.label} will be confirmed at the official weigh-in`,
          'soft',
        ),
      );
    } else if (participant.declaredWeightKg > weightSpec.maxWeightKg) {
      checks.push(
        fail(
          'weight-category',
          `declared ${participant.declaredWeightKg} kg exceeds ${weightSpec.label}; provisional only — failure at weigh-in means scratch or category move (§7.1.5)`,
        ),
      );
    } else {
      checks.push(
        pass(
          'weight-category',
          `declared ${participant.declaredWeightKg} kg within ${weightSpec.label} (provisional until weigh-in)`,
          'soft',
        ),
      );
    }
  }

  // §7.1.3 — an athlete cannot appear twice in the same event.
  const live = ctx.existingEntries.filter(
    (e) => e.entryStatus !== 'Withdrawn' && e.entryStatus !== 'Scratched' && e.entryStatus !== 'Blocked',
  );
  const dup = live.find((e) => e.participantRef.id === participant.ref.id);
  checks.push(
    dup
      ? fail(
          'duplicate-entry',
          `${participant.ref.displayName} is already entered in this event as ${dup.entryId} (§7.1.3)`,
        )
      : pass('duplicate-entry', 'not already entered in this event'),
  );

  // §7.1.4 — unit quotas are hard limits; Tournament Admin override only.
  const quota = event.maxEntriesPerUnit || tournament.maxEntriesPerUnit;
  const fromUnit = live.filter((e) => e.unitId === participant.unitId).length;
  checks.push(
    fromUnit >= quota
      ? fail(
          'unit-quota',
          `unit ${participant.unitId} already has ${fromUnit} of ${quota} permitted entries in this event; only Tournament Admin may override, with a reason (§7.1.4)`,
        )
      : pass('unit-quota', `unit ${participant.unitId} has ${fromUnit} of ${quota} entries`),
  );

  // §7.1.3 — configurable cross-event participation limit.
  const otherEvents = ctx.participantEntriesInTournament.filter((e) => e.eventId !== event.eventId);
  checks.push(
    otherEvents.length >= tournament.maxEventsPerAthlete
      ? fail(
          'max-events-per-athlete',
          `already entered in ${otherEvents.length} event(s); tournament limit is ${tournament.maxEventsPerAthlete} (§7.1.3)`,
        )
      : pass(
          'max-events-per-athlete',
          `${otherEvents.length} of ${tournament.maxEventsPerAthlete} permitted events used`,
        ),
  );

  // §3.4 / §5.2 — cross-event clash is an advisory, never a block.
  const clash = otherEvents.filter((e) => ctx.overlappingEventIds?.includes(e.eventId));
  if (clash.length) {
    checks.push(
      fail(
        'cross-event-clash',
        `overlaps ${clash.map((c) => c.eventLabel).join(', ')} — check the session grid before confirming`,
        'soft',
      ),
    );
  }

  // Squad size for team entries — Kabaddi needs 7 on the mat out of 12.
  if (event.participationType === 'team') {
    const n = participant.rosterRefs?.length ?? 0;
    const { min, max } = sport.roster;
    checks.push(
      n < min || n > max
        ? fail(
            'roster-size',
            `squad of ${n} is outside the permitted ${min}–${max} for ${sport.name}`,
            n < min ? 'hard' : 'soft',
          )
        : pass('roster-size', `squad of ${n} within ${min}–${max}`),
    );
  }

  return {
    eligible: !checks.some((c) => !c.passed && c.severity === 'hard'),
    checks,
    evaluatedAt: nowISO(),
  };
}

/** Hard failures only — what the §12.4 override queue lists. */
export function hardFailures(r: EligibilityResult): EligibilityCheck[] {
  return r.checks.filter((c) => !c.passed && c.severity === 'hard');
}

/** Soft advisories — shown with ⚠ but never blocking. */
export function advisories(r: EligibilityResult): EligibilityCheck[] {
  return r.checks.filter((c) => !c.passed && c.severity === 'soft');
}

/**
 * §7.1.5 — official weigh-in. A failure is a scratch or a category move per
 * sport rule, decided by the Competition Manager, never silently accepted.
 */
export function weighIn(
  entry: Entry,
  actualWeightKg: number,
  limitKg: number | undefined,
): { passed: boolean; message: string; action: 'none' | 'scratch-or-move' } {
  if (limitKg === undefined) {
    return { passed: true, message: 'event has no weight limit', action: 'none' };
  }
  if (actualWeightKg <= limitKg) {
    return { passed: true, message: `${actualWeightKg} kg within ${limitKg} kg`, action: 'none' };
  }
  return {
    passed: false,
    message: `${entry.participantRef.displayName} weighed ${actualWeightKg} kg against a ${limitKg} kg limit — scratch or category move required (§7.1.5)`,
    action: 'scratch-or-move',
  };
}
