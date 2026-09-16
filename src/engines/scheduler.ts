/**
 * Scheduling engine — §5.4, §6.3–6.4 and business rules §7.2.11–12.
 *
 * The distinction the document draws is the one this module is built around:
 * HARD constraints block publishing, SOFT preferences only warn and must be
 * explicitly acknowledged (§7.2.11). `detectConflicts` is the single source of
 * truth for both, so the Scheduling Board badges, the conflict report and the
 * publish gate can never disagree.
 */

import type {
  ISODate,
  ISOTime,
  Match,
  OfficialAssignment,
  Venue,
} from '../domain/types.ts';
import { getSport } from '../sports/registry.ts';

export type Session = 'morning' | 'afternoon' | 'evening';

export interface SessionBlock {
  session: Session;
  from: ISOTime;
  to: ISOTime;
}

/** §6.2 "Build time grid: session blocks, match duration + buffer, warm-up". */
export interface TimeGrid {
  dates: ISODate[];
  sessions: SessionBlock[];
  /** Turnaround between two fixtures on the same mat. */
  turnaroundMins: number;
  /** Warm-up window reserved before a fixture starts. */
  warmUpMins: number;
}

export interface Slot {
  date: ISODate;
  fopId: string;
  venueId: string;
  session: Session;
  startMins: number;
  endMins: number;
}

