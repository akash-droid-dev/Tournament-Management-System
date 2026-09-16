/**
 * Kabaddi sport configuration template.
 *
 * Implements the `SportConfigTemplate` contract so the TMS engines can run a
 * Kabaddi competition without knowing anything about Kabaddi. Every rule below
 * is data or a pure function; nothing here reaches back into the engines.
 *
 * Rule sources and their status
 * ─────────────────────────────
 * Structural rules of play (7 on the mat, raid alternation, all-out worth 2,
 * bonus-line eligibility at 6+ defenders, super tackle at 3 or fewer, the
 * do-or-die raid, bonus points not reviving a player) are encoded as
 * `'rule-of-play'`.
 *
 * Numbers that federations set and revise — weight limits, league point
 * values, half length for age groups, rest gaps, the walkover convention — are
 * marked `'configurable-default'`. They are starting values the organizing body
 * MUST confirm against its current technical handbook (AKFI / IKF / state
 * association) before a tournament goes live. The Sport & Event Setup screen
 * (§12.3) surfaces them as editable fields for exactly this reason.
 */

import type { ScoreEvent } from '../domain/types.ts';
import {
  register,
  type MatchParams,
  type ScoreEventInput,
  type SportConfigTemplate,
  type SportScoringEngine,
  type ValidationIssue,
  type ValidationResult,
} from './registry.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Live match state
// ─────────────────────────────────────────────────────────────────────────────

export interface KabaddiSideState {
  score: number;
  /** Players currently on the mat. Starts at 7, an all-out resets it to 7. */
  onCourt: number;
  /** Out players in the order they went out — revival order (rule of play). */
  outQueue: string[];
  /** Consecutive empty raids by this side; the 3rd raid is do-or-die. */
  consecutiveEmptyRaids: number;
  /** Statistics for the §10.6 match result report. */
  stats: {
    raidPoints: number;
    bonusPoints: number;
    tacklePoints: number;
    superTackles: number;
    allOuts: number;
    technicalPoints: number;
    emptyRaids: number;
    superRaids: number;
    totalRaids: number;
    successfulRaids: number;
  };
  /** Yellow-carded players serving a 2-minute suspension, by clock second. */
  suspensions: { participantId: string; untilClockSecs: number }[];
  cards: { green: number; yellow: number; red: number };
  timeoutsUsed: number;
}

export interface KabaddiState {
  period: number;
  clockSecs: number;
  raidNo: number;
  /** Which side is raiding next. Kabaddi alternates every raid. */
  raidingSide: 'A' | 'B';
  /** True when the upcoming raid must produce a point or the raider is out. */
  doOrDie: boolean;
  A: KabaddiSideState;
  B: KabaddiSideState;
  /** Set when the clock has run out on the final period. */
  finished: boolean;
  /** Extra-time / golden-raid phase after a tied knockout match. */
  tiePhase: 'none' | 'extra-1' | 'extra-2' | 'golden-raid';
}

const ON_COURT = 7;
const SQUAD_MAX = 12;
/** Rule of play: a bonus may only be taken with 6 or more defenders on the mat. */
const BONUS_MIN_DEFENDERS = 6;
/** Rule of play: a tackle by 3 or fewer defenders is a super tackle (2 points). */
const SUPER_TACKLE_MAX_DEFENDERS = 3;
/** Rule of play: the 3rd consecutive empty raid is do-or-die. */
const DO_OR_DIE_AFTER_EMPTY_RAIDS = 2;
/** Rule of play: an all-out awards 2 points to the opposing side. */
const ALL_OUT_POINTS = 2;
/** A raid worth 3 or more points is recorded as a super raid (statistic only). */
const SUPER_RAID_MIN_POINTS = 3;
/** Rule of play: a yellow card carries a 2-minute suspension. */
const YELLOW_SUSPENSION_SECS = 120;

