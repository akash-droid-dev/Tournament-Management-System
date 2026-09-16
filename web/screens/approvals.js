/**
 * Result Verification & Approval Queue — §12.10, plus the Correction / Unlock
 * workflow screen — §12.11.
 *
 * The chain is rendered as a chain, because that is the thing to get right:
 * enter → verify → protest window → approve → LOCK, then a permissioned
 * unlock → correct → re-verify → re-approve. Maker–checker is enforced server
 * side, so the buttons here can be pressed and will be refused with the rule
 * that refused them.
 */

import { badge, card, el, empty, field, notice, pageHead, prompt, select, table, tile } from '../ui.js';

const CHAIN = ['Pending', 'Entered', 'Verified', 'Approved'];

export async function render(ctx) {
  const t = ctx.tournament;
  const queue = await ctx.api.get(`/api/tournaments/${t.tournamentId}/results/queue`);
  const matches = await ctx.api.get(`/api/tournaments/${t.tournamentId}/matches`);
  const byId = new Map(matches.map((m) => [m.matchId, m]));

  const selected = ctx.params.matchId ?? queue[0]?.matchId ?? null;
  const canVerify = ['Super Admin', 'Technical Official', 'Tournament Admin'].includes(ctx.user.role);
  const canApprove = ['Super Admin', 'Tournament Admin'].includes(ctx.user.role);
  const canEnter = ['Super Admin', 'Scorer', 'Tournament Admin', 'Competition Manager', 'Technical Official'].includes(ctx.user.role);

  const act = (label, path, body) => ctx.api.act(label, () => ctx.api.post(path, body ?? {}));

  const detail = selected ? await loadDetail(ctx, selected) : null;

  const step = (name, done, current) =>
    el('div', {
      class: `pill`,
      style: done
        ? 'background:var(--ok-soft);color:var(--ok);border-color:var(--ok);font-weight:700'
        : current
          ? 'background:var(--accent-soft);color:var(--accent);border-color:var(--accent-line);font-weight:700'
          : '',
    }, name);

  const chainStrip = (result) => {
    const at = result ? CHAIN.indexOf(result.resultStatus === 'Under Protest' ? 'Verified' : result.resultStatus) : -1;
    return el('div', { class: 'pill-row' }, [
      ...CHAIN.map((s, i) => step(s === 'Approved' ? 'Approved + LOCKED' : s, at > i, at === i)),
      result?.resultStatus === 'Under Protest' ? step('Under Protest', false, true) : null,
      result?.resultStatus === 'Correction in Progress' ? step('Correction in progress', false, true) : null,
      result?.resultStatus === 'Re-verified' ? step('Re-verified', false, true) : null,
    ].filter(Boolean));
  };

  return el('div', {}, [
    pageHead(
      'Result verification & approval',
      'Phase 8 runs the maker–checker–lock chain. The user who entered a result can never verify or approve it, a two-step chain needs a third pair of hands, and approval locks the result automatically.',
      '§12.10–11',
    ),

    el('div', { class: 'grid grid-4' }, [
      tile('Awaiting entry', queue.filter((q) => q.awaiting === 'entry').length, 'Match finished, no result', queue.filter((q) => q.awaiting === 'entry').length ? 'is-alert' : 'is-ok'),
      tile('Awaiting verification', queue.filter((q) => q.awaiting === 'verification').length, 'Needs a Technical Official'),
      tile('In protest window', queue.filter((q) => q.awaiting === 'protest window').length, 'Cannot be approved yet'),
      tile('Awaiting approval', queue.filter((q) => q.awaiting === 'approval').length, 'Verified, ready to lock'),
    ]),
    el('div', { style: 'height:16px' }),

    card(
      'Queue',
      table(
        [
          { key: 'matchNo', label: 'Fixture', mono: true },
          { label: 'Sides', render: (q) => { const m = byId.get(q.matchId); return m ? `${m.sideA.displayName} v ${m.sideB.displayName}` : '—'; } },
          { label: 'Result status', render: (q) => badge(q.status) },
          { label: 'Awaiting', render: (q) => el('span', { style: 'font-weight:600' }, q.awaiting) },
          { key: 'enteredBy', label: 'Entered by', mono: true },
          { label: 'Protest window', render: (q) => (q.protestWindowRemainingMins ? `${q.protestWindowRemainingMins} min left` : '—') },
          { label: '', render: (q) => (q.overdue ? badge('Overdue', 'badge-plain badge-danger') : '') },
          {
            label: '',
            render: (q) => el('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.go('approvals', { matchId: q.matchId }) }, 'Open'),
          },
        ],
        queue,
        {
          rowClass: (q) => (q.overdue ? 'row-flag' : ''),
          emptyText: 'Nothing in the approval chain — every finished fixture is approved',
        },
      ),
      { flush: true, note: 'An overdue row is a finished fixture whose result has sat unentered or unverified beyond the threshold (§9.1)' },
    ),

    detail
      ? el('div', {}, [
          card(
            `${detail.match.matchNo} — ${detail.match.sideA.displayName} v ${detail.match.sideB.displayName}`,
            el('div', {}, [
              chainStrip(detail.result),
              el('div', { style: 'height:12px' }),
              detail.result
                ? el('dl', { class: 'kv' }, [
                    el('dt', {}, 'Score'), el('dd', {}, `${detail.result.finalScore.a} – ${detail.result.finalScore.b}`),
                    el('dt', {}, 'Outcome'), el('dd', {}, detail.result.outcomeType),
                    el('dt', {}, 'Winner'), el('dd', {}, winnerName(detail.match, detail.result)),
                    el('dt', {}, 'Entered by'), el('dd', {}, `${detail.result.enteredBy ?? '—'}${detail.result.enteredAt ? ` at ${new Date(detail.result.enteredAt).toLocaleString()}` : ''}`),
                    el('dt', {}, 'Verified by'), el('dd', {}, detail.result.verifiedBy ?? '—'),
                    el('dt', {}, 'Approved by'), el('dd', {}, detail.result.approvedBy ?? '—'),
                    el('dt', {}, 'Locked at'), el('dd', {}, detail.result.lockedAt ? new Date(detail.result.lockedAt).toLocaleString() : 'not locked'),
                    el('dt', {}, 'Published'), el('dd', {}, detail.result.publishedAt ? new Date(detail.result.publishedAt).toLocaleString() : 'not published'),
                    detail.result.verificationRemarks ? el('dt', {}, 'Returned with remarks') : null,
                    detail.result.verificationRemarks ? el('dd', {}, detail.result.verificationRemarks) : null,
                  ])
                : notice('warn', 'No result recorded', 'The Scorer must enter the final score before the chain can start (§8.1).'),
            ]),
            {
              note: detail.signed
                ? `Referee sign-off: ${detail.signed}`
                : 'The match report carries no referee signature yet (§7.7)',
              actions: [
                !detail.result && canEnter
                  ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => act('Result entered', `/api/results/${selected}/enter`) }, 'Enter result from live scoring')
                  : null,
                detail.result?.resultStatus === 'Entered' && canVerify
                  ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => act('Result verified', `/api/results/${selected}/verify`) }, 'Verify against scoresheet')
                  : null,
                ['Entered', 'Verified'].includes(detail.result?.resultStatus) && canVerify
                  ? el('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
                      const a = await prompt({ title: 'Return to the Scorer', confirmLabel: 'Return', fields: [{ name: 'remarks', label: 'Remarks', type: 'textarea', required: true, hint: 'The Scorer sees these when re-entering (§5.6)' }] });
                      if (a) await act('Returned to Scorer', `/api/results/${selected}/return`, a);
                    } }, 'Return with remarks')
                  : null,
                detail.result?.resultStatus === 'Verified' && canApprove
                  ? el('button', { class: 'btn btn-ok', type: 'button', onclick: async () => {
                      const q = queue.find((x) => x.matchId === selected);
                      if (q?.protestWindowRemainingMins) {
                        const a = await prompt({
                          title: 'The protest window is still open',
                          confirmLabel: 'Approve with a recorded reason',
                          fields: [{ name: 'overrideProtestWindowReason', label: 'Why approve early?', type: 'textarea', required: true, hint: `${q.protestWindowRemainingMins} min remain. Approving now locks the result before teams may contest it (§8.3).` }],
                        });
                        if (!a) return;
                        await act('Result approved and locked', `/api/results/${selected}/approve`, a);
                        return;
                      }
                      await act('Result approved and locked', `/api/results/${selected}/approve`);
                    } }, 'Approve & lock')
                  : null,
                detail.result?.resultStatus === 'Approved' && !detail.result.publishedAt && canApprove
                  ? el('button', { class: 'btn', type: 'button', onclick: () => act('Result published', `/api/results/${selected}/publish`) }, 'Publish')
                  : null,
                detail.result?.resultStatus === 'Re-verified' && canApprove
                  ? el('button', { class: 'btn btn-ok', type: 'button', onclick: () => act('Correction re-approved', `/api/results/${selected}/reapprove`) }, 'Re-approve & re-lock')
                  : null,
                detail.result?.resultStatus === 'Correction in Progress' && canVerify
                  ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => act('Correction re-verified', `/api/results/${selected}/reverify`) }, 'Re-verify correction')
                  : null,
              ].filter(Boolean),
            },
          ),

          // §12.11 — the correction / unlock workflow.
          detail.result?.resultStatus === 'Approved'
            ? card(
                'Correction / unlock workflow',
                el('div', {}, [
                  notice('warn', 'This result is approved and locked',
                    'Editing it requires a reason-coded unlock approved by a second role, then a correction, a re-verification and a re-approval. Standings, progression and medals recompute automatically, and every old and new value is stored (§8.7).'),
                  detail.downstream?.length
                    ? el('div', {}, [
                        el('p', { class: 'card-note' }, 'Correcting this result would disturb:'),
                        table(
                          [
                            { key: 'matchNo', label: 'Fixture', mono: true },
                            { key: 'stage', label: 'Stage' },
                            { key: 'matchStatus', label: 'Status' },
                            { key: 'reason', label: 'Why' },
                          ],
                          detail.downstream,
                        ),
                      ])
                    : null,
                ]),
                {
                  actions: canApprove
                    ? [el('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
                        const a = await prompt({
                          title: 'Request an unlock',
                          confirmLabel: 'Unlock',
                          fields: [
                            { name: 'reasonCode', label: 'Reason code', type: 'select', options: (ctx.reasonCodes.result ?? []).map((c) => ({ value: c, label: c })) },
                            { name: 'initiatedBy', label: 'Initiated by (user ID)', type: 'text', required: true, hint: 'Must differ from you: the initiator cannot approve their own unlock (§7.6.26)' },
                          ],
                        });
                        if (a) await act('Result unlocked', `/api/results/${selected}/unlock`, a);
                      } }, 'Unlock for correction…')]
                    : [],
                },
              )
            : null,

          detail.result?.resultStatus === 'Correction in Progress'
            ? card(
                'Apply the correction',
                el('div', {}, [
                  notice('info', 'Unlocked', 'Record the corrected values. Both the old and new value, the reason code and both approvers are stored in the correction history (§13.6).'),
                  el('div', { class: 'btn-row' }, [
                    el('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
                      const a = await prompt({
                        title: 'Correct the result',
                        confirmLabel: 'Apply correction',
                        fields: [
                          { name: 'a', label: `${detail.match.sideA.displayName} score`, type: 'number', value: String(detail.result.finalScore.a), required: true },
                          { name: 'b', label: `${detail.match.sideB.displayName} score`, type: 'number', value: String(detail.result.finalScore.b), required: true },
                          { name: 'reasonCode', label: 'Reason code', type: 'select', options: (ctx.reasonCodes.result ?? []).map((c) => ({ value: c, label: c })) },
                          { name: 'unlockedBy', label: 'Unlocked by (user ID)', type: 'text', required: true },
                          { name: 'initiatedBy', label: 'Initiated by (user ID)', type: 'text', required: true },
                        ],
                      });
                      if (!a) return;
                      await act('Correction applied', `/api/results/${selected}/correct`, {
                        reasonCode: a.reasonCode,
                        initiatedBy: a.initiatedBy,
                        unlockedBy: a.unlockedBy,
                        newFinalScore: { a: Number(a.a), b: Number(a.b) },
                      });
                    } }, 'Enter corrected score…'),
                  ]),
                ]),
              )
            : null,

          detail.result?.correctionHistory?.length
            ? card(
                'Correction history',
                table(
                  [
                    { key: 'field', label: 'Field' },
                    { key: 'oldValue', label: 'Old value', mono: true },
                    { key: 'newValue', label: 'New value', mono: true },
                    { key: 'reasonCode', label: 'Reason', mono: true },
                    { key: 'unlockedBy', label: 'Unlocked by', mono: true },
                    { key: 'approvedBy', label: 'Approved by', mono: true },
                    { label: 'At', render: (c) => new Date(c.unlockedAt).toLocaleString() },
                  ],
                  detail.result.correctionHistory,
                ),
                { flush: true, note: 'Append-only, and mirrored into the audit trail (§8.7)' },
              )
            : null,

          // §12.10 — side-by-side digital result against the scoresheet.
          detail.events?.length
            ? card(
                'Digital record — what the verifier checks against the signed scoresheet',
                table(
                  [
                    { label: 'Clock', render: (e) => `${String(Math.floor(e.clockSecs / 60)).padStart(2, '0')}:${String(e.clockSecs % 60).padStart(2, '0')}` },
                    { key: 'side', label: 'Side' },
                    { label: 'Event', render: (e) => e.type.replace(/-/g, ' ') },
                    { key: 'value', label: 'Points', num: true },
                    { key: 'enteredBy', label: 'Entered by', mono: true },
                    { label: 'Offline', render: (e) => (e.offlineEntry ? badge('offline entry', 'badge-plain badge-warn') : '') },
                  ],
                  detail.events.slice(-30).reverse(),
                ),
                { flush: true, note: 'Last 30 events. An offline entry was transcribed from a paper scoresheet after a system outage, and verification is mandatory (§8 exception 14).' },
              )
            : null,
        ])
      : null,
  ]);
}

async function loadDetail(ctx, matchId) {
  const c = await ctx.api.get(`/api/matches/${matchId}`);
  let downstream = [];
  if (c.result?.resultStatus === 'Approved') {
    // The impact list comes back with a correction; precomputing it here would
    // duplicate server logic, so the screen shows it after an unlock instead.
    downstream = [];
  }
  return {
    match: c.match,
    result: c.result,
    events: c.operations?.scoreEvents ?? [],
    signed: c.operations?.refereeSignoff
      ? `${c.operations.refereeSignoff.officialName} at ${new Date(c.operations.refereeSignoff.timestamp).toLocaleString()}`
      : null,
    downstream,
  };
}

function winnerName(match, result) {
  if (!result?.winnerRef) return '—';
  for (const s of [match.sideA, match.sideB]) {
    if (s.kind === 'entry' && s.entryId === result.winnerRef) return s.displayName;
  }
  return result.winnerRef;
}
