/**
 * TMS console shell.
 *
 * Zero build step: plain ES modules, no framework. Each screen exports
 * `render(ctx)` and returns a DOM node, so a screen is a function of state and
 * nothing more. `ctx.api` is the only way to reach the server, and every call
 * carries the acting user, so the server's §3.2 checks are what actually
 * enforce access — the UI only hides what a role cannot do, and never relies
 * on that hiding for security.
 */

import * as screens from './screens/index.js';
import { el, toast } from './ui.js';

const state = {
  user: null,
  users: [],
  tournament: null,
  tournaments: [],
  sports: [],
  sport: null,
  reasonCodes: {},
  reports: [],
  screen: 'dashboard',
  params: {},
  dashboard: null,
};

// ── API client ────────────────────────────────────────────────────────────

/**
 * The transport.
 *
 * Swappable on purpose. The default talks to the Node server over `fetch`;
 * the static build calls `setTransport` with one that runs the very same route
 * table in this tab, against an in-memory store. Either way this file, every
 * screen, and every rule the screens meet are unchanged — the only difference
 * is where the request lands.
 *
 * A transport takes `(method, path, body, userId)` and resolves to
 * `{ status, body }`, mirroring what `handleRequest` returns in `routes.ts`.
 */
async function fetchTransport(method, path, body, userId) {
  const res = await fetch(new URL(path, location.origin), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(userId ? { 'x-tms-user': userId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, body: data, statusText: res.statusText };
}

let transport = fetchTransport;

/** Point the UI at a different host. Used by the static build's bootstrap. */
export function setTransport(next) {
  transport = next;
}

async function request(method, path, body) {
  const { status, body: data, statusText } = await transport(
    method,
    path,
    body,
    state.user ? state.user.userId : undefined,
  );
  if (status < 200 || status >= 300) {
    // The message names the rule that rejected the action. That is exactly
    // what an operator needs to see, so it is surfaced verbatim.
    const message = (data && data.error) || `${status} ${statusText ?? ''}`.trim();
    const err = new Error(message);
    err.status = status;
    throw err;
  }
  return data;
}

const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  /**
   * The whole response rather than just its body — needed by the §10 exports,
   * which carry a content type and a filename alongside their payload.
   */
  async raw(method, p, b) {
    const out = await transport(method, p, b, state.user ? state.user.userId : undefined);
    if (out.status < 200 || out.status >= 300) {
      const err = new Error((out.body && out.body.error) || `${out.status}`);
      err.status = out.status;
      throw err;
    }
    return out;
  },
  /** Run an action, toast the outcome, then re-render. Screens use this. */
  async act(label, fn, { silent = false } = {}) {
    try {
      const out = await fn();
      if (!silent) toast(label ? `${label} — done` : 'Done', 'ok');
      await refresh();
      return out;
    } catch (e) {
      toast(e.message, 'err', 9000);
      return undefined;
    }
  },
};

// ── Navigation ────────────────────────────────────────────────────────────

/**
 * Screen registry. `spec` cites the §12 screen number so the console and the
 * functional document can be read side by side. `roles` is presentation only.
 */
const NAV = [
  {
    group: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard', spec: '§9', roles: '*' },
      { id: 'public', label: 'Public portal', spec: '§12.20', roles: '*' },
    ],
  },
  {
    group: 'Set up',
    items: [
      { id: 'tournament', label: 'Tournament', spec: '§12.1–2', roles: ['Super Admin', 'Tournament Admin', 'Competition Manager', 'Venue Manager'] },
      { id: 'events', label: 'Sport & events', spec: '§12.3', roles: ['Super Admin', 'Tournament Admin', 'Competition Manager'] },
      { id: 'entries', label: 'Entries', spec: '§12.4', roles: ['Super Admin', 'Tournament Admin', 'Competition Manager', 'Team Manager'] },
      { id: 'format', label: 'Format builder', spec: '§12.5', roles: ['Super Admin', 'Tournament Admin', 'Competition Manager'] },
    ],
  },
  {
    group: 'Competition',
    items: [
      { id: 'draw', label: 'Draw console', spec: '§12.6', roles: '*' },
      { id: 'schedule', label: 'Scheduling board', spec: '§12.7', roles: '*' },
      { id: 'officials', label: 'Officials board', spec: '§12.8', roles: ['Super Admin', 'Tournament Admin', 'Competition Manager', 'Venue Manager', 'Technical Official', 'Referee', 'Scorer'] },
      { id: 'matches', label: 'Match console', spec: '§12.9', roles: '*' },
    ],
  },
  {
    group: 'Results',
    items: [
      { id: 'approvals', label: 'Approval queue', spec: '§12.10–11', roles: ['Super Admin', 'Tournament Admin', 'Competition Manager', 'Technical Official'] },
      { id: 'standings', label: 'Standings', spec: '§12.12', roles: '*' },
      { id: 'medals', label: 'Medals', spec: '§12.13', roles: '*' },
      { id: 'protests', label: 'Protests & exceptions', spec: '§12.14', roles: '*' },
    ],
  },
  {
    group: 'Governance',
    items: [
      { id: 'reports', label: 'Reports hub', spec: '§12.15', roles: '*' },
      { id: 'audit', label: 'Audit log', spec: '§12.17', roles: ['Super Admin', 'Tournament Admin', 'Competition Manager', 'Venue Manager', 'Technical Official'] },
      { id: 'access', label: 'Role & access', spec: '§12.18', roles: '*' },
    ],
  },
];