export interface SchedulingContext {
  matches: Match[];
  venues: Venue[];
  grid: TimeGrid;
  /** Entry ID → unit, for the venue-hopping preference. */
  entryUnits: Record<string, string>;
  sportId: string;
  /** Existing official assignments, for double-booking checks. */
  assignments?: OfficialAssignment[];
  /** Matches that should land in prime evening slots — finals, broadcast picks. */
  primeMatchNos?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Time helpers
// ─────────────────────────────────────────────────────────────────────────────

export function toMins(t: ISOTime): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function toTime(mins: number): ISOTime {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Absolute minute across the tournament, so cross-day gaps compute correctly. */
function absolute(date: ISODate, mins: number): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 60000) + mins;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Real entry IDs on a match. Placeholder sides constrain nothing yet. */
function participantsOf(m: Match): string[] {
  return [m.sideA, m.sideB].filter((s) => s.kind === 'entry').map((s) => s.entryId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict detection
// ─────────────────────────────────────────────────────────────────────────────

export interface Conflict {
  severity: 'hard' | 'soft';
  code:
    | 'FOP_DOUBLE_BOOKED'
    | 'PARTICIPANT_OVERLAP'
    | 'OFFICIAL_OVERLAP'
    | 'ROUND_ORDER'
    | 'OUTSIDE_OPERATING_HOURS'
    | 'MAINTENANCE_BLOCK'
    | 'UNSCHEDULED'
    | 'REST_GAP_SHORT'
    | 'TWO_EVENTS_SAME_SESSION'
    | 'OFFICIAL_TRAVEL_BUFFER'
    | 'VENUE_HOPPING';
  message: string;
  matchNos: string[];
}

export interface ConflictReport {
  hard: Conflict[];
  soft: Conflict[];
  /** §7.2.11 — hard conflicts block publishing. */
  publishable: boolean;
}

/**
 * Evaluate every scheduling constraint in §6.4 and §5.4 over the current plan.
 *
 * Hard (block publish): FOP double-booked, participant in overlapping matches,
 * official double-booked, round order violated, slot outside operating hours or
 * inside a maintenance block, or a playable fixture left unscheduled.
 *
 * Soft (acknowledge): rest gap below the sport's recommendation, a side in two
 * events in one session, an official without a travel buffer between venues,
 * and a unit made to hop venues within a day.
 */
export function detectConflicts(ctx: SchedulingContext): ConflictReport {
  const hard: Conflict[] = [];
  const soft: Conflict[] = [];
  const sport = getSport(ctx.sportId);

  // A bye is awarded without play, so it is never scheduled.
  const playable = ctx.matches.filter((m) => !m.byeFlag);
  const scheduled = playable.filter((m) => m.scheduledDate && m.scheduledTime && m.fopId);

  const span = (m: Match) => {
    const start = absolute(m.scheduledDate as ISODate, toMins(m.scheduledTime as ISOTime));
    return { start, end: start + (m.durationMins ?? sport.matchDefaults.durationMins) };
  };

  for (const m of playable) {
    if (!m.scheduledDate || !m.scheduledTime || !m.fopId) {
      hard.push({
        severity: 'hard',
        code: 'UNSCHEDULED',
        message: `${m.matchNo} has no date, time or field of play assigned`,
        matchNos: [m.matchNo],
      });
    }
  }

  // Same field of play double-booked (§6.4 hard block).
  for (let i = 0; i < scheduled.length; i++) {
    for (let j = i + 1; j < scheduled.length; j++) {
      const a = scheduled[i] as Match;
      const b = scheduled[j] as Match;
      if (a.fopId !== b.fopId) continue;
      const sa = span(a);
      const sb = span(b);
      if (overlaps(sa.start, sa.end, sb.start, sb.end)) {
        hard.push({
          severity: 'hard',
          code: 'FOP_DOUBLE_BOOKED',
          message: `${a.fopId} is double-booked: ${a.matchNo} (${a.scheduledTime}) overlaps ${b.matchNo} (${b.scheduledTime}) on ${a.scheduledDate}`,
          matchNos: [a.matchNo, b.matchNo],
        });
      }
    }
  }

  // Same side in overlapping matches (hard), and rest gap (soft).
  const byEntry = new Map<string, Match[]>();
  for (const m of scheduled) {
    for (const p of participantsOf(m)) byEntry.set(p, [...(byEntry.get(p) ?? []), m]);
  }
  for (const [entryId, ms] of byEntry) {
    const sorted = [...ms].sort((x, y) => span(x).start - span(y).start);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i] as Match;
      const b = sorted[i + 1] as Match;
      const sa = span(a);
      const sb = span(b);
      if (overlaps(sa.start, sa.end, sb.start, sb.end)) {
        hard.push({
          severity: 'hard',
          code: 'PARTICIPANT_OVERLAP',
          message: `${entryId} is in two overlapping fixtures: ${a.matchNo} and ${b.matchNo}`,
          matchNos: [a.matchNo, b.matchNo],
        });
        continue;
      }
      const gap = sb.start - sa.end;
      if (gap < sport.restGap.hardMins) {
        hard.push({
          severity: 'hard',
          code: 'REST_GAP_SHORT',
          message: `${entryId} gets only ${gap} min between ${a.matchNo} and ${b.matchNo}; the sport's hard minimum is ${sport.restGap.hardMins} min`,
          matchNos: [a.matchNo, b.matchNo],
        });
      } else if (gap < sport.restGap.recommendedMins) {
        soft.push({
          severity: 'soft',
          code: 'REST_GAP_SHORT',
          message: `${entryId} gets ${gap} min between ${a.matchNo} and ${b.matchNo}; ${sport.restGap.recommendedMins} min is recommended`,
          matchNos: [a.matchNo, b.matchNo],
        });
      }
      // §6.4 soft warning: a side in two events in the same session.
      if (
        a.scheduledDate === b.scheduledDate &&
        a.session &&
        a.session === b.session &&
        a.eventId !== b.eventId
      ) {
        soft.push({
          severity: 'soft',
          code: 'TWO_EVENTS_SAME_SESSION',
          message: `${entryId} is in two events during the ${a.session} session on ${a.scheduledDate}`,
          matchNos: [a.matchNo, b.matchNo],
        });
      }
    }
  }

  // Round order: a fixture cannot start before its feeders have finished
  // (§5.4 hard constraint "Round order (R1 < R2 …)").
  const byNo = new Map(ctx.matches.map((m) => [m.matchNo, m]));
  for (const m of scheduled) {
    for (const side of [m.sideA, m.sideB]) {
      if (side.kind !== 'placeholder') continue;
      const feeder = byNo.get(side.matchNo);
      if (!feeder || feeder.byeFlag) continue;
      if (!feeder.scheduledDate || !feeder.scheduledTime) continue;
      const sf = span(feeder);
      const sm = span(m);
      if (sm.start < sf.end) {
        hard.push({
          severity: 'hard',
          code: 'ROUND_ORDER',
          message: `${m.matchNo} is scheduled before its feeder ${feeder.matchNo} finishes`,
          matchNos: [m.matchNo, feeder.matchNo],
        });
      }
    }
  }

  // Operating hours and maintenance blocks (§6.1 venue inventory).
  const fopIndex = new Map<string, { venue: Venue }>();
  for (const v of ctx.venues) for (const f of v.fopList) fopIndex.set(f.fopId, { venue: v });
  for (const m of scheduled) {
    const found = fopIndex.get(m.fopId as string);
    if (!found) {
      hard.push({
        severity: 'hard',
        code: 'UNSCHEDULED',
        message: `${m.matchNo} is assigned to unknown field of play ${m.fopId}`,
        matchNos: [m.matchNo],
      });
      continue;
    }
    const start = toMins(m.scheduledTime as ISOTime);
    const end = start + (m.durationMins ?? sport.matchDefaults.durationMins);
    const oh = found.venue.operatingHours;
    if (start < toMins(oh.open) || end > toMins(oh.close)) {
      hard.push({
        severity: 'hard',
        code: 'OUTSIDE_OPERATING_HOURS',
        message: `${m.matchNo} runs ${toTime(start)}–${toTime(end)}, outside ${found.venue.name} hours ${oh.open}–${oh.close}`,
        matchNos: [m.matchNo],
      });
    }
    for (const mb of found.venue.maintenanceBlocks) {
      if (mb.fopId !== m.fopId || mb.date !== m.scheduledDate) continue;
      if (overlaps(start, end, toMins(mb.from), toMins(mb.to))) {
        hard.push({
          severity: 'hard',
          code: 'MAINTENANCE_BLOCK',
          message: `${m.matchNo} clashes with a maintenance block on ${m.fopId} (${mb.from}–${mb.to}: ${mb.reason})`,
          matchNos: [m.matchNo],
        });
      }
    }
  }

  // Officials: overlapping duties (hard) and cross-venue travel buffer (soft).
  const byOfficial = new Map<string, Match[]>();
  for (const m of scheduled) {
    for (const o of m.officials) byOfficial.set(o.officialId, [...(byOfficial.get(o.officialId) ?? []), m]);
  }
  for (const [officialId, ms] of byOfficial) {
    const sorted = [...ms].sort((x, y) => span(x).start - span(y).start);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i] as Match;
      const b = sorted[i + 1] as Match;
      const sa = span(a);
      const sb = span(b);
      if (overlaps(sa.start, sa.end, sb.start, sb.end)) {
        hard.push({
          severity: 'hard',
          code: 'OFFICIAL_OVERLAP',
          message: `official ${officialId} is double-booked on ${a.matchNo} and ${b.matchNo}`,
          matchNos: [a.matchNo, b.matchNo],
        });
      } else if (a.venueId !== b.venueId && sb.start - sa.end < TRAVEL_BUFFER_MINS) {
        soft.push({
          severity: 'soft',
          code: 'OFFICIAL_TRAVEL_BUFFER',
          message: `official ${officialId} has ${sb.start - sa.end} min to travel from ${a.venueId} to ${b.venueId} between ${a.matchNo} and ${b.matchNo}; ${TRAVEL_BUFFER_MINS} min is the buffer`,
          matchNos: [a.matchNo, b.matchNo],
        });
      }
    }
  }

  // §5.4 soft preference: minimise a unit's venue-hopping within a day.
  const perUnitDay = new Map<string, Set<string>>();
  for (const m of scheduled) {
    for (const p of participantsOf(m)) {
      const unit = ctx.entryUnits[p];
      if (!unit) continue;
      const key = `${unit}|${m.scheduledDate}`;
      const set = perUnitDay.get(key) ?? new Set<string>();
      set.add(m.venueId ?? '?');
      perUnitDay.set(key, set);
    }
  }
  for (const [key, venues] of perUnitDay) {
    if (venues.size > 1) {
      const [unit, date] = key.split('|');
      soft.push({
        severity: 'soft',
        code: 'VENUE_HOPPING',
        message: `unit ${unit} plays at ${venues.size} venues on ${date} (${[...venues].join(', ')})`,
        matchNos: [],
      });
    }
  }

  return { hard, soft, publishable: hard.length === 0 };
}

