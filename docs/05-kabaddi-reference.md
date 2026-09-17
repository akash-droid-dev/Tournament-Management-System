# 05 — Kabaddi reference

**What this document is for:** every Kabaddi rule the system enforces, and —
just as important — every number in it that a federation is free to change.

The source TMS document (§7.4.13) says the scoring console must be "sport
specific" and (§12.3) that the sport setup screen holds "sport parameters",
but it never says which Kabaddi numbers are fixed by the laws of the game and
which are set by whoever is running the tournament. That distinction matters
enormously in practice: get it wrong in one direction and the software silently
enforces a rule of play that a state association has amended; get it wrong in
the other and an operator can "configure" away the all-out.

So every rule in `src/sports/kabaddi.ts` carries its provenance.

| Tag | Meaning | Who may change it |
| --- | --- | --- |
| `rule-of-play` | Structural to Kabaddi. The scoring engine is built around it. | Nobody, through the UI. Changing it is a code change with tests. |
| `configurable-default` | A starting value a federation sets and revises. | Tournament Admin, on the Sport & Event Setup screen (§12.3), before the tournament goes live. |

If you read only one section of this document, read
[Part 2 — the confirm-before-you-go-live list](#part-2--configurable-defaults).
Those are the numbers that will be wrong for your federation.

---

## Contents

- [Part 1 — Rules of play](#part-1--rules-of-play)
- [Part 2 — Configurable defaults](#part-2--configurable-defaults)
- [Part 3 — The event vocabulary](#part-3--the-event-vocabulary)
- [Part 4 — A raid, step by step](#part-4--a-raid-step-by-step)
- [Part 5 — What the engine refuses](#part-5--what-the-engine-refuses)
- [Part 6 — Statistics](#part-6--statistics)
- [Part 7 — Tie-breakers and medals](#part-7--tie-breakers-and-medals)
- [Part 8 — Walkovers](#part-8--walkovers)
- [Part 9 — The officials panel](#part-9--the-officials-panel)
- [Part 10 — Categories and rosters](#part-10--categories-and-rosters)
- [Part 11 — Presets](#part-11--presets)
- [Part 12 — What is deliberately not modelled](#part-12--what-is-deliberately-not-modelled)
- [Part 13 — Pre-tournament sign-off sheet](#part-13--pre-tournament-sign-off-sheet)

---

## Part 1 — Rules of play

These are encoded as constants at the top of `src/sports/kabaddi.ts`. The
scoring engine's arithmetic depends on them; they are not surfaced as editable
fields anywhere in the UI.

| Rule | Value | Constant | What depends on it |
| --- | --- | --- | --- |
| Players on the mat | 7 each | `ON_COURT` | All-out detection, bonus eligibility, super-tackle detection, revival ceiling |
| Raids alternate | every raid | `endRaid()` | The console's "who is raiding" indicator, the wrong-raider validation |
| All-out | 2 points to the opponent | `ALL_OUT_POINTS` | Derived automatically; cannot be entered by hand |
| After an all-out | the emptied side returns 7 to the mat | `checkAllOut()` | Reset of `onCourt` and `outQueue` |
| Bonus eligibility | 6 or more defenders on the mat | `BONUS_MIN_DEFENDERS` | Hard rejection of an illegal bonus |
| Super tackle | 3 or fewer defenders on the mat → 2 points | `SUPER_TACKLE_MAX_DEFENDERS` | Automatic upgrade of a plain tackle |
| Do-or-die raid | the 3rd consecutive empty raid | `DO_OR_DIE_AFTER_EMPTY_RAIDS` (= 2 prior) | Console warning banner, failed-raid point to the defence |
| Revival order | the order players went out | `outQueue` (FIFO) | Which player returns on a point |
| Bonus points do not revive | — | `REVIVING_EVENTS` | A bonus raises the score but brings nobody back |
| Yellow card | 2-minute suspension | `YELLOW_SUSPENSION_SECS` | Suspension timer; see the limitation in Part 12 |
| Super raid | a raid worth 3+ | `SUPER_RAID_MIN_POINTS` | Statistic only — it changes no score |

### Why these are not configurable

Take the all-out. If an operator could set it to zero points, every screen
downstream would still be correct — the standings, the tie-breakers, the medal
list would all compute cleanly from whatever the console produced. Nothing
would break. And that is exactly the danger: a misconfiguration would produce a
plausible-looking, fully audited, entirely wrong tournament. The rules of play
are the layer where "plausible but wrong" must be impossible, so they live in
code, under test, where changing them requires a diff and a review.

---

## Part 2 — Configurable defaults

**Every value in this section is a starting guess. Confirm each one against
your current technical handbook (AKFI / IKF / your state association) before
the tournament goes live.** They are seeded so the demo runs and so a new
tournament is not a blank form — not because they are authoritative.

### Match timing

| Field | Default | Note |
| --- | --- | --- |
| Periods | 2 | Two halves |
| Period length | 20 min | Senior standard |
| Interval | 5 min | |
| Total match duration | 45 min | 20 + 5 + 20 |
| Slot length | 60 min | 45 play + 15 turnaround; drives the scheduler's grid |

### League points

| Field | Default | Note |
| --- | --- | --- |
| Win | 2 | Federation convention |
| Tie | 1 | |
| Loss | 0 | |
| Losing bonus | none | The franchise-league 5/3/0 + bonus convention is a preset, see Part 11 |

### Rest between matches

| Field | Default | Note |
| --- | --- | --- |
| Hard minimum | 30 min | The scheduler refuses to publish a violation — a **hard conflict** |
| Recommended | 45 min | The scheduler warns and requires acknowledgement — a **soft conflict** |

The source document (§7.2.12) asks for a rest gap without giving a number or
saying whether it blocks. Splitting it into a hard floor and a recommended
target is the call this implementation makes; see gap 9 in
[03-gap-analysis.md](03-gap-analysis.md).

### Age categories

| Key | Label | Limit |
| --- | --- | --- |
| `U-14` | Sub-Junior | under 14 |
| `U-17` | Junior | under 17 |
| `U-19` | Youth | under 19 |
| `U-21` | Under 21 | under 21 |
| `SENIOR` | Senior | 17 and over |

### Weight categories

| Key | Label | Limit |
| --- | --- | --- |
| `SJB-50` | Sub-Junior Boys | 50 kg |
| `SJG-40` | Sub-Junior Girls | 40 kg |
| `JB-65` | Junior Boys | 65 kg |
| `JG-55` | Junior Girls | 55 kg |
| `YB-75` | Youth Boys | 75 kg |
| `SM-85` | Senior Men | 85 kg |
| `SW-75` | Senior Women | 75 kg |
| `OPEN` | Open weight | — |

Weight limits in particular are revised periodically and differ between
federations and between age groups within one federation. The eligibility
engine checks entries against whatever is configured (§7.1.5 confirms them at
the official weigh-in), so a wrong limit here produces a wrong eligibility
verdict — which is precisely why every row is tagged
`source: 'configurable-default'` in the code and rendered as an editable field
on the Sport & Event Setup screen.

### Tie-break mode

Default: *league matches share points on a tie; knockout matches go to two
5-minute extra halves, then a single golden raid each way.*

This is recorded as descriptive text on the format, not as an executable
procedure — see the limitation in Part 12.

---

## Part 3 — The event vocabulary

The console has two kinds of button, and the difference is the whole design.

### Entered events — what a Scorer presses

| Event | Button | Effect |
| --- | --- | --- |
| `raid-touch` | Raid touch | Raider puts out *n* defenders; *n* points; revives *n* of the raiding side |
| `raid-bonus` | Bonus | 1 point; **no** revival; needs 6+ defenders |
| `raid-empty` | Empty raid | No point — unless it is a do-or-die raid, in which case the defence takes 1 and the raider is out |
| `tackle` | Tackle | Raider out; 1 point to the defence, revives 1 — auto-upgraded to 2 at 3 or fewer defenders |
| `technical-point` | Technical point | *n* points for a rule violation; revives |
| `card-green` / `card-yellow` / `card-red` | Cards | Yellow and red put the player out; all three need a named player |
| `timeout`, `substitution`, `injury`, `period-end` | Admin | Recorded; no score effect |

### Derived events — what the engine produces

| Event | Produced when | Why it is not a button |
| --- | --- | --- |
| `all-out` | A side's `onCourt` reaches 0 | The 2 points and the 7-player reset must be automatic, or a distracted Scorer under-awards them |
| `revive` | Any reviving point is scored | Revival is bookkeeping, not a decision |
| `do-or-die-fail` | An empty raid on a do-or-die | The point belongs to the defence by rule, not by the Scorer's judgement |
| `super-tackle` | A tackle at 3 or fewer defenders | The Scorer presses "Tackle"; the engine decides whether it was worth 2 |

**Attempting to enter a derived event directly is refused** with
`DERIVED_EVENT`. This is the single most useful guard in the module: a Scorer
under time pressure cannot double-count an all-out by pressing a button *and*
having the engine award it.

```
 SCORER PRESSES                    ENGINE PRODUCES
 ┌──────────────────┐              ┌──────────────────────────────┐
 │  Raid touch × 3  │─────────────▶│  3 raid points               │
 │                  │              │  3 defenders out             │
 │                  │              │  → B now has 0 on the mat    │
 │                  │              │  ⚙ all-out  (+2 to A)        │
 │                  │              │  ⚙ revive   (A gets 2 back)  │
 │                  │              │  B returns 7 to the mat      │
 │                  │              │  raid closes, B raids next   │
 └──────────────────┘              └──────────────────────────────┘
        1 click                          6 state changes
```

---

## Part 4 — A raid, step by step

### The normal case

```
  State before      A: 7 on mat, 12 pts     B: 7 on mat, 10 pts
                    A is raiding, raid #14, not do-or-die

  ┌─ Scorer: "Raid touch, 1 defender" ────────────────────────────┐
  │                                                               │
  │  1. Validate    A is the raiding side          ✓              │
  │                 1 ≤ 7 defenders on the mat     ✓              │
  │                 clock has not gone backwards   ✓              │
  │                                                               │
  │  2. Apply       B: 1 defender → outQueue, onCourt 7 → 6       │
  │                 A: +1 point (13)                              │
  │                 A: revive 1 — nobody out, so no effect         │
  │                 all-out check: B has 6, no all-out            │
  │                                                               │
  │  3. End raid    A.totalRaids +1, A.successfulRaids +1         │
  │                 A.consecutiveEmptyRaids → 0                   │
  │                 raid #15, B raids next                        │
  │                 do-or-die = (B.consecutiveEmptyRaids ≥ 2)     │
  └───────────────────────────────────────────────────────────────┘

  State after       A: 7 on mat, 13 pts     B: 6 on mat, 10 pts
```

### The do-or-die sequence

This is where a naive implementation goes wrong, and it is worth spelling out
because the bug is invisible until late in a match.

```
  B raids, nothing happens        → B empty #1
  B raids, nothing happens        → B empty #2
  ⚠ B's next raid is DO-OR-DIE

  Case (a)  B scores              → counter resets to 0. Normal again.

  Case (b)  B raids empty         → the raider is OUT
                                  → A takes 1 point (the defence scored)
                                  → counter resets to 0   ← the important bit

  Case (c)  B is tackled          → A takes 1 (or 2)
                                  → counter resets to 0   ← also important
```

An "empty raid" in the rules means *neither side scored*. A failed do-or-die
is not empty — the defence took a point from it, so the sequence has resolved.
A tackle is not empty either. An implementation that counts both as empty
leaves a side permanently in do-or-die for the rest of the match, and every
subsequent raid by that side is scored under the wrong rule. `endRaid()` takes
`{ raiderScored, emptyRaid }` as two separate facts precisely so these cases
cannot be conflated.

### The super-tackle upgrade

```
  A raiding, B has 3 on the mat
  Scorer presses "Tackle"  (the only tackle button on the console)
       │
       ├─ engine: B.onCourt (3) ≤ 3  → this is a super tackle
       ├─ awards 2 points, not 1
       ├─ records B.stats.superTackles +1
       └─ emits a derived `super-tackle` event tagged upgradedFrom: 'tackle'
```

There is deliberately no "Super tackle" button on the pad. Requiring the
Scorer to notice that the defence was down to three, in the middle of a raid,
is asking for a systematic under-award. The engine can always see the count, so
it decides. (The event type still exists so that an offline scoresheet being
transcribed can name it explicitly; entering it when the defence has four or
more on the mat is rejected with `NOT_A_SUPER_TACKLE`.)

### Replay

Every scored event is stored. `replay()` rebuilds the live state from the event
log by re-applying only the *entered* events and skipping the derived ones —
re-applying an `all-out` that `apply()` already produced would double-count it.
That is what makes the match console resumable after a browser crash, a laptop
swap, or a mid-match handover between Scorers, and what makes an audited
reconstruction of a disputed match possible months later.

---

## Part 5 — What the engine refuses

§7.4.16 requires that "impossible scores" be rejected at entry. Every check
below runs *before* anything is written, and the message the operator sees is
the message in the table.

### Hard — the event is rejected

| Code | When | Message the operator sees |
| --- | --- | --- |
| `MATCH_FINISHED` | the match is over | the match is finished; no further events may be recorded |
| `CLOCK_BACKWARDS` | event clock < last clock | clock cannot move backwards (last event at *n*s, this one at *m*s) |
| `WRONG_RAIDER` | a raid point credited to the defending side | *X* is raiding; a raid point cannot be credited to *Y* |
| `WRONG_TACKLER` | a tackle point credited to the raiding side | *X* is defending; a tackle point cannot be credited to *Y* |
| `TOUCH_EXCEEDS_DEFENDERS` | touching more defenders than are on the mat | cannot touch *n* defenders — only *m* are on the mat |
| `BAD_TOUCH_COUNT` | a touch that puts out nobody | a raid touch must put out at least one defender |
| `BONUS_NOT_AVAILABLE` | bonus with fewer than 6 defenders | a bonus needs 6+ defenders on the mat; *n* are on |
| `NOT_A_SUPER_TACKLE` | super tackle with 4+ defenders | a super tackle needs 3 or fewer defenders on the mat; *n* are on |
| `NO_RAIDER` | a tackle when the raiding side has nobody on the mat | *X* has no players on the mat to raid |
| `BAD_VALUE` | a technical point worth less than 1 | a technical point must be worth at least 1 |
| `NO_PARTICIPANT` | a card with no player named | a card must name the player it is issued to |
| `DERIVED_EVENT` | entering `all-out`, `revive` or `do-or-die-fail` | "*x*" is derived by the rules engine and cannot be entered directly |
| `UNKNOWN_EVENT` | anything else | "*x*" is not a Kabaddi score event |

### Soft — the event is accepted and flagged

| Code | When | Why it is not blocked |
| --- | --- | --- |
| `SUPER_RAID` | a raid worth 3 or more | Rare but entirely legal — worth surfacing so a mis-click is noticed |
| `DO_OR_DIE_FAILED` | an empty raid on a do-or-die | Correct and expected; the note explains the consequence to the Scorer |

The split is the same one the scheduler uses: **hard means the data would be
impossible, soft means the data is unusual.** Blocking the unusual trains
operators to work around the system.

---

## Part 6 — Statistics

Produced per side by `summarize()` and carried into the §10.6 match result
report and the §8 result record:

| Statistic | Source |
| --- | --- |
| Raid points | touches |
| Bonus points | bonus line crossings |
| Tackle points | tackles, super tackles, failed do-or-die raids |
| Super tackles | count of upgraded tackles |
| All-outs | count inflicted on the opponent |
| Technical points | rule-violation awards |
| Empty raids | raids where neither side scored |
| Super raids | raids worth 3+ |
| Total raids / successful raids | closed raids, and those that scored |
| Raid success % | derived, rounded to a whole number |
| Green / yellow / red cards | card counts |

`describeState()` renders the one-line live summary the console header shows:

```
H2 14:32 · 27–24 · raid #41 by A · on mat 6v4 · DO-OR-DIE
```

---

## Part 7 — Tie-breakers and medals

### Tie-breaker hierarchy

Applied strictly in this order (§5.7, enforced at §7.5.22):

```
  1. League points
  2. Head-to-head result          (only when the tied sides met)
  3. Score difference
  4. Total points scored
  5. Matches won
  6. Fewer cards (fair play)
  7. Draw of lots                 ← requires a human decision
```

Steps 1–5 are computed. Step 6 depends on card data being complete for every
match in the group. Step 7 is **not** automated: the standings engine stops and
flags `drawOfLots` as requiring a documented decision, because a draw of lots
performed by software with a seeded RNG is not a draw of lots anyone will
accept in a protest hearing.

### Medals

`medalRuleDefault: 'joint-bronze'` — **two bronze medals, awarded to both
losing semi-finalists, with no bronze play-off.** §7.5.24 drives the medal
count off this sport config flag and §9.2 names Kabaddi as a joint-bronze
sport, so the two agree.

One consequence worth knowing about: if a joint-bronze medallist is later
disqualified, the medal list cannot simply promote the next finisher, because
there is no ranked "fourth place" between two tied bronzes. The DQ cascade
preserves the tie and returns `decisionRequired`, demanding a Jury or Admin
ruling rather than minting a second silver. See gap 22 in
[03-gap-analysis.md](03-gap-analysis.md).

---

## Part 8 — Walkovers

§7.4.20 says a walkover records "the sport's standard result" and illustrates
it with badminton (21-0, 21-0). Kabaddi has no universal forfeit score.

The default is therefore:

```
  winnerScore: 0      loserScore: 0      outcomeType: 'walkover'
  → standard win points ARE awarded
  → no points for or against are recorded
```

**Why not a nominal score.** Score difference is tie-breaker 3. Awarding a
fabricated 40–0 would move the winner up the group table past sides that
earned their difference on the mat, and would distort the difference of every
other side in that group by changing the totals they are compared against. A
walkover is an administrative event; it should decide the fixture without
rewriting the group's arithmetic.

Federations that mandate a nominal score can set one on the Sport & Event Setup
screen. The default carries a note saying exactly that, so the choice is
visible rather than buried.

---

## Part 9 — The officials panel

§7.3.15 requires a minimum panel before a match may move to Check-in. The
Kabaddi template declares both the full panel and that minimum.

| Role | Full panel | Minimum to start | Grade |
| --- | --- | --- | --- |
| Referee | 1 | 1 | A |
| Umpire | 2 | 2 | B |
| Scorer | 1 | 1 | — |
| Assistant Scorer | 2 | — | — |
| Time Keeper | 1 | — | — |
| Match Commissioner | 1 | — | A |

`startMatch` re-checks the minimum panel and refuses with, for example:

> M14 cannot start: minimum officials panel incomplete — Umpire 1/2 (§7.3.15)

Separately, only the **assigned** Referee may sign off the match report
(§7.7). A Referee who is not on the panel for that match is refused by name:

> M. Gaikwad is not assigned to M01 and cannot sign its match report

---

## Part 10 — Categories and rosters

| Field | Value |
| --- | --- |
| Roster minimum | 7 (you cannot field fewer) |
| Roster maximum | 12 |
| On the mat | 7 |
| Field-of-play type | `mat` |
| Participation type | `team` |
| Disciplines | Team Kabaddi, Circle Style (Punjabi), Beach Kabaddi |
| Genders | M, W |

The three disciplines are listed so an event can be labelled correctly. Their
rule differences are **not** modelled — see Part 12.

---

## Part 11 — Presets

Presets are named overlays on the match defaults, applied when an event is set
up. They exist so common variations do not require editing six fields by hand
and getting one wrong.

| Preset | Changes |
| --- | --- |
| `junior-15min` | 15-minute halves, 35-minute match, 50-minute slot |
| `franchise-league` | 5 for a win, 3 for a tie, 0 for a loss, plus 1 bonus point for losing by 7 or fewer |
| `knockout-golden-raid` | Tie-break text set to extra halves then golden raid; a tie is worth 0 |

---

## Part 12 — What is deliberately not modelled

Stated plainly, because a reference document that only lists what works is not
a reference document.

**1. Extra time and the golden raid are not executable.**
`KabaddiState.tiePhase` exists, and `isComplete()` knows that a golden raid
ends when the scores differ. But no event transitions a match *into*
`extra-1`, `extra-2` or `golden-raid` — the tie-break procedure is recorded as
descriptive text on the format and carried out by the officials, with the
result entered through the normal chain. A tied knockout match therefore needs
the Referee to run extra time on the mat and the Scorer to keep scoring; the
console will not gate the phases for them. Making this executable means adding
a `begin-tie-phase` event and the period logic behind it.

**2. A yellow-carded player does not automatically return to the mat.**
The card puts the player out and records a suspension expiring two minutes
later. When the clock passes that point the suspension record is dropped, but
the player re-enters through the normal revival queue rather than being
restored automatically. In a match with frequent scoring this is usually
invisible; in a defensive match it is not. Correct behaviour is a small change
to the suspension sweep in `apply()`, and it needs a federation ruling first:
whether the returning player rejoins immediately or occupies the next revival
is exactly the kind of detail handbooks differ on.

**3. Substitutions do not change the roster.**
`substitution` is recorded as an event for the match report and the audit
trail, but it does not swap a player in the on-mat set. The engine tracks *how
many* players are on the mat and *which* are in the revival queue; it does not
track a live line-up. Player-level statistics are therefore attributable only
where the Scorer names a participant on the event.

**4. Positional detail is not modelled.**
No lobby, no bonus-line position, no raider identity beyond an optional
participant ID, no left/right corner or cover roles. The engine scores
outcomes, not geometry. This is the right boundary for a tournament management
system; a broadcast analytics product would draw it elsewhere.

**5. The three disciplines share one rule set.**
Circle Style and Beach Kabaddi are selectable labels. Their differences — mat
dimensions, squad sizes, scoring variations — are not implemented. Running a
Circle Style event today means running it under Team Kabaddi rules with a
Circle Style name, which is honest only if everyone involved knows it. A real
Circle Style implementation is a second template file, which is what the sport
registry is for.

**6. Fair play (tie-breaker 6) depends on complete card data.**
The computation is implemented, but it is only meaningful if every match in the
group had its cards entered. There is no check that card data is complete
before the tie-breaker is applied.

---

## Part 13 — Pre-tournament sign-off sheet

Print this. Walk it with your technical delegate. Nothing here is a code
change — every row is a field on the Sport & Event Setup screen (§12.3).

```
  TOURNAMENT ______________________________  DATE ______________

  MATCH TIMING
  [ ] Period length          ____ min   (default 20)
  [ ] Number of periods      ____       (default 2)
  [ ] Interval               ____ min   (default 5)
  [ ] Slot length            ____ min   (default 60)

  LEAGUE POINTS
  [ ] Win                    ____       (default 2)
  [ ] Tie                    ____       (default 1)
  [ ] Loss                   ____       (default 0)
  [ ] Losing bonus           ____       (default none)
       └ if used, margin     ____       (franchise preset: 7)

  REST GAP
  [ ] Hard minimum           ____ min   (default 30 — blocks publication)
  [ ] Recommended            ____ min   (default 45 — warns only)

  CATEGORIES
  [ ] Age bands confirmed against the current handbook
  [ ] Weight limits confirmed against the current handbook
         ── these are the two most commonly out of date ──
  [ ] Gender categories for this tournament

  TIE-BREAKERS
  [ ] Hierarchy matches your regulations (points → H2H → diff → for
      → wins → fair play → lots)
  [ ] Who performs a draw of lots, and how it is documented

  MEDALS
  [ ] Joint bronze (default) or bronze play-off?

  WALKOVER
  [ ] 0–0 with win points (default), or a nominal score? If nominal:
      winner ____  loser ____  and note the tie-breaker effect

  OFFICIALS
  [ ] Minimum panel to start: 1 Referee + 2 Umpires + 1 Scorer (default)
  [ ] Grade requirements: Referee A, Umpire B (default)

  ACKNOWLEDGED LIMITATIONS (Part 12)
  [ ] Extra time / golden raid is run by officials, not gated by the console
  [ ] Yellow-card returns are handled by the Referee on the mat
  [ ] Substitutions are recorded, not roster-tracked
  [ ] Circle Style / Beach events run under Team Kabaddi rules

  Technical delegate ____________________  Signature ____________
```

---

## Where this lives in the code

| Concern | File |
| --- | --- |
| Every rule and default above | `src/sports/kabaddi.ts` |
| The contract it implements | `src/sports/registry.ts` |
| Rule tests (scoring, validation, derivation, replay) | `test/kabaddi-scoring.test.ts` |
| Tie-breaker application | `src/engines/standings.ts` |
| Medal rule application | `src/engines/medals.ts` |
| Walkover result construction | `src/workflow/result-approval.ts` |
| Minimum-panel enforcement | `src/engines/officials.ts`, `src/api/service.ts` |

Adding a second sport is a new file in `src/sports/` plus one line in
`src/sports/index.ts`. Nothing in `engines/`, `workflow/`, `store/` or `api/`
needs to know it happened.