function newSide(): KabaddiSideState {
  return {
    score: 0,
    onCourt: ON_COURT,
    outQueue: [],
    consecutiveEmptyRaids: 0,
    stats: {
      raidPoints: 0,
      bonusPoints: 0,
      tacklePoints: 0,
      superTackles: 0,
      allOuts: 0,
      technicalPoints: 0,
      emptyRaids: 0,
      superRaids: 0,
      totalRaids: 0,
      successfulRaids: 0,
    },
    suspensions: [],
    cards: { green: 0, yellow: 0, red: 0 },
    timeoutsUsed: 0,
  };
}

const other = (s: 'A' | 'B'): 'A' | 'B' => (s === 'A' ? 'B' : 'A');

function clone(s: KabaddiState): KabaddiState {
  return structuredClone(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event vocabulary
// ─────────────────────────────────────────────────────────────────────────────

export const KABADDI_EVENTS = {
  RAID_TOUCH: 'raid-touch',
  RAID_BONUS: 'raid-bonus',
  RAID_EMPTY: 'raid-empty',
  TACKLE: 'tackle',
  SUPER_TACKLE: 'super-tackle',
  ALL_OUT: 'all-out',
  DO_OR_DIE_FAIL: 'do-or-die-fail',
  TECHNICAL_POINT: 'technical-point',
  CARD_GREEN: 'card-green',
  CARD_YELLOW: 'card-yellow',
  CARD_RED: 'card-red',
  TIMEOUT: 'timeout',
  SUBSTITUTION: 'substitution',
  INJURY: 'injury',
  PERIOD_END: 'period-end',
  REVIVE: 'revive',
} as const;

/** Point events that revive an out player. A bonus point does not. */
const REVIVING_EVENTS = new Set<string>([
  KABADDI_EVENTS.RAID_TOUCH,
  KABADDI_EVENTS.TACKLE,
  KABADDI_EVENTS.SUPER_TACKLE,
  KABADDI_EVENTS.TECHNICAL_POINT,
  KABADDI_EVENTS.DO_OR_DIE_FAIL,
]);

const hard = (code: string, message: string): ValidationIssue => ({
  severity: 'hard',
  code,
  message,
});
const soft = (code: string, message: string): ValidationIssue => ({
  severity: 'soft',
  code,
  message,
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoring engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Revive out players for a side, in the order they went out.
 * Returns the number actually revived.
 */
function revive(side: KabaddiSideState, count: number): number {
  const n = Math.min(count, side.outQueue.length, ON_COURT - side.onCourt);
  if (n <= 0) return 0;
  side.outQueue.splice(0, n);
  side.onCourt += n;
  return n;
}

/** Put `ids` out for a side, in the order given. */
function putOut(side: KabaddiSideState, ids: string[]): void {
  for (const id of ids) {
    if (side.onCourt <= 0) break;
    side.onCourt -= 1;
    side.outQueue.push(id);
  }
}

const kabaddiScoring: SportScoringEngine<KabaddiState> = {
  initialState(_params: MatchParams): KabaddiState {
    return {
      period: 1,
      clockSecs: 0,
      raidNo: 1,
      // Set from the toss: §7.3 records the toss winner's choice of court or
      // the right to raid first. Defaults to A until the toss is entered.
      raidingSide: 'A',
      doOrDie: false,
      A: newSide(),
      B: newSide(),
      finished: false,
      tiePhase: 'none',
    };
  },

  /** §7.4.16 — impossible scores are rejected at entry, not on save. */
  validate(state: KabaddiState, ev: ScoreEventInput): ValidationResult {
    const issues: ValidationIssue[] = [];
    const push = (i: ValidationIssue) => issues.push(i);

    if (state.finished) {
      push(hard('MATCH_FINISHED', 'the match is finished; no further events may be recorded'));
      return { legal: false, issues };
    }
    if (ev.clockSecs < state.clockSecs) {
      push(
        hard(
          'CLOCK_BACKWARDS',
          `clock cannot move backwards (last event at ${state.clockSecs}s, this one at ${ev.clockSecs}s)`,
        ),
      );
    }

    const raiding = state.raidingSide;
    const defending = other(raiding);
    const def = state[defending];
    const raid = state[raiding];

    switch (ev.type) {
      case KABADDI_EVENTS.RAID_TOUCH: {
        if (ev.side !== raiding) {
          push(
            hard(
              'WRONG_RAIDER',
              `${raiding} is raiding; a raid point cannot be credited to ${ev.side}`,
            ),
          );
          break;
        }
        const touched = ev.value ?? 1;
        if (!Number.isInteger(touched) || touched < 1) {
          push(hard('BAD_TOUCH_COUNT', 'a raid touch must put out at least one defender'));
        } else if (touched > def.onCourt) {
          push(
            hard(
              'TOUCH_EXCEEDS_DEFENDERS',
              `cannot touch ${touched} defenders — only ${def.onCourt} are on the mat`,
            ),
          );
        }
        if (ev.detail?.bonus === true && def.onCourt < BONUS_MIN_DEFENDERS) {
          push(
            hard(
              'BONUS_NOT_AVAILABLE',
              `a bonus needs ${BONUS_MIN_DEFENDERS}+ defenders on the mat; ${def.onCourt} are on`,
            ),
          );
        }
        if (touched >= SUPER_RAID_MIN_POINTS) {
          push(soft('SUPER_RAID', `${touched}-point raid — recorded as a super raid`));
        }
        break;
      }

      case KABADDI_EVENTS.RAID_BONUS: {
        if (ev.side !== raiding) {
          push(hard('WRONG_RAIDER', `${raiding} is raiding; a bonus cannot be credited to ${ev.side}`));
          break;
        }
        if (def.onCourt < BONUS_MIN_DEFENDERS) {
          push(
            hard(
              'BONUS_NOT_AVAILABLE',
              `a bonus needs ${BONUS_MIN_DEFENDERS}+ defenders on the mat; ${def.onCourt} are on`,
            ),
          );
        }
        break;
      }

      case KABADDI_EVENTS.RAID_EMPTY: {
        if (ev.side !== raiding) {
          push(hard('WRONG_RAIDER', `${raiding} is raiding; an empty raid belongs to ${raiding}`));
        }
        if (state.doOrDie) {
          push(
            soft(
              'DO_OR_DIE_FAILED',
              'do-or-die raid produced nothing — the raider is out and the point goes to the defence',
            ),
          );
        }
        break;
      }

      case KABADDI_EVENTS.TACKLE:
      case KABADDI_EVENTS.SUPER_TACKLE: {
        if (ev.side !== defending) {
          push(
            hard(
              'WRONG_TACKLER',
              `${defending} is defending; a tackle point cannot be credited to ${ev.side}`,
            ),
          );
          break;
        }
        if (raid.onCourt < 1) {
          push(hard('NO_RAIDER', `${raiding} has no players on the mat to raid`));
        }
        if (
          ev.type === KABADDI_EVENTS.SUPER_TACKLE &&
          def.onCourt > SUPER_TACKLE_MAX_DEFENDERS
        ) {
          push(
            hard(
              'NOT_A_SUPER_TACKLE',
              `a super tackle needs ${SUPER_TACKLE_MAX_DEFENDERS} or fewer defenders on the mat; ${def.onCourt} are on`,
            ),
          );
        }
        break;
      }

      case KABADDI_EVENTS.TECHNICAL_POINT: {
        if ((ev.value ?? 1) < 1) {
          push(hard('BAD_VALUE', 'a technical point must be worth at least 1'));
        }
        break;
      }

      case KABADDI_EVENTS.ALL_OUT:
      case KABADDI_EVENTS.DO_OR_DIE_FAIL:
      case KABADDI_EVENTS.REVIVE: {
        push(
          hard(
            'DERIVED_EVENT',
            `"${ev.type}" is derived by the rules engine and cannot be entered directly`,
          ),
        );
        break;
      }

      case KABADDI_EVENTS.CARD_GREEN:
      case KABADDI_EVENTS.CARD_YELLOW:
      case KABADDI_EVENTS.CARD_RED: {
        if (!ev.participantId) {
          push(hard('NO_PARTICIPANT', 'a card must name the player it is issued to'));
        }
        break;
      }

      case KABADDI_EVENTS.TIMEOUT:
      case KABADDI_EVENTS.SUBSTITUTION:
      case KABADDI_EVENTS.INJURY:
      case KABADDI_EVENTS.PERIOD_END:
        break;

      default:
        push(hard('UNKNOWN_EVENT', `"${ev.type}" is not a Kabaddi score event`));
    }

    return { legal: !issues.some((i) => i.severity === 'hard'), issues };
  },

  apply(state: KabaddiState, ev: ScoreEventInput): { state: KabaddiState; derived: ScoreEventInput[] } {
    const s = clone(state);
    const derived: ScoreEventInput[] = [];
    const raiding = s.raidingSide;
    const defending = other(raiding);

    /** Award points and revive, then check for an all-out. */
    const award = (side: 'A' | 'B', points: number, reviving: boolean): void => {
      const me = s[side];
      me.score += points;
      if (reviving && points > 0) {
        const n = revive(me, points);
        if (n > 0) {
          derived.push({
            type: KABADDI_EVENTS.REVIVE,
            side,
            value: n,
            clockSecs: ev.clockSecs,
            detail: { revived: n },
          });
        }
      }
    };

    /** Rule of play: a side reduced to zero concedes 2 and returns 7 to the mat. */
    const checkAllOut = (): void => {
      for (const side of ['A', 'B'] as const) {
        if (s[side].onCourt <= 0) {
          const opp = other(side);
          s[opp].score += ALL_OUT_POINTS;
          s[opp].stats.allOuts += 1;
          derived.push({
            type: KABADDI_EVENTS.ALL_OUT,
            side: opp,
            value: ALL_OUT_POINTS,
            clockSecs: ev.clockSecs,
            detail: { allOutAgainst: side },
          });
          // The all-out side brings its full complement back on.
          s[side].onCourt = ON_COURT;
          s[side].outQueue = [];
          // The 2 all-out points revive the scoring side's out players too.
          revive(s[opp], ALL_OUT_POINTS);
        }
      }
    };

    /**
     * Close the raid: alternate the raiding side and roll the do-or-die counter.
     *
     * `emptyRaid` is the rules definition — a raid in which *neither* side
     * scored. A raid that ends in a tackle is therefore not empty: the defence
     * scored, so the do-or-die sequence resets. A failed do-or-die raid is not
     * empty either, because the defence takes a point from it; the sequence has
     * resolved and counting starts again from zero. Only these resets keep a
     * side from being stuck in do-or-die for the rest of the match.
     */
    const endRaid = (opts: { raiderScored: boolean; emptyRaid: boolean }): void => {
      s[raiding].stats.totalRaids += 1;
      if (opts.raiderScored) s[raiding].stats.successfulRaids += 1;
      s[raiding].consecutiveEmptyRaids = opts.emptyRaid
        ? s[raiding].consecutiveEmptyRaids + 1
        : 0;
      s.raidNo += 1;
      s.raidingSide = defending;
      s.doOrDie = s[defending].consecutiveEmptyRaids >= DO_OR_DIE_AFTER_EMPTY_RAIDS;
    };

    s.clockSecs = Math.max(s.clockSecs, ev.clockSecs);
    // Expire yellow-card suspensions that have run their two minutes.
    for (const side of ['A', 'B'] as const) {
      s[side].suspensions = s[side].suspensions.filter((x) => x.untilClockSecs > s.clockSecs);
    }

    switch (ev.type) {
      case KABADDI_EVENTS.RAID_TOUCH: {
        const touched = ev.value ?? 1;
        const bonus = ev.detail?.bonus === true ? 1 : 0;
        const ids =
          (ev.detail?.defenderIds as string | undefined)?.split(',').filter(Boolean) ??
          Array.from({ length: touched }, (_, i) => `${defending}-def-${s.raidNo}-${i}`);
        putOut(s[defending], ids.slice(0, touched));
        s[raiding].stats.raidPoints += touched;
        if (bonus) s[raiding].stats.bonusPoints += bonus;
        if (touched + bonus >= SUPER_RAID_MIN_POINTS) s[raiding].stats.superRaids += 1;
        // Bonus points do not revive (rule of play), touch points do.
        award(raiding, touched, true);
        if (bonus) award(raiding, bonus, false);
        checkAllOut();
        endRaid({ raiderScored: true, emptyRaid: false });
        break;
      }

      case KABADDI_EVENTS.RAID_BONUS: {
        s[raiding].stats.bonusPoints += 1;
        award(raiding, 1, false);
        checkAllOut();
        endRaid({ raiderScored: true, emptyRaid: false });
        break;
      }

      case KABADDI_EVENTS.RAID_EMPTY: {
        if (s.doOrDie) {
          // Do-or-die failed: the raider is out and the defence takes the point.
          const raiderId = ev.participantId ?? `${raiding}-raider-${s.raidNo}`;
          putOut(s[raiding], [raiderId]);
          s[defending].stats.tacklePoints += 1;
          derived.push({
            type: KABADDI_EVENTS.DO_OR_DIE_FAIL,
            side: defending,
            value: 1,
            clockSecs: ev.clockSecs,
            detail: { raider: raiderId },
          });
          award(defending, 1, true);
          checkAllOut();
          // The defence scored, so this raid is not "empty" and the sequence
          // resets — otherwise the side would stay in do-or-die permanently.
          endRaid({ raiderScored: false, emptyRaid: false });
        } else {
          s[raiding].stats.emptyRaids += 1;
          endRaid({ raiderScored: false, emptyRaid: true });
        }
        break;
      }

      case KABADDI_EVENTS.TACKLE:
      case KABADDI_EVENTS.SUPER_TACKLE: {
        // A tackle by 3 or fewer defenders is worth 2 — the engine upgrades it
        // so a Scorer pressing "Tackle" can never under-award a super tackle.
        const isSuper = s[defending].onCourt <= SUPER_TACKLE_MAX_DEFENDERS;
        const points = isSuper ? 2 : 1;
        if (isSuper) {
          s[defending].stats.superTackles += 1;
          if (ev.type === KABADDI_EVENTS.TACKLE) {
            derived.push({
              type: KABADDI_EVENTS.SUPER_TACKLE,
              side: defending,
              value: points,
              clockSecs: ev.clockSecs,
              detail: { upgradedFrom: 'tackle', defendersOnMat: s[defending].onCourt },
            });
          }
        }
        s[defending].stats.tacklePoints += points;
        const raiderId = ev.participantId ?? `${raiding}-raider-${s.raidNo}`;
        putOut(s[raiding], [raiderId]);
        award(defending, points, true);
        checkAllOut();
        endRaid({ raiderScored: false, emptyRaid: false });
        break;
      }

      case KABADDI_EVENTS.TECHNICAL_POINT: {
        const v = ev.value ?? 1;
        s[ev.side].stats.technicalPoints += v;
        award(ev.side, v, true);
        checkAllOut();
        break;
      }

      case KABADDI_EVENTS.CARD_GREEN:
        s[ev.side].cards.green += 1;
        break;

      case KABADDI_EVENTS.CARD_YELLOW: {
        s[ev.side].cards.yellow += 1;
        const id = ev.participantId ?? 'unknown';
        s[ev.side].suspensions.push({
          participantId: id,
          untilClockSecs: ev.clockSecs + YELLOW_SUSPENSION_SECS,
        });
        putOut(s[ev.side], [id]);
        checkAllOut();
        break;
      }

      case KABADDI_EVENTS.CARD_RED: {
        s[ev.side].cards.red += 1;
        putOut(s[ev.side], [ev.participantId ?? 'unknown']);
        checkAllOut();
        break;
      }

      case KABADDI_EVENTS.TIMEOUT:
        s[ev.side].timeoutsUsed += 1;
        break;

      case KABADDI_EVENTS.PERIOD_END:
        s.period += 1;
        break;

      case KABADDI_EVENTS.SUBSTITUTION:
      case KABADDI_EVENTS.INJURY:
        break;
    }

    return { state: s, derived };
  },

  summarize(state: KabaddiState) {
    const stat = (side: 'A' | 'B') => {
      const t = state[side].stats;
      return {
        [`${side}_raidPoints`]: t.raidPoints,
        [`${side}_bonusPoints`]: t.bonusPoints,
        [`${side}_tacklePoints`]: t.tacklePoints,
        [`${side}_superTackles`]: t.superTackles,
        [`${side}_allOuts`]: t.allOuts,
        [`${side}_technicalPoints`]: t.technicalPoints,
        [`${side}_emptyRaids`]: t.emptyRaids,
        [`${side}_superRaids`]: t.superRaids,
        [`${side}_totalRaids`]: t.totalRaids,
        [`${side}_successfulRaids`]: t.successfulRaids,
        [`${side}_raidSuccessPct`]: t.totalRaids
          ? Math.round((t.successfulRaids / t.totalRaids) * 100)
          : 0,
        [`${side}_greenCards`]: state[side].cards.green,
        [`${side}_yellowCards`]: state[side].cards.yellow,
        [`${side}_redCards`]: state[side].cards.red,
      };
    };
    return {
      a: state.A.score,
      b: state.B.score,
      statistics: { ...stat('A'), ...stat('B') },
    };
  },

  isComplete(state: KabaddiState, params: MatchParams): boolean {
    if (state.finished) return true;
    if (state.tiePhase === 'golden-raid') return state.A.score !== state.B.score;
    return state.period > params.periods;
  },

  describeState(state: KabaddiState): string {
    const half = state.tiePhase === 'none' ? `H${state.period}` : state.tiePhase;
    const mm = String(Math.floor(state.clockSecs / 60)).padStart(2, '0');
    const ss = String(state.clockSecs % 60).padStart(2, '0');
    const dod = state.doOrDie ? ' · DO-OR-DIE' : '';
    return `${half} ${mm}:${ss} · ${state.A.score}–${state.B.score} · raid #${state.raidNo} by ${state.raidingSide} · on mat ${state.A.onCourt}v${state.B.onCourt}${dod}`;
  },

  /** Rebuild state from the stored event log, skipping derived events. */
  replay(params: MatchParams, events: ScoreEvent[]): KabaddiState {
    let s = kabaddiScoring.initialState(params);
    const derivedTypes = new Set<string>([
      KABADDI_EVENTS.ALL_OUT,
      KABADDI_EVENTS.DO_OR_DIE_FAIL,
      KABADDI_EVENTS.REVIVE,
      KABADDI_EVENTS.SUPER_TACKLE,
    ]);
    for (const e of [...events].sort((x, y) => x.seq - y.seq)) {
      // Derived events were generated by `apply`; re-applying would double-count.
      // A super tackle entered directly by the Scorer carries no `upgradedFrom`.
      if (derivedTypes.has(e.type) && e.detail?.upgradedFrom !== undefined) continue;
      if (e.type === KABADDI_EVENTS.ALL_OUT || e.type === KABADDI_EVENTS.REVIVE) continue;
      if (e.type === KABADDI_EVENTS.DO_OR_DIE_FAIL) continue;
      const res = kabaddiScoring.apply(s, {
        type: e.type,
        side: e.side,
        value: e.value,
        clockSecs: e.clockSecs,
        participantId: e.participantId,
        detail: e.detail,
      });
      s = res.state;
    }
    return s;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Template
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Senior match defaults: two 20-minute halves with a 5-minute interval.
 *
 * League points default to the federation convention of 2 for a win, 1 for a
 * tie, 0 for a loss, with no losing bonus. The franchise-league convention
 * (5/3/0 plus a bonus point for losing by 7 or fewer) is available as the
 * `franchise-league` preset — see `presets` below.
 */
const SENIOR_DEFAULTS: MatchParams = {
  durationMins: 45, // 20 + 5 interval + 20
  periods: 2,
  periodMins: 20,
  breakMins: 5,
  tieBreakMode:
    'League: tie shares points. Knockout: two 5-minute extra halves, then a single golden raid each way.',
  pointsWin: 2,
  pointsDraw: 1,
  pointsLoss: 0,
  bonusPointMargin: undefined,
  pointsBonus: 0,
  slotMins: 60, // 45 play + 15 turnaround
};

export const kabaddi: SportConfigTemplate<KabaddiState> = {
  sportId: 'kabaddi',
  name: 'Kabaddi',
  fopType: 'mat',
  participationTypes: ['team'],
  disciplines: ['Team Kabaddi', 'Circle Style (Punjabi)', 'Beach Kabaddi'],
  matchDefaults: SENIOR_DEFAULTS,

  presets: {
    /** Junior and sub-junior halves are commonly shortened. */
    'junior-15min': { periodMins: 15, durationMins: 35, slotMins: 50 },
    /** Franchise-league scoring, including the losing-bonus point. */
    'franchise-league': {
      pointsWin: 5,
      pointsDraw: 3,
      pointsLoss: 0,
      bonusPointMargin: 7,
      pointsBonus: 1,
    },
    /** Knockout matches must produce a winner. */
    'knockout-golden-raid': {
      tieBreakMode: 'Two 5-minute extra halves, then a single golden raid each way.',
      pointsDraw: 0,
    },
  },

  /**
   * §7.3.15 — a match cannot move to Check-in until the minimum panel is
   * filled. The full panel follows the standard match-officials complement.
   */
  officials: {
    panel: [
      { role: 'Referee', count: 1, qualificationGrade: 'A' },
      { role: 'Umpire', count: 2, qualificationGrade: 'B' },
      { role: 'Scorer', count: 1 },
      { role: 'Assistant Scorer', count: 2 },
      { role: 'Time Keeper', count: 1 },
      { role: 'Match Commissioner', count: 1, qualificationGrade: 'A' },
    ],
    minimumToStart: [
      { role: 'Referee', count: 1 },
      { role: 'Umpire', count: 2 },
      { role: 'Scorer', count: 1 },
    ],
  },

  /** §5.7 tie-breaker hierarchy, applied strictly in this order (§7.5.22). */
  tieBreakers: [
    { key: 'points', label: 'League points', higherIsBetter: true },
    {
      key: 'headToHead',
      label: 'Head-to-head result',
      higherIsBetter: true,
      requiresHeadToHead: true,
    },
    { key: 'scoreDiff', label: 'Score difference', higherIsBetter: true },
    { key: 'scoreFor', label: 'Total points scored', higherIsBetter: true },
    { key: 'wins', label: 'Matches won', higherIsBetter: true },
    { key: 'fairPlay', label: 'Fewer cards (fair play)', higherIsBetter: true },
    { key: 'drawOfLots', label: 'Draw of lots', higherIsBetter: true, isDrawOfLots: true },
  ],

  /**
   * Two bronze medals, awarded to both losing semi-finalists, with no bronze
   * play-off. §7.5.24 drives this off the sport config flag, and §9.2 names
   * this as a joint-bronze sport family.
   */
  medalRuleDefault: 'joint-bronze',

  /** §7.2.12 — configurable-default; confirm against the technical handbook. */
  restGap: { hardMins: 30, recommendedMins: 45 },

  categories: {
    age: [
      { key: 'U-14', label: 'Sub-Junior (Under 14)', maxAgeYears: 14, source: 'configurable-default' },
      { key: 'U-17', label: 'Junior (Under 17)', maxAgeYears: 17, source: 'configurable-default' },
      { key: 'U-19', label: 'Youth (Under 19)', maxAgeYears: 19, source: 'configurable-default' },
      { key: 'U-21', label: 'Under 21', maxAgeYears: 21, source: 'configurable-default' },
      { key: 'SENIOR', label: 'Senior', minAgeYears: 17, source: 'configurable-default' },
    ],
    /**
     * Weight limits are set by the organizing federation and revised
     * periodically. These are starting values only — §12.3 exposes them as
     * editable fields and §7.1.5 confirms them at the official weigh-in.
     */
    weight: [
      { key: 'SJB-50', label: 'Sub-Junior Boys up to 50 kg', maxWeightKg: 50, gender: 'M', source: 'configurable-default' },
      { key: 'SJG-40', label: 'Sub-Junior Girls up to 40 kg', maxWeightKg: 40, gender: 'W', source: 'configurable-default' },
      { key: 'JB-65', label: 'Junior Boys up to 65 kg', maxWeightKg: 65, gender: 'M', source: 'configurable-default' },
      { key: 'JG-55', label: 'Junior Girls up to 55 kg', maxWeightKg: 55, gender: 'W', source: 'configurable-default' },
      { key: 'YB-75', label: 'Youth Boys up to 75 kg', maxWeightKg: 75, gender: 'M', source: 'configurable-default' },
      { key: 'SM-85', label: 'Senior Men up to 85 kg', maxWeightKg: 85, gender: 'M', source: 'configurable-default' },
      { key: 'SW-75', label: 'Senior Women up to 75 kg', maxWeightKg: 75, gender: 'W', source: 'configurable-default' },
      { key: 'OPEN', label: 'Open weight', gender: 'Open', source: 'configurable-default' },
    ],
    gender: ['M', 'W'],
  },

  /** Seven on the mat, twelve in the squad. */
  roster: { min: 7, max: SQUAD_MAX, onField: ON_COURT },

  /**
   * §7.4.20 asks for "the sport's standard result" on a walkover but only
   * gives a badminton example. Kabaddi has no single universal forfeit score,
   * so the default records the walkover with no points for or against: a
   * fabricated score would distort the score-difference tie-breaker (§5.7) of
   * every other side in the group. Standard win points are still awarded.
   * Organizing bodies that mandate a nominal score edit this in §12.3.
   */
  walkover: {
    winnerScore: 0,
    loserScore: 0,
    outcomeType: 'walkover',
    note:
      'Walkover recorded without points for/against so the score-difference tie-breaker is not distorted. Standard win points are awarded. Override in Sport & Event Setup if the federation mandates a nominal score.',
  },

  sportMetric: {
    label: 'Score Diff',
    compute: (row) => row.scoreFor - row.scoreAgainst,
  },

  scoring: kabaddiScoring,

  /** Buttons on the §12.9 match console, in the order a Scorer needs them. */
  consoleActions: [
    { type: KABADDI_EVENTS.RAID_TOUCH, label: 'Raid touch', hint: 'Raider touches defender(s) — 1 point each', kind: 'point', defaultValue: 1 },
    { type: KABADDI_EVENTS.RAID_BONUS, label: 'Bonus', hint: 'Bonus line crossed — needs 6+ defenders on the mat', kind: 'point', defaultValue: 1 },
    { type: KABADDI_EVENTS.RAID_EMPTY, label: 'Empty raid', hint: 'No point — third in a row is do-or-die', kind: 'point', defaultValue: 0 },
    { type: KABADDI_EVENTS.TACKLE, label: 'Tackle', hint: 'Raider stopped — auto-upgrades to super tackle at 3 or fewer defenders', kind: 'point', defaultValue: 1 },
    { type: KABADDI_EVENTS.TECHNICAL_POINT, label: 'Technical point', hint: 'Awarded for a rule violation', kind: 'point', defaultValue: 1 },
    { type: KABADDI_EVENTS.CARD_GREEN, label: 'Green card', hint: 'Warning', kind: 'admin' },
    { type: KABADDI_EVENTS.CARD_YELLOW, label: 'Yellow card', hint: 'Two-minute suspension', kind: 'admin' },
    { type: KABADDI_EVENTS.CARD_RED, label: 'Red card', hint: 'Sent off', kind: 'admin' },
    { type: KABADDI_EVENTS.TIMEOUT, label: 'Time out', hint: 'Team time out', kind: 'admin' },
    { type: KABADDI_EVENTS.SUBSTITUTION, label: 'Substitution', hint: 'Player change', kind: 'admin' },
    { type: KABADDI_EVENTS.INJURY, label: 'Injury', hint: 'Injury stoppage', kind: 'admin' },
    { type: KABADDI_EVENTS.PERIOD_END, label: 'End half', hint: 'Half-time or full-time whistle', kind: 'admin' },
  ],
};

register(kabaddi);

/** Import side-effect barrel: importing this registers every bundled sport. */
export default kabaddi;