/** §6.6 travel-time buffer between venues for an official. */
export const TRAVEL_BUFFER_MINS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Auto-scheduler
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleResult {
  matches: Match[];
  conflicts: ConflictReport;
  /** Fixtures the scheduler could not place, with the reason. */
  unplaced: { matchNo: string; reason: string }[];
}

/** Stage ordering so a final never gets scheduled before a quarter-final. */
const STAGE_RANK: Record<string, number> = {
  group: 0,
  R32: 1,
  R16: 2,
  QF: 3,
  repechage: 3,
  SF: 4,
  bronze: 5,
  F: 6,
};

/**
 * §6.3 — assign date/time/FOP per fixture, respecting venue availability,
 * minimum rest gap, event sequencing (R1 before R2) and prime-slot preference.
 *
 * Greedy earliest-feasible placement in dependency order. Greedy is the right
 * shape here: it is deterministic, explains itself (the reason a fixture went
 * where it did is "the first slot that satisfied every hard constraint"), and
 * §5.4 expects a human to adjust the result on the Scheduling Board rather than
 * trust an opaque optimum.
 */
export function autoSchedule(ctx: SchedulingContext): ScheduleResult {
  const sport = getSport(ctx.sportId);
  const turnaround = ctx.grid.turnaroundMins;
  const slotLen = (m: Match) => m.durationMins ?? sport.matchDefaults.durationMins;

  const fops: { fopId: string; venueId: string }[] = [];
  for (const v of ctx.venues) for (const f of v.fopList) fops.push({ fopId: f.fopId, venueId: v.venueId });

  // Running bookings per FOP and per entry, in absolute minutes.
  const fopBookings = new Map<string, { start: number; end: number }[]>();
  const entryBookings = new Map<string, { start: number; end: number }[]>();
  const placed = new Map<string, { start: number; end: number }>();

  const order = [...ctx.matches]
    .filter((m) => !m.byeFlag)
    .sort((a, b) => {
      const ra = (STAGE_RANK[a.stage] ?? 9) * 1000 + a.roundNo;
      const rb = (STAGE_RANK[b.stage] ?? 9) * 1000 + b.roundNo;
      if (ra !== rb) return ra - rb;
      return a.matchNo.localeCompare(b.matchNo);
    });

  const out = new Map(ctx.matches.map((m) => [m.matchNo, { ...m }]));
  const unplaced: { matchNo: string; reason: string }[] = [];

  const maintenanceHit = (fopId: string, date: ISODate, s: number, e: number): boolean => {
    for (const v of ctx.venues) {
      for (const mb of v.maintenanceBlocks) {
        if (mb.fopId === fopId && mb.date === date && overlaps(s, e, toMins(mb.from), toMins(mb.to))) {
          return true;
        }
      }
    }
    return false;
  };

  for (const m of order) {
    const dur = slotLen(m);
    // A fixture cannot start before its feeders end, plus the rest gap the
    // advancing side is owed.
    let earliest = -Infinity;
    for (const side of [m.sideA, m.sideB]) {
      if (side.kind !== 'placeholder') continue;
      const f = placed.get(side.matchNo);
      if (f) earliest = Math.max(earliest, f.end + sport.restGap.hardMins);
    }

    const parts = participantsOf(m);
    let done = false;
    let lastReason = 'no feasible slot in the time grid';

    // §5.4 soft preference "Prime slots for finals/TV": a prime fixture tries
    // the evening blocks first and only then falls back, so the preference can
    // never leave a fixture unplaced.
    const isPrime = ctx.primeMatchNos?.includes(m.matchNo) ?? false;
    const sessionOrder = isPrime
      ? [
          ...ctx.grid.sessions.filter((b) => b.session === 'evening'),
          ...ctx.grid.sessions.filter((b) => b.session !== 'evening'),
        ]
      : ctx.grid.sessions;

    outer: for (const date of ctx.grid.dates) {
      const dayStart = absolute(date, 0);
      for (const block of sessionOrder) {
        const blockStart = toMins(block.from);
        const blockEnd = toMins(block.to);

        // Gather every feasible (field of play, start) pair in this block and
        // take the globally earliest. Choosing per-field would serialise the
        // whole event onto the first mat while the others sat idle.
        const feasible: { fopId: string; venueId: string; start: number }[] = [];

        for (const { fopId, venueId } of fops) {
          const venue = ctx.venues.find((v) => v.venueId === venueId);
          if (!venue) continue;
          const openMins = Math.max(blockStart, toMins(venue.operatingHours.open));
          const closeMins = Math.min(blockEnd, toMins(venue.operatingHours.close));
          const existing = fopBookings.get(fopId) ?? [];
          // Only this date's bookings produce candidate start times; a booking
          // on another day would otherwise yield a meaningless offset.
          const sameDay = existing.filter((b) => b.start >= dayStart && b.start < dayStart + 1440);

          const candidates = [
            openMins + ctx.grid.warmUpMins,
            ...sameDay.map((b) => b.end - dayStart + turnaround),
          ]
            .filter((v) => v >= openMins && v + dur <= closeMins)
            .sort((x, y) => x - y);

          for (const start of candidates) {
            const abs = absolute(date, start);
            const absEnd = abs + dur;
            if (abs < earliest) continue;
            if (maintenanceHit(fopId, date, start, start + dur)) {
              lastReason = `maintenance block on ${fopId}`;
              continue;
            }
            if (existing.some((b) => overlaps(abs, absEnd, b.start, b.end))) continue;
            // Overlap and rest gap for both sides (§6.4, §7.2.12).
            const clash = parts.some((p) =>
              (entryBookings.get(p) ?? []).some(
                (b) =>
                  overlaps(abs, absEnd, b.start, b.end) ||
                  (abs >= b.end && abs - b.end < sport.restGap.hardMins) ||
                  (b.start >= absEnd && b.start - absEnd < sport.restGap.hardMins),
              ),
            );
            if (clash) {
              lastReason = `rest gap or overlap for a participating side (${sport.restGap.hardMins} min minimum)`;
              continue;
            }
            feasible.push({ fopId, venueId, start });
            break; // earliest start on this field is enough
          }
        }

        if (!feasible.length) continue;

        // §5.4 soft preference "Same event grouped on same FOP": among equally
        // early options, prefer a mat this event is already using.
        const eventFops = new Set(
          [...out.values()]
            .filter((x) => x.eventId === m.eventId && x.fopId)
            .map((x) => x.fopId as string),
        );
        feasible.sort(
          (a, b) =>
            a.start - b.start ||
            Number(eventFops.has(b.fopId)) - Number(eventFops.has(a.fopId)) ||
            a.fopId.localeCompare(b.fopId),
        );
        const chosen = feasible[0] as { fopId: string; venueId: string; start: number };
        const abs = absolute(date, chosen.start);
        const absEnd = abs + dur;

        const target = out.get(m.matchNo);
        if (target) {
          target.scheduledDate = date;
          target.scheduledTime = toTime(chosen.start);
          target.fopId = chosen.fopId;
          target.venueId = chosen.venueId;
          target.session = block.session;
        }
        fopBookings.set(chosen.fopId, [
          ...(fopBookings.get(chosen.fopId) ?? []),
          { start: abs, end: absEnd },
        ]);
        for (const p of parts) {
          entryBookings.set(p, [...(entryBookings.get(p) ?? []), { start: abs, end: absEnd }]);
        }
        placed.set(m.matchNo, { start: abs, end: absEnd });
        done = true;
        break outer;
      }
    }
    if (!done) unplaced.push({ matchNo: m.matchNo, reason: lastReason });
  }

  const matches = ctx.matches.map((m) => out.get(m.matchNo) ?? m);
  return { matches, conflicts: detectConflicts({ ...ctx, matches }), unplaced };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reschedule — §6.8, §8 exception 4 and 12
// ─────────────────────────────────────────────────────────────────────────────

export interface RescheduleProposal {
  matchNo: string;
  toDate: ISODate;
  toTime: ISOTime;
  toFopId: string;
  reasonCode: string;
  requestedBy: string;
}

/**
 * §6.8 — "New slot re-runs all conflict checks; affected parties auto-notified;
 * change logged." §7.2.10 — a published fixture is immutable, so the change
 * creates a new version with the prior one retained.
 */
export function proposeReschedule(
  ctx: SchedulingContext,
  proposal: RescheduleProposal,
  approvedBy: string,
): { matches: Match[]; conflicts: ConflictReport; accepted: boolean; error?: string } {
  const target = ctx.matches.find((m) => m.matchNo === proposal.matchNo);
  if (!target) {
    return { matches: ctx.matches, conflicts: detectConflicts(ctx), accepted: false, error: `no fixture ${proposal.matchNo}` };
  }
  if (!proposal.reasonCode?.trim()) {
    return {
      matches: ctx.matches,
      conflicts: detectConflicts(ctx),
      accepted: false,
      error: 'a reschedule requires a reason code (§6)',
    };
  }
  const venue = ctx.venues.find((v) => v.fopList.some((f) => f.fopId === proposal.toFopId));

  const candidate: Match = {
    ...target,
    scheduledDate: proposal.toDate,
    scheduledTime: proposal.toTime,
    fopId: proposal.toFopId,
    venueId: venue?.venueId ?? target.venueId,
    // §7.2.10 new version, prior slot retained in history.
    versionNo: target.versionNo + 1,
    rescheduleHistory: [
      ...target.rescheduleHistory,
      {
        fromDate: target.scheduledDate,
        fromTime: target.scheduledTime,
        fromFopId: target.fopId,
        toDate: proposal.toDate,
        toTime: proposal.toTime,
        toFopId: proposal.toFopId,
        reasonCode: proposal.reasonCode,
        requestedBy: proposal.requestedBy,
        approvedBy,
        at: new Date().toISOString(),
      },
    ],
  };

  const matches = ctx.matches.map((m) => (m.matchNo === proposal.matchNo ? candidate : m));
  const conflicts = detectConflicts({ ...ctx, matches });
  // Hard conflicts block the move outright; soft ones need acknowledgment.
  const introduced = conflicts.hard.filter((c) => c.matchNos.includes(proposal.matchNo));
  if (introduced.length) {
    return {
      matches: ctx.matches,
      conflicts,
      accepted: false,
      error: `reschedule rejected — ${introduced.map((c) => c.message).join('; ')}`,
    };
  }
  return { matches, conflicts, accepted: true };
}

/**
 * §8 exception 12 — bulk move every fixture on a field of play or venue.
 * Re-runs the full conflict check once, as the document requires.
 */
export function bulkReschedule(
  ctx: SchedulingContext,
  filter: { fopId?: string; venueId?: string; date?: ISODate },
  shiftMins: number,
  reasonCode: string,
  requestedBy: string,
  approvedBy: string,
): { matches: Match[]; conflicts: ConflictReport; moved: string[] } {
  const moved: string[] = [];
  const matches = ctx.matches.map((m) => {
    if (filter.fopId && m.fopId !== filter.fopId) return m;
    if (filter.venueId && m.venueId !== filter.venueId) return m;
    if (filter.date && m.scheduledDate !== filter.date) return m;
    if (!m.scheduledTime || !m.scheduledDate || m.byeFlag) return m;
    const next = toMins(m.scheduledTime) + shiftMins;
    moved.push(m.matchNo);
    return {
      ...m,
      scheduledTime: toTime(next),
      versionNo: m.versionNo + 1,
      rescheduleHistory: [
        ...m.rescheduleHistory,
        {
          fromDate: m.scheduledDate,
          fromTime: m.scheduledTime,
          fromFopId: m.fopId,
          toDate: m.scheduledDate,
          toTime: toTime(next),
          toFopId: m.fopId as string,
          reasonCode,
          requestedBy,
          approvedBy,
          at: new Date().toISOString(),
        },
      ],
    };
  });
  return { matches, conflicts: detectConflicts({ ...ctx, matches }), moved };
}

/** §9.3 venue utilisation heatmap: FOP × session occupancy. */
export function utilisation(ctx: SchedulingContext): {
  fopId: string;
  date: ISODate;
  session: Session;
  bookedMins: number;
  availableMins: number;
  pct: number;
}[] {
  const sport = getSport(ctx.sportId);
  const out: ReturnType<typeof utilisation> = [];
  for (const v of ctx.venues) {
    for (const f of v.fopList) {
      for (const date of ctx.grid.dates) {
        for (const block of ctx.grid.sessions) {
          const available =
            Math.min(toMins(block.to), toMins(v.operatingHours.close)) -
            Math.max(toMins(block.from), toMins(v.operatingHours.open));
          const booked = ctx.matches
            .filter(
              (m) => m.fopId === f.fopId && m.scheduledDate === date && m.session === block.session && !m.byeFlag,
            )
            .reduce((s, m) => s + (m.durationMins ?? sport.matchDefaults.durationMins), 0);
          out.push({
            fopId: f.fopId,
            date,
            session: block.session,
            bookedMins: booked,
            availableMins: Math.max(0, available),
            pct: available > 0 ? Math.round((booked / available) * 100) : 0,
          });
        }
      }
    }
  }
  return out;
}
