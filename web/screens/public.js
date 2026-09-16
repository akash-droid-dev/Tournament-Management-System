/**
 * Public / Viewer Portal — §12.20.
 *
 * Read-only, and only published data: fixtures, live scores, results,
 * standings and the medal tally. Anything in draft or awaiting approval is
 * absent, which is what §7.6.25 and §9.6 require.
 */

import { badge, card, el, empty, field, notice, pageHead, select, table, tile } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  const tally = await ctx.api.get(`/api/tournaments/${t.tournamentId}/medal-tally`);
  const matches = await ctx.api.get(`/api/tournaments/${t.tournamentId}/matches`);

  // Published fixtures only, with published results attached.
  const events = detail.events.filter((e) => e.drawStatus === 'Published');
  const published = [];
  const standings = [];
  const medals = [];
  for (const e of events) {
    const data = await ctx.api.get(`/api/events/${e.eventId}`);
    const state = data.scheduleState;
    if (!['Published', 'Amended', 'Final'].includes(state.status)) continue;
    const resultByMatch = new Map(data.results.filter((r) => r.publishedAt).map((r) => [r.matchId, r]));
    for (const m of data.matches) {
      if (m.byeFlag) continue;
      published.push({ event: e, match: m, result: resultByMatch.get(m.matchId) });
    }
    standings.push(...data.standings.map((s) => ({ ...s, discipline: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'}` })));
    medals.push(...data.medals.filter((x) => x.publishedAt).map((x) => ({ ...x, discipline: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'}` })));
  }

  const dates = [...new Set(published.map((p) => p.match.scheduledDate).filter(Boolean))].sort();
  const day = ctx.params.date ?? dates[0] ?? '';
  const live = published.filter((p) => p.match.matchStatus === 'Live');

  const scoreOf = (p) => {
    if (p.match.matchStatus === 'Live') return el('span', { class: 'badge badge-live' }, 'LIVE');
    if (!p.result) return el('span', { class: 'card-note' }, '—');
    const base = `${p.result.finalScore.a} – ${p.result.finalScore.b}`;
    return el('span', { class: 'mono' }, p.result.outcomeType === 'played' ? base : `${base} (${p.result.outcomeType})`);
  };

  /**
   * Public-facing status.
   *
   * §6.2 stops the *match* status at "Completed (Provisional)" because the
   * result lifecycle takes over from there — so the raw status would tell a
   * spectator a finished, approved, published result is provisional. The
   * public label follows the result instead.
   */
  const statusOf = (p) => {
    const m = p.match.matchStatus;
    if (m === 'Live') return badge('Live');
    if (['Walkover', 'Postponed', 'Cancelled', 'Abandoned', 'Disqualified', 'Suspended'].includes(m)) return badge(m);
    if (p.result?.publishedAt) return badge('Final', 'badge-plain badge-ok');
    if (m === 'Completed (Provisional)') return badge('Awaiting result', 'badge-plain badge-warn');
    return badge(m);
  };

  const groups = [...new Set(standings.map((s) => `${s.discipline}|${s.groupId}`))];

  return el('div', {}, [
    pageHead(
      t.name,
      `${t.hostCity} · ${t.season} · organised by ${t.organizingBody}`,
      '§12.20',
    ),

    notice(
      'info',
      'Published data only',
      'This portal shows what has been published: fixtures, live scores, approved and published results, standings and the medal tally. Draws in draft, unapproved results and anything held under protest do not appear here (§7.6.25, §9.6).',
    ),

    el('div', { class: 'grid grid-4' }, [
      tile('Events', events.length, `${detail.events.length - events.length} not yet published`),
      tile('Live now', live.length, live.length ? 'matches in play' : 'no match in play', live.length ? 'is-warn' : ''),
      tile('Results published', published.filter((p) => p.result).length, `of ${published.length} fixtures`),
      tile('Medals awarded', medals.filter((m) => m.medal !== 'none').length, `${tally.length} unit(s) on the tally`),
    ]),
    el('div', { style: 'height:16px' }),

    live.length
      ? card(
          'Live now',
          table(
            [
              { label: 'Fixture', render: (p) => el('span', { class: 'mono' }, p.match.matchNo) },
              { label: 'Event', render: (p) => `${p.event.discipline} ${p.event.genderCategory === 'M' ? 'Men' : 'Women'}` },
              { label: 'Mat', render: (p) => el('span', { class: 'mono' }, p.match.fopId ?? '—') },
              { label: 'Sides', render: (p) => `${p.match.sideA.displayName} v ${p.match.sideB.displayName}` },
              { label: '', render: scoreOf },
            ],
            live,
          ),
          { flush: true },
        )
      : null,

    card(
      'Fixtures & results',
      el('div', {}, [
        dates.length
          ? el('div', { class: 'filters' }, [
              field('Day', select([{ value: '', label: 'All days' }, ...dates.map((d) => ({ value: d, label: d }))], {
                value: day, onchange: (v) => ctx.go('public', { date: v }),
              })),
            ])
          : null,
        table(
          [
            { label: 'Date', render: (p) => p.match.scheduledDate ?? '—' },
            { label: 'Time', render: (p) => el('span', { class: 'mono' }, p.match.scheduledTime ?? '—') },
            { label: 'Fixture', render: (p) => el('span', { class: 'mono' }, p.match.matchNo) },
            { label: 'Event', render: (p) => `${p.event.discipline} ${p.event.genderCategory === 'M' ? 'Men' : 'Women'}` },
            { label: 'Stage', render: (p) => p.match.stage },
            { label: 'Mat', render: (p) => el('span', { class: 'mono' }, p.match.fopId ?? '—') },
            { label: 'Side A', render: (p) => p.match.sideA.displayName },
            { label: 'Side B', render: (p) => p.match.sideB.displayName },
            { label: 'Score', render: scoreOf },
            { label: 'Status', render: statusOf },
          ],
          day ? published.filter((p) => p.match.scheduledDate === day) : published,
          { emptyText: 'No published fixtures yet' },
        ),
      ]),
      { note: 'A fixture with no score is either still to be played or has a result that has not been published' },
    ),

    groups.length
      ? card(
          'Points tables',
          el('div', {}, groups.map((k) => {
            const [discipline, groupId] = k.split('|');
            return el('div', { style: 'margin-bottom:14px' }, [
              el('p', { class: 'card-note', style: 'font-weight:600;margin-bottom:6px' }, `${discipline} — Group ${groupId}`),
              table(
                [
                  { key: 'rank', label: '#', num: true },
                  { key: 'participantName', label: 'Team' },
                  { key: 'played', label: 'P', num: true },
                  { key: 'won', label: 'W', num: true },
                  { key: 'drawn', label: 'D', num: true },
                  { key: 'lost', label: 'L', num: true },
                  { key: 'points', label: 'Pts', num: true },
                  { key: 'scoreFor', label: 'For', num: true },
                  { key: 'scoreAgainst', label: 'Ag', num: true },
                  { key: 'sportMetric', label: standings[0]?.sportMetricLabel ?? 'Diff', num: true },
                  { label: '', render: (s) => (s.qualificationFlag === 'Q' ? badge('Q', 'badge-plain badge-ok') : '') },
                ],
                standings.filter((s) => s.discipline === discipline && s.groupId === groupId),
                { rowClass: (s) => (s.qualificationFlag === 'Q' ? 'row-ok' : '') },
              ),
            ]);
          })),
        )
      : null,

    el('div', { class: 'grid grid-2' }, [
      card(
        'Medal tally',
        tally.length
          ? table(
              [
                { key: 'rank', label: '#', num: true },
                { key: 'unitId', label: 'Unit' },
                { key: 'gold', label: 'Gold', num: true },
                { key: 'silver', label: 'Silver', num: true },
                { key: 'bronze', label: 'Bronze', num: true },
                { key: 'total', label: 'Total', num: true },
              ],
              tally,
            )
          : empty('No medals awarded yet'),
        { flush: true, note: 'Rank is by gold, then silver, then bronze; units level on all three share a rank' },
      ),

      card(
        'Medallists',
        medals.filter((m) => m.medal !== 'none').length
          ? table(
              [
                { key: 'discipline', label: 'Event' },
                { label: 'Medal', render: (m) => badge(m.medal === 'G' ? 'Gold' : m.medal === 'S' ? 'Silver' : 'Bronze', 'badge-plain badge-warn') },
                { key: 'participantName', label: 'Team' },
                { key: 'unitId', label: 'Unit' },
                { label: '', render: (m) => (m.jointFlag ? el('span', { class: 'card-note' }, 'joint award') : '') },
              ],
              medals.filter((m) => m.medal !== 'none'),
            )
          : empty('No medals published yet'),
        { flush: true },
      ),
    ]),
  ]);
}
