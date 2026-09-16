/**
 * Draw Console — §12.6.
 *
 * Runs the auto-draw, shows the bracket and the slot map, allows the
 * drag-free equivalent of §5.4's pre-publish swaps, exposes the RNG record so
 * §7.2.9's reproducibility claim can be checked on the spot, and gates
 * publication behind the validation result.
 */

import { badge, card, el, empty, field, gateList, input, notice, pageHead, prompt, select, sideLabel, table, tile } from '../ui.js';

const STAGE_ORDER = ['group', 'R32', 'R16', 'QF', 'SF', 'bronze', 'F'];

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  if (!detail.events.length) return el('div', {}, [pageHead('Draw console', null, '§12.6'), empty('No events')]);

  const eventId = ctx.params.eventId ?? detail.events[0].eventId;
  const data = await ctx.api.get(`/api/events/${eventId}`);
  const ev = data.event;
  const draw = data.draw;
  const matches = data.matches;
  const resultByMatch = new Map(data.results.map((r) => [r.matchId, r]));
  const canRun = ['Super Admin', 'Tournament Admin', 'Competition Manager'].includes(ctx.user.role);
  const canPublish = ['Super Admin', 'Tournament Admin'].includes(ctx.user.role);

  const seedCount = input({ type: 'number', min: '0', value: String(draw?.seedCount ?? 4) });
  const separation = select(
    [
      { value: 'same-unit-apart-r1', label: 'Same unit apart in round 1' },
      { value: 'same-unit-apart-r1-r2', label: 'Same unit apart in rounds 1 and 2' },
      { value: 'none', label: 'No separation rule' },
    ],
    { value: draw?.separationRule ?? 'same-unit-apart-r1' },
  );
  const byePolicy = select(
    [{ value: 'top-seeds', label: 'Byes to the top seeds' }, { value: 'random', label: 'Byes drawn at random' }],
    { value: draw?.byePolicy ?? 'top-seeds' },
  );
  const seedText = input({ value: draw?.rngSeed ?? `${eventId}:${Date.now().toString(36)}`, placeholder: 'RNG seed' });

  const runDraw = () =>
    ctx.api.act('Draw generated', () =>
      ctx.api.post(`/api/events/${eventId}/draw`, {
        seedCount: Number(seedCount.value),
        separationRule: separation.value,
        byePolicy: byePolicy.value,
        rngSeed: seedText.value,
      }),
    );

  const swap = async () => {
    const answers = await prompt({
      title: 'Swap two draw positions',
      confirmLabel: 'Swap and re-validate',
      fields: [
        { name: 'from', label: 'From slot', type: 'number', required: true },
        { name: 'to', label: 'To slot', type: 'number', required: true },
      ],
    });
    if (!answers) return;
    await ctx.api.act('Positions swapped', () =>
      ctx.api.post(`/api/events/${eventId}/draw/adjust`, { fromSlot: Number(answers.from), toSlot: Number(answers.to) }),
    );
  };

  const verify = async () => {
    try {
      const out = await ctx.api.get(`/api/events/${eventId}/draw/verify`);
      await prompt({
        title: out.reproducible ? 'Draw is reproducible' : 'Draw could not be reproduced',
        confirmLabel: 'Close',
        fields: [{ name: 'detail', label: 'Result', type: 'textarea', value: out.detail }],
      });
    } catch (e) {
      await prompt({ title: 'Verification failed', confirmLabel: 'Close', fields: [{ name: 'e', label: 'Error', type: 'textarea', value: e.message }] });
    }
  };

  // Bracket, grouped by round then stage.
  const rounds = new Map();
  for (const m of matches) {
    const key = `${m.roundNo}|${m.stage}`;
    if (!rounds.has(key)) rounds.set(key, []);
    rounds.get(key).push(m);
  }
  const orderedRounds = [...rounds.entries()].sort((a, b) => {
    const [ra, sa] = a[0].split('|');
    const [rb, sb] = b[0].split('|');
    return Number(ra) - Number(rb) || STAGE_ORDER.indexOf(sa) - STAGE_ORDER.indexOf(sb);
  });

  const bracketSide = (m, which) => {
    const side = which === 'A' ? m.sideA : m.sideB;
    const r = resultByMatch.get(m.matchId);
    const score = r ? (which === 'A' ? r.finalScore.a : r.finalScore.b) : '';
    const isWinner = r?.resultStatus === 'Approved' && r.winnerRef && side.kind === 'entry' && side.entryId === r.winnerRef;
    return el('div', { class: `bracket-side${isWinner ? ' bracket-side-win' : ''}` }, [
      el('span', {}, sideLabel(side)),
      el('span', { class: 'bracket-score' }, r ? String(score) : ''),
    ]);
  };

  const bracket = el('div', { class: 'bracket' }, orderedRounds.map(([key, ms]) => {
    const stage = key.split('|')[1];
    return el('div', { class: 'bracket-round' }, [
      el('div', { class: 'bracket-round-title' }, stage === 'group' ? `${ms[0].groupId ?? 'Group'} · R${ms[0].roundNo}` : stage),
      ...ms.map((m) =>
        el('button', { class: 'bracket-match', type: 'button', onclick: () => ctx.go('matches', { matchId: m.matchId }) }, [
          el('div', { class: 'bracket-match-head' }, [
            el('span', {}, m.matchNo),
            el('span', {}, m.scheduledTime ? `${m.scheduledDate?.slice(5)} ${m.scheduledTime}` : m.byeFlag ? 'bye' : 'unscheduled'),
          ]),
          bracketSide(m, 'A'),
          bracketSide(m, 'B'),
        ]),
      ),
    ]);
  }));

  return el('div', {}, [
    pageHead(
      'Draw console',
      'Phase 5 places seeds, allocates byes, draws the unseeded entries from a recorded seed, applies separation rules and validates the whole draw before an Admin publishes it.',
      '§12.6',
    ),

    el('div', { class: 'filters' }, [
      field('Event', select(detail.events.map((e) => ({ value: e.eventId, label: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'}` })), {
        value: eventId, onchange: (v) => ctx.go('draw', { eventId: v }),
      })),
      el('div', { style: 'flex:1' }),
      el('span', {}, badge(ev.drawStatus)),
    ]),

    draw
      ? el('div', { class: 'grid grid-4' }, [
          tile('Bracket size', draw.bracketSize, `${draw.entryCount} entries`),
          tile('Byes', draw.byeCount, draw.byePolicy === 'top-seeds' ? 'allocated to the top seeds' : 'drawn at random'),
          tile('Seeds placed', draw.seedCount, 'at conventional bracket positions'),
          tile('Fixtures', matches.length, `${matches.filter((m) => m.byeFlag).length} bye fixture(s)`),
        ])
      : null,
    draw ? el('div', { style: 'height:16px' }) : null,

    draw?.validationErrors?.length
      ? notice('danger', 'The draw failed validation and cannot be published', draw.validationErrors)
      : draw
        ? notice('ok', 'Validation passed',
            'No duplicate pairing, no participant twice in one round, bye count correct, separation rules honoured, and every progression slot mapped (§5.3).')
        : null,

    card(
      'Draw parameters',
      el('div', { class: 'grid grid-4' }, [
        field('Seeds', seedCount, 'Top n placed at bracket positions'),
        field('Separation rule', separation, 'Same-unit sides kept apart in early rounds'),
        field('Bye policy', byePolicy),
        field('RNG seed', seedText, 'Stored with the draw so it can be replayed (§7.2.9)'),
      ]),
      {
        actions: [
          canRun ? el('button', { class: 'btn btn-primary', type: 'button', onclick: runDraw }, draw ? 'Re-run auto-draw' : 'Run auto-draw') : null,
          draw?.status === 'Draft Draw' && canRun ? el('button', { class: 'btn', type: 'button', onclick: swap }, 'Swap positions…') : null,
          draw ? el('button', { class: 'btn', type: 'button', onclick: verify }, 'Verify reproducibility') : null,
          draw && draw.status !== 'Published' && canPublish && !draw.validationErrors.length
            ? el('button', { class: 'btn btn-ok', type: 'button', onclick: () => ctx.api.act('Draw published', () => ctx.api.post(`/api/events/${eventId}/draw/publish`)) }, 'Approve & publish draw')
            : null,
        ].filter(Boolean),
        note: draw?.status === 'Published'
          ? 'Published. Post-publish changes go through the formal redraw path, never a silent edit (§5.6).'
          : 'Manual swaps are allowed only while the draw is in Draft Draw, and each one is logged with before and after values (§5.4).',
      },
    ),

    draw
      ? card('Bracket', matches.length ? bracket : empty('No fixtures'), {
          note: 'Click any fixture to open its match console',
          flush: false,
        })
      : card('No draw yet', empty('Run the auto-draw', 'The format must be approved and entries locked first (§5.3 prerequisite)')),

    draw
      ? el('div', { class: 'grid grid-2' }, [
          card(
            'Slot map',
            table(
              [
                { key: 'slot', label: 'Slot', num: true },
                { key: 'nominalSeed', label: 'Bracket position', num: true },
                { label: 'Group', render: (s) => s.groupId ?? '—' },
                {
                  label: 'Occupant',
                  render: (s) => (s.occupant.kind === 'bye' ? el('span', { class: 'bracket-side-bye' }, 'BYE') : s.occupant.displayName),
                },
                { label: 'Unit', render: (s) => (s.occupant.kind === 'entry' ? s.occupant.unitId : '—') },
                { label: 'Seed', num: true, render: (s) => (s.occupant.kind === 'entry' ? s.occupant.seedNo ?? '—' : '—') },
              ],
              draw.slots,
              { rowClass: (s) => (s.occupant.kind === 'bye' ? 'row-muted' : '') },
            ),
            { flush: true, note: 'The basis for the official draw sheet and its bye markers (§10.1)' },
          ),

          el('div', {}, [
            card(
              'Draw record',
              el('dl', { class: 'kv' }, [
                el('dt', {}, 'Draw ID'), el('dd', { class: 'mono' }, draw.drawId),
                el('dt', {}, 'RNG seed'), el('dd', { class: 'mono' }, draw.rngSeed),
                el('dt', {}, 'Algorithm'), el('dd', { class: 'mono' }, draw.rngAlgorithm),
                el('dt', {}, 'Generated by'), el('dd', {}, `${draw.generatedBy} at ${new Date(draw.generatedAt).toLocaleString()}`),
                el('dt', {}, 'Approved by'), el('dd', {}, draw.approvedBy ?? '—'),
                el('dt', {}, 'Published'), el('dd', {}, draw.publishedAt ? new Date(draw.publishedAt).toLocaleString() : '—'),
              ]),
              { note: 'Storing the seed and algorithm is what makes a draw auditable in a dispute (§7.2.9)' },
            ),
            draw.manualAdjustments.length
              ? card('Manual adjustments',
                  table(
                    [
                      { label: 'Slots', render: (a) => `${a.fromSlot} ↔ ${a.toSlot}` },
                      { key: 'before', label: 'Before' },
                      { key: 'after', label: 'After' },
                      { key: 'by', label: 'By', mono: true },
                      { label: 'At', render: (a) => new Date(a.at).toLocaleString() },
                    ],
                    draw.manualAdjustments,
                  ),
                  { flush: true, note: 'Every pre-publish swap is logged and the draw re-validated (§5.4)' })
              : null,
          ]),
        ])
      : null,
  ]);
}
