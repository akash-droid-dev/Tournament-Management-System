/**
 * Standings & Progression — §12.12.
 *
 * Live points tables with the tie-break explainer the screen list asks for,
 * plus the bracket with its auto-filled slots and the reason any slot is still
 * blocked.
 */

import { badge, card, el, empty, field, notice, pageHead, select, table, tile } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  if (!detail.events.length) return el('div', {}, [pageHead('Standings', null, '§12.12'), empty('No events')]);

  const eventId = ctx.params.eventId ?? detail.events[0].eventId;
  const data = await ctx.api.get(`/api/events/${eventId}`);
  const sport = ctx.sport;
  const rows = data.standings;
  const format = data.format;
  const canRecompute = ['Super Admin', 'Tournament Admin', 'Competition Manager'].includes(ctx.user.role);

  const groups = [...new Set(rows.map((r) => r.groupId))].sort();
  const mp = format?.matchParams ?? sport.matchDefaults;

  const tableFor = (groupId) =>
    table(
      [
        { key: 'rank', label: '#', num: true },
        { key: 'participantName', label: 'Team' },
        { key: 'unitId', label: 'Unit' },
        { key: 'played', label: 'P', num: true },
        { key: 'won', label: 'W', num: true },
        { key: 'drawn', label: 'D', num: true },
        { key: 'lost', label: 'L', num: true },
        { key: 'points', label: 'Pts', num: true },
        { key: 'scoreFor', label: 'For', num: true },
        { key: 'scoreAgainst', label: 'Ag', num: true },
        { key: 'sportMetric', label: rows[0]?.sportMetricLabel ?? sport.sportMetricLabel, num: true },
        ...(mp.bonusPointMargin ? [{ key: 'bonusPoints', label: 'Bon', num: true }] : []),
        { label: 'Q/E', render: (r) => (r.qualificationFlag === 'Q' ? badge('Q', 'badge-plain badge-ok') : r.qualificationFlag === 'E' ? badge('E', 'badge-plain badge-neutral') : el('span', { class: 'card-note' }, 'undecided')) },
        {
          label: 'Tie-break',
          render: (r) => (r.tiebreakNotes.length ? el('div', {}, r.tiebreakNotes.map((n) => el('div', { class: 'card-note' }, n))) : '—'),
        },
      ],
      rows.filter((r) => r.groupId === groupId),
      { rowClass: (r) => (r.qualificationFlag === 'Q' ? 'row-ok' : ''), emptyText: 'No matches counted yet' },
    );

  // Progression: which knockout slots are filled and which are waiting.
  const placeholders = data.matches.flatMap((m) =>
    ['sideA', 'sideB']
      .map((k) => ({ m, side: k === 'sideA' ? 'A' : 'B', s: m[k] }))
      .filter((x) => x.s.kind === 'placeholder' || x.s.kind === 'placeholder-standing'),
  );

  return el('div', {}, [
    pageHead(
      'Standings & progression',
      'Points tables recompute on every result approval and every correction, and are never hand-edited. Tie-breakers run strictly in the configured order, and the rung that separated each row is recorded.',
      '§12.12',
    ),

    el('div', { class: 'filters' }, [
      field('Event', select(detail.events.map((e) => ({ value: e.eventId, label: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'}` })), {
        value: eventId, onchange: (v) => ctx.go('standings', { eventId: v }),
      })),
      el('div', { style: 'flex:1' }),
      canRecompute
        ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.api.act('Recomputed', () => ctx.api.post(`/api/events/${eventId}/recompute`)) }, 'Recompute now')
        : null,
    ]),

    el('div', { class: 'grid grid-4' }, [
      tile('League points', `${mp.pointsWin} / ${mp.pointsDraw} / ${mp.pointsLoss}`, 'win / tie / loss'),
      tile('Standings metric', rows[0]?.sportMetricLabel ?? sport.sportMetricLabel, 'used as the third tie-breaker'),
      tile('Groups', groups.length || '—', `${rows.length} row(s)`),
      tile('Qualified', rows.filter((r) => r.qualificationFlag === 'Q').length, 'flagged Q once a group is decided'),
    ]),
    el('div', { style: 'height:16px' }),

    rows.length
      ? el('div', {}, groups.map((g) => card(`Group ${g}`, tableFor(g), { flush: true })))
      : card('Points table', empty('No standings yet', 'A points table appears once results in a group stage are approved'), {
          note: 'A knockout event has no points table; see the bracket on the draw console',
        }),

    card(
      'Tie-breaker hierarchy',
      el('ol', { style: 'margin:0;padding-left:20px' }, sport.tieBreakers.map((tb, i) =>
        el('li', { style: 'margin-bottom:5px' }, [
          el('strong', {}, tb.label),
          tb.requiresHeadToHead ? el('span', { class: 'card-note' }, ' — counted only among the sides still tied') : null,
          tb.isDrawOfLots ? el('span', { class: 'card-note' }, ' — last resort; the outcome and at least two witnesses are recorded') : null,
        ]),
      )),
      {
        note: 'Applied strictly in this order. If every rung is exhausted the row says so and demands a recorded draw of lots (§7.5.22).',
      },
    ),

    rows.some((r) => r.tiebreakNotes.some((n) => n.includes('exhausted')))
      ? notice('warn', 'A tie survived the whole hierarchy',
          rows.filter((r) => r.tiebreakNotes.some((n) => n.includes('exhausted'))).map((r) => `${r.participantName}: ${r.tiebreakNotes.join('; ')}`))
      : null,

    card(
      'Progression tracker',
      placeholders.length
        ? table(
            [
              { label: 'Fixture', render: (p) => el('span', { class: 'mono' }, p.m.matchNo) },
              { key: 'side', label: 'Side' },
              { label: 'Waiting for', render: (p) => p.s.displayName },
              { label: 'Stage', render: (p) => p.m.stage },
              { label: 'Kind', render: (p) => (p.s.kind === 'placeholder-standing' ? 'group table' : 'match winner/loser') },
            ],
            placeholders,
          )
        : notice('ok', 'Every progression slot is filled', 'No fixture in this event is waiting on another.'),
      {
        flush: !!placeholders.length,
        note: 'A result Under Protest freezes only its own bracket path; unaffected fixtures keep advancing (§7.4.19)',
      },
    ),
  ]);
}
