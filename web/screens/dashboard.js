/**
 * Role-scoped dashboards — §9.1 to §9.6.
 *
 * One screen, six shapes. The server decides what each role may see and
 * returns only that, so this file renders whatever arrived rather than
 * filtering client-side.
 */

import { badge, card, el, empty, fmtDate, notice, pageHead, table, tile } from '../ui.js';

const PHASE_COUNT = 10;

function healthStrip(d) {
  return el('div', { class: 'grid grid-4' }, [
    el('div', { class: 'tile' }, [
      el('p', { class: 'tile-label' }, `Phase ${d.phase.no} of ${PHASE_COUNT}`),
      el('div', { class: 'tile-value', style: 'font-size:16px' }, d.phase.name),
      el('div', { class: 'meter' }, el('div', { class: 'meter-fill', style: `width:${(d.phase.no / PHASE_COUNT) * 100}%` })),
    ]),
    tile('Days remaining', d.daysRemaining, `Ends ${fmtDate(d.tournament.endDate)}`),
    tile('Events completed', `${d.eventsCompleted}/${d.eventsTotal}`, `${d.phase.progressPct}% of fixtures approved`),
    tile('Today', d.today.ongoing, `${d.today.scheduled} scheduled · ${d.today.completed} done · ${d.today.delayed} delayed`,
      d.today.delayed > 0 ? 'is-warn' : ''),
  ]);
}

function adminDashboard(ctx, d) {
  const p = d.pendingActions;
  const a = d.alerts;
  const totalPending = Object.values(p).reduce((x, y) => x + y, 0);

  return el('div', {}, [
    healthStrip(d),
    el('div', { style: 'height:16px' }),

    // §9.1 — "Pending actions queue (primary widget)".
    card(
      'Pending actions',
      el('div', { class: 'grid grid-3' }, [
        tile('Awaiting approval', p.resultsAwaitingApproval, 'Results verified, ready to lock', p.resultsAwaitingApproval ? 'is-warn' : 'is-ok'),
        tile('Awaiting verification', p.resultsAwaitingVerification, 'Entered, needs a Technical Official', p.resultsAwaitingVerification ? 'is-warn' : 'is-ok'),
        tile('Awaiting entry', p.resultsAwaitingEntry, 'Match finished, no result yet', p.resultsAwaitingEntry ? 'is-alert' : 'is-ok'),
        tile('Open protests', p.openProtests, 'Bracket paths frozen until ruled', p.openProtests ? 'is-alert' : 'is-ok'),
        tile('Corrections in progress', p.correctionsInProgress, 'Unlocked, awaiting re-approval', p.correctionsInProgress ? 'is-warn' : 'is-ok'),
        tile('Entry overrides pending', p.entryOverridesPending, 'Blocked entries needing a decision', p.entryOverridesPending ? 'is-warn' : 'is-ok'),
      ]),
      {
        note: totalPending ? `${totalPending} item(s) need a decision from you` : 'Nothing is waiting on you',
        actions: [
          el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('approvals') }, 'Approval queue'),
          el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('protests') }, 'Protests'),
        ],
      },
    ),

    // §9.1 — alerts.
    card(
      'Alerts',
      el('div', {}, [
        a.hardConflicts.length
          ? notice('danger', 'Hard scheduling conflicts block publishing (§7.2.11)',
              a.hardConflicts.map((c) => `${c.discipline}: ${c.hard} hard conflict(s)`))
          : null,
        a.eventsBelowMinimumEntries.length
          ? notice('warn', 'Events below the minimum entries rule (§7.1.6)',
              a.eventsBelowMinimumEntries.map((e) => `${e.discipline}: ${e.confirmed} confirmed against a minimum of ${e.required}`))
          : null,
        a.officialsCoverageGaps.length
          ? notice('warn', 'Fixtures in the next 48 hours without their minimum officials (§7.3.15)',
              a.officialsCoverageGaps.slice(0, 8).map((g) => `${g.matchNo} on ${g.date} ${g.time}: ${g.missing.map((m) => `${m.role} ${m.have}/${m.needed}`).join(', ')}`))
          : null,
        a.overdueResults.length
          ? notice('warn', 'Overdue results', a.overdueResults.map((r) => `${r.matchNo} — awaiting ${r.awaiting}`))
          : null,
        !a.hardConflicts.length && !a.eventsBelowMinimumEntries.length && !a.officialsCoverageGaps.length && !a.overdueResults.length
          ? notice('ok', 'No alerts', 'No hard conflicts, no event short of entries, every fixture in the next 48 hours is staffed, and no result is overdue.')
          : null,
      ]),
    ),

    el('div', { class: 'grid grid-2' }, [
      // §9.1 — publish status by event.
      card(
        'Publish status by event',
        table(
          [
            { key: 'discipline', label: 'Event' },
            { label: 'Draw', render: (r) => badge(r.drawStatus) },
            { label: 'Schedule', render: (r) => badge(r.scheduleStatus) },
            { label: 'Medals', render: (r) => (r.medalsPublished ? badge('Published') : badge('Draft')) },
            {
              label: '',
              render: (r) => el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('draw', { eventId: r.eventId }) }, 'Open'),
            },
          ],
          d.publishStatus,
        ),
        { note: 'Nothing is visible to teams or the public until an authorised role publishes it (design principle 3)' },
      ),

      // §9.1 — medal tally summary.
      card(
        'Medal tally',
        d.medalTally.length
          ? table(
              [
                { key: 'rank', label: '#', num: true },
                { key: 'unitId', label: 'Unit' },
                { key: 'gold', label: 'G', num: true },
                { key: 'silver', label: 'S', num: true },
                { key: 'bronze', label: 'B', num: true },
                { key: 'total', label: 'Total', num: true },
              ],
              d.medalTally,
            )
          : empty('No medals published yet', 'Medals appear here once an event is verified and published (§9.4)'),
        { note: 'Published medals only; rank is by gold, then silver, then bronze' },
      ),
    ]),
  ]);
}

