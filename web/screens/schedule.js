/**
 * Scheduling Board — §12.7.
 *
 * A field-of-play × time grid with conflict badges. The distinction the
 * document draws is the one the board makes loudest: hard conflicts block
 * publishing, soft ones must be acknowledged explicitly (§7.2.11).
 */

import { badge, card, el, empty, field, gateList, notice, pageHead, prompt, select, table, tile } from '../ui.js';

const SESSIONS = [
  { session: 'morning', from: 9 * 60, to: 13 * 60 },
  { session: 'afternoon', from: 14 * 60, to: 18 * 60 },
  { session: 'evening', from: 18 * 60 + 30, to: 22 * 60 },
];
const SLOT_MINS = 60;

const toMins = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  if (!detail.events.length) return el('div', {}, [pageHead('Scheduling board', null, '§12.7'), empty('No events')]);

  const eventId = ctx.params.eventId ?? detail.events[0].eventId;
  const data = await ctx.api.get(`/api/events/${eventId}`);
  const conflicts = await ctx.api.get(`/api/events/${eventId}/conflicts`);
  const matches = data.matches.filter((m) => !m.byeFlag);
  const state = data.scheduleState;
  const canSchedule = ['Super Admin', 'Tournament Admin', 'Competition Manager', 'Venue Manager'].includes(ctx.user.role);
  const canPublish = ['Super Admin', 'Tournament Admin'].includes(ctx.user.role);

  const fops = detail.venues.flatMap((v) => v.fopList.map((f) => ({ ...f, venueName: v.name })));
  const dates = [...new Set(matches.map((m) => m.scheduledDate).filter(Boolean))].sort();
  const day = ctx.params.date ?? dates[0] ?? t.startDate;

  const unacknowledged = conflicts.soft.filter((c) => !state.acknowledgedSoft.includes(c.code));

  // ── Grid ────────────────────────────────────────────────────────────────
  const slots = [];
  for (const s of SESSIONS) for (let m = s.from; m < s.to; m += SLOT_MINS) slots.push({ mins: m, session: s.session });

  const onDay = matches.filter((m) => m.scheduledDate === day);
  const cellFor = (fopId, slotMins) =>
    onDay.filter((m) => {
      if (m.fopId !== fopId || !m.scheduledTime) return false;
      const start = toMins(m.scheduledTime);
      return start >= slotMins && start < slotMins + SLOT_MINS;
    });

  const blockedAt = (fopId, slotMins) =>
    detail.venues.some((v) =>
      v.maintenanceBlocks.some(
        (b) => b.fopId === fopId && b.date === day && toMins(b.from) < slotMins + SLOT_MINS && slotMins < toMins(b.to),
      ),
    );

  const conflictedMatchNos = new Set([...conflicts.hard, ...conflicts.soft].flatMap((c) => c.matchNos));

  const grid = el(
    'div',
    { class: 'sched-grid', style: `grid-template-columns: 64px repeat(${Math.max(1, fops.length)}, minmax(150px, 1fr))` },
    [
      el('div', { class: 'sched-cell sched-head' }, 'Time'),
      ...fops.map((f) => el('div', { class: 'sched-cell sched-head' }, f.name)),
      ...slots.flatMap((slot) => [
        el('div', { class: 'sched-cell sched-time' }, toTime(slot.mins)),
        ...fops.map((f) => {
          if (blockedAt(f.fopId, slot.mins)) {
            return el('div', { class: 'sched-cell sched-blocked' }, 'MAINTENANCE');
          }
          const here = cellFor(f.fopId, slot.mins);
          return el('div', { class: 'sched-cell' }, here.map((m) =>
            el(
              'button',
              {
                class: 'sched-fixture',
                type: 'button',
                style: conflictedMatchNos.has(m.matchNo) ? 'border-left-color:var(--danger);background:var(--danger-soft)' : '',
                title: `${m.matchNo} ${m.scheduledTime} · ${m.sideA.displayName} v ${m.sideB.displayName}`,
                onclick: () => ctx.go('matches', { matchId: m.matchId }),
              },
              [
                el('div', { class: 'sched-fixture-no' }, `${m.matchNo} · ${m.scheduledTime} · ${m.stage}`),
                el('div', {}, `${m.sideA.displayName} v ${m.sideB.displayName}`),
              ],
            ),
          ));
        }),
      ]),
    ],
  );

  const doReschedule = async (m) => {
    const answers = await prompt({
      title: `Reschedule ${m.matchNo}`,
      confirmLabel: 'Propose new slot',
      fields: [
        { name: 'toDate', label: 'New date', type: 'date', value: m.scheduledDate ?? day, required: true },
        { name: 'toTime', label: 'New time', type: 'time', value: m.scheduledTime ?? '09:00', required: true },
        { name: 'toFopId', label: 'Field of play', type: 'select', options: fops.map((f) => ({ value: f.fopId, label: f.name })) },
        { name: 'reasonCode', label: 'Reason code', type: 'select', options: (ctx.reasonCodes.schedule ?? []).map((c) => ({ value: c, label: c })) },
      ],
    });
    if (!answers) return;
    await ctx.api.act(`Rescheduled ${m.matchNo}`, () => ctx.api.post(`/api/matches/${m.matchId}/reschedule`, answers));
  };

  return el('div', {}, [
    pageHead(
      'Scheduling board',
      'Phase 6 assigns date, time and field of play against venue availability, round order and the rest gap, then reports every conflict it could not avoid.',
      '§12.7',
    ),

    el('div', { class: 'filters' }, [
      field('Event', select(detail.events.map((e) => ({ value: e.eventId, label: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'}` })), {
        value: eventId, onchange: (v) => ctx.go('schedule', { eventId: v }),
      })),
      dates.length
        ? field('Day', select(dates.map((d) => ({ value: d, label: d })), { value: day, onchange: (v) => ctx.go('schedule', { eventId, date: v }) }))
        : null,
      el('div', { style: 'flex:1' }),
      el('span', {}, badge(state.status)),
      state.publishedAt ? el('span', { class: 'badge badge-plain badge-neutral' }, `version ${state.versionNo}`) : null,
    ]),

    el('div', { class: 'grid grid-4' }, [
      tile('Fixtures', matches.length, `${matches.filter((m) => m.scheduledDate).length} placed`),
      tile('Hard conflicts', conflicts.hard.length, conflicts.hard.length ? 'Blocks publishing' : 'None', conflicts.hard.length ? 'is-alert' : 'is-ok'),
      tile('Soft conflicts', conflicts.soft.length, `${unacknowledged.length} unacknowledged`, unacknowledged.length ? 'is-warn' : ''),
      tile('Fields of play', fops.length, detail.venues.map((v) => v.name).join(', ')),
    ]),
    el('div', { style: 'height:16px' }),

    conflicts.hard.length
      ? notice('danger', 'Hard conflicts must be resolved before the schedule can be published (§7.2.11)',
          conflicts.hard.map((c) => `${c.code}: ${c.message}`))
      : null,

    unacknowledged.length
      ? card(
          'Soft conflicts awaiting acknowledgment',
          table(
            [
              { key: 'code', label: 'Code', mono: true },
              { key: 'message', label: 'Detail' },
              { label: 'Fixtures', render: (c) => el('span', { class: 'mono' }, c.matchNos.join(', ')) },
            ],
            unacknowledged,
          ),
          {
            flush: true,
            note: 'Soft conflicts do not block publishing, but the document requires an explicit acknowledgment rather than silence (§7.2.11)',
            actions: canSchedule
              ? [el('button', { class: 'btn btn-primary', type: 'button', onclick: () =>
                  ctx.api.act('Acknowledged', () => ctx.api.post(`/api/events/${eventId}/schedule/acknowledge`, { codes: [...new Set(unacknowledged.map((c) => c.code))] })) },
                  'Acknowledge all')]
              : [],
          },
        )
      : null,

    card(`Grid — ${day}`, el('div', { class: 'sched' }, fops.length ? grid : empty('No fields of play mapped')), {
      note: 'A red fixture carries a conflict. Click any fixture to open its console.',
      actions: [
        canSchedule
          ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.api.act('Auto-scheduled', () => ctx.api.post(`/api/events/${eventId}/schedule`, {})) }, 'Run auto-scheduler')
          : null,
        canPublish && !conflicts.hard.length && !unacknowledged.length
          ? el('button', { class: 'btn btn-ok', type: 'button', onclick: () => ctx.api.act('Schedule published', () => ctx.api.post(`/api/events/${eventId}/schedule/publish`)) },
              state.publishedAt ? 'Republish schedule' : 'Publish schedule')
          : null,
      ].filter(Boolean),
    }),

    card(
      'All fixtures',
      table(
        [
          { key: 'matchNo', label: 'Fixture', mono: true },
          { key: 'stage', label: 'Stage' },
          { label: 'Group', render: (m) => m.groupId ?? '—' },
          { key: 'scheduledDate', label: 'Date' },
          { key: 'scheduledTime', label: 'Time', mono: true },
          { key: 'fopId', label: 'Mat', mono: true },
          { key: 'session', label: 'Session' },
          { label: 'Fixture', render: (m) => `${m.sideA.displayName} v ${m.sideB.displayName}` },
          { label: 'Status', render: (m) => badge(m.matchStatus) },
          { label: 'Ver.', num: true, render: (m) => m.versionNo },
          {
            label: '',
            render: (m) =>
              el('div', { class: 'btn-row' }, [
                canPublish ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => doReschedule(m) }, 'Reschedule…') : null,
                el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('matches', { matchId: m.matchId }) }, 'Console'),
              ]),
          },
        ],
        matches,
        {
          rowClass: (m) => (conflictedMatchNos.has(m.matchNo) ? 'row-flag' : ''),
          emptyText: 'No fixtures yet — publish a draw first',
        },
      ),
      {
        flush: true,
        note: 'A published fixture is immutable: a reschedule creates a new version and keeps the prior slot in history (§7.2.10)',
      },
    ),

    matches.some((m) => m.rescheduleHistory?.length)
      ? card('Reschedule history',
          table(
            [
              { label: 'Fixture', render: (r) => el('span', { class: 'mono' }, r.matchNo) },
              { label: 'From', render: (r) => `${r.h.fromDate ?? '—'} ${r.h.fromTime ?? ''} ${r.h.fromFopId ?? ''}`.trim() },
              { label: 'To', render: (r) => `${r.h.toDate} ${r.h.toTime} ${r.h.toFopId}` },
              { label: 'Reason', render: (r) => el('span', { class: 'mono' }, r.h.reasonCode) },
              { label: 'Requested / approved', render: (r) => `${r.h.requestedBy} → ${r.h.approvedBy}` },
              { label: 'At', render: (r) => new Date(r.h.at).toLocaleString() },
            ],
            matches.flatMap((m) => (m.rescheduleHistory ?? []).map((h) => ({ matchNo: m.matchNo, h }))),
          ),
          { flush: true })
      : null,
  ]);
}
