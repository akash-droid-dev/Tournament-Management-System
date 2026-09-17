/**
 * Reports Hub — §12.15.
 *
 * The §10 catalogue, filtered to what the acting role may run, with the scope
 * filters each report needs and the three output paths: on screen, CSV, and
 * print-ready HTML for print-to-PDF. Every export is audit-logged server side.
 */

import { badge, card, el, empty, field, notice, pageHead, select, showDocument, table, tile } from '../ui.js';

/**
 * Fetch an export through the API and hand it to the browser.
 *
 * These were plain `<a href="/api/reports/…">` links, which worked only
 * because a server happened to be listening on the same origin. Going through
 * the API client instead means an export obeys the same transport as every
 * other call — so it carries the acting user, still gets its §5.8 audit
 * entry, and works unchanged in the static build where there is no server to
 * link to.
 */
async function deliver(ctx, key, qs, format, label) {
  try {
    const out = await ctx.api.raw('GET', `/api/reports/${key}?${qs}`);
    showDocument({
      title: format === 'csv' ? `${label} — CSV` : `${label} — printable`,
      body: String(out.body),
      kind: format,
    });
  } catch (e) {
    ctx.toast(e.message, 'err', 9000);
  }
}

export async function render(ctx) {
  const t = ctx.tournament;
  const catalogue = await ctx.api.get('/api/reports');
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  const units = [...new Set(t.participatingUnits)];

  const key = ctx.params.key ?? catalogue[0]?.key;
  const def = catalogue.find((r) => r.key === key);

  const f = {};
  f.event = select([{ value: '', label: 'All events' }, ...detail.events.map((e) => ({ value: e.eventId, label: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'}` }))], { value: ctx.params.eventId ?? '' });
  f.date = el('input', { type: 'date', value: ctx.params.date ?? t.startDate });
  f.venue = select([{ value: '', label: 'All venues' }, ...detail.venues.map((v) => ({ value: v.venueId, label: v.name }))], { value: '' });
  f.unit = select(
    ctx.user.role === 'Team Manager'
      ? [{ value: ctx.user.scope.unitId, label: ctx.user.scope.unitId }]
      : [{ value: '', label: 'All units' }, ...units.map((u) => ({ value: u, label: u }))],
    { value: ctx.user.role === 'Team Manager' ? ctx.user.scope.unitId : '' },
  );
  f.provisional = select([{ value: '', label: 'Approved data only' }, { value: 'true', label: 'Include provisional, flagged' }], { value: '' });

  const query = (format) => {
    const p = new URLSearchParams({ tournamentId: t.tournamentId });
    if (f.event.value) p.set('eventId', f.event.value);
    if (def?.scope === 'date' || key === 'schedule-master' || key === 'schedule-venue') p.set('date', f.date.value);
    if (f.venue.value) p.set('venueId', f.venue.value);
    if (f.unit.value) p.set('unitId', f.unit.value);
    if (f.provisional.value && def?.audience === 'internal') p.set('includeProvisional', 'true');
    if (format) p.set('format', format);
    p.set('as', ctx.user.userId);
    return p.toString();
  };

  let preview = null;
  let error = null;
  if (def) {
    try {
      preview = await ctx.api.get(`/api/reports/${key}?${query()}`);
    } catch (e) {
      error = e.message;
    }
  }

  return el('div', {}, [
    pageHead(
      'Reports hub',
      'The full §10 report pack. External reports render from approved and published data only; internal ops reports may include provisional data, flagged as such.',
      '§12.15',
    ),

    el('div', { class: 'grid grid-4' }, [
      tile('Reports available to you', catalogue.length, `of ${ctx.state.reports.length} in the pack`),
      tile('External', catalogue.filter((r) => r.audience === 'external').length, 'approved and published data only'),
      tile('Internal', catalogue.filter((r) => r.audience === 'internal').length, 'may include provisional'),
      tile('Rows in preview', preview?.rows.length ?? 0, def?.name ?? '—'),
    ]),
    el('div', { style: 'height:16px' }),

    card(
      'Catalogue',
      table(
        [
          { key: 'no', label: '#', num: true },
          { key: 'name', label: 'Report' },
          { key: 'purpose', label: 'Purpose' },
          { label: 'Audience', render: (r) => badge(r.audience === 'external' ? 'Published' : 'Draft', 'badge-plain') },
          { label: 'Scope', render: (r) => el('span', { class: 'pill' }, r.scope) },
          { label: 'Formats', render: (r) => el('div', { class: 'pill-row' }, r.formats.map((x) => el('span', { class: 'pill' }, x))) },
          {
            label: '',
            render: (r) =>
              el('button', {
                class: `btn btn-sm${r.key === key ? ' btn-primary' : ''}`,
                type: 'button',
                onclick: () => ctx.go('reports', { key: r.key }),
              }, r.key === key ? 'Selected' : 'Select'),
          },
        ],
        catalogue,
        { rowClass: (r) => (r.key === key ? 'row-ok' : ''), emptyText: 'No reports available to your role' },
      ),
      { flush: true, note: `${ctx.user.role} may run ${catalogue.length} of the ${ctx.state.reports.length} reports in the pack (§10)` },
    ),

    def
      ? card(
          def.name,
          el('div', {}, [
            el('div', { class: 'filters' }, [
              field('Event', f.event),
              ['date'].includes(def.scope) || ['schedule-master', 'schedule-venue'].includes(key) ? field('Date', f.date) : null,
              def.scope === 'venue' ? field('Venue', f.venue) : null,
              def.scope === 'team' ? field('Unit', f.unit) : null,
              def.audience === 'internal' ? field('Provisional data', f.provisional, '§5.8') : null,
              el('div', { style: 'flex:1' }),
              el('button', { class: 'btn', type: 'button', onclick: () => ctx.go('reports', { key, eventId: f.event.value, date: f.date.value }) }, 'Apply filters'),
            ].filter(Boolean)),

            error ? notice('danger', 'Report could not be built', error) : null,

            preview
              ? el('div', {}, [
                  preview.notes.length ? notice('info', 'Notes', preview.notes) : null,
                  preview.rows.length
                    ? table(preview.columns.map((c, i) => ({ label: c, render: (row) => row[i] })), preview.rows.slice(0, 200))
                    : empty('No rows', 'Nothing matches the current filters'),
                  preview.rows.length > 200 ? el('p', { class: 'card-note' }, `Showing the first 200 of ${preview.rows.length} rows; the export contains all of them.`) : null,
                ])
              : null,
          ]),
          {
            note: def.purpose,
            actions: [
              el('button', { class: 'btn', type: 'button', onclick: () => deliver(ctx, key, query('csv'), 'csv', def.name) }, 'View CSV'),
              el('button', { class: 'btn', type: 'button', onclick: () => deliver(ctx, key, query('html'), 'html', def.name) }, 'View printable'),
            ],
          },
        )
      : null,

    notice(
      'info',
      'Every export is logged',
      'The document treats these as controlled documents, so each export writes an audit entry recording who ran which report, in which format, and when (§5.8).',
    ),
  ]);
}
