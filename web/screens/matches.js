/**
 * Match Console — §12.9.
 *
 * The match-day screen: attendance and accreditation, the toss, the
 * sport-specific scoring pad, the event log, exception buttons and the
 * referee's sign-off. The pad is generated from the sport template's
 * `consoleActions`, so a different sport changes the buttons without changing
 * this file.
 *
 * Validation is the server's: an illegal Kabaddi action (a bonus with five
 * defenders on the mat, a touch that puts out more defenders than are on it)
 * is rejected at entry and surfaced as a toast naming the rule (§7.4.16).
 */

import { badge, card, el, empty, field, fmtClock, gateList, input, notice, pageHead, prompt, select, table, tile } from '../ui.js';

export async function render(ctx) {
  const t = ctx.tournament;
  const all = await ctx.api.get(`/api/tournaments/${t.tournamentId}/matches`);
  const playable = all.filter((m) => !m.byeFlag);
  if (!playable.length) return el('div', {}, [pageHead('Match console', null, '§12.9'), empty('No fixtures yet')]);

  const matchId = ctx.params.matchId ?? pickDefault(playable);
  const c = await ctx.api.get(`/api/matches/${matchId}`);
  const m = c.match;
  const ops = c.operations;
  const st = c.state;
  const sport = ctx.sport;

  const picker = field(
    'Fixture',
    select(
      playable.map((x) => ({
        value: x.matchId,
        label: `${x.matchNo} · ${x.stage} · ${x.sideA.displayName} v ${x.sideB.displayName} · ${x.matchStatus}`,
      })),
      { value: matchId, onchange: (v) => ctx.go('matches', { matchId: v }) },
    ),
  );

  const clockInput = input({ type: 'number', min: '0', value: String(st.clockSecs ?? 0), style: 'width:92px' });

  const score = (side) =>
    el('div', { class: 'sb-side' }, [
      el('div', { class: 'sb-name' }, m[side === 'A' ? 'sideA' : 'sideB'].displayName),
      el('div', { class: 'sb-score' }, String(st[side].score)),
      el('div', { class: 'sb-mat' }, `${st[side].onCourt} on the ${sport.fopType}${st[side].outQueue.length ? ` · ${st[side].outQueue.length} out` : ''}`),
    ]);

  const scoreboard = el('div', { class: 'scoreboard' }, [
    score('A'),
    el('div', { class: 'sb-mid' }, [
      el('div', {}, st.tiePhase === 'none' ? `Half ${st.period}` : st.tiePhase),
      el('div', { style: 'font-size:16px;margin:4px 0' }, fmtClock(st.clockSecs)),
      el('div', {}, ['raid #', String(st.raidNo), ' by ', el('span', { class: 'sb-raiding' }, st.raidingSide)]),
      st.doOrDie ? el('div', { class: 'sb-dod' }, 'DO OR DIE') : null,
      el('div', { style: 'margin-top:6px' }, badge(m.matchStatus)),
    ]),
    score('B'),
  ]);

  // ── Scoring pad ────────────────────────────────────────────────────────
  const sendScore = async (action, side, value, extra = {}) => {
    await ctx.api.act(null, () =>
      ctx.api.post(`/api/matches/${m.matchId}/score`, {
        type: action.type,
        side,
        value,
        clockSecs: Number(clockInput.value) + 30,
        ...extra,
      }),
      { silent: true },
    );
  };

  const isLive = m.matchStatus === 'Live';
  const padFor = (side) =>
    el('div', { class: 'pad' }, sport.consoleActions.filter((a) => a.kind === 'point').map((a) =>
      el(
        'button',
        {
          class: 'pad-btn',
          type: 'button',
          disabled: !isLive || !c.canScore,
          onclick: () => sendScore(a, side, a.defaultValue),
        },
        [el('span', { class: 'pad-btn-label' }, a.label), el('span', { class: 'pad-btn-hint' }, a.hint)],
      ),
    ));

  const adminPad = el('div', { class: 'pad' }, sport.consoleActions.filter((a) => a.kind === 'admin').map((a) =>
    el(
      'button',
      {
        class: 'pad-btn is-admin',
        type: 'button',
        disabled: !isLive || !c.canScore,
        onclick: async () => {
          if (a.type.startsWith('card-')) {
            const players = ops.attendance.filter((x) => x.present);
            const answers = await prompt({
              title: a.label,
              confirmLabel: 'Issue',
              fields: [
                { name: 'participantId', label: 'Player', type: 'select', options: players.map((p) => ({ value: p.participantId, label: `${p.side} · ${p.participantName}` })) },
                { name: 'reason', label: 'Reason', type: 'text', required: true },
              ],
            });
            if (!answers) return;
            const player = players.find((p) => p.participantId === answers.participantId);
            await sendScore(a, player?.side ?? 'A', 0, { participantId: answers.participantId, detail: { reason: answers.reason } });
            return;
          }
          const answers = await prompt({
            title: a.label,
            confirmLabel: 'Record',
            fields: [{ name: 'side', label: 'Side', type: 'select', options: [{ value: 'A', label: m.sideA.displayName }, { value: 'B', label: m.sideB.displayName }] }],
          });
          if (!answers) return;
          await sendScore(a, answers.side, 0);
        },
      },
      [el('span', { class: 'pad-btn-label' }, a.label), el('span', { class: 'pad-btn-hint' }, a.hint)],
    ),
  ));

  // ── Attendance ─────────────────────────────────────────────────────────
  const attendanceRows = ops.attendance.length
    ? ops.attendance
    : [];

  const confirmAttendance = async () => {
    // Build the full squad from the match's entries, defaulting everyone
    // present with the first `onField` marked as the starting line-up.
    const data = await ctx.api.get(`/api/events/${m.eventId}`);
    const rows = [];
    for (const side of ['A', 'B']) {
      const s = side === 'A' ? m.sideA : m.sideB;
      if (s.kind !== 'entry') continue;
      const entry = data.entries.find((e) => e.entryId === s.entryId);
      (entry?.rosterRefs ?? []).slice(0, sport.roster.max).forEach((r, i) => {
        rows.push({
          participantId: r.id,
          participantName: r.displayName,
          side,
          present: true,
          checkinTime: new Date().toISOString(),
          accreditationValid: true,
          startingLineup: i < sport.roster.onField,
        });
      });
    }
    await ctx.api.act('Attendance confirmed', () => ctx.api.post(`/api/matches/${m.matchId}/attendance`, { attendance: rows }));
  };

  const doToss = async () => {
    const answers = await prompt({
      title: 'Record the toss',
      confirmLabel: 'Record',
      fields: [
        { name: 'winner', label: 'Toss won by', type: 'select', options: [{ value: 'A', label: m.sideA.displayName }, { value: 'B', label: m.sideB.displayName }] },
        { name: 'choice', label: 'Chose', type: 'select', options: [{ value: 'raid', label: 'To raid first' }, { value: 'court', label: 'Court' }] },
      ],
    });
    if (!answers) return;
    await ctx.api.act('Toss recorded', () => ctx.api.post(`/api/matches/${m.matchId}/toss`, answers));
  };

  const doException = async (kind, title, fields) => {
    const answers = await prompt({ title, confirmLabel: 'Apply', fields });
    if (!answers) return;
    const out = await ctx.api.act(title, () => ctx.api.post(`/api/matches/${m.matchId}/exception/${kind}`, answers));
    if (out?.followUps?.length) {
      await prompt({
        title: 'Follow-up actions required',
        confirmLabel: 'Understood',
        fields: [{ name: 'f', label: 'The system requires these next', type: 'textarea', value: out.followUps.map((x, i) => `${i + 1}. ${x}`).join('\n') }],
      });
    }
  };

  const reasonOpts = (kind) => (ctx.reasonCodes[kind] ?? []).map((x) => ({ value: x, label: x }));
  const sideOpts = [{ value: 'A', label: m.sideA.displayName }, { value: 'B', label: m.sideB.displayName }];

  // ── Event log ──────────────────────────────────────────────────────────
  const derivedTypes = new Set(['all-out', 'revive', 'do-or-die-fail', 'super-tackle']);
  const timeline = el('div', { class: 'timeline' }, [...ops.scoreEvents].reverse().map((e) =>
    el('div', { class: 'tl-row' }, [
      el('span', { class: 'tl-clock' }, fmtClock(e.clockSecs)),
      el('span', { class: 'tl-side' }, e.side),
      el('span', { class: derivedTypes.has(e.type) ? 'tl-derived' : '' },
        [e.type.replace(/-/g, ' '), e.detail?.upgradedFrom ? ' (upgraded from tackle)' : '',
         e.detail?.allOutAgainst ? ` — ${e.detail.allOutAgainst} all out` : '',
         e.detail?.revived ? ` ×${e.detail.revived}` : '',
         e.detail?.reason ? ` — ${e.detail.reason}` : ''].join('')),
      el('span', { class: 'tl-pts' }, e.value ? `+${e.value}` : ''),
    ]),
  ));

  const stats = c.summary.statistics;
  const statRow = (label, key) => ({ label, a: stats[`A_${key}`] ?? 0, b: stats[`B_${key}`] ?? 0 });

  return el('div', {}, [
    pageHead(
      'Match console',
      'Phase 7 runs match day: check-in, attendance and accreditation, the toss, live scoring with legality validation, exception handling and the referee sign-off.',
      '§12.9',
    ),

    el('div', { class: 'filters' }, [picker, el('div', { style: 'flex:1' }),
      el('span', { class: 'badge badge-plain badge-neutral' }, `${m.stage}${m.groupId ? ` · ${m.groupId}` : ''}`),
      m.fopId ? el('span', { class: 'badge badge-plain badge-neutral' }, `${m.fopId} · ${m.scheduledDate ?? ''} ${m.scheduledTime ?? ''}`) : null,
    ]),

    scoreboard,

    !c.gate.open
      ? card('Gate to match operations', gateList(c.gate), {
          note: 'A fixture cannot reach Check-in until its schedule is published and its minimum officials panel is filled (§7.3.15)',
        })
      : null,

    card(
      'Match control',
      el('div', {}, [
        el('div', { class: 'btn-row' }, [
          m.matchStatus === 'Scheduled'
            ? el('button', { class: 'btn btn-primary', type: 'button', disabled: !c.gate.open, onclick: () => ctx.api.act('Console opened', () => ctx.api.post(`/api/matches/${m.matchId}/open`)) }, 'Open console (→ Check-in)')
            : null,
          m.matchStatus === 'Check-in'
            ? el('button', { class: 'btn', type: 'button', onclick: confirmAttendance }, 'Confirm attendance & line-up')
            : null,
          m.matchStatus === 'Check-in' ? el('button', { class: 'btn', type: 'button', onclick: doToss }, 'Record toss') : null,
          m.matchStatus === 'Check-in'
            ? el('button', { class: 'btn btn-primary', type: 'button', disabled: !ops.attendance.length, onclick: () => ctx.api.act('Match started', () => ctx.api.post(`/api/matches/${m.matchId}/start`)) }, 'Start match (→ Live)')
            : null,
          isLive
            ? el('button', { class: 'btn btn-ok', type: 'button', onclick: () => ctx.api.act('Match ended', () => ctx.api.post(`/api/matches/${m.matchId}/end`)) }, 'End match')
            : null,
          m.matchStatus === 'Completed (Provisional)' && !ops.refereeSignoff
            ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.api.act('Match report signed', () => ctx.api.post(`/api/matches/${m.matchId}/signoff`)) }, 'Referee sign-off')
            : null,
          m.matchStatus === 'Suspended'
            ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => doException('resume', 'Resume from the saved state', [{ name: 'atClockSecs', label: 'Clock (seconds)', type: 'number', value: String(st.clockSecs) }]) }, 'Resume')
            : null,
          m.matchStatus === 'Completed (Provisional)'
            ? el('button', { class: 'btn', type: 'button', onclick: () => ctx.go('approvals', { matchId: m.matchId }) }, 'Go to result approval →')
            : null,
        ].filter(Boolean)),
        ops.tossWinner
          ? el('p', { class: 'card-note', style: 'margin-top:10px' },
              `Toss won by ${ops.tossWinner === 'A' ? m.sideA.displayName : m.sideB.displayName}, chose ${ops.tossChoice === 'raid' ? 'to raid first' : 'the court'}.`)
          : null,
        ops.refereeSignoff
          ? el('p', { class: 'card-note' }, `Match report signed by ${ops.refereeSignoff.officialName} at ${new Date(ops.refereeSignoff.timestamp).toLocaleString()}.`)
          : null,
      ]),
      {
        note: `Status machine: ${m.matchStatus}. Every transition is checked against §6.2 and terminal or exception statuses require a reason code.`,
        actions: [
          el('div', { class: 'field', style: 'flex-direction:row;align-items:center;gap:6px' }, [
            el('span', { class: 'field-label' }, 'Clock (s)'), clockInput,
          ]),
        ],
      },
    ),

    isLive
      ? el('div', { class: 'grid grid-2' }, [
          card(`${m.sideA.displayName} — scoring`, padFor('A'), {
            note: st.raidingSide === 'A' ? 'Raiding this turn' : 'Defending this turn',
          }),
          card(`${m.sideB.displayName} — scoring`, padFor('B'), {
            note: st.raidingSide === 'B' ? 'Raiding this turn' : 'Defending this turn',
          }),
        ])
      : null,

    isLive ? card('Match events', adminPad, { note: 'Cards, time outs, substitutions, injuries and the half-time whistle' }) : null,

    card(
      'Exceptions',
      el('div', { class: 'btn-row' }, [
        ['Scheduled', 'Check-in'].includes(m.matchStatus)
          ? el('button', { class: 'btn btn-danger', type: 'button', onclick: () => doException('walkover', 'Award a walkover', [
              { name: 'winningSide', label: 'Awarded to', type: 'select', options: sideOpts },
              { name: 'reasonCode', label: 'Reason code', type: 'select', options: reasonOpts('match') },
              { name: 'detail', label: 'Detail', type: 'textarea', required: true },
            ]) }, 'Walkover')
          : null,
        m.matchStatus === 'Check-in'
          ? el('button', { class: 'btn btn-danger', type: 'button', onclick: () => doException('no-show', 'Rule a no-show', [
              { name: 'absentSide', label: 'Absent side', type: 'select', options: sideOpts },
            ]) }, 'No-show')
          : null,
        ['Scheduled', 'Check-in'].includes(m.matchStatus)
          ? el('button', { class: 'btn', type: 'button', onclick: () => doException('postpone', 'Postpone this fixture', [
              { name: 'reasonCode', label: 'Reason code', type: 'select', options: reasonOpts('match') },
              { name: 'detail', label: 'Detail', type: 'textarea', required: true },
              { name: 'approvedBy', label: 'Approved by (Tournament Admin user ID)', type: 'text' },
            ]) }, 'Postpone')
          : null,
        isLive
          ? el('button', { class: 'btn', type: 'button', onclick: () => doException('suspend', 'Suspend the match', [
              { name: 'atClockSecs', label: 'Clock (seconds)', type: 'number', value: String(st.clockSecs) },
              { name: 'reasonCode', label: 'Reason code', type: 'select', options: reasonOpts('match') },
              { name: 'detail', label: 'Detail', type: 'textarea', required: true },
            ]) }, 'Suspend')
          : null,
        isLive
          ? el('button', { class: 'btn btn-danger', type: 'button', onclick: () => doException('disqualification', 'Disqualify a side', [
              { name: 'disqualifiedEntryId', label: 'Disqualified entry', type: 'select', options: [m.sideA, m.sideB].filter((s) => s.kind === 'entry').map((s) => ({ value: s.entryId, label: s.displayName })) },
              { name: 'reasonCode', label: 'Reason code', type: 'select', options: reasonOpts('match') },
              { name: 'detail', label: 'Detail', type: 'textarea', required: true },
              { name: 'cascadePriorResults', label: 'Cascade prior results?', type: 'select', options: [{ value: '', label: 'No' }, { value: 'true', label: 'Yes — recompute earlier results' }] },
              { name: 'ratifiedBy', label: 'Ratified by (required for a cascade)', type: 'text' },
            ]) }, 'Disqualify')
          : null,
        ['Live', 'Suspended'].includes(m.matchStatus)
          ? el('button', { class: 'btn btn-danger', type: 'button', onclick: () => doException('abandon', 'Abandon the match', [
              { name: 'reasonCode', label: 'Reason code', type: 'select', options: reasonOpts('match') },
              { name: 'detail', label: 'Detail', type: 'textarea', required: true },
              { name: 'committeeDecision', label: 'Committee decision', type: 'select', options: [{ value: 'replay', label: 'Replay in full' }, { value: 'award-result', label: 'Award the result' }, { value: 'void', label: 'Void the match' }] },
              { name: 'awardedTo', label: 'Awarded to (if awarding)', type: 'select', options: [{ value: '', label: '—' }, ...sideOpts] },
              { name: 'ratifiedBy', label: 'Ratified by (Tournament Admin)', type: 'text', required: true },
            ]) }, 'Abandon')
          : null,
        el('button', { class: 'btn', type: 'button', onclick: () => doException('offline-entry', 'Mark as an offline entry', [
          { name: 'reasonCode', label: 'Reason code', type: 'select', options: reasonOpts('match') },
          { name: 'scoresheetRef', label: 'Paper scoresheet reference', type: 'text', required: true },
          { name: 'detail', label: 'Detail', type: 'textarea', required: true },
        ]) }, 'Offline entry'),
      ].filter(Boolean)),
      {
        note: 'Each exception enforces its deciding role, demands a reason code, and requires a second-role ratification where the action is high-impact (§8, §7.6.26)',
      },
    ),

    el('div', { class: 'grid grid-2' }, [
      card('Event log', ops.scoreEvents.length ? timeline : empty('No events yet'), {
        flush: true,
        note: 'Italic rows are derived by the rules engine — all-outs, revivals, do-or-die concessions and super-tackle upgrades',
      }),

      el('div', {}, [
        card(
          'Match statistics',
          table(
            [
              { key: 'label', label: '' },
              { key: 'a', label: m.sideA.displayName.slice(0, 14), num: true },
              { key: 'b', label: m.sideB.displayName.slice(0, 14), num: true },
            ],
            [
              statRow('Raid points', 'raidPoints'),
              statRow('Bonus points', 'bonusPoints'),
              statRow('Tackle points', 'tacklePoints'),
              statRow('Super tackles', 'superTackles'),
              statRow('All outs', 'allOuts'),
              statRow('Technical points', 'technicalPoints'),
              statRow('Total raids', 'totalRaids'),
              statRow('Successful raids', 'successfulRaids'),
              statRow('Raid success %', 'raidSuccessPct'),
              statRow('Empty raids', 'emptyRaids'),
              statRow('Super raids', 'superRaids'),
              statRow('Green cards', 'greenCards'),
              statRow('Yellow cards', 'yellowCards'),
              statRow('Red cards', 'redCards'),
            ],
          ),
          { flush: true, note: 'Carried into the result and the §10.6 match result report' },
        ),
        card(
          'Officials on duty',
          table(
            [
              { key: 'role', label: 'Seat' },
              { key: 'officialName', label: 'Official' },
              { key: 'unitId', label: 'Unit' },
              { label: 'Neutrality', render: (o) => badge(o.neutralityCheckResult) },
            ],
            c.officials,
            { emptyText: 'No officials assigned' },
          ),
          {
            flush: true,
            note: c.panel.ok
              ? 'Minimum panel filled'
              : `Minimum panel incomplete: ${c.panel.missing.map((x) => `${x.role} ${x.have}/${x.needed}`).join(', ')}`,
          },
        ),
      ]),
    ]),

    ops.attendance.length
      ? card(
          'Attendance & line-up',
          table(
            [
              { key: 'side', label: 'Side' },
              { key: 'participantName', label: 'Player' },
              { label: 'Present', render: (a) => (a.present ? badge('Confirmed') : badge('Blocked')) },
              { label: 'Starting', render: (a) => (a.startingLineup ? `on the ${sport.fopType}` : 'substitute') },
              { label: 'Accreditation', render: (a) => (a.accreditationValid ? badge('pass') : badge('fail')) },
            ],
            attendanceRows,
          ),
          {
            flush: true,
            note: `${sport.roster.onField} on the ${sport.fopType}, up to ${sport.roster.max} in the squad. Invalid or expired accreditation blocks attendance confirmation (§11).`,
          },
        )
      : null,

    ops.suspensionLog.length
      ? card('Suspensions',
          table(
            [
              { label: 'From', render: (s) => fmtClock(s.fromClockSecs) },
              { label: 'To', render: (s) => (s.toClockSecs === undefined ? 'open' : fmtClock(s.toClockSecs)) },
              { key: 'reasonCode', label: 'Reason', mono: true },
              { key: 'decidedBy', label: 'Decided by', mono: true },
            ],
            ops.suspensionLog,
          ),
          { flush: true, note: 'State is saved so the match resumes from exactly where it stopped (§8 exception 7)' })
      : null,
  ]);
}

/** Prefer a live or in-progress fixture, so the console opens on real work. */
function pickDefault(matches) {
  const order = ['Live', 'Check-in', 'Scheduled', 'Completed (Provisional)'];
  for (const s of order) {
    const hit = matches.find((m) => m.matchStatus === s);
    if (hit) return hit.matchId;
  }
  return matches[0].matchId;
}
