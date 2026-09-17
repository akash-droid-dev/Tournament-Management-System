# 06 — API reference

Every endpoint, the permission it needs, and the rule it enforces.

The API is a thin layer. It resolves who is acting, hands the call to
`TmsService`, and turns a domain refusal into a 4xx whose body is the message
the operator should read. There is no business logic in `src/api/server.ts` —
if an endpoint refuses you, the reason came from the domain, and the same call
made from a test or another host would be refused identically.

---

## Contents

- [Conventions](#conventions)
- [The permission model](#the-permission-model)
- [Bootstrap](#bootstrap)
- [Phase 1–2 — Tournament and events](#phase-12--tournament-and-events)
- [Phase 3 — Entries](#phase-3--entries)
- [Phase 4 — Format](#phase-4--format)
- [Phase 5 — Draw](#phase-5--draw)
- [Phase 6 — Schedule](#phase-6--schedule)
- [Phase 7 — Officials and the match console](#phase-7--officials-and-the-match-console)
- [Phase 8 — Results](#phase-8--results)
- [Protests](#protests)
- [Exceptions](#exceptions)
- [Phase 9 — Standings and medals](#phase-9--standings-and-medals)
- [Phase 10 — Closure, audit, dashboards](#phase-10--closure-audit-dashboards)
- [Reports](#reports)
- [Worked example — one match, end to end](#worked-example--one-match-end-to-end)
- [Worked example — three refusals](#worked-example--three-refusals)
- [Error reference](#error-reference)
- [The authentication boundary](#the-authentication-boundary)
- [Known characteristics](#known-characteristics)

---

## Conventions

**Base URL.** `http://localhost:4321` by default (`PORT` overrides it).

**Acting user.** Every route except the two bootstrap routes needs an
identified user:

```
x-tms-user: ta1                # header — what a host GMS would send
?as=ta1                        # query parameter — what the UI's role switcher uses
```

Both resolve the same way: look the ID up in the store, fail with 401 if it is
missing or unknown. See [the authentication boundary](#the-authentication-boundary).

**Bodies.** JSON in, JSON out, UTF-8. A `POST` with no body is fine where the
table shows no fields. Bodies over 2 MB are refused with 413 — a scoresheet is
kilobytes, so anything larger is a mistake, not a big match.

**Responses.** `200` with the JSON result, or `{ "ok": true }` where a handler
returns nothing. Errors are always:

```json
{ "error": "Scorer may not approve Result approval & lock (has: —)" }
```

**Status codes.**

| Code | Meaning | Thrown by |
| --- | --- | --- |
| 400 | The request is legal JSON but the domain refuses it | `bad()`, or any domain invariant |
| 401 | No acting user, or an unknown one | `resolveUser` |
| 403 | The user exists but this role, scope or qualifier forbids it | `deny()` — always a §3.2 matrix decision |
| 404 | No such entity, or no such route | `missing()` |
| 413 | Body over 2 MB | `readBody` |

The distinction between 400 and 403 is worth respecting when building a UI:
**403 means "not you", 400 means "not now".** A 403 should hide or disable a
control; a 400 should be shown as a blocking message with the rule in it.

**Caching.** Every response is `no-store`. Live tournament data has no safe
cache window, and a stale points table is worse than a slow one.

---

## The permission model

Every mutating route calls `can(user, function, permission, context)` before
doing anything. That function reads `SPEC_MATRIX` — the §3.2 table transcribed
cell by cell — and returns a decision with a reason.

| Letter | Verb |
| --- | --- |
| `C` | create |
| `E` | edit |
| `A` | approve |
| `P` | publish |
| `L` | lock / unlock |
| `V` | view |

Three structural rules sit on top of the table:

**1. An action implies sight of what it acts on.** The matrix gives the
Tournament Admin `A` and `P` on draw generation but no `V`. Read literally
that forbids an Admin from opening the draw they are required to approve.
A grant carrying any action permission — or any named verb like *verify* or
*recommend* — therefore satisfies a `V` check. It never widens access: a role
with no cell at all still has none, and scope and qualifiers still apply.

**2. Maker–checker.** Whoever entered a result can never verify or approve it.
Checked at both steps, so a Scorer who also holds Technical Official rights
cannot wave their own result through.

**3. Publishing is Admin-only.** Everyone else may prepare; only Tournament
Admin and Super Admin may publish.

`GET /api/rbac/matrix` returns the whole matrix plus the four places where §3.2
and the §4 phase tables contradict each other, each with both citations and the
call made. Those are not patched silently — the Role & Access screen shows
them.

---

## Bootstrap

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/bootstrap` | **none** | Users, tournaments, the full sport config, reason codes, report catalogue |
| `GET` | `/api/rbac/matrix` | **none** | The §3.2 matrix and its reconciliations |

These two are anonymous because the UI needs them to render its own sign-in
picker. They expose configuration, never tournament data.

---

## Phase 1–2 — Tournament and events

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `GET` | `/api/tournaments` | valid user | — |
| `POST` | `/api/tournaments` | `tournament.config` **C** | §7.0 mandatory fields; code uniqueness |
| `GET` | `/api/tournaments/:id` | valid user | — (tournament, events, venues, officials) |
| `POST` | `/api/tournaments/:id/activate` | `tournament.config` **E** | §4 Phase-1 gate: sport, venue, dates, officials pool all present |
| `POST` | `/api/tournaments/:id/status` | `tournament.config` **E** | §6.1 machine; cancellation needs a reason code and no approved results |
| `POST` | `/api/tournaments/:id/close` | `tournament.config` **E** | §7.6 closure gate: every event medalled, no open protest or exception |
| `POST` | `/api/tournaments/:id/events` | `sport.config` **C** | Sport must be registered; category must exist in the sport template |
| `GET` | `/api/events/:id` | valid user | Everything about one event in a single payload |
| `POST` | `/api/events/:id/confirm` | `sport.config` **E** | §7.0.7 — confirmed events can no longer change sport or category |

`activate` and `close` both return the gate result alongside the tournament, so
a UI can show *why* a gate is closed without a second call:

```json
{
  "tournament": { "...": "..." },
  "gate": { "open": false, "blockers": ["no officials in the pool (§7.0.12)"] }
}
```

---

## Phase 3 — Entries

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `GET` | `/api/events/:id/pool` | `entry.mapping` **C** (Team Manager) / **E** | Team Manager sees only their own unit's athletes |
| `GET` | `/api/events/:id/entries` | valid user | — |
| `POST` | `/api/events/:id/entries` | `entry.mapping` **C** / **E** | §7.1 eligibility: hard failures block, soft failures flag |
| `POST` | `/api/entries/:id/confirm` | `entry.mapping` **A** | An entry with an unresolved hard failure cannot be confirmed |
| `POST` | `/api/entries/:id/override` | **Tournament Admin or Super Admin only** | §7.1.4 — and a reason is mandatory (§3.5) |
| `POST` | `/api/entries/:id/scratch` | `entry.mapping` **E**, own unit | §7.1.9 — a scratch after the draw triggers a bye or a walkover |

`override` is one of only four routes that check the role directly rather than
through the matrix, because §7.1.4 names the role explicitly rather than
describing a permission. The message says so:

> only a Tournament Admin may override a failed eligibility check, with a reason (§7.1.4)

**Hard versus soft eligibility.** A hard failure is a fact that makes the entry
impossible — wrong age band, wrong gender category, no registration. A soft
failure is a fact someone must look at — a missing medical certificate date, a
squad one player short. Hard blocks; soft flags and records. This split runs
through the whole module.

---

## Phase 4 — Format

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `POST` | `/api/events/:id/format` | `format.rules` **C** | Format must be feasible for the confirmed entry count; locked once a draw exists |
| `POST` | `/api/events/:id/format/approve` | `format.rules` **A** | §7.2.2 — the draw cannot run until the format is approved |

Once a draw is generated the format is `lockedByDraw`. Changing it means
regenerating the draw, which means the published-draw amendment path — not an
edit.

---

## Phase 5 — Draw

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `POST` | `/api/events/:id/draw` | `draw.generation` **C** | Format approved; entries confirmed; seeding rules; separation rules |
| `POST` | `/api/events/:id/draw/adjust` | `draw.generation` **E** | Manual slot swap, audited with both slots — refused once published |
| `POST` | `/api/events/:id/draw/publish` | `draw.generation` **P** | Publish is Admin-only; emits a §11 notification |
| `GET` | `/api/events/:id/draw/verify` | `draw.generation` **V** | Re-runs the draw from the stored seed and compares |

Request body for generation:

```json
{
  "seedCount": 4,
  "separationRule": "same-unit-apart-r1",
  "byePolicy": "top-seeds",
  "rngSeed": "EVT-0001:any-string-you-like"
}
```

**Why the seed is stored.** §7.2.9 requires a draw to be reproducible. The
draw uses a deterministic seeded generator (mulberry32 over an FNV-1a hash of
the seed string, recorded as `mulberry32/v1`) and stores both the seed *and*
that algorithm identifier on the draw record. `draw/verify` re-runs it and reports whether the same slots come
out:

```json
{ "reproducible": true, "detail": "seed \"EVT-0001:k3f9\" reproduces the draw exactly" }
```

Storing the algorithm ID alongside the seed is what makes the guarantee survive
a future change to the shuffle. A draw generated by an older algorithm does not
silently "fail" verification — it says so:

> draw was generated with mulberry32/v1 but this build uses mulberry32/v2

**Manual adjustments do not break reproducibility.** A draw with logged swaps
verifies against the pre-adjustment map, and the response says how many swaps
there were:

> draw carries 2 logged manual adjustment(s); the auto-draw from seed "…"
> reproduces exactly and each swap is recorded with before/after

---

## Phase 6 — Schedule

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `POST` | `/api/events/:id/schedule` | `schedule.allocation` **C** | Auto-allocates fixtures to mats and slots; respects round order and rest gaps |
| `GET` | `/api/events/:id/conflicts` | valid user | Returns `{ hard, soft, publishable }` |
| `POST` | `/api/events/:id/schedule/acknowledge` | `schedule.allocation` **E** | Records explicit acknowledgement of named soft conflicts |
| `POST` | `/api/events/:id/schedule/publish` | `schedule.allocation` **P** | Refuses with any hard conflict, or any unacknowledged soft one |
| `GET` | `/api/events/:id/utilisation` | valid user | Mat-by-mat occupancy for the §12.8 heatmap |
| `POST` | `/api/matches/:id/reschedule` | `schedule.allocation` **E** | Needs a reason code; re-runs conflict detection |

`primeMatchNos` in the schedule body marks fixtures that should land in evening
prime slots. The allocator makes two passes — prime-eligible slots first, then
a fallback — so marking a fixture as prime can never leave it unscheduled.

**Conflict classes.**

| Class | Examples | Effect |
| --- | --- | --- |
| Hard | Same team twice at once; same mat double-booked; rest gap under the hard floor; a fixture scheduled before the round it depends on | Publication refused |
| Soft | Rest gap under the recommended target; an official on back-to-back duties; a unit playing three times in a day | Publication allowed after explicit acknowledgement |

The round-order check covers group-standing dependencies as well as bracket
ones: a semi-final whose sides are "winner of Group A" must be scheduled after
*every* match in that group, not merely after one of them. That gap was found
by running the seeder, not by reading the specification — see gap 12 in
[03-gap-analysis.md](03-gap-analysis.md).

---

## Phase 7 — Officials and the match console

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `POST` | `/api/matches/:id/officials` | `officials.assignment` **C** | Neutrality (no official from a competing unit), grade requirements, no clashing duty |
| `GET` | `/api/tournaments/:id/duty-roster` | valid user | The §10.5 roster |
| `GET` | `/api/matches/:id` | valid user | The whole console payload, including an advisory `canScore` flag |
| `POST` | `/api/matches/:id/open` | `match.start` **E** | §7.3 gate: schedule published, panel assigned |
| `POST` | `/api/matches/:id/attendance` | `match.start` **E** | Roster minimum for the sport |
| `POST` | `/api/matches/:id/toss` | **Referee, Scorer, Technical Official or Admin** | §7.3 — the Referee conducts it; the Scorer may record it on their behalf |
| `POST` | `/api/matches/:id/start` | `match.start` **E** | §7.3.15 minimum panel, re-checked here |
| `POST` | `/api/matches/:id/score` | `match.score` **E** | The sport's validation — see [05-kabaddi-reference](05-kabaddi-reference.md#part-5--what-the-engine-refuses) |
| `POST` | `/api/matches/:id/end` | `match.start` **E** | Returns the final summary and statistics |
| `POST` | `/api/matches/:id/signoff` | **the assigned Referee** | §7.7 — by name, not by role alone |

A score event body:

```json
{ "type": "raid-touch", "side": "A", "value": 2, "clockSecs": 412, "detail": { "bonus": true } }
```

The response carries the new live state, the running summary, the one-line
description the console header shows, and any soft issues raised:

```json
{
  "state": { "A": { "score": 14, "onCourt": 7 }, "B": { "score": 11, "onCourt": 5 }, "doOrDie": false },
  "summary": { "a": 14, "b": 11, "statistics": { "A_raidPoints": 9, "A_bonusPoints": 2 } },
  "describe": "H1 06:52 · 14–11 · raid #18 by B · on mat 7v5",
  "issues": [ { "severity": "soft", "code": "SUPER_RAID", "message": "3-point raid — recorded as a super raid" } ],
  "operations": { "scoreEvents": [ "…the entered event, then every derived one…" ] }
}
```

Derived events are not a separate field — they are appended to
`operations.scoreEvents` right after the event that caused them, each with its
own sequence number, so the log reads in the order things happened.

Scoring is refused unless the match is Live:

> M01 is Completed (Provisional); scores can only be recorded while the match is Live

`canScore` on the console payload is **advisory** — it exists so the UI can
disable the pad for a Team Manager watching a live match. The authority is the
`match.score` check on the write route, which runs regardless of what the UI
decided to render.

---

## Phase 8 — Results

The chain, and who may move each step:

```
   Scorer            Technical Official        Tournament Admin
     │                       │                        │
  ENTER ────────────────▶ VERIFY ──────────────────▶ APPROVE ──▶ PUBLISH
  (Pending)              (Verified)               (Approved      (visible
     ▲                       │                     + LOCKED)      publicly)
     │                       │
     └──── RETURN ◀──────────┘
        (with remarks)

  Maker–checker: the user who entered it may do neither of the next two steps.
  2-step chain: the verifier may not also be the approver.
  Approval locks. Locked results change only through unlock → correct → re-verify → re-approve.
```

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `POST` | `/api/results/:matchId/enter` | `result.provisional` **C** | Match must be complete; §8.1 auto-fills the score from the live event log |
| `POST` | `/api/results/:matchId/verify` | `result.provisional` **E** | Maker–checker (§7.4.17) |
| `POST` | `/api/results/:matchId/return` | `result.provisional` **E** | §5.6 — remarks are mandatory |
| `POST` | `/api/results/:matchId/approve` | `result.approval` **A** | Maker–checker; 2-step separation; protest window; not Under Protest |
| `POST` | `/api/results/:matchId/publish` | `result.approval` **A** | Admin-only publication |
| `POST` | `/api/results/:matchId/unlock` | `result.correction` **A** | §7.4.18 — reason code **and** a named initiator |
| `POST` | `/api/results/:matchId/correct` | `result.correction` **A** | Re-opens the chain from Entered |
| `POST` | `/api/results/:matchId/reverify` | `result.correction` **A** | Same maker–checker rules apply again |
| `POST` | `/api/results/:matchId/reapprove` | `result.correction` **A** | Re-locks; downstream fixtures recompute |
| `GET` | `/api/tournaments/:id/results/queue` | `result.approval` **V** | The verification/approval queue for the acting role |

**The body is optional.** §8.1 auto-fills the final score from the live event
log, so entering a result after a console-scored match needs no body at all.
`finalScore` is for an offline entry, or for a correction after a scoresheet
discrepancy — and passing one that disagrees with the event log is exactly the
kind of thing verification exists to catch.

**The protest window.** Approving a result while the protest window is still
open would lock it before teams may contest it. The refusal names the clock:

> the protest window is still open for another 23 min (closes 2026-02-11T14:40:00.000Z); approving now would lock the result before teams may contest it (§8.3)

An Admin may override it by passing `overrideProtestWindowReason`, which is
audited as an override rather than a normal approval.

**A correction is never a quiet edit.** Approval sets `lockedAt`. The only
route back is unlock (reason code + initiator) → correct → re-verify →
re-approve, and every step is a separate audit entry naming a separate person.
Downstream fixtures and standings recompute automatically on re-approval, and
the progression engine reports which later matches were affected.

---

## Protests

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `POST` | `/api/matches/:id/protest` | `protests` **C**, own unit | §8.3 window still open; fee recorded; result moves to Under Protest |
| `POST` | `/api/protests/:id/rule` | `protests` **A** (Jury of Appeal has **A**/**E**) | A ruling must state an outcome and an action; recomputes the event |
| `GET` | `/api/tournaments/:id/protests` | valid user | — |

Filing a protest moves the result to **Under Protest**, and an Under Protest
result cannot be approved until the protest is ruled (§7.4.19). That is checked
before the state machine so the message names the rule rather than reporting a
missing reason code.

---

## Exceptions

One route, fourteen scenarios:

```
POST /api/matches/:id/exception/:kind
```

| `:kind` | Body | Produces |
| --- | --- | --- |
| `walkover` | `winningSide`, `reasonCode`, `detail` | Auto-generates the sport's walkover result |
| `no-show` | `absentSide` | Same, for the side that turned up |
| `disqualification` | `disqualifiedEntryId`, `reasonCode`, `cascadePriorResults`, `ratifiedBy` | Optionally cascades through prior results and medals |
| `postpone` | `reasonCode`, `detail`, `approvedBy` | Match returns to the scheduling pool |
| `cancel` | `reasonCode`, `pointsHandling` (`void` \| `shared`), `ratifiedBy` | Standings adjusted per the chosen handling |
| `suspend` | `atClockSecs`, `reasonCode`, `detail` | Freezes the live match at that clock |
| `resume` | `atClockSecs` | Continues from the frozen state |
| `abandon` | `reasonCode`, `committeeDecision` (`replay` \| `award-result` \| `void`), `awardedTo`, `ratifiedBy` | Per the committee's decision |
| `offline-entry` | `reasonCode`, `detail`, `scoresheetRef` | Records a paper scoresheet; verification becomes mandatory (§8.14) |

Each returns the updated match, the exception record, and any follow-up actions
the exception created:

```json
{
  "match": { "...": "..." },
  "exception": { "exceptionId": "EXC-0003", "kind": "walkover", "reasonCode": "TEAM_WITHDREW" },
  "followUps": ["notify the opposing Team Manager", "re-check group standings"],
  "autoResult": { "resultId": "RES-0021", "outcomeType": "walkover" }
}
```

Several kinds require a `ratifiedBy` — a named second person — because the
source document treats them as committee decisions rather than operator
actions. Omitting it is a 400, not a silent single-signature write.

---

## Phase 9 — Standings and medals

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `GET` | `/api/events/:id/standings` | valid user | — |
| `POST` | `/api/events/:id/recompute` | valid user | Recomputes standings and progression from approved results |
| `GET` | `/api/events/:id/rankings` | valid user | Final ranking, propagating placeholders first |
| `GET` | `/api/events/:id/medals/verify` | `medals` **V** | **Read-only** §9.3 checklist |
| `POST` | `/api/events/:id/medals/generate` | `medals` **C** | Derives the medal list; preserves existing publication stamps |
| `POST` | `/api/events/:id/medals/publish` | `medals` **P** | Needs a named verifier; Admin-only |
| `GET` | `/api/tournaments/:id/medal-tally` | valid user | Unit-wise tally |

**Why `verify` is a separate GET.** The Medal Management screen needs the
verification checklist every time it renders. `generate` persists rows — so a
screen that called it on render would overwrite a *published* medal list with a
freshly derived, unpublished one. Reading must never write. `generate` also
carries publication stamps forward for any row whose position and medal are
unchanged, so re-generating after a late correction does not un-publish the
medals that were unaffected.

The checklist blocks on: an unapproved result anywhere in the event, an open
protest, an open doping flag on a medallist (read from Athlete Registration),
or an incomplete bracket.

---

## Phase 10 — Closure, audit, dashboards

| Method | Path | Needs | Enforces |
| --- | --- | --- | --- |
| `GET` | `/api/tournaments/:id/dashboard` | valid user | Role-filtered — each role gets only what §9.1–9.6 grants it |
| `GET` | `/api/tournaments/:id/audit` | valid user | Scoped: Super Admin sees all, everyone else their own tournament |
| `GET` | `/api/tournaments/:id/exceptions` | valid user | — |
| `GET` | `/api/tournaments/:id/notifications` | valid user | The §11 outbound queue |
| `GET` | `/api/tournaments/:id/matches` | valid user | `?date=YYYY-MM-DD` narrows to one day |

Query parameters on the audit route: `entityType`, `entityId`, `action`,
`limit` (default 200).

**The audit log is append-only by construction.** There is no update or delete
method on the store and none on the `AuditLog` class — not a permission that
could be granted, an absence of code. Every state change in the module returns
its audit entries to the caller, which is what makes forgetting one a
compile-time shape mismatch rather than a silent gap.

---

## Reports

```
GET /api/reports                       → the catalogue this role may run
GET /api/reports/:key?tournamentId=…   → the report
```

Fourteen reports (§10.1–10.14). The catalogue is filtered by role, and asking
for one outside it is a 403 naming the report:

> Tournament Admin may not run the "…" report (§10)

| Parameter | Applies to |
| --- | --- |
| `tournamentId` | **required** on every report |
| `eventId`, `date`, `venueId`, `unitId`, `officialId` | scope, per the report's `scope` field |
| `includeProvisional` | `true` includes unapproved results, clearly marked |
| `format` | `json` (default), `csv`, `html` / `print` |

`csv` responds with a `content-disposition` attachment. `html` and `print`
render a printable document with the tournament name in the header.

A `unitId` is defaulted from the acting user's scope for a Team Manager, so a
team's own schedule report cannot accidentally be run across the whole
tournament.

**Every export is audited** (§5.8) with the format and the row count, before
the bytes are written. These are controlled documents; knowing who took a copy
of the points table at 19:40 is the point.

| # | Key | Report |
| --- | --- | --- |
| 1 | `fixture-draw` | Fixture / draw report |
| 2 | `schedule-master` | Match schedule (master) |
| 3 | `schedule-team` | Team-wise schedule |
| 4 | `schedule-venue` | Venue-wise schedule / run sheet |
| 5 | `duty-roster` | Official duty roster |
| 6 | `match-result` | Match result report |
| 7 | `daily-bulletin` | Daily results bulletin |
| 8 | `points-table` | Points table / standings |
| 9 | `final-ranking` | Final ranking & medal report |
| 10 | `medal-tally` | Medal tally |
| 11 | `entry-scratch` | Entry list / scratch report |
| 12 | `exception-register` | Exception & protest register |
| 13 | `audit-extract` | Audit trail extract |
| 14 | `final-tournament` | Final tournament report |

---

## Worked example — one match, end to end

Against the seeded demo (`npm run seed -- --reset && npm start`). Note that the
acting user changes at each step — that is the separation of duties, not an
accident of the example.

```bash
BASE=http://localhost:4321/api

# 1. The Competition Manager assigns the officials panel.
curl -sX POST $BASE/matches/MCH-0001/officials -H 'x-tms-user: cm1'

# 2. The Scorer opens the console. Refused unless the schedule is published
#    and the panel is complete.
curl -sX POST $BASE/matches/MCH-0001/open -H 'x-tms-user: sc1'

# 3. Attendance, against the sport's roster minimum of 7.
curl -sX POST $BASE/matches/MCH-0001/attendance \
  -H 'x-tms-user: sc1' -H 'content-type: application/json' \
  -d '{"attendance":[{"participantId":"ATH-0001","participantName":"R. Patil",
        "side":"A","present":true,"accreditationValid":true,"startingLineup":true}]}'

# 4. The toss. The Referee conducts it; the Scorer may record it.
curl -sX POST $BASE/matches/MCH-0001/toss \
  -H 'x-tms-user: sc1' -H 'content-type: application/json' \
  -d '{"winner":"A","choice":"raid"}'

# 5. Start. Re-checks the minimum panel (§7.3.15).
curl -sX POST $BASE/matches/MCH-0001/start -H 'x-tms-user: sc1'

# 6. Score. A two-defender raid with a bonus.
curl -sX POST $BASE/matches/MCH-0001/score \
  -H 'x-tms-user: sc1' -H 'content-type: application/json' \
  -d '{"type":"raid-touch","side":"A","value":2,"clockSecs":95,"detail":{"bonus":true}}'

# 7. End the match, then enter the result.
curl -sX POST $BASE/matches/MCH-0001/end -H 'x-tms-user: sc1'
curl -sX POST $BASE/results/MCH-0001/enter \
  -H 'x-tms-user: sc1' -H 'content-type: application/json' \
  -d '{"finalScore":{"a":34,"b":29},"outcomeType":"played"}'

# 8. The Technical Official verifies — a DIFFERENT person from the one
#    who entered it, or this is a 403.
curl -sX POST $BASE/results/MCH-0001/verify -H 'x-tms-user: to1'

# 9. The Tournament Admin approves. Approval locks the result.
curl -sX POST $BASE/results/MCH-0001/approve -H 'x-tms-user: ta1'

# 10. And publishes it.
curl -sX POST $BASE/results/MCH-0001/publish -H 'x-tms-user: ta1'
```

---

## Worked example — three refusals

The refusals are the interesting part of an API like this one. Each of these
returns the rule, not a generic message.

```bash
# A Scorer tries to approve their own result.
curl -sX POST $BASE/results/MCH-0001/approve -H 'x-tms-user: sc1'
# 403 { "error": "Scorer may not approve Result approval & lock (has: —)" }

# The same Technical Official who entered a result tries to verify it.
curl -sX POST $BASE/results/MCH-0002/verify -H 'x-tms-user: to1'
# 403 { "error": "maker–checker violation: the user who entered this result
#                 cannot verify it (§7.4.17)" }

# A Scorer credits a raid point to the defending side.
curl -sX POST $BASE/matches/MCH-0001/score \
  -H 'x-tms-user: sc1' -H 'content-type: application/json' \
  -d '{"type":"raid-touch","side":"B","value":1,"clockSecs":120}'
# 400 { "error": "A is raiding; a raid point cannot be credited to B" }
```

The third one is the shape of the whole design: the API does not know Kabaddi.
The Kabaddi template refused it, the service turned the refusal into a 400, and
the console showed it as a toast with the score unchanged.

---

## Error reference

Messages you will meet often, and what they mean.

| Message | Code | Meaning |
| --- | --- | --- |
| `no acting user: send an x-tms-user header or ?as=<userId>` | 401 | The host GMS did not identify the caller |
| `unknown user "x"` | 401 | Identified, but not a TMS user |
| `<Role> may not <verb> <Function> (has: CE)` | 403 | §3.2 matrix refusal, showing what the role does have |
| `<Role> has no access to <Function>` | 403 | No cell at all for that role |
| `maker–checker violation: …` | 403 | Rule 1 — separation of duties |
| `publishing is restricted to Tournament Admin and Super Admin` | 403 | Rule 2 |
| `…out of scope…` | 403 | Right role, wrong tournament / unit / match |
| `<X> not found` | 404 | Unknown entity ID |
| `no route for POST /api/…` | 404 | Unknown route |
| `cannot move from <A> to <B>` | 400 | §6 status machine refused the transition |
| `… requires a reason code` | 400 | §3.5 — the transition exists but needs a documented reason |
| `… cannot start: minimum officials panel incomplete — …` | 400 | §7.3.15 |
| `the protest window is still open for another N min` | 400 | §8.3 |
| `request body is not valid JSON` | 400 | Malformed body |
| `request body too large` | 413 | Over 2 MB |

---

## The authentication boundary

This module does not authenticate anyone, on purpose. It is one module of a
Games Management System, and the GMS owns identity — sessions, SSO, password
policy, MFA, device trust. A TMS that grew its own login would be a second
source of truth about who someone is.

What the module owns is **authorization**: given an identified user with a
role and a scope, what may they do. That is `src/domain/rbac.ts`, and it is
fully implemented and tested.

The seam is one function:

```ts
// src/api/server.ts
function resolveUser(req: IncomingMessage, url: URL, service: TmsService): User {
  const id = (req.headers['x-tms-user'] as string | undefined) ?? url.searchParams.get('as') ?? '';
  ...
}
```

Replace it with a call to the GMS session service, returning a `User` with
`userId`, `name`, `role` and `scope`. Nothing else in the module changes —
every route, every service method and every test goes through that one type.

The `?as=` query parameter exists so the demo's role switcher works without
cookies. **It must not survive contact with a real deployment**, and the
comment above it says so. If you are wiring this in, that parameter is the
first thing to delete.

---

## Known characteristics

Worth knowing before you build on this.

**Read routes check the user, not always the role.** Most `GET` routes require
a resolved user but do not re-check the matrix; the ones that expose
role-sensitive shapes do (`dashboard` filters per role, `audit` scopes by role,
`results/queue` and `medals/verify` require a `V` grant, the report catalogue
is role-filtered). A deployment that exposes this API to untrusted clients
should add the matrix check to the remaining read routes — the `can()` call is
one line and the context is already in scope. The write routes, which are the
ones that matter for integrity, all check.

**No pagination except on the audit log.** A tournament's fixtures, entries and
results are returned whole. At the scale the document describes — a national
championship — the largest payload is a few hundred kilobytes. A multi-sport
Games would want cursors.

**No websockets.** The console polls. Live score push is a genuine improvement
and a genuine addition; the event log makes it straightforward, because a
client that knows the last `seq` it saw can be sent only what came after.

**Notifications are emitted, not delivered.** §11 names a Notification module
as the owner of delivery. This module writes notification events with an
audience, channels and a payload, and the store records them. Nothing sends an
email. `GET /api/tournaments/:id/notifications` is the queue a real
notification service would drain.

**Upstream data is referenced, never copied.** Athletes, teams, venues and
officials come from other GMS modules as an `UpstreamRef` carrying the source
module and a `revalidatedAt` stamp. The TMS stores the reference and the
snapshot it validated against, so an eligibility decision can be explained
months later — but it never becomes a second master record of who an athlete
is.
