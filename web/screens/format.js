/**
 * Format Builder — §12.5.
 *
 * A visual format designer with the validation panel §4.5 asks for: bracket
 * size against entry count with the byes it implies, group maths consistency,
 * and progression rules that lead somewhere.
 */

import { badge, card, el, empty, field, gateList, input, notice, pageHead, select, table, tile } from '../ui.js';

const TYPES = [
  { value: 'knockout', label: 'Knockout (single elimination)' },
  { value: 'league-single', label: 'League — single round-robin' },
  { value: 'league-double', label: 'League — double round-robin' },
  { value: 'group-knockout', label: 'Groups + knockout' },
  { value: 'pool', label: 'Pool stage' },
  { value: 'qualification-finals', label: 'Qualification rounds + finals' },
  { value: 'repechage', label: 'Repechage' },
  { value: 'heats-semis-finals', label: 'Heats – semis – finals' },
];

const nextPowerOfTwo = (n) => (n <= 1 ? n : 2 ** Math.ceil(Math.log2(n)));

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  if (!detail.events.length) return el('div', {}, [pageHead('Format builder', null, '§12.5'), empty('No events')]);

  const eventId = ctx.params.eventId ?? detail.events[0].eventId;
  const data = await ctx.api.get(`/api/events/${eventId}`);
  const ev = data.event;
  const existing = data.format;
  const sport = ctx.sport;
  const confirmed = data.entries.filter((e) => e.entryStatus === 'Confirmed').length;
  const canEdit = ['Super Admin', 'Tournament Admin', 'Competition Manager'].includes(ctx.user.role);
  const canApprove = ['Super Admin', 'Tournament Admin'].includes(ctx.user.role);
  const locked = existing?.lockedByDraw || ev.drawStatus === 'Published';

  const f = {};
  f.type = select(TYPES, { value: existing?.type ?? 'group-knockout' });
  f.groupCount = input({ type: 'number', min: '1', value: String(existing?.groupCount ?? 2) });
  f.teamsPerGroup = input({ type: 'number', min: '0', value: String(existing?.teamsPerGroup ?? Math.ceil(confirmed / 2)) });
  f.legs = select([{ value: '1', label: 'Single meeting' }, { value: '2', label: 'Home and away' }], { value: String(existing?.matchesPerPairing ?? 1) });
  f.advance = input({ type: 'number', min: '1', value: String(existing?.progressionRules?.[0]?.positions?.length ?? 2) });
  f.periods = input({ type: 'number', min: '1', value: String(existing?.matchParams.periods ?? sport.matchDefaults.periods) });
  f.periodMins = input({ type: 'number', min: '1', value: String(existing?.matchParams.periodMins ?? sport.matchDefaults.periodMins) });
  f.breakMins = input({ type: 'number', min: '0', value: String(existing?.matchParams.breakMins ?? sport.matchDefaults.breakMins) });
  f.win = input({ type: 'number', value: String(existing?.matchParams.pointsWin ?? sport.matchDefaults.pointsWin) });
  f.draw = input({ type: 'number', value: String(existing?.matchParams.pointsDraw ?? sport.matchDefaults.pointsDraw) });
  f.loss = input({ type: 'number', value: String(existing?.matchParams.pointsLoss ?? sport.matchDefaults.pointsLoss) });
  f.bonusMargin = input({ type: 'number', placeholder: 'none', value: existing?.matchParams.bonusPointMargin ?? '' });
  f.bonusPoints = input({ type: 'number', value: String(existing?.matchParams.pointsBonus ?? 0) });

  /** §4.5 — live validation of the format against the entry count. */
  const validate = () => {
    const type = f.type.value;
    const groups = Number(f.groupCount.value);
    const perGroup = Number(f.teamsPerGroup.value);
    const advance = Number(f.advance.value);
    const out = [];
    if (type === 'knockout' || type === 'qualification-finals') {
      const bracket = nextPowerOfTwo(confirmed);
      out.push({ ok: confirmed >= 2, text: `${confirmed} confirmed entries — a knockout needs at least 2` });
      out.push({ ok: true, text: `Bracket size ${bracket}, so ${bracket - confirmed} bye(s) in round 1` });
      out.push({ ok: true, text: `${Math.max(0, bracket - 1)} fixtures, ${Math.log2(bracket)} round(s)` });
    } else if (type === 'group-knockout' || type === 'pool' || type === 'heats-semis-finals') {
      out.push({ ok: groups >= 1, text: `${groups} group(s)` });
      out.push({
        ok: groups * perGroup >= confirmed,
        text: `${groups} × ${perGroup} holds ${groups * perGroup} sides against ${confirmed} entered`,
      });
      const qualifiers = groups * advance;
      out.push({ ok: advance >= 1 && advance <= perGroup, text: `Top ${advance} per group advance` });
      out.push({
        ok: qualifiers >= 2,
        text: `${qualifiers} qualifier(s) → knockout bracket of ${nextPowerOfTwo(qualifiers)}${nextPowerOfTwo(qualifiers) !== qualifiers ? `, needing ${nextPowerOfTwo(qualifiers) - qualifiers} bye(s)` : ''}`,
      });
      const legs = Number(f.legs.value);
      out.push({ ok: true, text: `${groups * (perGroup * (perGroup - 1) / 2) * legs} group fixture(s)` });
    } else {
      const legs = Number(f.legs.value);
      out.push({ ok: confirmed >= 2, text: `${confirmed} confirmed entries` });
      out.push({ ok: true, text: `${(confirmed * (confirmed - 1) / 2) * legs} fixture(s) in a ${legs === 2 ? 'double' : 'single'} round-robin` });
    }
    out.push({ ok: Number(f.periods.value) > 0 && Number(f.periodMins.value) > 0, text: `Match: ${f.periods.value} × ${f.periodMins.value} min with a ${f.breakMins.value} min interval` });
    return out;
  };

  const panel = el('ul', { class: 'gate' });
  const refreshPanel = () => {
    panel.replaceChildren(
      ...validate().map((v) =>
        el('li', { class: v.ok ? 'gate-pass' : 'gate-fail' }, [
          el('span', { class: 'gate-mark' }, v.ok ? '✓' : '✕'),
          el('span', {}, v.text),
        ]),
      ),
    );
  };
  refreshPanel();
  for (const control of Object.values(f)) control.addEventListener('change', refreshPanel);

  const save = () => {
    const type = f.type.value;
    const advance = Number(f.advance.value);
    const grouped = ['group-knockout', 'pool', 'heats-semis-finals'].includes(type);
    return ctx.api.act('Format saved', () =>
      ctx.api.post(`/api/events/${eventId}/format`, {
        type,
        groupCount: grouped ? Number(f.groupCount.value) : 1,
        teamsPerGroup: grouped ? Number(f.teamsPerGroup.value) : 0,
        matchesPerPairing: Number(f.legs.value),
        progressionRules: grouped
          ? [{ fromGroupId: '*', positions: Array.from({ length: advance }, (_, i) => i + 1), toStage: advance * Number(f.groupCount.value) > 4 ? 'QF' : 'SF', seedApart: true }]
          : [],
        matchParams: {
          periods: Number(f.periods.value),
          periodMins: Number(f.periodMins.value),
          breakMins: Number(f.breakMins.value),
          durationMins: Number(f.periods.value) * Number(f.periodMins.value) + Number(f.breakMins.value),
          slotMins: Number(f.periods.value) * Number(f.periodMins.value) + Number(f.breakMins.value) + 15,
          tieBreakMode: sport.matchDefaults.tieBreakMode,
          pointsWin: Number(f.win.value),
          pointsDraw: Number(f.draw.value),
          pointsLoss: Number(f.loss.value),
          bonusPointMargin: f.bonusMargin.value ? Number(f.bonusMargin.value) : undefined,
          pointsBonus: Number(f.bonusPoints.value),
        },
      }),
    );
  };

  return el('div', {}, [
    pageHead(
      'Format builder',
      'Phase 4 chooses the format, the stage structure and the progression rules, then validates them against the entry count before the Tournament Admin approves.',
      '§12.5',
    ),

    el('div', { class: 'filters' }, [
      field('Event', select(detail.events.map((e) => ({ value: e.eventId, label: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'}` })), {
        value: eventId, onchange: (v) => ctx.go('format', { eventId: v }),
      })),
      el('div', { style: 'flex:1' }),
      existing ? el('span', {}, badge(existing.approvalStatus)) : null,
    ]),

    locked
      ? notice('warn', 'Format locked by the published draw',
          'The format cannot change after draw publication. A change forces a formal redraw with Admin approval and republication (§7.2.7).')
      : null,

    el('div', { class: 'grid grid-2' }, [
      card(
        'Stage structure',
        el('div', { class: 'grid grid-2' }, [
          field('Format', f.type),
          field('Matches per pairing', f.legs),
          field('Groups', f.groupCount),
          field('Sides per group', f.teamsPerGroup),
          field('Advance per group', f.advance, 'Top n qualify for the knockout (§4.3)'),
        ]),
        { note: `${confirmed} confirmed entries in this event` },
      ),

      card('Validation panel', panel, {
        note: '§4.5 checks bracket size against entries, group maths, and that no progression rule leads to a dead end',
      }),
    ]),

    el('div', { class: 'grid grid-2' }, [
      card(
        'Match parameters',
        el('div', { class: 'grid grid-3' }, [
          field('Periods', f.periods),
          field('Minutes per period', f.periodMins),
          field('Interval (min)', f.breakMins),
          field('Points — win', f.win),
          field('Points — tie', f.draw),
          field('Points — loss', f.loss),
          field('Losing bonus margin', f.bonusMargin, 'Blank for no losing bonus'),
          field('Bonus points', f.bonusPoints),
        ]),
        {
          note: `Defaults come from the ${sport.name} template. ${sport.matchDefaults.tieBreakMode}`,
          actions: canEdit && !locked
            ? [el('button', { class: 'btn btn-primary', type: 'button', onclick: save }, existing ? 'Update format' : 'Save format')]
            : [],
        },
      ),

      card(
        'Approval',
        existing
          ? el('div', {}, [
              el('dl', { class: 'kv' }, [
                el('dt', {}, 'Format'), el('dd', {}, existing.formatId),
                el('dt', {}, 'Status'), el('dd', {}, badge(existing.approvalStatus)),
                el('dt', {}, 'Approved by'), el('dd', {}, existing.approvedBy ?? '—'),
                el('dt', {}, 'Locked by draw'), el('dd', {}, existing.lockedByDraw ? 'yes' : 'no'),
              ]),
              el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
                canApprove && existing.approvalStatus !== 'Approved'
                  ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.api.act('Format approved', () => ctx.api.post(`/api/events/${eventId}/format/approve`)) }, 'Approve format')
                  : null,
                existing.approvalStatus === 'Approved'
                  ? el('button', { class: 'btn', type: 'button', onclick: () => ctx.go('draw', { eventId }) }, 'Go to draw console →')
                  : null,
              ]),
              !canApprove ? el('p', { class: 'card-note', style: 'margin-top:10px' }, 'A Competition Manager prepares the format; the Tournament Admin approves it (§4.6).') : null,
            ])
          : empty('No format yet', 'Choose a structure and save it'),
      ),
    ]),

    existing?.progressionRules?.length
      ? card('Progression rules',
          table(
            [
              { label: 'From', render: (r) => (r.fromGroupId === '*' ? 'every group' : r.fromGroupId) },
              { label: 'Positions', render: (r) => r.positions.join(', ') },
              { key: 'toStage', label: 'To stage' },
              { label: 'Seeded apart', render: (r) => (r.seedApart ? 'yes' : 'no') },
            ],
            existing.progressionRules,
          ),
          { flush: true, note: 'Group winners are paired against runners-up from a different group (§4.3)' })
      : null,
  ]);
}
