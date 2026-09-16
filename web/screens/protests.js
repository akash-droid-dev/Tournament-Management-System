/**
 * Protest & Exception Register — §12.14.
 *
 * Filing, jury rulings and the full exception log in one place, because §10.12
 * treats them as one governance record: "All walkovers, DQs, protests with
 * rulings, corrections with before/after".
 */

import { badge, card, el, empty, field, notice, pageHead, prompt, select, table, tile } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const protests = await ctx.api.get(`/api/tournaments/${t.tournamentId}/protests`);
  const exceptions = await ctx.api.get(`/api/tournaments/${t.tournamentId}/exceptions`);
  const matches = await ctx.api.get(`/api/tournaments/${t.tournamentId}/matches`);
  const byId = new Map(matches.map((m) => [m.matchId, m]));

  const canRule = ['Super Admin', 'Tournament Admin', 'Jury of Appeal', 'Technical Official'].includes(ctx.user.role);
  const isTM = ctx.user.role === 'Team Manager';

  // §9.5 — a Team Manager can only file while the window is open.
  let openWindows = [];
  if (isTM && ctx.dashboard?.protestTimers) openWindows = ctx.dashboard.protestTimers;

  const open = protests.filter((p) => p.status === 'Filed' || p.status === 'Under Review');

  const doFile = async (matchId) => {
    const a = await prompt({
      title: 'File a protest',
      confirmLabel: 'File with fee',
      fields: [
        { name: 'grounds', label: 'Grounds', type: 'textarea', required: true, hint: 'Stated grounds are recorded verbatim and shown to the Jury' },
        { name: 'feePaid', label: 'Fee paid', type: 'number', value: String(t.protestFee), required: true, hint: `The tournament fee is ${t.protestFee}; the fee is forfeited if the protest is rejected (§8.3)` },
      ],
    });
    if (!a) return;
    await ctx.api.act('Protest filed', () => ctx.api.post(`/api/matches/${matchId}/protest`, { grounds: a.grounds, feePaid: Number(a.feePaid) }));
  };

  const doRule = async (p) => {
    const a = await prompt({
      title: `Rule on ${p.protestId}`,
      confirmLabel: 'Record ruling',
      fields: [
        { name: 'outcome', label: 'Outcome', type: 'select', options: [{ value: 'Rejected', label: 'Rejected — fee forfeited, result proceeds' }, { value: 'Upheld', label: 'Upheld — result amended or match replayed' }] },
        { name: 'action', label: 'Action', type: 'select', options: [{ value: 'no-change', label: 'No change' }, { value: 'amend-result', label: 'Amend the result' }, { value: 'replay-match', label: 'Replay the match' }] },
        { name: 'text', label: 'Ruling', type: 'textarea', required: true, hint: 'Recorded in writing on the register (§8.9)' },
      ],
    });
    if (!a) return;
    await ctx.api.act('Ruling recorded', () => ctx.api.post(`/api/protests/${p.protestId}/rule`, a));
  };

  return el('div', {}, [
    pageHead(
      'Protest & exception register',
      'Every walkover, no-show, disqualification, postponement, suspension, abandonment, protest and correction, with who decided it, under which reason code, and who ratified it.',
      '§12.14',
    ),

    el('div', { class: 'grid grid-4' }, [
      tile('Open protests', open.length, open.length ? 'Bracket paths frozen' : 'None', open.length ? 'is-alert' : 'is-ok'),
      tile('Upheld', protests.filter((p) => p.status === 'Upheld').length, 'Result amended or replayed'),
      tile('Rejected', protests.filter((p) => p.status === 'Rejected').length, 'Fee forfeited'),
      tile('Exceptions logged', exceptions.length, `${new Set(exceptions.map((e) => e.scenario)).size} distinct scenario(s)`),
    ]),
    el('div', { style: 'height:16px' }),

    open.length
      ? notice('danger', 'Open protests freeze their bracket path (§7.4.19)',
          open.map((p) => `${p.protestId} on ${byId.get(p.matchId)?.matchNo ?? p.matchId}: ${p.grounds}`))
      : null,

    isTM && openWindows.length
      ? card(
          'Protest windows open for your unit',
          table(
            [
              { key: 'matchNo', label: 'Fixture', mono: true },
              { label: 'Closes in', render: (w) => `${w.remainingMins} min` },
              { label: '', render: (w) => el('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => doFile(w.matchId) }, 'File protest…') },
            ],
            openWindows,
          ),
          { flush: true, note: `Window is ${t.protestWindowMins} min from verification; the fee is ${t.protestFee} and is forfeited if the protest is rejected (§8.3)` },
        )
      : null,

    card(
      'Protests',
      table(
        [
          { key: 'protestId', label: 'ID', mono: true },
          { label: 'Fixture', render: (p) => el('span', { class: 'mono' }, byId.get(p.matchId)?.matchNo ?? p.matchId) },
          { key: 'filedByUnit', label: 'Filed by' },
          { label: 'When', render: (p) => new Date(p.filedAt).toLocaleString() },
          { key: 'grounds', label: 'Grounds' },
          { label: 'Fee', num: true, render: (p) => `${p.feePaid}${p.feeForfeited ? ' (forfeited)' : ''}` },
          { label: 'Status', render: (p) => badge(p.status) },
          { key: 'ruling', label: 'Ruling' },
          { key: 'ruledBy', label: 'Ruled by', mono: true },
          {
            label: '',
            render: (p) =>
              canRule && (p.status === 'Filed' || p.status === 'Under Review')
                ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => doRule(p) }, 'Rule…')
                : null,
          },
        ],
        protests,
        {
          rowClass: (p) => (p.status === 'Filed' || p.status === 'Under Review' ? 'row-flag' : ''),
          emptyText: 'No protests filed',
        },
      ),
      { flush: true, note: 'The Jury of Appeal rules; an upheld protest sends the result back for correction, a rejected one forfeits the fee and lets it proceed (§8.9)' },
    ),

    card(
      'Exception log',
      table(
        [
          { key: 'exceptionId', label: 'ID', mono: true },
          { label: 'Scenario', render: (e) => badge(e.scenario.replace(/-/g, ' '), 'badge-plain badge-warn') },
          { label: 'Fixture', render: (e) => el('span', { class: 'mono' }, e.matchId ? byId.get(e.matchId)?.matchNo ?? e.matchId : '—') },
          { key: 'reasonCode', label: 'Reason code', mono: true },
          { key: 'detail', label: 'Detail' },
          { label: 'Decided by', render: (e) => `${e.decidedBy} (${e.decidedByRole})` },
          { label: 'Ratified by', render: (e) => e.ratifiedBy ?? el('span', { class: 'card-note' }, 'not required') },
          { label: 'At', render: (e) => new Date(e.at).toLocaleString() },
        ],
        exceptions,
        { emptyText: 'No exceptions recorded' },
      ),
      { flush: true, note: 'High-impact actions — unlocks, redraws, cancellations, mass reschedules, DQ cascades — carry a second-role ratification (§7.6.26)' },
    ),

    card(
      'The exception playbook',
      table(
        [
          { key: 'n', label: '#', num: true },
          { key: 'name', label: 'Scenario' },
          { key: 'trigger', label: 'Trigger' },
          { key: 'handling', label: 'System handling' },
          { key: 'role', label: 'Deciding role' },
          { label: 'Seen here', num: true, render: (r) => exceptions.filter((e) => e.scenario === r.key).length },
        ],
        PLAYBOOK,
      ),
      { flush: true, note: 'All fourteen rows of §8, with the count recorded in this tournament' },
    ),
  ]);
}

