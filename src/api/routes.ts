/**
 * The route table, and dispatch.
 *
 * Deliberately free of any platform import. `server.ts` wraps this in
 * node:http for the real deployment; the browser build wraps the same table in
 * a function that the UI calls instead of `fetch`. One table, two hosts — so a
 * route cannot exist in one and be missing from the other, and the rules a
 * screen meets are identical either way.
 *
 * Every mutating route resolves the acting user, then delegates to
 * `TmsService`, which enforces the §3.2 matrix. Domain refusals come back as
 * 4xx whose body is the message the operator should read.
 */

import type { User } from '../domain/types.ts';
import { describeMatrix, RECONCILIATIONS } from '../domain/rbac.ts';
import { REASON_CODES } from '../domain/status.ts';
import { listSports } from '../sports/registry.ts';
import '../sports/index.ts';
import { ServiceError, type TmsService } from './service.ts';
import { buildReport, catalogueFor, REPORTS, toCsv, toPrintableHtml } from '../reports/index.ts';

type Handler = (
  ctx: {
    user: User;
    params: Record<string, string>;
    query: URLSearchParams;
    body: Record<string, unknown>;
    service: TmsService;
  },
) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
  /** Routes that do not need a resolved user (the bootstrap payload). */
  anonymous?: boolean;
}

const routes: Route[] = [];
const add = (method: string, path: string, handler: Handler, anonymous = false): void => {
  routes.push({ method, pattern: path.split('/').filter(Boolean), handler, anonymous });
};

function matchRoute(method: string, segments: string[]): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method || route.pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.pattern.length; i++) {
      const p = route.pattern[i] as string;
      const s = segments[i] as string;
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s);
      else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the UI needs to render its role switcher and pickers. */
add('GET', '/api/bootstrap', ({ service }) => ({
  users: service.store.listUsers(),
  tournaments: service.store.listTournaments(),
  sports: listSports().map((s) => ({
    sportId: s.sportId,
    name: s.name,
    fopType: s.fopType,
    disciplines: s.disciplines,
    participationTypes: s.participationTypes,
    matchDefaults: s.matchDefaults,
    presets: Object.keys(s.presets),
    officials: s.officials,
    tieBreakers: s.tieBreakers,
    medalRuleDefault: s.medalRuleDefault,
    restGap: s.restGap,
    categories: s.categories,
    roster: s.roster,
    walkover: s.walkover,
    consoleActions: s.consoleActions,
    sportMetricLabel: s.sportMetric.label,
  })),
  reasonCodes: REASON_CODES,
  reports: REPORTS,
}), true);

add('GET', '/api/rbac/matrix', () => ({ matrix: describeMatrix(), reconciliations: RECONCILIATIONS }), true);

// Tournaments
add('GET', '/api/tournaments', ({ service }) => service.store.listTournaments());
add('POST', '/api/tournaments', ({ user, body, service }) =>
  service.createTournament(user, body as never),
);
add('GET', '/api/tournaments/:id', ({ params, service }) => ({
  tournament: service.store.getTournament(params.id as string),
  events: service.store.listEvents(params.id as string),
  venues: service.store.listVenues(params.id as string),
  officials: service.store.listOfficials(params.id as string),
}));
add('POST', '/api/tournaments/:id/activate', ({ user, params, service }) =>
  service.activateTournament(user, params.id as string),
);
add('POST', '/api/tournaments/:id/status', ({ user, params, body, service }) =>
  service.setTournamentStatus(user, params.id as string, body.status as never, body.reasonCode as string | undefined),
);
add('POST', '/api/tournaments/:id/close', ({ user, params, service }) =>
  service.closeTournament(user, params.id as string),
);
add('GET', '/api/tournaments/:id/dashboard', ({ user, params, service }) =>
  service.dashboard(user, params.id as string),
);
add('GET', '/api/tournaments/:id/audit', ({ user, params, query, service }) => {
  // §3.2 — audit visibility is scoped by role.
  const scope = user.role === 'Super Admin' ? {} : { tournamentId: params.id as string };
  return service.store.queryAudit({
    ...scope,
    tournamentId: params.id as string,
    entityType: query.get('entityType') ?? undefined,
    entityId: query.get('entityId') ?? undefined,
    action: query.get('action') ?? undefined,
    limit: Number(query.get('limit') ?? 200),
  });
});
add('GET', '/api/tournaments/:id/exceptions', ({ params, service }) =>
  service.store.listExceptions(params.id as string),
);
add('GET', '/api/tournaments/:id/protests', ({ service }) => service.store.listProtests());
add('GET', '/api/tournaments/:id/notifications', ({ params, service }) =>
  service.store.listNotifications(params.id as string, 100),
);
add('GET', '/api/tournaments/:id/medal-tally', ({ params, service }) =>
  service.medalTally(params.id as string),
);
add('GET', '/api/tournaments/:id/duty-roster', ({ params, service }) =>
  service.dutyRoster(params.id as string),
);
add('GET', '/api/tournaments/:id/results/queue', ({ user, params, service }) =>
  service.approvalQueue(user, params.id as string),
);
add('GET', '/api/tournaments/:id/matches', ({ params, query, service }) => {
  const date = query.get('date');
  return date
    ? service.store.listMatchesOnDate(params.id as string, date)
    : service.store.listMatchesForTournament(params.id as string);
});

