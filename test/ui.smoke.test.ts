/**
 * Browser smoke test — every screen renders for every role.
 *
 * Skipped unless Playwright is installed, so `npm test` works on a machine
 * without a browser. Run it with `npm run test:ui` after
 * `npm i -D playwright`.
 *
 * What it guards: a screen that throws, a console error, or a permission
 * denial presented as a broken page. It deliberately drives a whole match as
 * well, because the scoring pad is the one screen where a wrong payload is
 * invisible until someone tries it on match day.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { TmsStore } from '../src/store/db.ts';
import { TmsService } from '../src/api/service.ts';
import { createTmsServer } from '../src/api/server.ts';
import { seedKabaddiTournament } from '../src/seed/kabaddi-tournament.ts';

const SCREENS = [
  'dashboard', 'public', 'tournament', 'events', 'entries', 'format', 'draw',
  'schedule', 'officials', 'matches', 'approvals', 'standings', 'medals',
  'protests', 'reports', 'audit', 'access',
];

const ROLES: [string, string][] = [
  ['sa1', 'Super Admin'],
  ['ta1', 'Tournament Admin'],
  ['cm1', 'Competition Manager'],
  ['vm1', 'Venue Manager'],
  ['to1', 'Technical Official'],
  ['sc1', 'Scorer'],
  ['tm-mh', 'Team Manager'],
  ['vw1', 'Viewer'],
];

/** Chromium ships with Playwright; this environment also pre-installs one. */
const CHROMIUM_PATHS = [
  process.env.TMS_CHROMIUM,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter(Boolean) as string[];

let playwright: typeof import('playwright') | undefined;
try {
  playwright = await import('playwright');
} catch {
  playwright = undefined;
}

let server: Server | undefined;
let store: TmsStore | undefined;
let base = '';

before(async () => {
  if (!playwright) return;
  store = new TmsStore(':memory:');
  seedKabaddiTournament(store);
  server = createTmsServer(new TmsService(store));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server!.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  store?.close();
});

describe('browser smoke test', { skip: playwright ? false : 'playwright is not installed (npm i -D playwright)' }, () => {
  test('every screen renders for every role with no page errors', async () => {
    const executablePath = CHROMIUM_PATHS.find((p) => existsSync(p));
    const browser = await playwright!.chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        // A 401/403 from a probing fetch is the server enforcing access, which
        // the screen is expected to handle; anything else is a real fault.
        if (m.type() === 'error' && !/Failed to load resource|favicon|40[0-9]/.test(m.text())) {
          errors.push(`console: ${m.text()}`);
        }
      });

      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.topbar:not([hidden])', { timeout: 20000 });

      const failures: string[] = [];
      for (const [userId, role] of ROLES) {
        await page.evaluate((id) => localStorage.setItem('tms.user', id), userId);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector('.topbar:not([hidden])');
        assert.equal(await page.locator('#role-badge').textContent(), role);

        for (const screen of SCREENS) {
          errors.length = 0;
          await page.evaluate((s) => {
            location.hash = `#/${s}`;
            dispatchEvent(new PopStateEvent('popstate'));
          }, screen);
          await page.waitForFunction(
            () => !document.getElementById('main')!.textContent!.includes('Loading…'),
            { timeout: 20000 },
          );
          const text = await page.locator('#main').textContent();
          if (text?.includes('This screen could not load')) {
            const detail = await page.locator('#main .notice-body p:last-child').textContent().catch(() => '');
            failures.push(`${role} / ${screen}: ${detail}`);
          }
          if (errors.length) failures.push(`${role} / ${screen}: ${errors[0]}`);
        }
      }
      assert.deepEqual(failures, [], `screens failed to render:\n${failures.join('\n')}`);
    } finally {
      await browser.close();
    }
  });

  test('a match can be driven through check-in, scoring and completion', async () => {
    const executablePath = CHROMIUM_PATHS.find((p) => existsSync(p));
    const browser = await playwright!.chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await page.evaluate(() => localStorage.setItem('tms.user', 'sc1'));
      await page.goto(`${base}/#/matches`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.topbar:not([hidden])');
      const settled = () =>
        page.waitForFunction(() => !document.getElementById('main')!.textContent!.includes('Loading…'), { timeout: 20000 });
      await settled();

      // Pick a fixture that has not started.
      const options = await page.$$eval('.filters select option', (os) =>
        os.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' })),
      );
      const target = options.find((o) => /Scheduled/.test(o.text));
      assert.ok(target, 'the demo should contain a fixture still to be played');
      await page.selectOption('.filters select', target!.value);
      await settled();

      const click = async (label: string) => {
        const btn = page.locator(`button:has-text("${label}")`).first();
        assert.ok(await btn.count(), `expected a "${label}" button`);
        await btn.click();
        await page.waitForTimeout(400);
        await settled();
      };

      await click('Open console');
      await click('Confirm attendance');
      await click('Start match');
      assert.match(await page.locator('.scoreboard .badge').first().textContent() ?? '', /Live/);

      const header = () => page.$eval('.sb-mid', (n) => n.textContent!.replace(/\s+/g, ' '));
      const scores = () => page.$$eval('.sb-score', (n) => n.map((x) => Number(x.textContent)));

      // Score a few raids from whichever side is raiding.
      for (let i = 0; i < 4; i++) {
        const raiding = (await header()).match(/by ([AB])/)?.[1];
        await page.locator('.pad-btn:has-text("Raid touch")').nth(raiding === 'A' ? 0 : 1).click();
        await page.waitForTimeout(350);
        await settled();
      }
      const total = (await scores()).reduce((a, b) => a + b, 0);
      assert.ok(total >= 4, `expected at least 4 points recorded, got ${total}`);

      // An illegal action must be refused by the server and surfaced.
      const raiding = (await header()).match(/by ([AB])/)?.[1];
      await page.locator('.pad-btn:has-text("Raid touch")').nth(raiding === 'A' ? 1 : 0).click();
      await page.waitForTimeout(800);
      const toastText = await page.$$eval('.toast', (n) => n.map((x) => x.textContent ?? ''));
      assert.ok(
        toastText.some((t) => /raid point cannot be credited/.test(t)),
        `expected the server's rejection to surface, saw: ${JSON.stringify(toastText)}`,
      );
      assert.equal((await scores()).reduce((a, b) => a + b, 0), total, 'a refused action must not change the score');

      await click('End match');
      assert.match(await page.locator('.scoreboard .badge').first().textContent() ?? '', /Completed/);
    } finally {
      await browser.close();
    }
  });
});
