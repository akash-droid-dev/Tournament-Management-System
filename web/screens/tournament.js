/**
 * Tournament list, creation wizard and configuration — §12.1 and §12.2.
 *
 * The §5.1 validation list is the gate for moving Draft → Configured, so it is
 * rendered as a live checklist rather than surfacing as a rejection.
 */

import { badge, card, el, field, fmtDate, gateList, input, notice, pageHead, plainBadge, select, table, tile } from '../ui.js';

const LEVELS = ['school', 'district', 'state', 'national', 'international'];

export async function render(ctx) {
  const { tournament } = ctx;
  if (!tournament) return el('div', {}, [pageHead('Tournaments', null, '§12.1'), createWizard(ctx)]);

  const detail = await ctx.api.get(`/api/tournaments/${tournament.tournamentId}`);
  const t = detail.tournament;
  const canEdit = ['Super Admin', 'Tournament Admin'].includes(ctx.user.role);

  const advance = async (status, reasonCode) => {
    await ctx.api.act(`Tournament → ${status}`, () =>
      ctx.api.post(`/api/tournaments/${t.tournamentId}/status`, { status, reasonCode }),
    );
  };

  return el('div', {}, [
    pageHead(
      t.name,
      `${t.organizingBody} · ${t.level} · ${t.hostCity} · ${fmtDate(t.startDate)} to ${fmtDate(t.endDate)}`,
      '§12.2',
    ),

    el('div', { class: 'grid grid-4' }, [
      tile('Status', t.status, `Code ${t.code}`),
      tile('Events', detail.events.length, `${detail.events.filter((e) => e.confirmedAt).length} confirmed`),
      tile('Units', t.participatingUnits.length, t.participatingUnits.slice(0, 6).join(' · ')),
      tile('Officials pool', detail.officials.length, `${detail.officials.filter((o) => o.roles.includes('Referee')).length} referees`),
    ]),
    el('div', { style: 'height:16px' }),

    el('div', { class: 'grid grid-2' }, [
      card(
        'Configuration',
        el('dl', { class: 'kv' }, [
          el('dt', {}, 'Entry deadline'), el('dd', {}, fmtDate(t.entryDeadline)),
          el('dt', {}, 'Withdrawal deadline'), el('dd', {}, fmtDate(t.withdrawalDeadline)),
          el('dt', {}, 'Category cut-off'), el('dd', {}, [fmtDate(t.categoryCutOffDate), el('span', { class: 'spec-ref' }, '§7.1.2')]),
          el('dt', {}, 'Protest window'), el('dd', {}, `${t.protestWindowMins} min · fee ${t.protestFee}`),
          el('dt', {}, 'Approval chain'), el('dd', {}, [t.approvalChainType, el('span', { class: 'spec-ref' }, '§1.4')]),
          el('dt', {}, 'Publish results'), el('dd', {}, t.autoPublishResults ? 'automatically on approval' : 'as a separate explicit act'),
          el('dt', {}, 'Official neutrality'), el('dd', {}, t.enforceOfficialNeutrality ? 'enforced (hard block)' : 'advisory only'),
          el('dt', {}, 'Max events / athlete'), el('dd', {}, String(t.maxEventsPerAthlete)),
          el('dt', {}, 'Min entries to run'), el('dd', {}, String(t.minEntriesToRun)),
          el('dt', {}, 'Max entries / unit'), el('dd', {}, String(t.maxEntriesPerUnit)),
        ]),
        { note: 'Set in Phase 1 step 1.4; drives eligibility, protests and the approval chain' },
      ),

      card(
        'Lifecycle',
        el('div', {}, [
          el('div', { class: 'pill-row', style: 'margin-bottom:12px' },
            ['Draft', 'Configured', 'Entries Open', 'Entries Locked', 'Draw Published', 'Active', 'Completed', 'Archived']
              .map((s) => el('span', { class: `pill${s === t.status ? '' : ''}`, style: s === t.status ? 'background:var(--accent-soft);color:var(--accent);border-color:var(--accent-line);font-weight:700' : '' }, s)),
          ),
          el('p', { class: 'card-note' }, 'Every transition is checked against the §6.1 machine and writes an audit entry. Cancellation after Active is reserved to Super Admin with a reason.'),
          canEdit
            ? el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
                t.status === 'Draft'
                  ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.api.act('Validate and configure', () => ctx.api.post(`/api/tournaments/${t.tournamentId}/activate`)) }, 'Validate & configure')
                  : null,
                t.status === 'Configured'
                  ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => advance('Entries Open') }, 'Open entries')
                  : null,
                t.status === 'Entries Open'
                  ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => advance('Entries Locked') }, 'Lock entries')
                  : null,
                t.status === 'Draw Published'
                  ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => advance('Active') }, 'Mark active')
                  : null,
                t.status === 'Active'
                  ? el('button', { class: 'btn btn-ok', type: 'button', onclick: () => ctx.api.act('Close tournament', () => ctx.api.post(`/api/tournaments/${t.tournamentId}/close`)) }, 'Close tournament')
                  : null,
                t.status === 'Completed'
                  ? el('button', { class: 'btn', type: 'button', onclick: () => advance('Archived') }, 'Archive')
                  : null,
              ])
            : notice('info', null, `${ctx.user.role} may view tournament configuration but not change it (§3.2).`),
        ]),
      ),
    ]),

    card(
      'Venues and fields of play',
      table(
        [
          { key: 'name', label: 'Venue' },
          { key: 'address', label: 'Address' },
          { label: 'Fields of play', render: (v) => el('div', { class: 'pill-row' }, v.fopList.map((f) => el('span', { class: 'pill' }, `${f.name} (${f.type})`))) },
          { label: 'Hours', render: (v) => `${v.operatingHours.open}–${v.operatingHours.close}` },
          { label: 'Maintenance', render: (v) => v.maintenanceBlocks.length ? v.maintenanceBlocks.map((m) => `${m.date} ${m.from}–${m.to}`).join('; ') : '—' },
          { key: 'capacity', label: 'Capacity', num: true },
        ],
        detail.venues,
        { emptyText: 'No venues mapped' },
      ),
      { flush: true, note: 'Read from the Venue Management module by reference; TMS writes utilisation back (§11)' },
    ),

    card(
      'Tournament team',
      table(
        [
          { key: 'name', label: 'Name' },
          { label: 'Role', render: (u) => plainBadge(u.role, 'info') },
          { label: 'Scope', render: (u) => el('span', { class: 'card-note' }, [
              u.scope.sportIds?.length ? `sports: ${u.scope.sportIds.join(', ')} ` : '',
              u.scope.venueIds?.length ? `venues: ${u.scope.venueIds.join(', ')} ` : '',
              u.scope.unitId ? `unit: ${u.scope.unitId}` : '',
            ].filter(Boolean).join(' · ') || 'tournament-wide') },
        ],
        ctx.state.users.filter((u) => !/^OF-/.test(u.userId) && u.role !== 'Viewer'),
      ),
      { flush: true, note: '§1.5 maps Competition Managers, Venue Managers and admin staff to the tournament' },
    ),
  ]);
}

