/**
 * HTTP API.
 *
 * A small router over node:http — no framework, so the module has no runtime
 * dependencies. Every mutating route resolves the acting user, then delegates
 * to `TmsService`, which enforces the §3.2 matrix. Domain errors surface as
 * 4xx with the rule that rejected them, because those messages are what the UI
 * shows the operator.
 *
 * Authentication is deliberately out of scope: this module is one part of the
 * GMS, and the GMS owns identity. `resolveUser` reads a header naming the
 * acting user and looks them up in the store, which is enough for the module
 * to be driven and tested. Wiring it to real GMS sessions means replacing that
 * one function.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { User } from '../domain/types.ts';
import { describeMatrix, RECONCILIATIONS } from '../domain/rbac.ts';
import { REASON_CODES } from '../domain/status.ts';
import { listSports } from '../sports/registry.ts';
import '../sports/index.ts';
import { TmsStore } from '../store/db.ts';
import { ServiceError, TmsService } from './service.ts';
import { buildReport, catalogueFor, REPORTS, toCsv, toPrintableHtml } from '../reports/index.ts';

const WEB_ROOT = resolve(fileURLToPath(new URL('../../web', import.meta.url)));
const DB_PATH = process.env.TMS_DB ?? resolve(fileURLToPath(new URL('../../data/tms.db', import.meta.url)));

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
// Server
// ─────────────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    // The UI is served from the same origin, so no CORS is needed. Kept
    // explicit so a cross-origin GMS shell has one obvious place to widen it.
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // A scoresheet-sized payload is generous; anything larger is a mistake.
    if (size > 2_000_000) throw new ServiceError('request body too large', 413);
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ServiceError('request body is not valid JSON', 400);
  }
}

/**
 * Identify the acting user.
 *
 * The GMS owns authentication. This reads the `x-tms-user` header (or a
 * `?as=` query parameter, which makes the UI's role switcher work without
 * cookies) and looks the user up. Replace this function to wire real sessions.
 */
function resolveUser(req: IncomingMessage, url: URL, service: TmsService): User {
  const id = (req.headers['x-tms-user'] as string | undefined) ?? url.searchParams.get('as') ?? '';
  if (!id) {
    throw new ServiceError(
      'no acting user: send an x-tms-user header or ?as=<userId>. Authentication belongs to the host GMS; see resolveUser in src/api/server.ts',
      401,
    );
  }
  const user = service.store.getUser(id);
  if (!user) throw new ServiceError(`unknown user "${id}"`, 401);
  return user;
}

/** Serve the web UI. Paths are normalized so nothing escapes WEB_ROOT. */
async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(join(WEB_ROOT, normalize(rel)));
  if (!target.startsWith(WEB_ROOT)) {
    send(res, 403, { error: 'forbidden path' });
    return;
  }
  try {
    const data = await readFile(target);
    send(res, 200, data.toString('utf8'), MIME[extname(target)] ?? 'application/octet-stream');
  } catch {
    // Single-page app: unknown non-API paths fall back to the shell.
    if (!extname(target)) {
      try {
        const shell = await readFile(join(WEB_ROOT, 'index.html'));
        send(res, 200, shell.toString('utf8'), MIME['.html'] as string);
        return;
      } catch {
        /* fall through */
      }
    }
    send(res, 404, { error: `not found: ${pathname}` });
  }
}

export function createTmsServer(service: TmsService) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    try {
      // Report rendering sits outside the JSON router because it negotiates
      // CSV and printable HTML as well as JSON.
      if (pathname.startsWith('/api/reports/')) {
        const user = resolveUser(req, url, service);
        const key = pathname.slice('/api/reports/'.length);
        const def = catalogueFor(user.role).find((r) => r.key === key);
        if (!def) {
          send(res, 403, { error: `${user.role} may not run the "${key}" report (§10)` });
          return;
        }
        const tournamentId = url.searchParams.get('tournamentId') ?? '';
        if (!tournamentId) {
          send(res, 400, { error: 'tournamentId is required' });
          return;
        }
        const report = buildReport(service.store, key, {
          tournamentId,
          eventId: url.searchParams.get('eventId') ?? undefined,
          date: url.searchParams.get('date') ?? undefined,
          venueId: url.searchParams.get('venueId') ?? undefined,
          unitId: url.searchParams.get('unitId') ?? (user.role === 'Team Manager' ? user.scope.unitId : undefined),
          officialId: url.searchParams.get('officialId') ?? undefined,
          includeProvisional: url.searchParams.get('includeProvisional') === 'true',
        });
        // §5.8 — every export is logged for controlled documents.
        service.audit.record({
          userId: user.userId, userName: user.name, role: user.role, tournamentId,
          entityType: 'report', entityId: key, action: 'report.export',
          newValue: { format: url.searchParams.get('format') ?? 'json', rows: report.rows.length },
        });
        const format = url.searchParams.get('format') ?? 'json';
        if (format === 'csv') {
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${key}-${tournamentId}.csv"`,
          });
          res.end(toCsv(report));
          return;
        }
        if (format === 'html' || format === 'print') {
          const t = service.store.getTournament(tournamentId);
          send(res, 200, toPrintableHtml(report, t ? `${t.name} (${t.code})` : tournamentId), MIME['.html'] as string);
          return;
        }
        send(res, 200, report);
        return;
      }

      if (pathname.startsWith('/api/')) {
        const segments = pathname.split('/').filter(Boolean);
        const found = matchRoute(req.method ?? 'GET', segments);
        if (!found) {
          send(res, 404, { error: `no route for ${req.method} ${pathname}` });
          return;
        }
        const user = found.route.anonymous
          ? ({ userId: 'anonymous', name: 'anonymous', role: 'Viewer', scope: {} } as User)
          : resolveUser(req, url, service);
        const body = req.method === 'GET' ? {} : await readBody(req);
        const result = await found.route.handler({
          user,
          params: found.params,
          query: url.searchParams,
          body,
          service,
        });
        send(res, 200, result ?? { ok: true });
        return;
      }

      await serveStatic(pathname, res);
    } catch (err) {
      if (err instanceof ServiceError) {
        send(res, err.status, { error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // Domain invariants thrown as plain Errors are still the operator's
      // problem, not a server fault — report them as a bad request.
      send(res, 400, { error: message });
    }
  });
}

/** Entry point for `npm start`. */
async function main(): Promise<void> {
  const store = new TmsStore(DB_PATH);
  const service = new TmsService(store);
  const port = Number(process.env.PORT ?? 4321);
  const server = createTmsServer(service);
  server.listen(port, () => {
    const t = store.listTournaments()[0];
    console.log(`\n  TMS module — Kabaddi\n  ────────────────────────────────────────`);
    console.log(`  UI    http://localhost:${port}/`);
    console.log(`  API   http://localhost:${port}/api/bootstrap`);
    console.log(`  DB    ${DB_PATH}`);
    console.log(`  Data  ${t ? `${t.name} (${t.code}) — ${store.listEvents(t.tournamentId).length} event(s)` : 'empty — run `npm run seed` first'}\n`);
  });
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  await main();
}
