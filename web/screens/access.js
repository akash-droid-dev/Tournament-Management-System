/**
 * Role & Access Management — §12.18.
 *
 * Renders the §3.2 matrix the system actually enforces, and — more usefully —
 * shows every place that matrix had to be reconciled against the §4 phase
 * tables, with both citations. A Business Analyst can check the calls without
 * reading the code.
 */

import { badge, card, el, empty, notice, pageHead, table, tile } from '../ui.js';

export async function render(ctx) {
  const data = await ctx.api.get('/api/rbac/matrix');
  const matrix = data.matrix;
  const reconciliations = data.reconciliations;
  const roles = matrix[0]?.cells.map((c) => c.role) ?? [];
  const users = ctx.state.users;

  const grid = el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Function'),
        ...roles.map((r) => el('th', {}, r.replace(' ', ' '))),
      ])),
      el('tbody', {}, matrix.map((row) =>
        el('tr', {}, [
          el('td', {}, [row.label, el('div', { class: 'card-note mono' }, row.fn)]),
          ...row.cells.map((c) =>
            el('td', { class: 'mono', style: c.reconciled ? 'background:var(--warn-soft)' : c.display === '—' ? 'color:var(--text-3)' : '' },
              [c.display, c.reconciled ? el('span', { class: 'spec-ref' }, 'reconciled') : null]),
          ),
        ]),
      )),
    ]),
  ]);

  return el('div', {}, [
    pageHead(
      'Role & access management',
      'The permission matrix the system enforces, the scope each role is narrowed to, and every place the document contradicted itself.',
      '§12.18',
    ),

    el('div', { class: 'grid grid-4' }, [
      tile('Roles', roles.length, '§3.1 role definitions'),
      tile('Functions', matrix.length, '§3.2 matrix rows'),
      tile('Reconciliations', reconciliations.length, 'conflicts between §3.2 and §4'),
      tile('Users', users.length, `${new Set(users.map((u) => u.role)).size} distinct roles in use`),
    ]),
    el('div', { style: 'height:16px' }),

    notice(
      'info',
      'Legend',
      'C create · E edit · A approve · P publish · L lock or unlock · V view · — no access. A parenthesis narrows the grant, for example "C (own-entries)". A named verb — verify, recommend, unlock, rule — is the matrix\'s own wording for an action that is not one of the letters. An amber cell is one this build had to reconcile.',
    ),

    card('Permission matrix', grid, {
      note: 'Transcribed cell by cell from §3.2. Every API route and every UI action is checked against this table.',
    }),

    card(
      'Reconciliations against the phase tables',
      reconciliations.length
        ? el('div', {}, reconciliations.map((r) =>
            el('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' }, [
              el('p', { style: 'margin:0 0 6px' }, [
                el('strong', {}, `${r.role} — ${r.fn}`),
                el('span', { class: 'spec-ref' }, `+${r.add.join('')}`),
              ]),
              el('dl', { class: 'kv' }, [
                el('dt', {}, 'Matrix says'), el('dd', {}, r.matrixSays),
                el('dt', {}, 'Phase table says'), el('dd', {}, r.phaseSays),
                el('dt', {}, 'Call made'), el('dd', {}, r.rationale),
              ]),
            ]),
          ))
        : empty('No reconciliations'),
      {
        note: 'These are resolved in favour of the phase tables, because those describe the operative workflow. Both citations are kept so the call can be checked.',
      },
    ),

    card(
      'Structural rule applied to the whole matrix',
      el('div', {}, [
        el('dl', { class: 'kv' }, [
          el('dt', {}, 'Rule'), el('dd', {}, el('strong', {}, 'Any of C, E, A, P or L implies V')),
          el('dt', {}, 'Why'), el('dd', {}, '§3.2 lists Tournament Admin as "A P" on draw generation and schedule allocation, and "A L" on result approval, with no V. Read literally, an Admin could not open the draw they are required to approve — yet §5.6 has them approve and publish it, §12.6 names them a primary user of the Draw Console, and §9.1 builds their dashboard from the same data.'),
          el('dt', {}, 'Scope'), el('dd', {}, 'Applied once as a notation rule rather than as twenty corrected cells. It never widens access: a role with no cell at all still has none, and scope and qualifiers still apply.'),
        ]),
      ]),
      { note: 'This is the one gap in the document that is systemic rather than a handful of wrong cells' },
    ),

    card(
      'Key permission rules',
      el('ul', { style: 'margin:0;padding-left:20px' }, [
        el('li', {}, [el('strong', {}, 'Maker–checker. '), 'The user who entered a result can never verify or approve it. A two-step chain additionally requires the verifier and the approver to differ, and a correction requires a third pair of hands to re-verify.']),
        el('li', {}, [el('strong', {}, 'Publishing is restricted. '), 'Only a Tournament Admin or Super Admin may publish a draw, a schedule, a result or a medal list. Competition Managers prepare; Admins publish.']),
        el('li', {}, [el('strong', {}, 'Unlock needs a reason. '), 'Unlocking an approved result requires Tournament Admin or Super Admin and a reason code, and the initiator cannot approve their own unlock.']),
        el('li', {}, [el('strong', {}, 'Team Managers see only their own. '), 'Unpublished data is never visible beyond a Team Manager\'s own entries; all cross-team data becomes visible only on publish.']),
        el('li', {}, [el('strong', {}, 'High-impact actions need two roles. '), 'Unlocks, redraws, cancellations, mass reschedules and disqualification cascades all require a second-role ratification and a reason code.']),
      ]),
      { note: 'The five prose rules under the §3.2 matrix, each enforced by its own named function' },
    ),

    card(
      'Users and scope',
      table(
        [
          { key: 'userId', label: 'User ID', mono: true },
          { key: 'name', label: 'Name' },
          { label: 'Role', render: (u) => el('span', { class: 'pill' }, u.role) },
          {
            label: 'Scope',
            render: (u) => {
              const parts = [];
              if (u.scope.tournamentIds?.length) parts.push(`tournaments: ${u.scope.tournamentIds.join(', ')}`);
              if (u.scope.sportIds?.length) parts.push(`sports: ${u.scope.sportIds.join(', ')}`);
              if (u.scope.venueIds?.length) parts.push(`venues: ${u.scope.venueIds.join(', ')}`);
              if (u.scope.unitId) parts.push(`unit: ${u.scope.unitId}`);
              return parts.length ? el('span', { class: 'card-note' }, parts.join(' · ')) : el('span', { class: 'card-note' }, 'unscoped');
            },
          },
        ],
        users.filter((u) => !/^OF-/.test(u.userId)),
      ),
      { flush: true, note: 'A role is narrowed by scope: a Competition Manager to their sport, a Venue Manager to their venue, a Team Manager to their unit (§3.1)' },
    ),
  ]);
}
