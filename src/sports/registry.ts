/**
 * Sport configuration registry — design principle #5.
 *
 * "Sport-configurable, not sport-hardcoded: scoring formats, tie-breakers,
 * medal rules, and classifications are driven by sport configuration
 * templates."
 *
 * Nothing outside `src/sports/` knows what Kabaddi is. The engines ask the
 * registry for a template and drive it through this interface, so adding
 * Volleyball or Wrestling is a new file here plus a `register()` call — no
 * change to the draw, schedule, standings, medal or approval code.
 */

import type {
  GenderCategory,
  MatchParams,
  MedalRule,
  OutcomeType,
  ParticipationType,
  ScoreEvent,
  StandingsRow,
} from '../domain/types.ts';

// MatchParams lives in the domain so the Format and the scoring engine share
// one definition. Re-exported here so sport templates need only this module.
export type { MatchParams };

/** One scoring action a Scorer can record, before the engine validates it. */
export interface ScoreEventInput {
  type: string;
  side: 'A' | 'B';
  /** Points claimed. The engine may correct or derive this. */
  value?: number;
  participantId?: string;
  clockSecs: number;
  detail?: Record<string, string | number | boolean>;
}

export interface ValidationIssue {
  /** 'hard' is rejected at entry (§7.4.16); 'soft' warns the Scorer. */
  severity: 'hard' | 'soft';
  code: string;
  message: string;
}

export interface ValidationResult {
  legal: boolean;
  issues: ValidationIssue[];
}

/** Age / weight classification offered when configuring an event (§2.4). */
export interface CategorySpec {
  key: string;
  label: string;
  /** Upper age bound, evaluated against the tournament's cut-off date (§7.1.2). */
  maxAgeYears?: number;
  minAgeYears?: number;
  /** Upper weight bound in kg, provisional at entry, confirmed at weigh-in. */
  maxWeightKg?: number;
  gender?: GenderCategory;
  /**
   * Where the number comes from. 'configurable-default' means the value is a
   * starting point the organizing body must confirm against its current
   * technical handbook before the tournament goes live.
   */
  source: 'rule-of-play' | 'configurable-default';
}

/** §7.3.15 minimum officials template per match. */
export interface OfficialsTemplate {
  /** Every seat on a full panel. */
  panel: { role: string; count: number; qualificationGrade?: string }[];
  /** Subset that must be filled before the match may move to Check-in. */
  minimumToStart: { role: string; count: number }[];
}

/** One rung of the §5.7 tie-breaker hierarchy, applied in array order. */
export interface TieBreakerSpec {
  key: string;
  label: string;
  /** Higher value ranks first when true. */
  higherIsBetter: boolean;
  /** Needs the full match set (head-to-head) rather than just the row. */
  requiresHeadToHead?: boolean;
  /** §7.5.22 last resort — outcome and witnesses must be recorded. */
  isDrawOfLots?: boolean;
}

export interface ScoringSummary {
  a: number;
  b: number;
  statistics: Record<string, number>;
}

/**
 * The sport-specific live-scoring state machine. `S` is opaque to callers —
 * only the template's own functions interpret it.
 */
export interface SportScoringEngine<S> {
  /** Fresh state at kick-off. */
  initialState(params: MatchParams): S;
  /** §7.4.16 real-time legality validation. */
  validate(state: S, ev: ScoreEventInput): ValidationResult;
  /**
   * Apply an event. `derived` holds events the rules generate automatically
   * (an all-out bonus, a do-or-die concession) so the timeline stays complete.
   */
  apply(state: S, ev: ScoreEventInput): { state: S; derived: ScoreEventInput[] };
  /** Running score plus the statistics block for the §10.6 match report. */
  summarize(state: S): ScoringSummary;
  /** True once the clock and rules say the match is over. */
  isComplete(state: S, params: MatchParams): boolean;
  /** One-line state description for the match console header. */
  describeState(state: S): string;
  /** Rebuild state from a stored event log — used after a page reload. */
  replay(params: MatchParams, events: ScoreEvent[]): S;
}

export interface SportConfigTemplate<S = unknown> {
  sportId: string;
  name: string;
  /** Sport's own name for its playing surface — 'mat', 'court', 'pool'. */
  fopType: string;
  participationTypes: ParticipationType[];
  disciplines: string[];
  matchDefaults: MatchParams;
  /** Alternative rule presets, e.g. federation vs. franchise league points. */
  presets: Record<string, Partial<MatchParams>>;
  officials: OfficialsTemplate;
  tieBreakers: TieBreakerSpec[];
  medalRuleDefault: MedalRule;
  /** §7.2.12 sport-configurable minimum rest gap between a side's matches. */
  restGap: { hardMins: number; recommendedMins: number };
  categories: {
    age: CategorySpec[];
    weight: CategorySpec[];
    gender: GenderCategory[];
  };
  /** Squad limits — `onField` is how many may be in play at once. */
  roster: { min: number; max: number; onField: number };
  /**
   * §7.4.20 standard result generated for a walkover / no-show. The document
   * only gives a badminton example, so the numbers here are a documented
   * default the organizing body confirms.
   */
  walkover: { winnerScore: number; loserScore: number; outcomeType: OutcomeType; note: string };
  /** The league metric shown in standings — 'Score Diff' for Kabaddi. */
  sportMetric: {
    label: string;
    compute(row: Pick<StandingsRow, 'scoreFor' | 'scoreAgainst' | 'played'>): number;
  };
  scoring: SportScoringEngine<S>;
  /** Score-event types the match console renders as buttons, in order. */
  consoleActions: {
    type: string;
    label: string;
    hint: string;
    /** 'point' scores, 'admin' logs without scoring. */
    kind: 'point' | 'admin';
    defaultValue?: number;
  }[];
}

const registry = new Map<string, SportConfigTemplate<never>>();

export function register<S>(template: SportConfigTemplate<S>): void {
  if (registry.has(template.sportId)) {
    throw new Error(`sport "${template.sportId}" is already registered`);
  }
  registry.set(template.sportId, template as unknown as SportConfigTemplate<never>);
}

export function getSport(sportId: string): SportConfigTemplate<never> {
  const t = registry.get(sportId);
  if (!t) {
    const known = [...registry.keys()].join(', ') || 'none';
    // §11 integration rule: a failed lookup blocks the action rather than
    // proceeding on a guess.
    throw new Error(`unknown sport "${sportId}"; registered sports: ${known}`);
  }
  return t;
}

export function listSports(): SportConfigTemplate<never>[] {
  return [...registry.values()];
}

export function isRegistered(sportId: string): boolean {
  return registry.has(sportId);
}
