/**
 * Officials Assignment Board — §12.8.
 *
 * Match list against the official pool, with the reason each candidate was
 * accepted or refused. Showing the refusals is the point: a Competition
 * Manager needs to tell a pool gap from a neutrality block.
 */

import { badge, card, el, empty, field, notice, pageHead, select, table, tile } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  const roster = await ctx.api.get(`/api/tournaments/${t.tournamentId}/duty-roster`);
  const allMatches = await ctx.api.get(`/api/tournaments/${t.tournamentId}/matches`);
  const sport = ctx.sport;
  const canAssign = ['Super Admin', 'Tournament Admin', 'Competition Manager'].includes(ctx.user.role);

  const playable = allMatches.filter((m) => !m.byeFlag);
  const panelSize = sport.officials.panel.reduce((n, p) => n + p.count, 0);
  const minRoles = sport.officials.minimumToStart;

  const panelState = (m) => {
    const have = m.officials ?? [];
    const missing = minRoles
      .map((r) => ({ role: r.role, needed: r.count, have: have.filter((o) => o.role === r.role).length }))
      .filter((x) => x.have < x.needed);
    return { have, missing, complete: have.length >= panelSize };
  };

  const unstaffed = playable.filter((m) => panelState(m).missing.length);
  const neutralityIssues = roster.flatMap((r) => r.duties.filter((d) => d.neutrality === 'fail').map((d) => ({ ...d, officialName: r.officialName })));
  const waived = roster.flatMap((r) => r.duties.filter((d) => d.neutrality === 'waived').map((d) => ({ ...d, officialName: r.officialName })));

  // Load distribution, so the board shows whether duties are spread fairly.
  const load = roster
    .map((r) => ({ officialName: r.officialName, officialId: r.officialId, duties: r.duties.length, byDay: countByDay(r.duties) }))
    .sort((a, b) => b.duties - a.duties);

  const eligibleOf = (role) => detail.officials.filter((o) => o.sports.includes(sport.sportId) && o.roles.includes(role));

  return el('div', {}, [
    pageHead(
      'Officials assignment board',
      'Phase 6 fills each fixture from the officials pool, filtered by sport qualification, certification, grade, accreditation and availability, then applies neutrality, overlap, travel buffer and the per-day cap.',
      '§12.8',
    ),

    el('div', { class: 'grid grid-4' }, [
      tile('Pool', detail.officials.length, `${detail.officials.filter((o) => o.sports.includes(sport.sportId)).length} qualified for ${sport.name}`),
      tile('Duty assignments', roster.reduce((n, r) => n + r.duties.length, 0), `Full panel is ${panelSize} seats per fixture`),
      tile('Fixtures below minimum', unstaffed.length, unstaffed.length ? 'Cannot reach Check-in' : 'All staffed', unstaffed.length ? 'is-alert' : 'is-ok'),
      tile('Neutrality failures', neutralityIssues.length, waived.length ? `${waived.length} waived` : 'None waived', neutralityIssues.length ? 'is-alert' : 'is-ok'),
    ]),
    el('div', { style: 'height:16px' }),

    neutralityIssues.length
      ? notice('danger', 'Neutrality rule breached (§7.3.13)',
          neutralityIssues.map((d) => `${d.officialName} on ${d.matchNo} as ${d.role} — same unit as a participant`))
      : null,

    waived.length
      ? notice('warn', 'Neutrality waived',
          [`${waived.length} assignment(s) carry a waived neutrality check because this tournament level does not enforce it. Each is recorded on the duty roster.`])
      : null,

    unstaffed.length
      ? card(
          'Fixtures below the minimum panel',
          table(
            [
              { key: 'matchNo', label: 'Fixture', mono: true },
              { key: 'scheduledDate', label: 'Date' },
              { key: 'scheduledTime', label: 'Time', mono: true },
              { key: 'fopId', label: 'Mat', mono: true },
              { label: 'Fixture', render: (m) => `${m.sideA.displayName} v ${m.sideB.displayName}` },
              { label: 'Missing', render: (m) => panelState(m).missing.map((x) => `${x.role} ${x.have}/${x.needed}`).join(', ') },
              {
                label: '',
                render: (m) =>
                  canAssign
                    ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => ctx.api.act(`Assigned officials to ${m.matchNo}`, () => ctx.api.post(`/api/matches/${m.matchId}/officials`)) }, 'Auto-assign')
                    : el('span', { class: 'card-note' }, 'Competition Manager'),
              },
            ],
            unstaffed,
            { rowClass: () => 'row-flag' },
          ),
          { flush: true, note: `Minimum to start: ${minRoles.map((r) => `${r.count} ${r.role}`).join(', ')} (§7.3.15)` },
        )
      : notice('ok', 'Every fixture meets its minimum panel', `All ${playable.length} playable fixtures have at least ${minRoles.map((r) => `${r.count} ${r.role}`).join(', ')}.`),

    card(
      'Fixture × panel',
      table(
        [
          { key: 'matchNo', label: 'Fixture', mono: true },
          { key: 'scheduledDate', label: 'Date' },
          { key: 'scheduledTime', label: 'Time', mono: true },
          { label: 'Sides', render: (m) => `${m.sideA.displayName} v ${m.sideB.displayName}` },
          { label: 'Panel', num: true, render: (m) => `${(m.officials ?? []).length}/${panelSize}` },
          {
            label: 'Officials',
            render: (m) =>
              (m.officials ?? []).length
                ? el('div', { class: 'pill-row' }, m.officials.map((o) => el('span', { class: 'pill' }, `${o.role}: ${o.officialName} (${o.unitId})`)))
                : el('span', { class: 'card-note' }, 'none assigned'),
          },
          {
            label: '',
            render: (m) =>
              canAssign
                ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.api.act(`Assigned officials to ${m.matchNo}`, () => ctx.api.post(`/api/matches/${m.matchId}/officials`)) }, 'Fill panel')
                : null,
          },
        ],
        playable,
        {
          rowClass: (m) => (panelState(m).missing.length ? 'row-flag' : panelState(m).complete ? 'row-ok' : ''),
          emptyText: 'No fixtures yet',
        },
      ),
      { flush: true },
    ),

    el('div', { class: 'grid grid-2' }, [
      card(
        'Duty load per official',
        table(
          [
            { key: 'officialName', label: 'Official' },
            { key: 'duties', label: 'Duties', num: true },
            { label: 'Busiest day', num: true, render: (r) => Math.max(0, ...Object.values(r.byDay)) },
            {
              label: 'Per day',
              render: (r) => el('div', { class: 'pill-row' }, Object.entries(r.byDay).map(([d, n]) => el('span', { class: 'pill' }, `${d.slice(5)}: ${n}`))),
            },
          ],
          load,
          {
            rowClass: (r) => (Math.max(0, ...Object.values(r.byDay)) > 4 ? 'row-flag' : ''),
            emptyText: 'No duties assigned',
          },
        ),
        { flush: true, note: 'The engine caps an official at four matches a day and prefers a fresher official, so load spreads rather than piling on the first eligible name (§6.6)' },
      ),

      card(
        'Pool by seat',
        table(
          [
            { key: 'role', label: 'Seat' },
            { key: 'count', label: 'Needed per fixture', num: true },
            { label: 'Grade required', render: (p) => p.qualificationGrade ?? 'any' },
            { label: 'Certified in pool', num: true, render: (p) => eligibleOf(p.role).length },
            {
              label: 'Meeting the grade',
              num: true,
              render: (p) =>
                eligibleOf(p.role).filter((o) => !p.qualificationGrade || (o.grade ?? 'Z') <= p.qualificationGrade).length,
            },
          ],
          sport.officials.panel,
        ),
        { flush: true, note: `${playable.length} fixtures × ${panelSize} seats = ${playable.length * panelSize} seat-assignments needed in total` },
      ),
    ]),

    card(
      'Duty roster',
      table(
        [
          { key: 'officialName', label: 'Official' },
          { key: 'role', label: 'Role' },
          { key: 'matchNo', label: 'Fixture', mono: true },
          { key: 'date', label: 'Date' },
          { key: 'time', label: 'Time', mono: true },
          { label: 'Report by', render: (d) => (d.reportTime ? new Date(d.reportTime).toISOString().slice(11, 16) : '—') },
          { key: 'fopId', label: 'Mat', mono: true },
          { label: 'Neutrality', render: (d) => badge(d.neutrality) },
          { label: 'Status', render: (d) => badge(d.status) },
        ],
        roster.flatMap((r) => r.duties.map((d) => ({ ...d, officialName: r.officialName }))),
        {
          rowClass: (d) => (d.neutrality === 'fail' ? 'row-flag' : ''),
          emptyText: 'No duties assigned yet',
        },
      ),
      { flush: true, note: 'Exported as report 5, including the neutrality confirmation per assignment (§10.5)' },
    ),
  ]);
}

function countByDay(duties) {
  const out = {};
  for (const d of duties) if (d.date) out[d.date] = (out[d.date] ?? 0) + 1;
  return out;
}