// Events
add('POST', '/api/tournaments/:id/events', ({ user, params, body, service }) =>
  service.addEvent(user, params.id as string, body as never),
);
add('GET', '/api/events/:id', ({ params, service }) => {
  const id = params.id as string;
  return {
    event: service.store.getEvent(id),
    format: service.store.getFormatForEvent(id),
    draw: service.store.getDrawForEvent(id),
    entries: service.store.listEntries(id),
    matches: service.store.listMatches(id),
    results: service.store.listResults(id),
    standings: service.store.listStandings(id),
    medals: service.store.listMedals(id),
    scheduleState: service.store.getScheduleState(id),
    entryGate: service.entryGate(id),
  };
});
add('POST', '/api/events/:id/confirm', ({ user, params, service }) =>
  service.confirmEvent(user, params.id as string),
);

// Entries
add('GET', '/api/events/:id/pool', ({ user, params, service }) =>
  service.eligiblePool(user, params.id as string),
);
add('GET', '/api/events/:id/entries', ({ params, service }) => service.store.listEntries(params.id as string));
add('POST', '/api/events/:id/entries', ({ user, params, body, service }) =>
  service.addEntry(user, params.id as string, body as never),
);
add('POST', '/api/entries/:id/confirm', ({ user, params, service }) =>
  service.confirmEntry(user, params.id as string),
);
add('POST', '/api/entries/:id/override', ({ user, params, body, service }) =>
  service.overrideEntry(user, params.id as string, String(body.reason ?? '')),
);
add('POST', '/api/entries/:id/scratch', ({ user, params, body, service }) =>
  service.scratchEntry(user, params.id as string, String(body.reason ?? '')),
);

// Format
add('POST', '/api/events/:id/format', ({ user, params, body, service }) =>
  service.setFormat(user, params.id as string, body as never),
);
add('POST', '/api/events/:id/format/approve', ({ user, params, service }) =>
  service.approveFormat(user, params.id as string),
);

// Draw
add('POST', '/api/events/:id/draw', ({ user, params, body, service }) =>
  service.generateDraw(user, params.id as string, {
    seedCount: Number(body.seedCount ?? 0),
    separationRule: (body.separationRule as never) ?? 'same-unit-apart-r1',
    byePolicy: (body.byePolicy as never) ?? 'top-seeds',
    rngSeed: String(body.rngSeed ?? `${params.id}:${Date.now().toString(36)}`),
  }),
);
add('POST', '/api/events/:id/draw/adjust', ({ user, params, body, service }) =>
  service.adjustDraw(user, params.id as string, Number(body.fromSlot), Number(body.toSlot)),
);
add('POST', '/api/events/:id/draw/publish', ({ user, params, service }) =>
  service.publishDraw(user, params.id as string),
);
add('GET', '/api/events/:id/draw/verify', ({ user, params, service }) =>
  service.verifyDraw(user, params.id as string),
);

// Schedule
add('POST', '/api/events/:id/schedule', ({ user, params, body, service }) =>
  service.autoSchedule(user, params.id as string, body.primeMatchNos as string[] | undefined),
);
add('GET', '/api/events/:id/conflicts', ({ params, service }) => service.conflicts(params.id as string));
add('POST', '/api/events/:id/schedule/acknowledge', ({ user, params, body, service }) => {
  service.acknowledgeSoftConflicts(user, params.id as string, (body.codes as string[]) ?? []);
  return service.store.getScheduleState(params.id as string);
});
add('POST', '/api/events/:id/schedule/publish', ({ user, params, service }) =>
  service.publishSchedule(user, params.id as string),
);
add('GET', '/api/events/:id/utilisation', ({ params, service }) =>
  service.venueUtilisation(params.id as string),
);

