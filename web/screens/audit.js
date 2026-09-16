/**
 * Audit Log Viewer — §12.17.
 *
 * Filterable, with before and after values. The log is append-only: there is
 * no edit or delete control here because the capability does not exist in the
 * store either, for any role including Super Admin (§7.6.27).
 */

import { badge, card, el, empty, field, input, notice, pageHead, select, table, tile } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const entityType = ctx.params.entityType ?? '';
  const action = ctx.params.action ?? '';
  const entityId = ctx.params.entityId ?? '';

  const q = new URLSearchParams({ limit: '400' });
  if (entityType) q.set('entityType', entityType);
  if (action) q.set('action', action);
  if (entityId) q.set('entityId', entityId);

  const entries = await ctx.api.get(`/api/tournaments/${t.tournamentId}/audit?${q}`);
  const all = await ctx.api.get(`/api/tournaments/${t.tournamentId}/audit?limit=10000`);

  const types = [...new Set(all.map((e) => e.entityType))].sort();
  const actions = [...new Set(all.map((e) => e.action))].sort();
  const withReason = all.filter((e) => e.reasonCode);

  const idInput = input({ value: entityId, placeholder: 'e.g. RES-0004' });

  const scopeNote = {
    'Super Admin': 'Super Admin sees every entry across the system.',
    'Tournament Admin': 'Scoped to this tournament.',
    'Competition Manager': 'Scoped to your sport.',
    'Venue Manager': 'Scoped to your venue.',
    'Technical Official': 'Scoped to your matches.',
  }[ctx.user.role] ?? 'Your role has no audit access.';

  return el('div', {}, [
    pageHead(
      'Audit log',
      'Every create, edit, approve, lock and correction, with the old and new value and the reason code. Append-only for every role, including Super Admin.',
      '§12.17',
    ),

    el('div', { class: 'grid grid-4' }, [
      tile('Entries', all.length, scopeNote),
      tile('Entity types', types.length, types.slice(0, 6).join(', ')),
      tile('Distinct actions', actions.length),
      tile('Reason-coded actions', withReason.length, 'terminal, exception and override actions'),
    ]),
    el('div', { style: 'height:16px' }),

    notice(
      'info',
      'Append-only by construction',
      'There is no edit or delete control on this screen because the store exposes no such operation: the audit table is insert-and-select only, so the rule is enforced structurally rather than by policy (§7.6.27).',
    ),

    card(
      'Filters',
      el('div', { class: 'filters' }, [
        field('Entity type', select([{ value: '', label: 'All' }, ...types.map((x) => ({ value: x, label: x }))], {
          value: entityType, onchange: (v) => ctx.go('audit', { entityType: v, action, entityId }),
        })),
        field('Action', select([{ value: '', label: 'All' }, ...actions.map((x) => ({ value: x, label: x }))], {
          value: action, onchange: (v) => ctx.go('audit', { entityType, action: v, entityId }),
        })),
        field('Entity ID', idInput),
        el('button', { class: 'btn', type: 'button', onclick: () => ctx.go('audit', { entityType, action, entityId: idInput.value }) }, 'Filter'),
        (entityType || action || entityId)
          ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ctx.go('audit') }, 'Clear')
          : null,
      ].filter(Boolean)),
    ),

    card(
      `Entries (${entries.length}${entries.length === 400 ? ', newest 400' : ''})`,
      table(
        [
          { label: 'When', render: (e) => new Date(e.timestamp).toLocaleString() },
          { key: 'userName', label: 'User' },
          { label: 'Role', render: (e) => el('span', { class: 'pill' }, e.role) },
          { key: 'action', label: 'Action', mono: true },
          { key: 'entityType', label: 'Entity' },
          { key: 'entityId', label: 'ID', mono: true },
          { label: 'Old value', render: (e) => truncate(e.oldValue) },
          { label: 'New value', render: (e) => truncate(e.newValue) },
          { label: 'Reason', render: (e) => (e.reasonCode ? el('span', { class: 'badge badge-plain badge-warn' }, e.reasonCode) : '') },
        ],
        entries,
        {
          rowClass: (e) => (e.reasonCode ? 'row-flag' : ''),
          emptyText: 'No entries match these filters',
        },
      ),
      {
        flush: true,
        note: 'A highlighted row carries a reason code — a terminal transition, an exception, an override, an unlock or a correction',
      },
    ),

    card(
      'Action frequency',
      table(
        [
          { label: 'Action', render: ([a]) => el('span', { class: 'mono' }, a) },
          { label: 'Count', num: true, render: ([, n]) => n },
          {
            label: '',
            render: ([a]) => el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('audit', { action: a }) }, 'Filter'),
          },
        ],
        Object.entries(all.reduce((m, e) => ({ ...m, [e.action]: (m[e.action] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]),
      ),
      { flush: true, note: 'Exported as report 13, the audit trail extract (§10.13)' },
    ),
  ]);
}

function truncate(v) {
  if (!v) return '';
  const s = String(v);
  return el('span', { class: 'mono', title: s }, s.length > 60 ? `${s.slice(0, 60)}…` : s);
}