/** §12.1 — the guided creation wizard: basics → scope → rules → team. */
function createWizard(ctx) {
  const f = {};
  const mk = (name, attrs) => (f[name] = input(attrs));

  const submit = async () => {
    const payload = {
      code: f.code.value, name: f.name.value, organizingBody: f.body.value,
      level: f.level.value, season: f.season.value,
      startDate: f.start.value, endDate: f.end.value, hostCity: f.city.value,
      venues: [], ageCategories: f.ages.value.split(',').map((s) => s.trim()).filter(Boolean),
      genderCategories: f.genders.value.split(',').map((s) => s.trim()).filter(Boolean),
      participatingUnits: f.units.value.split(',').map((s) => s.trim()).filter(Boolean),
      entryDeadline: f.entryDeadline.value, withdrawalDeadline: f.withdrawalDeadline.value,
      protestWindowMins: Number(f.protestWindow.value), protestFee: Number(f.protestFee.value),
      approvalChainType: f.chain.value, categoryCutOffDate: f.cutOff.value,
      maxEventsPerAthlete: Number(f.maxEvents.value), minEntriesToRun: Number(f.minEntries.value),
      maxEntriesPerUnit: Number(f.maxPerUnit.value),
      autoPublishResults: f.autoPublish.value === 'true',
      enforceOfficialNeutrality: f.neutrality.value === 'true',
    };
    await ctx.api.act('Tournament created', () => ctx.api.post('/api/tournaments', payload));
    location.reload();
  };

  f.level = select(LEVELS.map((l) => ({ value: l, label: l })), { value: 'national' });
  f.chain = select([{ value: '2-step', label: '2-step (verify then approve)' }, { value: '1-step', label: '1-step' }], { value: '2-step' });
  f.autoPublish = select([{ value: 'false', label: 'Separate explicit act' }, { value: 'true', label: 'Automatically on approval' }], { value: 'false' });
  f.neutrality = select([{ value: 'true', label: 'Enforced (hard block)' }, { value: 'false', label: 'Advisory only' }], { value: 'true' });

  return el('div', {}, [
    notice('info', 'Phase 1 — Tournament Creation', 'The wizard collects basics, scope and rules. On submit the §5.1 validation list runs: end date on or after start, entry deadline before start, organizing body present, unique code, a Competition Manager assigned, and a category cut-off date set.'),
    card(
      'New tournament',
      el('div', { class: 'grid grid-3' }, [
        field('Name', mk('name', { value: 'National Kabaddi Championship 2026' })),
        field('Code', mk('code', { value: 'NKC-2026' })),
        field('Organizing body', mk('body', { value: 'Amateur Kabaddi Federation of India' })),
        field('Level', f.level),
        field('Season / edition', mk('season', { value: '2026' })),
        field('Host city', mk('city', { value: 'Pune' })),
        field('Start date', mk('start', { type: 'date', value: '2026-03-10' })),
        field('End date', mk('end', { type: 'date', value: '2026-03-14' })),
        field('Category cut-off', mk('cutOff', { type: 'date', value: '2026-01-01' }), 'Age is judged on this date, not today (§7.1.2)'),
        field('Age categories', mk('ages', { value: 'SENIOR' })),
        field('Gender categories', mk('genders', { value: 'M, W' })),
        field('Participating units', mk('units', { value: 'MH, HR, PB, UP, RJ, TN, KA, DL' })),
        field('Entry deadline', mk('entryDeadline', { type: 'date', value: '2026-02-20' })),
        field('Withdrawal deadline', mk('withdrawalDeadline', { type: 'date', value: '2026-02-25' })),
        field('Protest window (min)', mk('protestWindow', { type: 'number', value: '30' })),
        field('Protest fee', mk('protestFee', { type: 'number', value: '5000' })),
        field('Approval chain', f.chain),
        field('Publish results', f.autoPublish),
        field('Official neutrality', f.neutrality, 'Configurable per tournament level (§7.3.13)'),
        field('Max events per athlete', mk('maxEvents', { type: 'number', value: '1' })),
        field('Min entries to run an event', mk('minEntries', { type: 'number', value: '4' })),
        field('Max entries per unit', mk('maxPerUnit', { type: 'number', value: '1' })),
      ]),
      { actions: [el('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, 'Create draft')] },
    ),
  ]);
}