function visibleTo(item, role) {
  return item.roles === '*' || item.roles.includes(role);
}

/** Counts shown as sidebar badges, so pending work is visible without clicking. */
function navCount(id) {
  const d = state.dashboard;
  if (!d) return 0;
  if (id === 'approvals' && d.pendingActions) {
    return (d.pendingActions.resultsAwaitingApproval ?? 0) +
      (d.pendingActions.resultsAwaitingVerification ?? 0) +
      (d.pendingActions.resultsAwaitingEntry ?? 0) +
      (d.pendingActions.correctionsInProgress ?? 0);
  }
  if (id === 'protests' && d.pendingActions) return d.pendingActions.openProtests ?? 0;
  if (id === 'entries' && d.pendingActions) return d.pendingActions.entryOverridesPending ?? 0;
  return 0;
}

function renderNav() {
  const nav = document.getElementById('sidebar');
  nav.replaceChildren(
    ...NAV.map((group) => {
      const items = group.items.filter((i) => visibleTo(i, state.user.role));
      if (!items.length) return el('div');
      return el('div', { class: 'nav-group' }, [
        el('div', { class: 'nav-group-title' }, group.group),
        ...items.map((item) => {
          const count = navCount(item.id);
          return el(
            'button',
            {
              class: 'nav-item',
              type: 'button',
              ...(state.screen === item.id ? { 'aria-current': 'page' } : {}),
              onclick: () => go(item.id),
            },
            [
              el('span', {}, item.label),
              count > 0
                ? el('span', { class: 'nav-count' }, String(count))
                : el('span', { class: 'nav-item-spec' }, item.spec),
            ],
          );
        }),
      ]);
    }),
  );
}