function competitionManagerDashboard(ctx, d) {
  return el('div', {}, [
    healthStrip(d),
    el('div', { style: 'height:16px' }),

    // §9.2 — event pipeline board.
    card(
      'Event pipeline',
      table(
        [
          { key: 'discipline', label: 'Event' },
          { label: 'Status', render: (r) => badge(r.status) },
          { key: 'entries', label: 'Entries', num: true },
          { label: 'Format', render: (r) => (r.formatApproved ? badge('Approved') : badge('Submitted')) },
          { label: 'Draw', render: (r) => badge(r.drawStatus) },
          { key: 'scheduled', label: 'Scheduled', num: true },
          { key: 'inPlay', label: 'In play', num: true },
          { label: 'Completed', num: true, render: (r) => `${r.completed}/${r.total}` },
          {
            label: 'Flags',
            render: (r) => (r.validationFlags.length ? badge(`${r.validationFlags.length} draw error(s)`, 'badge-danger') : ''),
          },
          {
            label: '',
            render: (r) => el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('draw', { eventId: r.eventId }) }, 'Open'),
          },
        ],
        d.pipeline,
      ),
      { note: 'Counts per stage: entries → format → draw → scheduled → in play → completed' },
    ),

    el('div', { class: 'grid grid-2' }, [
      // §9.2 — progression tracker.
      card(
        'Progression tracker',
        el('div', {}, d.progression.map((p) =>
          el('div', { style: 'margin-bottom:12px' }, [
            el('p', { class: 'card-note' }, `${p.eventId}: ${p.resolved} of ${p.total} progression slot(s) filled`),
            p.pending.length
              ? table(
                  [
                    { key: 'matchNo', label: 'Fixture', mono: true },
                    { key: 'side', label: 'Side' },
                    { key: 'waitingOn', label: 'Waiting on', mono: true },
                    { key: 'reason', label: 'Why' },
                  ],
                  p.pending,
                )
              : notice('ok', null, 'Every slot in this event is filled.'),
          ]),
        )),
        { note: 'A protest freezes only its own bracket path; unaffected fixtures keep advancing (§7.4.19)' },
      ),

      card(
        'Warnings to acknowledge',
        d.softWarnings.length
          ? table(
              [
                { key: 'code', label: 'Code', mono: true },
                { key: 'message', label: 'Detail' },
              ],
              d.softWarnings,
            )
          : notice('ok', null, 'No soft conflicts outstanding.'),
        { note: 'Soft conflicts do not block publishing but must be acknowledged explicitly (§7.2.11)' },
      ),
    ]),

    d.officialsCoverage.length
      ? card('Officials coverage gaps, next 48 hours',
          table(
            [
              { key: 'matchNo', label: 'Fixture', mono: true },
              { key: 'date', label: 'Date' },
              { key: 'time', label: 'Time', mono: true },
              { label: 'Missing', render: (r) => r.missing.map((m) => `${m.role} ${m.have}/${m.needed}`).join(', ') },
            ],
            d.officialsCoverage,
          ),
          { note: 'A fixture cannot move to Check-in until its minimum panel is filled (§7.3.15)' })
      : null,
  ]);
}

