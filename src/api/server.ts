/**
 * HTTP host.
 *
 * Everything interesting lives in `routes.ts`, which is platform-free. This
 * file does only what node:http requires: read the request, name the acting
 * user, hand it to `handleRequest`, write the response, and serve the static
 * UI. The browser build (`web/local-api.js`) is the same wrapper against the
 * same table, which is why a screen behaves identically with or without a
 * server behind it.
 *
 * Authentication is deliberately out of scope: this module is one part of the
 * GMS, and the GMS owns identity. `resolveUser` reads a header naming the
 * acting user; wiring it to real GMS sessions means replacing that one
 * function.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TmsStore } from '../store/db.ts';
import { ServiceError, TmsService } from './service.ts';
import { handleRequest } from './routes.ts';

const WEB_ROOT = resolve(fileURLToPath(new URL('../../web', import.meta.url)));
const DB_PATH = process.env.TMS_DB ?? resolve(fileURLToPath(new URL('../../data/tms.db', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType = 'application/json; charset=utf-8',
  filename?: string,
): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    // The UI is served from the same origin, so no CORS is needed. Kept
    // explicit so a cross-origin GMS shell has one obvious place to widen it.
    'x-content-type-options': 'nosniff',
    ...(filename ? { 'content-disposition': `attachment; filename="${filename}"` } : {}),
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
 * Name the acting user.
 *
 * The GMS owns authentication. This reads the `x-tms-user` header (or a `?as=`
 * query parameter, which makes the demo's role switcher work without cookies —
 * delete that half before a real deployment). Replace this to wire real
 * sessions.
 */
function actingUserId(req: IncomingMessage, url: URL): string | undefined {
  return (req.headers['x-tms-user'] as string | undefined) ?? url.searchParams.get('as') ?? undefined;
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

    if (!url.pathname.startsWith('/api/')) {
      await serveStatic(url.pathname, res);
      return;
    }

    try {
      const out = await handleRequest(service, {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body: req.method === 'GET' ? {} : await readBody(req),
        userId: actingUserId(req, url),
      });
      send(res, out.status, out.body, out.contentType, out.filename);
    } catch (err) {
      // Only body-reading can throw out here; routes return their own 4xx.
      if (err instanceof ServiceError) {
        send(res, err.status, { error: err.message });
        return;
      }
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
