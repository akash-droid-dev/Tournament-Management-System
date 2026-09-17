# Gap analysis

Every place the *TMS Functional Workflow Document v1.0* is silent, ambiguous, or
contradicts itself — found by implementing it — with the call made on each and
where that call lives in the code.

The document is unusually complete for a functional spec. These are not
complaints; they are the decisions someone has to make to turn it into working
software, recorded so they can be reviewed rather than discovered later.

**How to read the table.** *Closed* means the code resolves it and the choice is
defensible. *Surfaced* means the code refuses to decide and forces a human
ruling. *Open* means it is not implemented and the README says so.

| # | Gap | Kind | Status |
| --- | --- | --- | --- |
| [1](#1--the-permission-matrix-contradicts-the-phase-tables) | Permission matrix contradicts the phase tables in four places | Contradiction | Closed |
| [2](#2--the-matrix-grants-action-letters-with-no-view-right) | Matrix grants action letters with no view right | Contradiction | Closed |
| [3](#3--the-jury-of-appeal-has-no-row-in-the-matrix) | Jury of Appeal has no row in the matrix | Omission | Closed |
| [4](#4--no-walkover-score-is-defined-for-kabaddi) | No walkover score defined for Kabaddi | Silence | Closed |
| [5](#5--how-a-joint-medal-cascades-after-a-disqualification-is-undefined) | Joint medal cascade after a disqualification undefined | Silence | **Surfaced** |
| [6](#6--match-status-never-advances-past-completed-provisional) | Match status never advances past Completed (Provisional) | Ambiguity | Closed |
| [7](#7--there-is-no-status-for-a-fixture-awarded-by-a-bye) | No status for a fixture awarded by a bye | Omission | Closed |
| [8](#8--round-order-does-not-cover-fixtures-fed-by-a-group-table) | Round order does not cover fixtures fed by a group table | Silence | Closed |
| [9](#9--the-protest-windows-anchor-is-unspecified) | Protest window anchor unspecified | Ambiguity | Closed |
| [10](#10--nothing-stops-approval-inside-an-open-protest-window) | Nothing stops approval inside an open protest window | Silence | Closed |
| [11](#11--reproducibility-needs-the-algorithm-not-just-the-seed) | Reproducibility needs the algorithm, not just the seed | Omission | Closed |
| [12](#12--the-fair-play-tie-breaker-has-no-data-source) | Fair-play tie-breaker has no data source | Omission | **Open** |
| [13](#13--when-a-qualification-flag-may-be-shown-is-unspecified) | Qualification flag timing unspecified | Ambiguity | Closed |
| [14](#14--a-draw-of-lots-requires-witnesses-but-no-entity-holds-them) | Draw of lots requires witnesses but no entity holds them | Omission | Closed |
| [15](#15--a-cross-event-clash-cannot-be-checked-at-entry-time) | Cross-event clash cannot be checked at entry time | Ordering | Closed |
| [16](#16--there-is-no-scoring-template-entity-despite-a-foreign-key-to-one) | No scoring-template entity despite a foreign key to one | Omission | Closed |
| [17](#17--reschedule-history-has-no-approver-field) | Reschedule history has no approver field | Omission | Closed |
| [18](#18--event-merger-is-offered-but-never-defined) | Event merger offered but not defined | Silence | **Open** |
| [19](#19--team-manager-visibility-rules-conflict) | Team Manager visibility rules conflict | Contradiction | Closed |
| [20](#20--officials-pool-sizing-is-implied-but-never-computed) | Officials pool sizing is implied but never computed | Silence | Closed |
| [21](#21--abandoned-is-terminal-but-may-be-replayed) | Abandoned is terminal but may be replayed | Contradiction | Closed |
| [22](#22--report-audience-is-stated-once-not-per-report) | Report audience stated once, not per report | Ambiguity | Closed |
| [23](#23--no-show-grace-and-rest-gap-are-unspecified-for-kabaddi) | No-show grace period and rest gap unspecified for Kabaddi | Silence | Closed |
| [24](#24--federation-set-numbers-are-presented-as-fixed-configuration) | Federation-set numbers presented as fixed configuration | Risk | Closed |
| [25](#25--dashboards-are-specified-by-pointer-only) | Dashboards specified by pointer only | Omission | Closed |
| [26](#26--authentication-is-never-mentioned) | Authentication never mentioned | Scope | Closed |
| [27](#27--the-default-result-publish-policy-is-not-stated) | Result publish default not stated | Ambiguity | Closed |
| [28](#28--correction-re-verification-separation-is-not-stated) | Correction re-verification separation not stated | Silence | Closed |

---

## 1 — The permission matrix contradicts the phase tables

**Where.** §3.2 against §2.1–2.6 and §9.3.

The §3.2 matrix and the §4 phase tables disagree about who does what, in four
places:

| Function | §3.2 says | The phase table says |
| --- | --- | --- |
| Sport/discipline configuration | Competition Manager: `E` only | §2.1–2.6 assign "Add sport(s)", "Add disciplines", "Attach scoring template" to the Competition Manager — all creation |
| Medal allocation | Technical Official: `Verify` only | §9.3 has them verify the medal list against accreditation, which requires reading it |
| Result approval & lock | Competition Manager: `Recommend` only | Recommending an approval requires seeing the pending result |
| Protest handling | Jury of Appeal: no row at all | §3.1 defines the role, §8 exception 9 makes it the deciding role |

**The call.** Resolved in favour of the phase tables, because those describe the
operative workflow — Phase 2 literally cannot run if the Competition Manager
cannot create an event.

**But not silently.** The matrix is transcribed verbatim into `SPEC_MATRIX`, and
each patch is a row in `RECONCILIATIONS` carrying both citations and a
rationale:

```ts
{
  fn: 'sport.config',
  role: 'Competition Manager',
  add: ['C'],
  matrixSays: '§3.2 grants Competition Manager only "E" on Sport/discipline configuration.',
  phaseSays: '§2.1–2.6 assign "Add sport(s)", … to the Competition Manager.',
  rationale: 'Phase 2 cannot run without create rights. Without this, no event can
              exist and the Phase 2 gate is unreachable.',
}
```

The Role & Access screen (§12.18) renders these with the reconciled cells
highlighted, so a Business Analyst can check the calls without reading code.

**Recommendation.** Have the document owner confirm each of the four. If the
matrix is right and the phase tables are wrong, the workflow needs rewriting,
which is a bigger change than fixing four cells.

`src/domain/rbac.ts` · tests in `test/rbac.test.ts`

---

## 2 — The matrix grants action letters with no view right

**Where.** §3.2, systemically.

Many cells list action letters without `V`:

- Tournament Admin is `A P` on Draw/fixture generation, `A P` on Schedule &
  venue allocation, `A L` on Result approval & lock, `A P` on Medal allocation.
- Super Admin is `L` on Result approval, `E` on several others.
- Technical Official is `Verify` only on Result approval.
- Competition Manager is `C E` on several rows.

Read literally, a Tournament Admin could not **open** the draw they are required
to approve. That is plainly not the intent: §5.6 has them approve and publish the
draw, §12.6 names them a primary user of the Draw Console, and §9.1 builds their
dashboard out of exactly this data.

**The call.** One documented notation rule rather than twenty corrected cells:

> Any of C, E, A, P or L — or any named verb such as *verify* or *recommend* —
> implies V.

It never widens access. A role with no cell at all still has none, and scope and
qualifiers still apply. Verified by test: `Scorer` has no `result.approval` cell,
and `can(scorer, 'result.approval', 'V')` is still refused.

**How it was found.** The API. A Tournament Admin hitting `GET
/api/events/:id/draw/verify` got *"Tournament Admin may not view Draw/fixture
generation (has: AP)"* — the matrix, transcribed faithfully, refusing the
document's own workflow.

**Recommendation.** Add a legend line to §3.2: "an action right implies view".
It is one sentence and removes twenty ambiguous cells.

`src/domain/rbac.ts` → `grantImpliesView` and `STRUCTURAL_RECONCILIATIONS`

---

## 3 — The Jury of Appeal has no row in the matrix

**Where.** §3.1 defines it; §3.2 omits it; §8 exception 9 depends on it.

§3.1 defines the Jury of Appeal as a committee entity recorded in the system,
constituted per event from senior Technical Officials plus a Tournament Admin
nominee. §8 exception 9 makes it the deciding role for protests and appeals. It
has no row in the §3.2 matrix at all.

**The call.** Modelled with the narrowest rights that let §8.9 work: view and
rule on protests, nothing else. It cannot enter results, approve medals, or
touch a draw.

**Not modelled.** §3.1 describes the Jury as a *committee* — constituted per
event, with named members. The implementation treats it as a role a user holds.
A committee entity with membership, quorum and a constitution record is a larger
piece of work and is not built.

**Recommendation.** Decide whether the Jury is a role or an entity. If rulings
need to record which members sat, it is an entity and §13 needs a section for it.

---

## 4 — No walkover score is defined for Kabaddi

**Where.** §7.4.20 and §8 exception 1.

The document requires a walkover to "auto-generate the sport's standard result"
and gives a badminton example — `21-0, 21-0`. Kabaddi has no equivalent
universal forfeit score.

**Why it matters more than it looks.** Any fabricated score enters the points
table and distorts the **score-difference tie-breaker** for every other side in
the group. Award a nominal 30–0 and you have handed the walkover beneficiary a
+30 swing they did not earn on the mat, which can decide who qualifies.

**The call.** Record the walkover with **no points for or against**, and award
the standard win points:

```ts
walkover: {
  winnerScore: 0,
  loserScore: 0,
  outcomeType: 'walkover',
  note: 'Walkover recorded without points for/against so the score-difference
         tie-breaker is not distorted. Standard win points are awarded. Override
         in Sport & Event Setup if the federation mandates a nominal score.',
}
```

Because the score alone no longer says who won, a walkover result must name its
winner explicitly — and the result entry function refuses a non-played outcome
that does not.

**Recommendation.** Confirm against the federation's technical handbook. If it
mandates a nominal score, the value is one line of configuration, and the note
explains the consequence.

`src/sports/kabaddi.ts` · tests in `test/standings.test.ts`

---

## 5 — How a joint medal cascades after a disqualification is undefined

**Where.** §8 exception 3.

The document says that where ineligibility is discovered, "all affected prior
results recomputed (forfeits cascaded); medals re-allocated if needed". It does
not say **how a joint medal re-allocates**.

Kabaddi awards joint bronze. So:

```
Before             MH gold
                   KA silver
                   HR bronze (joint)   RJ bronze (joint)

MH is disqualified. Now what?

Option A  promote the pair together   KA gold, HR + RJ joint SILVER
          → two silvers, which the competition never produced
Option B  withhold the vacated medal  KA gold, HR + RJ stay bronze, no silver
Option C  promote one of them         → requires a tie-break the event never ran
```

Federations differ. Some vacate rather than promote.

**The call — surfaced, not decided.** The cascade preserves the tie, because that
is the only option which invents no ranking the competition never produced. But
it sets `decisionRequired`:

> the cascade leaves HR and RJ level at position 2 with a silver medal each,
> because they shared a joint medal before the disqualification. §8 exception 3
> does not say whether a joint medal promotes as a pair or the vacated medal is
> withheld — the Jury of Appeal or Tournament Admin must rule and record the
> decision before publication.

The rows come back unpublished and unapproved, so they cannot reach the public
tally without passing the §9.3 checklist again. Disqualifying one of the joint
bronzes creates no tie above bronze and needs no ruling — the flag only fires
when it is genuinely ambiguous.

**Recommendation.** Add a sport-config flag: `jointMedalCascade: 'promote-pair'
| 'withhold-vacated' | 'jury-decides'`. Until then, the flag is the honest
behaviour.

`src/engines/medals.ts` → `reallocateAfterDisqualification`

---

## 6 — Match status never advances past Completed (Provisional)

**Where.** §6.2 against §6.3.

The §6.2 table gives `Completed (Provisional)` an "Allowed Next" of "—
(result lifecycle takes over)". That is a sound design — the match is over, and
what happens next is about the *result*, not the match.

But it means the match status stays `Completed (Provisional)` **forever**, even
after the result is approved, locked and published. A screen that displays the
raw match status tells a spectator that a finished, published result is
provisional.

**The call.** Any public-facing display derives its label from the result, not
the match:

| Condition | Public label |
| --- | --- |
| match is Live | **Live** |
| terminal exception (Walkover, Postponed, Cancelled, Abandoned, Disqualified, Suspended) | that status |
| result exists and is published | **Final** |
| match complete, result not yet published | **Awaiting result** |

**How it was found.** Reviewing a screenshot of the public portal, which showed
"Completed (Provisional)" against two dozen published results.

**Recommendation.** Add a line to §6.2 noting that the match status is an
internal operational state and that public displays follow the result status.

`web/screens/public.js` → `statusOf`

---

## 7 — There is no status for a fixture awarded by a bye

**Where.** §13.4 against §6.2.

§13.4 puts `bye_flag` on the Fixture/Match entity, and §10.1 expects "bye
markers" on the draw report. So a bye is a fixture. But §6.2 has no status for a
fixture that will never be played and is not a walkover.

**The call.** A bye fixture exists for the draw sheet and carries `byeFlag`, and
is then excluded from everything that assumes play:

- the **scheduler** skips it — a bye is never assigned a slot
- the **conflict detector** skips it — it cannot double-book a mat
- the **standings engine** excludes it — otherwise a bye is a free win in a
  league table
- the **progression engine** advances its occupant the moment the draw is
  published, without waiting for a result
- the **validation gate** enforces §7.2.8: byes are round-one only

**Recommendation.** Either add a `Bye` status to §6.2, or add a note that a bye
fixture carries `bye_flag` and is excluded from scheduling, standings and the
result lifecycle. The second is closer to what the document already implies.

---

## 8 — Round order does not cover fixtures fed by a group table

**Where.** §5.4 and §6.3.

§5.4 lists "Round order (R1 < R2 …)" as a hard scheduling constraint, and §6.3
requires "event sequencing (R1 before R2)". Both describe a fixture waiting on
its **direct feeder**.

A semi-final fed by a **group table** has a stronger constraint: it cannot start
until *every* fixture in that group has finished, because until then nobody
knows who qualified. There is no direct feeder to point at.

**How it was found.** A live bug. The seeded tournament scheduled the men's
semi-finals at 09:15 on day one — before most of the group stage. The
dashboard's conflict count was non-zero on a schedule that had already been
published, which is how it surfaced.

**The call.** Both the auto-scheduler and the conflict detector now treat a
`placeholder-standing` side as depending on the whole group:

```
earliest start = max(end of every fixture in the feeding group)
                 + the sport's hard rest gap
```

After the fix, the semi-finals land at 14:15 on day two, after the last group
fixture at 09:15.

**Recommendation.** Extend §5.4's hard-constraint list: "a fixture fed by a
group table cannot start before every fixture in that group has finished".

`src/engines/scheduler.ts` → `latestEndOfGroup` · test: *"a semi-final fed by a
group table, scheduled before its group finishes"*

---

## 9 — The protest window's anchor is unspecified

**Where.** §8.3.

§8.3 gives "Configurable window (e.g. 30–60 min post-match)". Post *which*
moment? The final whistle, the provisional result entry, or the verification?

They can be far apart. A Scorer may enter a result twenty minutes after the
whistle, and a Technical Official may verify it twenty minutes after that. A
window anchored to the whistle could close before the result is even visible to
the team that wants to contest it.

**The call.** Anchored to **verification** (§8.2), falling back to entry if no
verification exists. Verification is the moment the result becomes a checked,
contestable claim — before that, a team would be protesting a number that may
still be corrected as a data-entry error.

**Recommendation.** Say which event starts the clock. "…minutes after the result
is Verified" is one word longer and removes the ambiguity.

`src/workflow/result-approval.ts` → `protestWindow`

---

## 10 — Nothing stops approval inside an open protest window

**Where.** §8.3 and §8.4.

§8.3 gives teams a window to file a protest. §8.4 has the Tournament Admin
approve, and §7.4.18 makes approval lock the result automatically.

The document does not say approval must wait for the window to close. If it does
not, an Admin can approve and lock a result two minutes after verification, and
the protest right the previous step just granted is worthless.

**The call.** Approval inside an open window is **refused**, with the remaining
minutes and the closing time in the message. An Admin who genuinely must approve
early — a broadcast deadline, a ceremony that cannot wait — can, but only by
recording a reason that goes into the audit log.

The demo seeder uses this path itself, with the reason
`DEMO_SEED_PROTEST_WINDOW_WAIVED`, rather than waiting thirty real minutes per
match. That is visible in the audit trail, which is the point.

**Recommendation.** State it: "a result may not be approved while its protest
window is open, except by a Tournament Admin recording a reason code".

`src/workflow/result-approval.ts` → `approveResult`

---

## 11 — Reproducibility needs the algorithm, not just the seed

**Where.** §7.2.9.

§7.2.9 requires that "seeded random draws must store the RNG seed so any draw is
reproducible for dispute resolution".

A seed alone is not enough. Feed the same seed to a different generator and you
get a different draw. If the implementation's shuffle ever changes — a library
upgrade, a refactor, a different platform — every historical draw silently
becomes unreproducible, and nobody finds out until a dispute.

**The call.** The draw record stores an algorithm identifier alongside the seed:

```ts
rngSeed: 'EVT-0001:NKC2026-MEN-DRAW',
rngAlgorithm: 'mulberry32/v1',
```

`verifyReproducible` refuses to claim reproducibility if the current build's
algorithm does not match the one that produced the draw. It says so explicitly
rather than quietly comparing against the wrong generator.

`Math.random()` is never used in draw code, since it cannot be replayed at all.

**Recommendation.** Add `rng_algorithm` to §13's draw fields.

`src/engines/rng.ts` · `src/engines/draw.ts` → `verifyReproducible`

---

## 12 — The fair-play tie-breaker has no data source

**Where.** §5.7 against §13.5 and §13.7.

§5.7's example tie-breaker hierarchy includes "5. Fair-play points". §13.5 gives
the match-operations entity a `cards/sanctions[]` array, so cards are recorded
per match. But §13.7's Standings Row has no field for them, and nothing in the
document aggregates cards per side across a group.

**Status: open.** The rung exists in the Kabaddi hierarchy because the document
lists it, and it currently returns zero for every side — so it never separates
anyone, and the next rung decides. The code says so:

```ts
case 'fairPlay':
  // Placeholder until card counts are aggregated per side; kept so the
  // rung exists in the hierarchy and is visible in the explainer.
  return 0;
```

Implementing it needs two things the document does not specify: a fair-play
points formula (how many points is a yellow worth against a red?), and a
`fairPlayPoints` field on the standings row.

**Recommendation.** Either specify the formula and add the field, or remove the
rung from the example hierarchy so it does not imply a capability that is not
defined.

---

## 13 — When a qualification flag may be shown is unspecified

**Where.** §5.7.

§5.7 says "positions meeting progression rule flagged 'Q' (qualified) / 'E'
(eliminated)". It does not say **when**.

Flag on the current table and you tell a side mid-group that it has qualified
when it can still be overtaken — or that it is eliminated when it can still
qualify. Either is worse than showing nothing.

**The call.** A flag is set only once the group is mathematically decided —
every side has played every other. Until then both flags are blank and the
Standings screen shows "undecided".

`markQualification` computes `expectedEach = group.length - 1` and requires every
row to have reached it.

**Recommendation.** Add "flagged once the group is complete" to §5.7. A fuller
version would flag as soon as a position is mathematically certain even with
fixtures outstanding, which is a harder computation and a product decision.

`src/engines/standings.ts` → `markQualification`

---

## 14 — A draw of lots requires witnesses, but no entity holds them

**Where.** §7.5.22 against §13.7.

§7.5.22 says that if all tie-breakers fail, "'draw of lots' is conducted and the
outcome + witnesses recorded". §13.7's Standings Row has `tiebreak_notes` but no
structure for the outcome, the witnesses, or a reproducible record of how the lot
was drawn.

**The call.** `conductDrawOfLots` takes the tied entries, a seed and a witness
list, and:

- requires **at least two witnesses**, throwing if fewer — a lot drawn with one
  witness is one person's word
- uses the same seeded generator as the draw, so the outcome is reproducible from
  the recorded seed
- returns the order, the seed, the witnesses and a timestamp

A tie that survives the whole hierarchy writes a note onto the affected rows
saying so and naming the other sides, so the Standings screen demands the lot
rather than picking silently.

**Recommendation.** Add a draw-of-lots record to §13: the tied participants, the
resulting order, the witnesses, the seed and the timestamp.

`src/engines/standings.ts` → `conductDrawOfLots`

---

## 15 — A cross-event clash cannot be checked at entry time

**Where.** §3.4 against Phase 6.

§3.4 lists a "cross-event clash advisory (same athlete, overlapping events)"
among the entry-time validations, marked with a ⚠.

But sessions do not exist yet. Entries close in Phase 3; the schedule is built in
Phase 6. At entry time the system cannot know whether two events overlap.

**The call.** The check takes an optional `overlappingEventIds` input and is
**always soft**. With no schedule it produces nothing; once a provisional
schedule exists it can be supplied and the advisory appears. Blocking on a
maybe would be wrong, and the ⚠ in the document shows the author knew that.

The real clash detection is Phase 6's `TWO_EVENTS_SAME_SESSION` soft conflict,
which runs against the actual grid.

**Recommendation.** Note in §3.4 that the advisory is only meaningful once a
provisional schedule exists, and cross-reference §6.4.

`src/engines/eligibility.ts`

---

## 16 — There is no scoring-template entity, despite a foreign key to one

**Where.** §13.2 against §13 as a whole.

§13.2 gives the Event entity a `scoring_template_id`. §2.5 describes what a
scoring template does — "Sets-based, goals-based, points-based,
time/distance-based; win/draw/loss point values; tie-breaker hierarchy for the
sport". Nothing in §13 defines the template entity itself. The foreign key points
nowhere.

**The call.** The template is code, not data — `SportConfigTemplate` in
`src/sports/registry.ts` — and `scoringTemplateId` is the sport key into the
registry. An unknown key throws with the list of registered sports, honouring
§11's rule that a failed lookup blocks the dependent action rather than
proceeding on stale data.

**Why code rather than a table.** A scoring template is not just values; it is
behaviour. Kabaddi's all-out, revival order and do-or-die logic cannot be
expressed as rows. The values *inside* the template that federations change
(point values, weight limits, half length) are editable through the Sport &
Event Setup screen and are marked `configurable-default`.

**Recommendation.** Add a §13 subsection describing the template's fields even
if it is not a database table, so the foreign key has a referent.

---

## 17 — Reschedule history has no approver field

**Where.** §13.4 against §6.8.

§13.4 gives the Fixture entity `reschedule_history[]`. §6.8 requires that a
reschedule goes "Competition Manager → Tournament Admin approval". So the history
must record who approved, or the approval requirement is unverifiable after the
fact.

**The call.** The reschedule record carries both:

```ts
interface RescheduleRecord {
  fromDate, fromTime, fromFopId;
  toDate, toTime, toFopId;
  reasonCode: string;
  requestedBy: string;
  approvedBy: string;    // added
  at: string;
}
```

The Scheduling Board shows a reschedule-history table with the
requested-by → approved-by pair visible.

**Recommendation.** Add `requested_by` and `approved_by` to §13.4's
`reschedule_history[]`.

---

## 18 — Event merger is offered but never defined

**Where.** §7.1.6 and §3.7's gate.

§7.1.6 says events below the minimum entries are "auto-flagged for cancellation
**or merger** — Admin decision required". The Phase 3 gate mentions the
`Cancelled – Insufficient Entries` status.

Cancellation is fully defined. Merger is not defined anywhere: what happens to
the entries, whether the merged event keeps either event's ID, what the medal
implications are (does a merged under-17 and under-19 event award one set of
medals or two?), or how it appears in reports.

**Status: open.** Cancellation is implemented; merger is not. The event status
`Cancelled – Insufficient Entries` exists and the gate reports the shortfall by
name. Attempting a merger is not offered, rather than half-offered.

**Recommendation.** Specify merger, or remove it from §7.1.6. The medal question
alone makes it a product decision, not an implementation detail.

---

## 19 — Team Manager visibility rules conflict

**Where.** §3.2's key permission rules against §7.6.25.

§3.2 rule 4: "Team Managers only ever see their own unpublished entries; all
cross-team data becomes visible only on publish."

§7.6.25: "Unpublished data is never visible to Team Managers (beyond their own
entries) or Viewers."

Read together they are consistent, but the first sentence taken alone ("their own
unpublished entries") reads as though a Team Manager sees their own entries even
before publication — which is right — while the second, taken alone, reads as a
blanket prohibition.

**The call.** Both, precisely: the `own-entries` qualifier scopes an entry to the
acting user's unit regardless of publication state, and the `published` qualifier
gates everything else. So a Team Manager sees their own entry the moment it is
created, and another unit's entry never, and a fixture only once the schedule is
published.

Tested both ways: a Team Manager can create an entry for their own unit and is
refused for another, and the Team Manager dashboard filters fixtures on the
schedule's publication state.

**Recommendation.** Merge the two statements into one sentence in §3.2.

`src/domain/rbac.ts` → `qualifierSatisfied`

---

## 20 — Officials pool sizing is implied but never computed

**Where.** §7.3.15 and §6.6.

§7.3.15 requires a minimum officials template per match, and the sport template
defines a full panel. §6.6 caps an official at a maximum number of matches per
day. Together those imply a **minimum pool size** the document never computes:

```
fixtures per day × seats per fixture ÷ max matches per official per day
```

For the demo — three mats, eight seats per Kabaddi panel, a four-match daily cap
— that is a pool in the dozens, not a handful. A tournament planned with a token
pool discovers on match day that fixtures cannot reach Check-in.

**How it was found.** The seeder, with an initial pool of sixteen officials,
failed at the first match with *"minimum officials panel incomplete: Scorer 0/1"*
— the gate correctly refusing an understaffed fixture.

**The call.** Not a code change, an information one. The Officials Board shows
the arithmetic:

> 23 fixtures × 8 seats = 184 seat-assignments needed in total

alongside, per seat, how many in the pool are certified and how many meet the
grade. A Competition Manager can see a shortfall before match day rather than
during it.

**Recommendation.** Add a planning note to §6.5 with the formula, so a
tournament's officials requirement is computed at setup rather than discovered.

`web/screens/officials.js`

---

## 21 — Abandoned is terminal but may be replayed

**Where.** §6.2.

The §6.2 status table gives Abandoned an "Allowed Next" of "Terminal **or**
Replay (committee decision)". Terminal and replayable are contradictory: a
terminal status has no outgoing transitions.

**The call.** Modelled as terminal with one reason-coded edge back to
`Scheduled`, which is what a replay is. The committee decision itself is recorded
as an exception with its basis, and `abandon()` requires
`committeeDecision: 'replay' | 'award-result' | 'void'` plus Admin ratification —
so the outcome is always an explicit ruling rather than a status change someone
made quietly.

**Recommendation.** Split the row: `Abandoned` → `Scheduled (replay)` with a
reason code, or terminal. The current wording leaves it to the implementer.

`src/domain/status.ts` → `MATCH_MACHINE`

---

## 22 — Report audience is stated once, not per report

**Where.** §5.8 against §10.

§5.8 states the rule once: reports render "from LIVE approved data only
(provisional/unpublished data excluded from external reports; internal ops
reports may include provisional flagged as such)".

§10 then lists fourteen reports without saying which are external and which are
internal. Reading down the list, the answer is usually obvious — a fixture/draw
report is external, an audit trail extract is not — but "match result report" and
"points table" are genuinely arguable.

**The call.** `audience: 'external' | 'internal'` is a property of every report
definition, and the filter is applied once in `visibleResults` rather than
re-remembered by fourteen renderers. External reports see approved and published
data only; internal reports may include provisional data when the caller asks for
it, and the report's notes say so.

Assignments made: external — fixture/draw, team schedule, match result, daily
bulletin, points table, final ranking, medal tally. Internal — master schedule,
venue run sheet, duty roster, entry/scratch, exception register, audit extract,
final tournament report.

**Recommendation.** Add an audience column to the §10 table. It is fourteen words
and removes the judgement call.

`src/reports/index.ts`

---

## 23 — No-show grace and rest gap are unspecified for Kabaddi

**Where.** §7.2 and §7.2.12.

§7.2 gives "no-show timer starts per sport rule (e.g. 15 min)". §7.2.12 gives
"minimum rest gap … is sport-configurable (e.g. 30 min badminton, 3 hrs
football)". Neither gives the Kabaddi value.

**The call.** Configurable defaults, marked as such:

| Setting | Default | Basis |
| --- | --- | --- |
| No-show grace | 15 min | The document's own example |
| Rest gap, hard minimum | 30 min | A conservative floor; the scheduler refuses to go below it |
| Rest gap, recommended | 45 min | A soft warning between 30 and 45 |

The hard/soft split matters: below 30 minutes the scheduler will not place the
fixture at all, and between 30 and 45 it places it and raises a soft conflict
that an Admin must acknowledge before publishing.

**Recommendation.** Get the federation's figures. These are starting values, and
the Sport & Event Setup screen marks them as needing confirmation.

`src/sports/kabaddi.ts` → `restGap` · `src/api/service.ts` → `NO_SHOW_GRACE_MINS`

---

## 24 — Federation-set numbers are presented as fixed configuration

**Where.** §2.4, §4.4, §7.1.5.

The document treats classifications and point values as configuration to be
entered — which they are — without flagging that several of them are set by a
federation and **revised periodically**. Weight limits change between seasons.
League point conventions differ between a federation championship and a franchise
league. Junior half lengths differ from senior.

A system that hardcodes last season's numbers, or presents them as though they
were rules of play, quietly runs a tournament under the wrong rules.

**The call.** Every category carries its provenance:

```ts
{ key: 'SM-85', label: 'Senior Men up to 85 kg', maxWeightKg: 85,
  gender: 'M', source: 'configurable-default' }
```

Two values are used:

| Marked | Meaning |
| --- | --- |
| `rule-of-play` | Structural, will not change: seven on the mat, all-out worth two, bonus at six defenders, the do-or-die raid, bonus points not reviving |
| `configurable-default` | A starting value the organizing body **must confirm** against its current technical handbook |

The Sport & Event Setup screen shows a standing warning naming how many values
need confirmation, and a test asserts that every age and weight category is
marked configurable — so adding one without provenance fails the build.

**Recommendation.** Add a provenance column to §2.4's classification list. It
converts a silent risk into a setup checklist item.

`src/sports/kabaddi.ts` · test: *"federation-set numbers are marked as
configurable defaults"*

---

## 25 — Dashboards are specified by pointer only

**Where.** §12.19 against §9.

§12's screen list has entry 19: "Dashboards (per role) — As specified in Section
9 — All". §9 then describes six dashboards in bullet form, which is a
requirements summary rather than a screen specification: it names the widgets but
not the layout, the drill-downs, or what each role must *not* see.

**The call.** Six distinct server payloads, one per role family, each containing
only what that role may see — so filtering is server-side, not a client-side
hide. The dashboard screen renders whatever arrived.

The §9 widgets are all present: the tournament health strip, the pending-actions
queue as the Admin's primary widget, the alert set, the event pipeline board, the
progression tracker, the utilisation heatmap, the run sheet, duty schedules,
pending verifications, protest-window timers, and the Viewer's published-only
view.

Tested: a Viewer's payload contains no `pendingActions` key at all, and every
result in it is published; a Team Manager's `entries` are all from their own unit.

**Recommendation.** If the dashboards are a deliverable, they need a §12-style
screen spec. If §9 is the spec, say so explicitly.

`src/api/service.ts` → `dashboard` · `web/screens/dashboard.js`

---

## 26 — Authentication is never mentioned

**Where.** Nowhere.

The document defines ten roles in detail, a permission matrix, and scoping rules,
and never says where identity comes from. This is *correct* for a module
specification — the parent system owns identity — but an implementer has to
decide something, and an unstated decision tends to become an unnoticed one.

**The call.** Kept to a single, deliberately visible function so it cannot be
mistaken for a finished feature:

```ts
function resolveUser(req, url, service): User {
  const id = req.headers['x-tms-user'] ?? url.searchParams.get('as');
  if (!id) throw new ServiceError('no acting user: send an x-tms-user header or
    ?as=<userId>. Authentication belongs to the host GMS; see resolveUser in
    src/api/server.ts', 401);
  const user = service.store.getUser(id);
  if (!user) throw new ServiceError(`unknown user "${id}"`, 401);
  return user;
}
```

The error message names the boundary. The README lists it under "what is
deliberately not built".

**Recommendation.** Add one line to §11's integration list: identity and session
management are provided by the GMS platform, and TMS receives an authenticated
principal.

---

## 27 — The default result publish policy is not stated

**Where.** §8.6.

§8.6 has the result published by "Tournament Admin (or auto-on-approve,
configurable)". Both are offered; neither is the default.

It matters, because the two produce different behaviour on the public portal the
moment a result is approved.

**The call.** Default to the **explicit act**, because the document's third
design principle is "Publish is an explicit act — nothing is visible to
teams/public until an authorized role publishes it". Auto-publish is a documented
alternative, and the seeded tournament publishes explicitly so the two-step path
is what the demo exercises.

**Recommendation.** State the default in §8.6 and reference principle 3.

`src/domain/types.ts` → `Tournament.autoPublishResults`

---

## 28 — Correction re-verification separation is not stated

**Where.** §8.7.

§8.7's correction path is "Unlock with reason code → correct → re-verify →
re-approve". §7.4.17 establishes maker–checker for the original result. The
document does not say whether the same separation applies to a **correction** —
whether the person who made the correction may re-verify their own work.

**The call.** It does apply. The person who applied the correction cannot
re-verify it, and the re-verifier cannot re-approve it. Combined with the
original chain, that means a corrected result has been touched by at least four
distinct people:

```
entered by      A
verified by     B       (≠ A)
approved by     C       (≠ A, ≠ B)
unlock initiated by  D  \  (≠ each other)
unlock approved by   E  /
corrected by    E
re-verified by  F       (≠ E)
re-approved by  G       (≠ F)
```

A correction is the highest-risk operation in the system — it changes a locked,
published result and cascades through standings, progression and medals — so the
strictest reading is the right one.

**Recommendation.** State it: "the maker–checker separation applies to each step
of the correction path".

`src/workflow/result-approval.ts` → `reVerifyCorrection`, `reApproveCorrection`

---

## Summary

| Status | Count | Meaning |
| --- | --- | --- |
| Closed | 25 | The code resolves it; the choice is documented and defensible |
| Surfaced | 1 | The code refuses to decide and forces a recorded human ruling ([5](#5--how-a-joint-medal-cascades-after-a-disqualification-is-undefined)) |
| Open | 2 | Not implemented, and the README says so ([12](#12--the-fair-play-tie-breaker-has-no-data-source), [18](#18--event-merger-is-offered-but-never-defined)) |

Three of these were found only by running the system rather than by reading the
document: the round-order gap ([8](#8--round-order-does-not-cover-fixtures-fed-by-a-group-table)) as a live scheduling bug, the view-right
contradiction ([2](#2--the-matrix-grants-action-letters-with-no-view-right)) as an API rejection, and the provisional-status display
problem ([6](#6--match-status-never-advances-past-completed-provisional)) by looking at the public portal. That is the argument for a
working reference implementation alongside a functional specification — some
gaps are only visible once something tries to run.