function venueManagerDashboard(ctx, d) {
  const heatTone = (pct) =>
    pct === 0 ? 'var(--surface-3)' : pct < 40 ? 'var(--info-soft)' : pct < 75 ? 'var(--warn-soft)' : 'var(--danger-soft)';
  const byFop = new Map();
  for (const h of d.heatmap) {
    if (!byFop.has(h.fopId)) byFop.set(h.fopId, []);
    byFop.get(h.fopId).push(h);
  }

  return el('div', {}, [
    healthStrip(d),
    el('div', { style: 'height:16px' }),

    // §9.3 — utilisation heatmap.
    card(
      'Utilisation by field of play',
      byFop.size
        ? el('div', {}, [...byFop.entries()].map(([fopId, cells]) =>
            el('div', { style: 'margin-bottom:10px' }, [
              el('p', { class: 'card-note', style: 'margin-bottom:4px' }, fopId),
              el(
                'div',
                { class: 'heat', style: `grid-template-columns: repeat(${cells.length}, minmax(52px,1fr))` },
                cells.map((c) =>
                  el(
                    'div',
                    {
                      class: 'heat-cell',
                      style: `background:${heatTone(c.pct)}`,
                      title: `${c.date} ${c.session}: ${c.bookedMins} of ${c.availableMins} min booked`,
                    },
                    `${c.pct}%`,
                  ),
                ),
              ),
            ]),
          ))
        : empty('No utilisation data', 'Utilisation appears once fixtures are scheduled on this venue'),
      { note: 'Each cell is one session on one mat. Hover for the booked minutes.' },
    ),

    // §9.3 — today's run sheet.
    card(
      "Today's run sheet",
      table(
        [
          { key: 'time', label: 'Time', mono: true },
          { key: 'fopId', label: 'Mat', mono: true },
          { key: 'matchNo', label: 'Fixture', mono: true },
          { label: 'Sides', render: (r) => `${r.sideA} v ${r.sideB}` },
          { label: 'Status', render: (r) => badge(r.status) },
          { label: 'Officials', render: (r) => el('span', { class: 'card-note' }, r.officials.join(' · ')) },
        ],
        d.runSheet,
        { emptyText: 'Nothing scheduled on your venue today' },
      ),
      { flush: true },
    ),

    d.maintenanceBlocks.length
      ? card('Maintenance windows',
          table(
            [
              { key: 'fopId', label: 'Mat', mono: true },
              { key: 'date', label: 'Date' },
              { label: 'Window', render: (r) => `${r.from}–${r.to}` },
              { key: 'reason', label: 'Reason' },
            ],
            d.maintenanceBlocks,
          ),
          { note: 'The scheduler treats a maintenance window as a hard block' })
      : null,
  ]);
}

function officialDashboard(ctx, d) {
  return el('div', {}, [
    healthStrip(d),
    el('div', { style: 'height:16px' }),

    // §9.4 — my duty schedule.
    card(
      'My duty schedule',
      table(
        [
          { key: 'date', label: 'Date' },
          { key: 'time', label: 'Time', mono: true },
          { key: 'matchNo', label: 'Fixture', mono: true },
          { key: 'role', label: 'Role' },
          { key: 'fopId', label: 'Mat', mono: true },
          { label: 'Sides', render: (r) => `${r.sideA} v ${r.sideB}` },
          { label: 'Status', render: (r) => badge(r.status) },
          {
            label: '',
            render: (r) => el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('matches', { matchId: r.matchId }) }, 'Console'),
          },
        ],
        d.myMatches,
        { emptyText: 'You have no duties in this tournament' },
      ),
      { flush: true, note: 'Deep links open the match console for that fixture (§12.9)' },
    ),

    d.pendingVerifications?.length
      ? card('Results awaiting your verification',
          table(
            [
              { key: 'matchNo', label: 'Fixture', mono: true },
              { label: 'Status', render: (r) => badge(r.status) },
              { key: 'enteredBy', label: 'Entered by', mono: true },
              {
                label: '',
                render: (r) => el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => ctx.go('approvals') }, 'Verify'),
              },
            ],
            d.pendingVerifications,
          ),
          { note: 'You cannot verify a result you entered yourself (§7.4.17)' })
      : null,
  ]);
}

