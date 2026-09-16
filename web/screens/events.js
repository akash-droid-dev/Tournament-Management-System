/**
 * Sport & Event Setup — §12.3.
 *
 * The Kabaddi sport template is shown as editable configuration rather than
 * hidden behind the code, because §2.4–2.6 make classifications, scoring and
 * entry limits the Competition Manager's job, and because several of those
 * numbers are federation-set values a tournament must confirm before going
 * live.
 */

import { badge, card, el, field, input, notice, pageHead, select, table } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  const sport = ctx.sport;
  const canCreate = ['Super Admin', 'Tournament Admin', 'Competition Manager'].includes(ctx.user.role);
  const canConfirm = ['Super Admin', 'Tournament Admin'].includes(ctx.user.role);

  const f = {};
  f.discipline = select(sport.disciplines.map((d) => ({ value: d, label: d })), { value: sport.disciplines[0] });
  f.age = select(sport.categories.age.map((a) => ({ value: a.key, label: a.label })), { value: 'SENIOR' });
  f.gender = select(sport.categories.gender.map((g) => ({ value: g, label: g === 'M' ? 'Men' : 'Women' })), { value: 'M' });
  f.weight = select(sport.categories.weight.map((w) => ({ value: w.key, label: w.label })), { value: 'SM-85' });
  f.seeding = select(
    [{ value: 'previous-ranking', label: 'Previous ranking' }, { value: 'manual', label: 'Manual' }, { value: 'none', label: 'None' }],
    { value: 'previous-ranking' },
  );
  f.medalRule = select(
    [{ value: 'joint-bronze', label: 'Joint bronze (both semi-final losers)' }, { value: 'playoff', label: 'Bronze play-off' }],
    { value: sport.medalRuleDefault },
  );
  const maxPerUnit = input({ type: 'number', value: '1' });
  const minEntries = input({ type: 'number', value: '4' });

  const addEvent = () =>
    ctx.api.act('Event added', () =>
      ctx.api.post(`/api/tournaments/${t.tournamentId}/events`, {
        sport: sport.sportId,
        discipline: f.discipline.value,
        participationType: sport.participationTypes[0],
        ageCategory: f.age.value,
        genderCategory: f.gender.value,
        weightCategory: f.weight.value,
        scoringTemplateId: sport.sportId,
        maxEntriesPerUnit: Number(maxPerUnit.value),
        minEntriesToRun: Number(minEntries.value),
        seedingSource: f.seeding.value,
        medalRule: f.medalRule.value,
      }),
    );

  const configurableCount = [...sport.categories.age, ...sport.categories.weight]
    .filter((c) => c.source === 'configurable-default').length;

  return el('div', {}, [
    pageHead(
      'Sport & event setup',
      'Phase 2 adds sports, disciplines and classifications, then attaches a scoring template. The Tournament Admin locks the catalogue; new events after that need Admin approval (§2.7).',
      '§12.3',
    ),

    card(
      'Event catalogue',
      table(
        [
          { key: 'eventId', label: 'ID', mono: true },
          { key: 'discipline', label: 'Discipline' },
          { label: 'Category', render: (e) => `${e.ageCategory} · ${e.genderCategory === 'M' ? 'Men' : 'Women'}${e.weightCategory ? ` · ${e.weightCategory}` : ''}` },
          { key: 'participationType', label: 'Type' },
          { label: 'Status', render: (e) => badge(e.status) },
          { label: 'Draw', render: (e) => badge(e.drawStatus) },
          { label: 'Medal rule', render: (e) => el('span', { class: 'card-note' }, e.medalRule) },
          { label: 'Min / max', num: true, render: (e) => `${e.minEntriesToRun} / ${e.maxEntriesPerUnit}` },
          {
            label: '',
            render: (e) =>
              el('div', { class: 'btn-row' }, [
                !e.confirmedAt && canConfirm
                  ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => ctx.api.act('Event confirmed', () => ctx.api.post(`/api/events/${e.eventId}/confirm`)) }, 'Confirm')
                  : null,
                el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('entries', { eventId: e.eventId }) }, 'Entries'),
              ]),
          },
        ],
        detail.events,
        { emptyText: 'No events yet' },
      ),
      { flush: true, note: `${detail.events.filter((e) => e.confirmedAt).length} of ${detail.events.length} confirmed` },
    ),

    canCreate
      ? card(
          'Add an event',
          el('div', { class: 'grid grid-4' }, [
            field('Discipline', f.discipline),
            field('Age category', f.age),
            field('Gender', f.gender),
            field('Weight category', f.weight, 'Provisional at entry, confirmed at weigh-in (§7.1.5)'),
            field('Seeding source', f.seeding),
            field('Medal rule', f.medalRule, 'Kabaddi default is joint bronze (§7.5.24)'),
            field('Max entries per unit', maxPerUnit),
            field('Min entries to run', minEntries, 'Below this the event is flagged for cancellation (§7.1.6)'),
          ]),
          { actions: [el('button', { class: 'btn btn-primary', type: 'button', onclick: addEvent }, 'Add event')] },
        )
      : null,

    notice(
      'warn',
      `${configurableCount} classification values are configurable defaults, not rules of play`,
      'Weight limits, age bands, league point values, half length and rest gaps are set by the organizing federation and revised periodically. The values below are starting points the organizing body must confirm against its current technical handbook before the tournament goes live.',
    ),

    el('div', { class: 'grid grid-2' }, [
      card(
        `${sport.name} scoring template`,
        el('dl', { class: 'kv' }, [
          el('dt', {}, 'Match structure'), el('dd', {}, `${sport.matchDefaults.periods} × ${sport.matchDefaults.periodMins} min, ${sport.matchDefaults.breakMins} min interval`),
          el('dt', {}, 'Slot booked'), el('dd', {}, `${sport.matchDefaults.slotMins} min (play + interval + turnaround)`),
          el('dt', {}, 'League points'), el('dd', {}, `win ${sport.matchDefaults.pointsWin} · tie ${sport.matchDefaults.pointsDraw} · loss ${sport.matchDefaults.pointsLoss}${sport.matchDefaults.bonusPointMargin ? ` · bonus ${sport.matchDefaults.pointsBonus} for losing by ≤${sport.matchDefaults.bonusPointMargin}` : ' · no losing bonus'}`),
          el('dt', {}, 'Tie resolution'), el('dd', {}, sport.matchDefaults.tieBreakMode),
          el('dt', {}, 'Squad'), el('dd', {}, `${sport.roster.onField} on the ${sport.fopType}, ${sport.roster.min}–${sport.roster.max} in the squad`),
          el('dt', {}, 'Rest gap'), el('dd', {}, `${sport.restGap.hardMins} min hard minimum, ${sport.restGap.recommendedMins} min recommended`),
          el('dt', {}, 'Standings metric'), el('dd', {}, sport.sportMetricLabel),
          el('dt', {}, 'Walkover'), el('dd', {}, [`${sport.walkover.winnerScore}–${sport.walkover.loserScore}`, el('div', { class: 'card-note', style: 'margin-top:4px' }, sport.walkover.note)]),
          el('dt', {}, 'Rule presets'), el('dd', {}, el('div', { class: 'pill-row' }, sport.presets.map((p) => el('span', { class: 'pill' }, p)))),
        ]),
        { note: 'Attached to every event in this sport (§2.5)' },
      ),

      el('div', {}, [
        card(
          'Tie-breaker hierarchy',
          el('ol', { style: 'margin:0;padding-left:20px' }, sport.tieBreakers.map((tb) =>
            el('li', { style: 'margin-bottom:4px' }, [
              tb.label,
              tb.requiresHeadToHead ? el('span', { class: 'spec-ref' }, 'cohort only') : null,
              tb.isDrawOfLots ? el('span', { class: 'spec-ref' }, 'recorded + witnessed') : null,
            ]),
          )),
          { note: 'Applied strictly in this order; if all fail, a draw of lots is conducted and recorded (§7.5.22)' },
        ),
        card(
          'Officials panel',
          table(
            [
              { key: 'role', label: 'Seat' },
              { key: 'count', label: 'Needed', num: true },
              { label: 'Grade', render: (p) => p.qualificationGrade ?? 'any' },
              {
                label: 'Required to start',
                render: (p) => {
                  const min = sport.officials.minimumToStart.find((m) => m.role === p.role);
                  return min ? badge(`${min.count} minimum`, 'badge-plain badge-warn') : el('span', { class: 'card-note' }, 'not blocking');
                },
              },
            ],
            sport.officials.panel,
          ),
          { flush: true, note: 'A fixture cannot move to Check-in until the minimum is filled (§7.3.15)' },
        ),
      ]),
    ]),
  ]);
}
