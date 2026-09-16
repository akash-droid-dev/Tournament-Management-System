/**
 * Entry Management — §12.4.
 *
 * Shows the three things §3.4–3.6 need visible at once: the eligible pool
 * (only Approved upstream records), each entry's eligibility result with hard
 * failures separated from advisories, and the quota tracker. Blocked entries
 * form the override queue, which only a Tournament Admin can clear and only
 * with a reason.
 */

import { badge, card, el, empty, field, gateList, input, notice, pageHead, prompt, select, table, tile } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const detail = await ctx.api.get(`/api/tournaments/${t.tournamentId}`);
  const events = detail.events;
  if (!events.length) return el('div', {}, [pageHead('Entries', null, '§12.4'), empty('No events', 'Add an event first (§12.3)')]);

  const eventId = ctx.params.eventId ?? events[0].eventId;
  const data = await ctx.api.get(`/api/events/${eventId}`);
  const ev = data.event;
  const entries = data.entries;

  let pool = [];
  try {
    pool = await ctx.api.get(`/api/events/${eventId}/pool`);
  } catch {
    // A role without entry rights simply sees no pool; the table still renders.
  }

  const isTM = ctx.user.role === 'Team Manager';
  const canOverride = ['Super Admin', 'Tournament Admin'].includes(ctx.user.role);
  const canConfirm = ['Super Admin', 'Tournament Admin', 'Competition Manager'].includes(ctx.user.role);

  const confirmed = entries.filter((e) => e.entryStatus === 'Confirmed');
  const blocked = entries.filter((e) => e.entryStatus === 'Blocked');
  const scratched = entries.filter((e) => e.entryStatus === 'Scratched' || e.entryStatus === 'Withdrawn');

  // Quota tracker: §7.1.4 unit quotas are hard limits.
  const quota = ev.maxEntriesPerUnit || t.maxEntriesPerUnit;
  const byUnit = new Map();
  for (const e of entries) {
    if (['Scratched', 'Withdrawn'].includes(e.entryStatus)) continue;
    byUnit.set(e.unitId, (byUnit.get(e.unitId) ?? 0) + 1);
  }

  const alreadyEntered = new Set(entries.map((e) => e.participantRef.id));
  const available = pool.filter((p) => !alreadyEntered.has(p.ref.id));
  const pick = select(
    available.length
      ? available.map((p) => ({ value: p.ref.id, label: `${p.ref.displayName} (${p.unitId})` }))
      : [{ value: '', label: 'Nothing left in your pool' }],
  );
  const seedInput = input({ type: 'number', min: '1', placeholder: 'optional' });

  const addEntry = () => {
    if (!pick.value) return;
    return ctx.api.act('Entry submitted', () =>
      ctx.api.post(`/api/events/${eventId}/entries`, {
        participantId: pick.value,
        seedNo: seedInput.value ? Number(seedInput.value) : undefined,
      }),
    );
  };

  const doOverride = async (entry) => {
    const answers = await prompt({
      title: `Override eligibility for ${entry.participantRef.displayName}`,
      confirmLabel: 'Override with reason',
      fields: [
        { name: 'code', label: 'Reason code', type: 'select', options: (ctx.reasonCodes.entry ?? []).map((c) => ({ value: c, label: c })) },
        { name: 'detail', label: 'Justification', type: 'textarea', required: true, hint: 'Recorded in the audit trail against your name (§7.1.4)' },
      ],
    });
    if (!answers) return;
    await ctx.api.act('Override recorded', () =>
      ctx.api.post(`/api/entries/${entry.entryId}/override`, { reason: `${answers.code}: ${answers.detail}` }),
    );
  };

  const doScratch = async (entry) => {
    const answers = await prompt({
      title: `Scratch ${entry.participantRef.displayName}`,
      confirmLabel: 'Scratch',
      fields: [
        { name: 'code', label: 'Reason code', type: 'select', options: (ctx.reasonCodes.entry ?? []).map((c) => ({ value: c, label: c })) },
        { name: 'detail', label: 'Detail', type: 'textarea', required: true },
      ],
    });
    if (!answers) return;
    await ctx.api.act('Entry scratched', () =>
      ctx.api.post(`/api/entries/${entry.entryId}/scratch`, { reason: `${answers.code}: ${answers.detail}` }),
    );
  };

  const eligibilityCell = (e) => {
    const failures = e.eligibilityResult.checks.filter((c) => !c.passed);
    if (!failures.length) return badge('Passed all checks');
    return el('div', {}, failures.map((c) =>
      el('div', { class: 'card-note', style: c.severity === 'hard' ? 'color:var(--danger)' : 'color:var(--warn)' },
        `${c.severity === 'hard' ? '✕' : '⚠'} ${c.message}`),
    ));
  };

  return el('div', {}, [
    pageHead(
      'Entry management',
      'Phase 3 maps approved athletes and teams into events. The eligibility engine runs on every entry; hard failures block, advisories warn.',
      '§12.4',
    ),

    el('div', { class: 'filters' }, [
      field('Event', select(events.map((e) => ({ value: e.eventId, label: `${e.discipline} ${e.genderCategory === 'M' ? 'Men' : 'Women'} (${e.eventId})` })), {
        value: eventId,
        onchange: (v) => ctx.go('entries', { eventId: v }),
      })),
      el('div', { style: 'flex:1' }),
      el('span', { class: 'badge badge-plain badge-neutral' }, `Event status: ${ev.status}`),
    ]),

    el('div', { class: 'grid grid-4' }, [
      tile('Confirmed', confirmed.length, `Minimum to run: ${ev.minEntriesToRun}`, confirmed.length < ev.minEntriesToRun ? 'is-alert' : 'is-ok'),
      tile('Blocked', blocked.length, blocked.length ? 'Needs a decision' : 'None', blocked.length ? 'is-warn' : ''),
      tile('Scratched', scratched.length, 'Kept on record (§5.2)'),
      tile('Units entered', byUnit.size, `Quota ${quota} per unit per event`),
    ]),
    el('div', { style: 'height:16px' }),

    // The Phase 3 → 4 gate, as a live checklist.
    card('Gate to Phase 4 — Format setup', gateList(data.entryGate), {
      note: data.entryGate.open ? 'This event is ready for a format' : 'These conditions must be satisfied first',
    }),

    blocked.length
      ? card(
          'Override queue',
          table(
            [
              { key: 'entryId', label: 'Entry', mono: true },
              { label: 'Participant', render: (e) => e.participantRef.displayName },
              { key: 'unitId', label: 'Unit' },
              { label: 'Why blocked', render: eligibilityCell },
              {
                label: '',
                render: (e) =>
                  canOverride
                    ? el('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => doOverride(e) }, 'Override…')
                    : el('span', { class: 'card-note' }, 'Tournament Admin only'),
              },
            ],
            blocked,
            { rowClass: () => 'row-flag' },
          ),
          {
            flush: true,
            note: 'Only a Tournament Admin may override a failed check, and only with a reason code that is audit-logged (§7.1.4)',
          },
        )
      : null,

    card(
      'Entries',
      table(
        [
          { key: 'entryId', label: 'Entry', mono: true },
          { label: 'Participant', render: (e) => e.participantRef.displayName },
          { key: 'unitId', label: 'Unit' },
          { label: 'Seed', num: true, render: (e) => e.seedNo ?? '—' },
          { label: 'Squad', num: true, render: (e) => e.rosterRefs?.length ?? 0 },
          { label: 'Status', render: (e) => badge(e.entryStatus) },
          { label: 'Eligibility', render: eligibilityCell },
          {
            label: 'Override',
            render: (e) => (e.overrideFlag ? el('span', { class: 'card-note', style: 'color:var(--warn)' }, `${e.overrideReason} — by ${e.overrideBy}`) : '—'),
          },
          {
            label: '',
            render: (e) =>
              el('div', { class: 'btn-row' }, [
                e.entryStatus === 'Submitted' && canConfirm
                  ? el('button', { class: 'btn btn-sm btn-ok', type: 'button', onclick: () => ctx.api.act('Entry confirmed', () => ctx.api.post(`/api/entries/${e.entryId}/confirm`)) }, 'Confirm')
                  : null,
                ['Confirmed', 'Submitted'].includes(e.entryStatus) && (canConfirm || (isTM && e.unitId === ctx.user.scope.unitId))
                  ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => doScratch(e) }, 'Scratch…')
                  : null,
              ]),
          },
        ],
        entries,
        {
          rowClass: (e) => (e.entryStatus === 'Blocked' ? 'row-flag' : e.entryStatus === 'Confirmed' ? 'row-ok' : ''),
          emptyText: 'No entries in this event yet',
        },
      ),
      { flush: true },
    ),

    el('div', { class: 'grid grid-2' }, [
      card(
        'Add an entry',
        ['Entries Open', 'Confirmed'].includes(ev.status)
          ? el('div', {}, [
              el('div', { class: 'grid grid-2' }, [
                field(isTM ? 'From my unit\'s approved pool' : 'From the approved pool', pick,
                  `${available.length} of ${pool.length} pool record(s) not yet entered`),
                field('Seed number', seedInput, 'Only seeds 1..n are placed at bracket positions'),
              ]),
              el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
                el('button', { class: 'btn btn-primary', type: 'button', disabled: !available.length, onclick: addEntry }, 'Submit entry'),
              ]),
            ])
          : notice('info', null, `Entries are not open for this event (status ${ev.status}).`),
        {
          note: 'The pool holds only records the upstream module has Approved with valid accreditation — there is no free-text participant (§7.1.1)',
        },
      ),

      card(
        'Unit quota tracker',
        byUnit.size
          ? table(
              [
                { label: 'Unit', render: ([u]) => u },
                { label: 'Entries', num: true, render: ([, n]) => n },
                { label: 'Quota', num: true, render: () => quota },
                { label: '', render: ([, n]) => (n >= quota ? badge('At limit', 'badge-plain badge-warn') : badge('Space', 'badge-plain badge-ok')) },
              ],
              [...byUnit.entries()],
            )
          : empty('No entries yet'),
        { flush: true, note: 'A unit quota is a hard limit; only a Tournament Admin may exceed it, with a reason (§7.1.4)' },
      ),
    ]),
  ]);
}
