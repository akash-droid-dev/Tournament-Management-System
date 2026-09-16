/**
 * Seeder CLI: `npm run seed [-- --reset]`.
 *
 * Builds the demo Kabaddi tournament by calling the same service methods the
 * API and UI use, so a successful run is also an end-to-end smoke test of the
 * whole ten-phase lifecycle.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TmsStore } from '../store/db.ts';
import { seedKabaddiTournament } from './kabaddi-tournament.ts';

const DB_PATH = process.env.TMS_DB ?? resolve(fileURLToPath(new URL('../../data/tms.db', import.meta.url)));

const store = new TmsStore(DB_PATH);
if (process.argv.includes('--reset')) {
  store.reset();
  console.log('• existing data cleared');
}

const started = Date.now();
const out = seedKabaddiTournament(store);
const events = store.listEvents(out.tournamentId);
const matches = store.listMatchesForTournament(out.tournamentId);
const results = store.listResultsForTournament(out.tournamentId);

console.log(`\n  Seeded ${store.getTournament(out.tournamentId)?.name} in ${Date.now() - started} ms`);
console.log(`  ────────────────────────────────────────────────────────────`);
console.log(`  tournament   ${out.tournamentId}`);
for (const e of events) {
  const ms = store.listMatches(e.eventId);
  const rs = store.listResults(e.eventId);
  console.log(
    `  ${e.eventId}     ${e.discipline} ${e.genderCategory} · ${e.status} · ` +
      `${store.listEntries(e.eventId).length} entries · ${ms.length} fixtures · ` +
      `${rs.filter((r) => r.resultStatus === 'Approved').length} approved`,
  );
}
console.log(`  fixtures     ${matches.length} (${matches.filter((m) => m.byeFlag).length} bye)`);
console.log(`  results      ${results.filter((r) => r.resultStatus === 'Approved').length} approved, ` +
  `${results.filter((r) => r.resultStatus === 'Under Protest').length} under protest, ` +
  `${results.filter((r) => !['Approved', 'Under Protest'].includes(r.resultStatus)).length} in the chain`);
console.log(`  officials    ${store.listAssignments().length} duty assignments`);
console.log(`  protests     ${store.listProtests().length}`);
console.log(`  exceptions   ${store.listExceptions(out.tournamentId).length}`);
console.log(`  audit        ${store.queryAudit({ tournamentId: out.tournamentId, limit: 100000 }).length} entries`);
console.log(`  users        ${out.users.length} (sign in as any of: ${out.users.slice(0, 6).map((u) => u.userId).join(', ')}, …)`);
console.log(`\n  Notes`);
for (const n of out.notes) console.log(`   • ${n}`);
console.log('');
store.close();
