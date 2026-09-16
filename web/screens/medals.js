/**
 * Medal Management — §12.13.
 *
 * Final ranking review, the medal rules engine's output, the §9.3 verification
 * checklist, and the publish control. Publication is gated: medals cannot be
 * published while any result is unapproved or under protest, or while an
 * integrity flag sits on a medallist.
 */

import { badge, card, el, empty, field, notice, pageHead, prompt, select, table, tile } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  if (!detail.events.length) return el('div', {}, [pageHead('Medals', null, '§12.13'), empty('No events')]);

  const eventId = ctx.params.eventId ?? detail.events[0].eventId;
  const data = await ctx.api.get(`/api/events/${eventId}`);
  const rankings = await ctx.api.get(`/api/events/${eventId}/rankings`);
  const tally = await ctx.api.get(`/api/tournaments/${t.tournamentId}/medal-tally`);
  const ev = data.event;
  const stored = data.medals;
  const canGenerate = ['Super Admin', 'Tournament Admin', 'Competition Manager'].includes(ctx.user.role);
  const canPublish = ['Super Admin', 'Tournament Admin'].includes(ctx.user.role);
  const published = stored.some((m) => m.publishedAt);

  // Read-only: the checklist is the engine's own verification result, fetched
  // without persisting anything. Rendering a screen must never write — calling
  // the generator here would overwrite a published medal list with a freshly
  // derived, unpublished one.
  let verification = null;
  try {
    verification = await ctx.api.get(`/api/events/${eventId}/medals/verify`);
  } catch (e) {
    verification = { ok: false, blockers: [e.message], warnings: [], rows: rankings };
  }

  const medalRow = (r) => ({
    position: r.position,
    name: r.participantName,
    unit: r.unitId,
    medal: r.medal,
    joint: r.jointFlag,
    dq: r.dqAnnotation,
    state: r.publishedAt ? 'published' : 'unpublished',
  });

  const doPublish = async () => {
    const a = await prompt({
      title: 'Publish the medal list',
      confirmLabel: 'Approve & publish',
      fields: [
        {
          name: 'verifiedBy',
          label: 'Verified by (Technical Official user ID)',
          type: 'text',
          required: true,
          hint: 'Must differ from you: the verifier cannot also be the approver (§3.2 maker–checker)',
        },
      ],
    });
    if (!a) return;
    await ctx.api.act('Medals published', () => ctx.api.post(`/api/events/${eventId}/medals/publish`, a));
  };

  return el('div', {}, [
    pageHead(
      'Medal management',
      'Phase 9 derives the final ranking from the bracket or the points table, applies the sport medal rule, and gates publication behind a verification checklist.',
      '§12.13',
    ),

    el('div', { class: 'filters' }, [
      field('Event', select(detail.events.map((e) => ({ value: e.eventId, label: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'}` })), {
        value: eventId, onchange: (v) => ctx.go('medals', { eventId: v }),
      })),
      el('div', { style: 'flex:1' }),
      el('span', { class: 'badge badge-plain badge-neutral' }, `Medal rule: ${ev.medalRule}`),
      published ? badge('Published') : badge('Draft'),
    ]),

    ev.medalRule === 'joint-bronze'
      ? notice('info', 'Joint bronze',
          'Both losing semi-finalists take bronze and no bronze play-off is held. This comes from the Kabaddi sport template, not from the medal code (§7.5.24).')
      : null,

    verification
      ? verification.ok
        ? notice('ok', 'Verification checklist passed',
            'Every playable fixture has an Approved result, no protest is open, the podium is complete, and no medallist carries an integrity flag (§7.5.23).')
        : notice('danger', 'Medals cannot be published yet', verification.blockers)
      : null,

    verification?.warnings?.length ? notice('warn', 'Data-quality warnings', verification.warnings) : null,

    el('div', { class: 'grid grid-2' }, [
      card(
        'Final ranking',
        table(
          [
            { key: 'position', label: '#', num: true },
            { key: 'name', label: 'Participant' },
            { key: 'unit', label: 'Unit' },
            { label: 'Medal', render: (r) => (r.medal === 'none' ? el('span', { class: 'card-note' }, '—') : badge(r.medal === 'G' ? 'Gold' : r.medal === 'S' ? 'Silver' : 'Bronze', 'badge-plain badge-warn')) },
            { label: 'Joint', render: (r) => (r.joint ? 'joint award' : '') },
            { key: 'dq', label: 'DQ note' },
            { label: 'State', render: (r) => (r.state === 'published' ? badge('Published') : badge('Draft')) },
          ],
          (stored.length ? stored : rankings).map(medalRow),
          { emptyText: 'No ranking yet' },
        ),
        {
          flush: true,
          note: 'Positions 1..N derived from the bracket, or from the points table for a pure league (§9.1)',
          actions: [
            canGenerate ? el('button', { class: 'btn', type: 'button', onclick: () => ctx.api.act('Rankings regenerated', () => ctx.api.post(`/api/events/${eventId}/medals/generate`)) }, 'Regenerate') : null,
            canPublish && verification?.ok && !published
              ? el('button', { class: 'btn btn-ok', type: 'button', onclick: doPublish }, 'Verify & publish…')
              : null,
          ].filter(Boolean),
        },
      ),

      el('div', {}, [
        card(
          'Verification checklist',
          el('ul', { class: 'gate' }, [
            ...(verification?.blockers ?? []).map((b) => el('li', { class: 'gate-fail' }, [el('span', { class: 'gate-mark' }, '✕'), el('span', {}, b)])),
            ...(verification?.ok
              ? [
                  ['Every playable fixture has an Approved result', 'No protest is open on this event', 'The podium is complete for the medal rule', 'No medallist carries a doping or DQ flag']
                    .map((s) => el('li', { class: 'gate-pass' }, [el('span', { class: 'gate-mark' }, '✓'), el('span', {}, s)]))
                ].flat()
              : []),
          ]),
          { note: '§9.3 has the Technical Official verify, then the Tournament Admin approves and publishes' },
        ),

        card(
          'Medal tally',
          tally.length
            ? table(
                [
                  { key: 'rank', label: '#', num: true },
                  { key: 'unitId', label: 'Unit' },
                  { key: 'gold', label: 'G', num: true },
                  { key: 'silver', label: 'S', num: true },
                  { key: 'bronze', label: 'B', num: true },
                  { key: 'total', label: 'Total', num: true },
                ],
                tally,
              )
            : empty('No published medals yet'),
          { flush: true, note: 'Streams to the GMS Medal Tally module on publication (§11 outbound)' },
        ),

        card(
          'Victory ceremony sheet',
          (stored.length ? stored : rankings).filter((r) => r.medal !== 'none').length
            ? el('dl', { class: 'kv' },
                (stored.length ? stored : rankings).filter((r) => r.medal !== 'none').flatMap((r) => [
                  el('dt', {}, r.medal === 'G' ? 'Gold' : r.medal === 'S' ? 'Silver' : 'Bronze'),
                  el('dd', {}, `${r.participantName} (${r.unitId})${r.jointFlag ? ' — joint' : ''}`),
                ]),
              )
            : empty('Podium not resolved yet'),
          { note: '§9.5 generates the ceremony report with medallists, presenters and the schedule' },
        ),
      ]),
    ]),
  ]);
}