const PLAYBOOK = [
  { n: 1, key: 'walkover', name: 'Walkover', trigger: 'One side concedes before the start', handling: 'Sport-standard auto-result; opponent advances; standard points', role: 'Technical Official confirms' },
  { n: 2, key: 'no-show', name: 'No-show', trigger: 'Absent at the no-show deadline', handling: 'Timer expiry recorded; treated as a walkover; unit flagged for repeat offences', role: 'Technical Official' },
  { n: 3, key: 'disqualification', name: 'Disqualification', trigger: 'Conduct, equipment, doping, or ineligibility discovered', handling: 'Result per sport rule; prior results recomputed and forfeits cascaded; medals reallocated', role: 'Technical Official / Jury; Admin ratifies the cascade' },
  { n: 4, key: 'postponed', name: 'Postponed match', trigger: 'Weather, venue failure, medical, force majeure', handling: 'Reschedule with a full conflict re-check; dependent fixtures shifted with a warning report', role: 'Competition Manager proposes, Admin approves' },
  { n: 5, key: 'cancelled', name: 'Cancelled match or event', trigger: 'Insufficient entries, safety, or a ruling', handling: 'Terminal status with a reason; points void or shared per the ruling', role: 'Tournament Admin' },
  { n: 6, key: 'tie', name: 'Tie / draw', trigger: 'Level score at full time', handling: 'Sport template decides: shared points in a league, extra halves then a golden raid in a knockout', role: 'System per config; Referee executes' },
  { n: 7, key: 'suspended', name: 'Suspended match', trigger: 'Rain, light or an operational delay mid-match', handling: 'Score, clock and situation saved; resume from that state or reschedule the remainder', role: 'Referee + Technical Official' },
  { n: 8, key: 'abandoned', name: 'Abandoned match', trigger: 'Cannot be completed or resumed', handling: 'Committee decides replay, resume or award; decision and basis recorded', role: 'Jury/Committee, Admin ratifies' },
  { n: 9, key: 'protest', name: 'Protest / appeal', trigger: 'Filed within the window with the fee', handling: 'Result held Under Protest; bracket path frozen; jury ruling recorded', role: 'Jury of Appeal' },
  { n: 10, key: 'result-correction', name: 'Result correction', trigger: 'Error found after the lock', handling: 'Unlock, correct, re-verify, re-approve, recompute; full audit trail', role: 'Admin initiates, Admin/Super Admin approves' },
  { n: 11, key: 'participant-change', name: 'Participant / team change', trigger: 'Injury replacement or roster change', handling: 'Approved reserve list only, before the first match; eligibility re-validated; logged', role: 'Competition Manager + Admin approval' },
  { n: 12, key: 'venue-change', name: 'Venue / schedule change', trigger: 'Venue unavailable', handling: 'Bulk reschedule of a field of play or venue; conflict re-check; mass notification', role: 'Venue Manager proposes, Admin approves' },
  { n: 13, key: 'weather-delay', name: 'Weather / operational delay', trigger: 'A session is lost', handling: 'Session-shift compresses the remaining grid; reduced rest gaps flagged for acknowledgment', role: 'Competition Manager + Admin' },
  { n: 14, key: 'system-outage', name: 'Data / system outage', trigger: 'Live entry impossible', handling: 'Paper scoresheet fallback; post-facto entry marked as offline; verification mandatory', role: 'Scorer + Technical Official' },
];