export function go(screen, params = {}) {
  state.screen = screen;
  state.params = params;
  const hash = `#/${screen}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  renderNav();
  renderScreen();
  document.getElementById('main').scrollIntoView({ block: 'start' });
}

function readHash() {
  const m = /^#\/([\w-]+)(?:\?(.*))?$/.exec(location.hash);
  if (!m) return { screen: 'dashboard', params: {} };
  return { screen: m[1], params: Object.fromEntries(new URLSearchParams(m[2] ?? '')) };
}

// ── Rendering ─────────────────────────────────────────────────────────────

function context() {
  return {
    state,
    api,
    go,
    toast,
    user: state.user,
    tournament: state.tournament,
    sport: state.sport,
    params: state.params,
    dashboard: state.dashboard,
    reasonCodes: state.reasonCodes,
  };
}

async function renderScreen() {
  const main = document.getElementById('main');
  const screen = screens[state.screen] ?? screens.dashboard;

  // A screen the current role has no nav entry for is not a crash — say so
  // plainly. The server still enforces access; this only avoids presenting a
  // permission denial as a broken page.
  const navItem = NAV.flatMap((g) => g.items).find((i) => i.id === state.screen);
  if (navItem && !visibleTo(navItem, state.user.role)) {
    main.replaceChildren(
      el('div', {}, [
        el('div', { class: 'page-head' }, [
          el('h1', { class: 'page-title' }, navItem.label),
        ]),
        el('div', { class: 'notice notice-info' }, [
          el('span', { class: 'notice-icon' }, 'i'),
          el('div', { class: 'notice-body' }, [
            el('p', {}, el('strong', {}, `Not available to a ${state.user.role}`)),
            el('p', {}, `The §3.2 permission matrix gives this screen to other roles. Switch acting user above to reach it.`),
          ]),
        ]),
      ]),
    );
    return;
  }

  main.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
  try {
    const node = await screen.render(context());
    main.replaceChildren(node);
  } catch (e) {
    main.replaceChildren(
      el('div', { class: 'notice notice-danger' }, [
        el('span', { class: 'notice-icon' }, '!'),
        el('div', { class: 'notice-body' }, [
          el('p', {}, el('strong', {}, 'This screen could not load')),
          el('p', {}, e.message),
        ]),
      ]),
    );
  }
}

/** Re-pull the dashboard (it drives the sidebar counts) and re-render. */
async function refresh() {
  if (state.tournament) {
    try {
      state.dashboard = await api.get(`/api/tournaments/${state.tournament.tournamentId}/dashboard`);
    } catch {
      state.dashboard = null;
    }
  }
  renderNav();
  await renderScreen();
}

function renderTopbar() {
  const select = document.getElementById('user-select');
  // Named demo users first, then the officials pool, which is long.
  const primary = state.users.filter((u) => !/^OF-/.test(u.userId));
  const officials = state.users.filter((u) => /^OF-/.test(u.userId));
  const option = (u) => el('option', { value: u.userId, ...(u.userId === state.user.userId ? { selected: '' } : {}) }, `${u.name} — ${u.role}`);
  select.replaceChildren(
    el('optgroup', { label: 'Tournament staff' }, primary.map(option)),
    officials.length ? el('optgroup', { label: `Officials on duty (${officials.length})` }, officials.map(option)) : el('span'),
  );
  select.onchange = async () => {
    const next = state.users.find((u) => u.userId === select.value);
    if (!next) return;
    state.user = next;
    localStorage.setItem('tms.user', next.userId);
    // A role change can hide the current screen; fall back to the dashboard.
    const item = NAV.flatMap((g) => g.items).find((i) => i.id === state.screen);
    if (item && !visibleTo(item, next.role)) state.screen = 'dashboard';
    document.getElementById('role-badge').textContent = next.role;
    await refresh();
    toast(`Now acting as ${next.name} (${next.role})`, 'ok');
  };
  document.getElementById('role-badge').textContent = state.user.role;
  const chip = document.getElementById('tournament-chip');
  chip.textContent = state.tournament
    ? `${state.tournament.name} · ${state.tournament.code} · ${state.tournament.status}`
    : 'No tournament';
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  // The static build installs its in-tab transport on the global before
  // importing this module, so the UI never reaches for a server that is not
  // there. With no override, the default `fetch` transport stands.
  if (typeof globalThis.__tmsTransport === 'function') {
    setTransport(globalThis.__tmsTransport);
  }

  const bootstrap = await api.get('/api/bootstrap');
  state.users = bootstrap.users;
  state.tournaments = bootstrap.tournaments;
  state.sports = bootstrap.sports;
  state.sport = bootstrap.sports.find((s) => s.sportId === 'kabaddi') ?? bootstrap.sports[0] ?? null;
  state.reasonCodes = bootstrap.reasonCodes ?? {};
  state.reports = bootstrap.reports ?? [];

  if (!state.users.length) {
    document.getElementById('boot').innerHTML =
      '<div class="boot-card"><p><strong>No data yet.</strong></p>' +
      '<p>Run <code>npm run seed</code> to build the demo Kabaddi tournament, then reload.</p></div>';
    return;
  }

  const saved = localStorage.getItem('tms.user');
  state.user = state.users.find((u) => u.userId === saved)
    ?? state.users.find((u) => u.role === 'Tournament Admin')
    ?? state.users[0];
  state.tournament = state.tournaments[0] ?? null;

  const route = readHash();
  state.screen = route.screen;
  state.params = route.params;

  document.getElementById('boot').hidden = true;
  document.querySelector('.topbar').hidden = false;
  document.querySelector('.layout').hidden = false;

  renderTopbar();
  await refresh();

  addEventListener('popstate', () => {
    const r = readHash();
    state.screen = r.screen;
    state.params = r.params;
    renderNav();
    renderScreen();
  });
}

boot().catch((e) => {
  document.getElementById('boot').innerHTML =
    `<div class="boot-card"><p><strong>Could not start.</strong></p><p>${e.message}</p></div>`;
});