// Standings, medals
add('GET', '/api/events/:id/standings', ({ params, service }) => service.store.listStandings(params.id as string));
add('POST', '/api/events/:id/recompute', ({ params, service }) => service.recomputeEvent(params.id as string));
add('GET', '/api/events/:id/rankings', ({ params, service }) => service.rankings(params.id as string));
add('GET', '/api/events/:id/medals/verify', ({ user, params, service }) =>
  service.verifyMedalList(user, params.id as string),
);
add('POST', '/api/events/:id/medals/generate', ({ user, params, service }) =>
  service.generateMedals(user, params.id as string),
);
add('POST', '/api/events/:id/medals/publish', ({ user, params, body, service }) =>
  service.publishMedals(user, params.id as string, String(body.verifiedBy ?? '')),
);

// Matches and the match console
add('GET', '/api/matches/:id', ({ user, params, service }) => service.matchConsole(user, params.id as string));
add('POST', '/api/matches/:id/officials', ({ user, params, service }) =>
  service.assignOfficials(user, params.id as string),
);
add('POST', '/api/matches/:id/open', ({ user, params, service }) =>
  service.openConsole(user, params.id as string),
);
add('POST', '/api/matches/:id/attendance', ({ user, params, body, service }) =>
  service.recordAttendance(user, params.id as string, (body.attendance as never) ?? []),
);
add('POST', '/api/matches/:id/toss', ({ user, params, body, service }) =>
  service.recordToss(user, params.id as string, body.winner as 'A' | 'B', body.choice as 'court' | 'raid'),
);
add('POST', '/api/matches/:id/start', ({ user, params, service }) =>
  service.startMatch(user, params.id as string),
);
add('POST', '/api/matches/:id/score', ({ user, params, body, service }) =>
  service.recordScore(user, params.id as string, body as never),
);
add('POST', '/api/matches/:id/end', ({ user, params, service }) => service.endMatch(user, params.id as string));
add('POST', '/api/matches/:id/signoff', ({ user, params, service }) =>
  service.refereeSignoff(user, params.id as string),
);
add('POST', '/api/matches/:id/reschedule', ({ user, params, body, service }) =>
  service.reschedule(user, params.id as string, body as never),
);
add('POST', '/api/matches/:id/exception/:kind', ({ user, params, body, service }) =>
  service.applyException(user, params.id as string, params.kind as string, body),
);

// Results
add('POST', '/api/results/:matchId/enter', ({ user, params, body, service }) =>
  service.enterResult(user, params.matchId as string, body as never),
);
add('POST', '/api/results/:matchId/verify', ({ user, params, service }) =>
  service.verifyResult(user, params.matchId as string),
);
add('POST', '/api/results/:matchId/return', ({ user, params, body, service }) =>
  service.returnResult(user, params.matchId as string, String(body.remarks ?? '')),
);
add('POST', '/api/results/:matchId/approve', ({ user, params, body, service }) =>
  service.approveResult(user, params.matchId as string, body.overrideProtestWindowReason as string | undefined),
);
add('POST', '/api/results/:matchId/publish', ({ user, params, service }) =>
  service.publishResult(user, params.matchId as string),
);
add('POST', '/api/results/:matchId/unlock', ({ user, params, body, service }) =>
  service.unlockResult(user, params.matchId as string, String(body.reasonCode ?? ''), String(body.initiatedBy ?? '')),
);
add('POST', '/api/results/:matchId/correct', ({ user, params, body, service }) =>
  service.correctResult(user, params.matchId as string, body as never),
);
add('POST', '/api/results/:matchId/reverify', ({ user, params, service }) =>
  service.reVerifyResult(user, params.matchId as string),
);
add('POST', '/api/results/:matchId/reapprove', ({ user, params, service }) =>
  service.reApproveResult(user, params.matchId as string),
);

// Protests
add('POST', '/api/matches/:id/protest', ({ user, params, body, service }) =>
  service.fileProtest(user, params.id as string, {
    grounds: String(body.grounds ?? ''),
    feePaid: Number(body.feePaid ?? 0),
  }),
);
add('POST', '/api/protests/:id/rule', ({ user, params, body, service }) =>
  service.ruleProtest(user, params.id as string, {
    outcome: body.outcome as 'Upheld' | 'Rejected',
    action: body.action as never,
    text: String(body.text ?? ''),
  }),
);