function teamManagerDashboard(ctx, d) {
  return el('div', {}, [
    el('div', { class: 'grid grid-4' }, [
      tile('My unit', d.unit ?? '—', `${d.entries.length} entr${d.entries.length === 1 ? 'y' : 'ies'}`),
      d.nextMatch
        ? tile('Next match', `${d.nextMatch.date ?? ''} ${d.nextMatch.time ?? ''}`.trim() || '—',
            `vs ${d.nextMatch.opponent ?? 'TBD'} on ${d.nextMatch.fopId ?? 'TBD'}`)
        : tile('Next match', '—', 'No upcoming fixture'),
      tile('Protest windows open', d.protestTimers.length, d.protestTimers.length ? 'Act before they close' : 'None',
        d.protestTimers.length ? 'is-warn' : ''),
      tile('Phase', `${d.phase.no}/${PHASE_COUNT}`, d.phase.name),
    ]),
    el('div', { style: 'height:16px' }),

    // §9.5 — protest window timers.
    d.protestTimers.length
      ? card('Protest windows',
          table(
            [
              { key: 'matchNo', label: 'Fixture', mono: true },
              { label: 'Closes in', render: (r) => `${r.remainingMins} min` },
              {
                label: '',
                render: (r) => el('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => ctx.go('protests', { matchId: r.matchId }) }, 'File protest'),
              },
            ],
            d.protestTimers,
          ),
          { note: `A protest must be filed within the window and carries a fee (§8.3)` })
      : null,

    // §9.5 — entry status per event.
    card(
      'My entries',
      table(
        [
          { key: 'discipline', label: 'Event' },
          { key: 'participant', label: 'Team' },
          { label: 'Status', render: (r) => badge(r.status) },
          {
            label: 'Eligibility',
            render: (r) =>
              r.eligibility.length
                ? el('div', {}, r.eligibility.map((c) =>
                    el('div', { class: 'card-note' }, `${c.severity === 'hard' ? '✕' : '⚠'} ${c.message}`),
                  ))
                : badge('Approved'),
          },
        ],
        d.entries,
        { rowClass: (r) => (r.status === 'Blocked' ? 'row-flag' : ''), emptyText: 'No entries yet' },
      ),
      { flush: true },
    ),

    // §9.5 — my team's schedule.
    card(
      'My schedule',
      table(
        [
          { key: 'date', label: 'Date' },
          { key: 'time', label: 'Time', mono: true },
          { key: 'matchNo', label: 'Fixture', mono: true },
          { key: 'fopId', label: 'Mat', mono: true },
          { label: 'Fixture', render: (r) => `${r.sideA} v ${r.sideB}` },
          { label: 'Status', render: (r) => badge(r.status) },
        ],
        d.schedule,
        { emptyText: 'Nothing published for your unit yet' },
      ),
      { flush: true, note: 'Only published fixtures are visible to a Team Manager (§7.6.25)' },
    ),

    card(
      'Notifications',
      table(
        [
          { label: 'When', render: (r) => new Date(r.sentAt).toLocaleString() },
          { key: 'type', label: 'Type', mono: true },
          { label: 'Detail', render: (r) => el('span', { class: 'card-note' }, JSON.stringify(r.payload)) },
        ],
        (d.notifications ?? []).slice(0, 12),
        { emptyText: 'No notifications' },
      ),
      { flush: true },
    ),
  ]);
}

function viewerDashboard(ctx, d) {
  return el('div', {}, [
    notice('info', 'Public view', 'This dashboard shows published data only: fixtures, results, standings and the medal tally. Nothing in draft or awaiting approval is visible here (§9.6, §7.6.25).'),
    el('div', { class: 'grid grid-4' }, [
      tile('Events', d.events.length, `${d.eventsCompleted} completed`),
      tile('Published fixtures', d.fixtures.length),
      tile('Published results', d.results.length),
      tile('Medals awarded', d.medalTally.reduce((n, t) => n + t.total, 0)),
    ]),
    el('div', { style: 'height:16px' }),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.go('public') }, 'Open the public portal'),
    ]),
  ]);
}

export async function render(ctx) {
  if (!ctx.tournament) {
    return el('div', {}, [pageHead('Dashboard', null, '§9'), empty('No tournament', 'Run npm run seed to build the demo tournament')]);
  }
  const d = ctx.dashboard ?? (await ctx.api.get(`/api/tournaments/${ctx.tournament.tournamentId}/dashboard`));

  const byRole = {
    'Super Admin': adminDashboard,
    'Tournament Admin': adminDashboard,
    'Competition Manager': competitionManagerDashboard,
    'Venue Manager': venueManagerDashboard,
    'Technical Official': officialDashboard,
    Referee: officialDashboard,
    Scorer: officialDashboard,
    'Team Manager': teamManagerDashboard,
  };
  const build = byRole[ctx.user.role] ?? viewerDashboard;

  const specRef = {
    'Super Admin': '§9.1', 'Tournament Admin': '§9.1', 'Competition Manager': '§9.2',
    'Venue Manager': '§9.3', 'Technical Official': '§9.4', Referee: '§9.4', Scorer: '§9.4',
    'Team Manager': '§9.5',
  }[ctx.user.role] ?? '§9.6';

  return el('div', {}, [
    pageHead(
      `${ctx.user.role} dashboard`,
      `${d.tournament.name} · ${d.tournament.hostCity} · ${fmtDate(d.tournament.startDate)} to ${fmtDate(d.tournament.endDate)}`,
      specRef,
    ),
    build(ctx, d),
  ]);
}
