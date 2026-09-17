/**
 * Static-build entry point.
 *
 * This is the whole trick behind the GitHub Pages demo, and it is worth being
 * precise about what it does and does not do.
 *
 * It does NOT reimplement anything. It loads the compiled domain — the §3.2
 * permission matrix, the §6 status machines, the Kabaddi scoring engine, the
 * draw, scheduler, standings, medal and approval logic, the ten phase gates —
 * and the same route table `server.ts` serves, then points the UI's transport
 * at `handleRequest` running in this tab instead of over HTTP.
 *
 * So every rule you meet on the published page is the real rule. A raid point
 * credited to the defending side is refused by `src/sports/kabaddi.ts`. A
 * Scorer approving their own result is refused by `enforceMakerChecker`. The
 * only thing replaced is storage: `MemoryStore` in place of node:sqlite.
 *
 * What that costs: the store lives in the tab, so a reload starts over from
 * the seeded snapshot, and nothing is shared between visitors. Both are
 * correct for a demo and wrong for a tournament — which is exactly why the
 * banner says so.
 */

import { MemoryStore } from './lib/store/memory.js';
import { TmsService } from './lib/api/service.js';
import { handleRequest } from './lib/api/routes.js';
// A module, not a fetched JSON file. An ES import is the one loading mechanism
// every host allows — some sandboxes (the Claude artifact viewer among them)
// restrict page-initiated fetches, and a demo that cannot load its own data is
// no demo. It costs one extra `export default` at build time.
import snapshot from './seed.js';

const boot = document.getElementById('boot');
const fail = (heading, detail) => {
  boot.innerHTML = `<div class="boot-card"><p><strong>${heading}</strong></p><p>${detail}</p></div>`;
};

try {
  // The seeder runs in Node at build time and dumps the finished store, so the
  // page starts from a genuinely seeded tournament — ten phases already driven
  // through — instead of spending three seconds re-seeding on every load.
  const store = MemoryStore.fromJSON(snapshot);
  const service = new TmsService(store);

  /**
   * The in-tab transport.
   *
   * Same shape as the `fetch` one in app.js: `(method, path, body, userId)`
   * in, `{ status, body }` out. `path` arrives with its query string attached,
   * so it is split here the way a server would.
   */
  globalThis.__tmsTransport = async (method, path, body, userId) => {
    const url = new URL(path, 'http://tms.local');
    const out = await handleRequest(service, {
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      userId,
    });
    return {
      status: out.status,
      body: out.body,
      contentType: out.contentType,
      filename: out.filename,
      statusText: '',
    };
  };

  // Expose the store for the "reset demo" control, and for anyone who opens
  // the console to poke at it.
  globalThis.__tms = { service, store, snapshot };

  // Dynamic import so the transport is installed before app.js boots. A
  // static import would race it.
  await import('./app.js');
} catch (e) {
  fail('Could not start the demo.', e.message);
}