// Reports
add('GET', '/api/reports', ({ user }) => catalogueFor(user.role));

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteRequest {
  method: string;
  /** Pathname only, e.g. `/api/matches/MCH-0001/score`. */
  path: string;
  query?: URLSearchParams;
  body?: Record<string, unknown>;
  /**
   * The acting user's id, resolved by the host: an `x-tms-user` header on the
   * server, the picker's selection in the browser. Authentication belongs to
   * the host GMS either way — see `resolveUser` in server.ts.
   */
  userId?: string;
}

export interface RouteResponse {
  status: number;
  body: unknown;
  /** Set for the non-JSON report formats. */
  contentType?: string;
  /** Set when the response should download rather than render. */
  filename?: string;
}

const ANONYMOUS: User = { userId: 'anonymous', name: 'anonymous', role: 'Viewer', scope: {} };

function resolve(service: TmsService, userId: string | undefined): User {
  if (!userId) {
    throw new ServiceError(
      'no acting user: send an x-tms-user header or ?as=<userId>. Authentication belongs to the host GMS; see resolveUser in src/api/server.ts',
      401,
    );
  }
  const user = service.store.getUser(userId);
  if (!user) throw new ServiceError(`unknown user "${userId}"`, 401);
  return user;
}

/**
 * §10 report rendering, which negotiates CSV and printable HTML as well as
 * JSON and so does not fit the JSON router.
 */
function runReport(service: TmsService, req: RouteRequest, query: URLSearchParams): RouteResponse {
  const user = resolve(service, req.userId);
  const key = req.path.slice('/api/reports/'.length);
  const def = catalogueFor(user.role).find((r) => r.key === key);
  if (!def) return { status: 403, body: { error: `${user.role} may not run the "${key}" report (§10)` } };

  const tournamentId = query.get('tournamentId') ?? '';
  if (!tournamentId) return { status: 400, body: { error: 'tournamentId is required' } };

  const report = buildReport(service.store, key, {
    tournamentId,
    eventId: query.get('eventId') ?? undefined,
    date: query.get('date') ?? undefined,
    venueId: query.get('venueId') ?? undefined,
    unitId: query.get('unitId') ?? (user.role === 'Team Manager' ? user.scope.unitId : undefined),
    officialId: query.get('officialId') ?? undefined,
    includeProvisional: query.get('includeProvisional') === 'true',
  });

  // §5.8 — every export is logged, because these are controlled documents.
  service.audit.record({
    userId: user.userId, userName: user.name, role: user.role, tournamentId,
    entityType: 'report', entityId: key, action: 'report.export',
    newValue: { format: query.get('format') ?? 'json', rows: report.rows.length },
  });

  const format = query.get('format') ?? 'json';
  if (format === 'csv') {
    return {
      status: 200,
      body: toCsv(report),
      contentType: 'text/csv; charset=utf-8',
      filename: `${key}-${tournamentId}.csv`,
    };
  }
  if (format === 'html' || format === 'print') {
    const t = service.store.getTournament(tournamentId);
    return {
      status: 200,
      body: toPrintableHtml(report, t ? `${t.name} (${t.code})` : tournamentId),
      contentType: 'text/html; charset=utf-8',
    };
  }
  return { status: 200, body: report };
}

/**
 * Run one request against the service.
 *
 * Never throws: a domain refusal becomes a 4xx carrying its own message, which
 * is what the UI shows the operator. That keeps both hosts trivial — neither
 * needs to know which errors mean what.
 */
export async function handleRequest(service: TmsService, req: RouteRequest): Promise<RouteResponse> {
  const query = req.query ?? new URLSearchParams();
  try {
    if (req.path.startsWith('/api/reports/')) return runReport(service, req, query);

    const segments = req.path.split('/').filter(Boolean);
    const found = matchRoute(req.method, segments);
    if (!found) return { status: 404, body: { error: `no route for ${req.method} ${req.path}` } };

    const user = found.route.anonymous ? ANONYMOUS : resolve(service, req.userId);
    const result = await found.route.handler({
      user,
      params: found.params,
      query,
      body: req.body ?? {},
      service,
    });
    return { status: 200, body: result ?? { ok: true } };
  } catch (err) {
    if (err instanceof ServiceError) return { status: err.status, body: { error: err.message } };
    // A domain invariant thrown as a plain Error is still the operator's
    // problem, not a server fault.
    const message = err instanceof Error ? err.message : String(err);
    return { status: 400, body: { error: message } };
  }
}
