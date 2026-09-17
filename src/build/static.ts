/**
 * Build the static bundle.
 *
 * Produces a `dist/` that is the whole module minus the server: the compiled
 * domain, the same route table, the UI, and a seeded store dumped to JSON.
 * GitHub Pages serves it; nothing else is required to run it.
 *
 *   node src/build/static.ts [--out dist]
 *
 * Three steps, in order:
 *   1. `tsc -p tsconfig.static.json` emits src/ to dist/lib as browser ESM.
 *      `rewriteRelativeImportExtensions` turns the `.ts` specifiers into
 *      `.js`, so the emitted modules load in a browser unchanged.
 *   2. Run the real seeder against a `MemoryStore` and dump it to seed.json,
 *      so the page opens on a tournament with ten phases already driven
 *      through rather than re-seeding on every load.
 *   3. Copy `web/`, swap the entry script for `static-boot.js`, and add the
 *      banner that says what this build is and is not.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../store/memory.ts';
import { seedKabaddiTournament } from '../seed/kabaddi-tournament.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argOut = process.argv.indexOf('--out');
const OUT = resolve(ROOT, argOut > -1 ? (process.argv[argOut + 1] as string) : 'dist');

const step = (n: number, what: string): void => console.log(`  ${n}. ${what}`);

/**
 * The banner.
 *
 * Every rule on the page is real — the permission matrix, the Kabaddi engine,
 * the approval chain all run here. What is not real is persistence, so the
 * banner says exactly that rather than letting someone assume their scoring
 * went somewhere.
 */
const BANNER = `<div class="static-banner">
  <strong>Live demo.</strong>
  The real rules run in your browser — the §3.2 permission matrix, the Kabaddi
  scoring engine, the maker–checker approval chain, all of it. Storage is the
  only thing swapped: this tab holds its own copy, so your changes are yours
  alone and a reload starts fresh from the seeded tournament.
  <a href="https://github.com/akash-droid-dev/Tournament-Management-System">Source and docs</a>
</div>`;

const BANNER_CSS = `
/* ── Static-build banner ────────────────────────────────────────────────── */
.static-banner {
  background: #fff8e6;
  border-bottom: 1px solid #e8d9a8;
  color: #5c4a15;
  font-size: 13px;
  line-height: 1.5;
  padding: 8px 20px;
}
.static-banner strong { color: #3d3009; }
.static-banner a { color: #8a5a00; margin-left: 4px; }
@media (prefers-color-scheme: dark) {
  .static-banner { background: #2a2312; border-bottom-color: #4a3f1d; color: #e0d3a8; }
  .static-banner strong { color: #f5ecd0; }
  .static-banner a { color: #e3b94f; }
}
`;

async function main(): Promise<void> {
  console.log('\n  Building the static bundle\n  ────────────────────────────────────────');

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // ── 1. Compile the domain to browser ESM ──────────────────────────────────
  step(1, 'compiling src/ → dist/lib');
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(ROOT, 'tsconfig.static.json'), '--outDir', join(OUT, 'lib')],
    { stdio: 'inherit', cwd: ROOT },
  );

  // ── 2. Seed in Node, dump for the browser ─────────────────────────────────
  step(2, 'seeding a tournament and dumping it to seed.json');
  const store = new MemoryStore();
  const summary = seedKabaddiTournament(store);
  const snapshot = JSON.stringify(store.toJSON());
  await writeFile(join(OUT, 'seed.json'), snapshot);

  // ── 3. Ship the UI ────────────────────────────────────────────────────────
  step(3, 'copying web/ and rewriting the entry point');
  await cp(join(ROOT, 'web'), OUT, { recursive: true });

  const html = await readFile(join(ROOT, 'web/index.html'), 'utf8');
  const staticHtml = html
    // static-boot.js installs the in-tab transport, then imports app.js.
    .replace('<script type="module" src="./app.js"></script>', '<script type="module" src="./static-boot.js"></script>')
    .replace('<body>', `<body>\n${BANNER}`)
    .replace('<title>TMS · Kabaddi</title>', '<title>TMS · Kabaddi — live demo</title>');
  if (staticHtml === html) throw new Error('index.html did not match the expected entry script — the build would ship a page that reaches for a server');
  await writeFile(join(OUT, 'index.html'), staticHtml);

  const css = await readFile(join(ROOT, 'web/styles.css'), 'utf8');
  await writeFile(join(OUT, 'styles.css'), css + BANNER_CSS);

  // Pages runs Jekyll by default, which strips directories beginning with an
  // underscore and can mangle others. This opts out.
  await writeFile(join(OUT, '.nojekyll'), '');

  // A 404 that serves the shell keeps deep links working on Pages, which has
  // no rewrite rules of its own.
  await writeFile(join(OUT, '404.html'), staticHtml);

  const kb = (n: number) => `${Math.round(n / 1024)} kB`;
  console.log('\n  Built');
  console.log(`  out        ${OUT}`);
  const tid = summary.tournamentId;
  const events = store.listEvents(tid);
  const fixtures = store.listMatchesForTournament(tid).length;
  const approved = store.listResultsForTournament(tid).filter((r) => r.resultStatus === 'Approved').length;
  console.log(`  seed       ${kb(snapshot.length)} · ${events.length} event(s), ${fixtures} fixtures, ${approved} approved, ${store.queryAudit({ limit: 100000 }).length} audit entries`);
  console.log(`  entry      index.html → static-boot.js → lib/api/routes.js`);
  console.log('\n  Serve it with any static server, e.g.  npx serve dist\n');
}

await main();
