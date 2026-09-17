# UI/UX wireframes and live logic

Every screen from §12, its layout, and — more importantly — the live logic behind
each control: what it does, what it refuses, and which rule does the refusing.

A wireframe without its logic is decoration, so each screen below has three
parts: **the layout**, **what is live**, and **what it refuses**.

---

## The shell

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ TMS KABADDI │ National Kabaddi Championship 2026 · NKC-2026 · Active │        │
│                              SIGNED IN AS [ R. Kulkarni — Tournament Admin ▾] │
│                                                       ( Tournament Admin )     │
├──────────────────┬─────────────────────────────────────────────────────────────┤
│ OVERVIEW         │                                                             │
│  Dashboard   §9  │                                                             │
│  Public     §12.20                                                             │
│                  │                                                             │
│ SET UP           │                                                             │
│  Tournament §12.1│                    the active screen                        │
│  Sport & events  │                                                             │
│  Entries     (1) │  ← a red badge is pending work, not a spec reference        │
│  Format builder  │                                                             │
│                  │                                                             │
│ COMPETITION      │                                                             │
│  Draw console    │                                                             │
│  Scheduling board│                                                             │
│  Officials board │                                                             │
│  Match console   │                                                             │
│                  │                                                             │
│ RESULTS          │                                                             │
│  Approval queue  │                                                             │
│  Standings       │                                                             │
│  Medals          │                                                             │
│  Protests    (1) │                                                             │
│                  │                                                             │
│ GOVERNANCE       │                                                             │
│  Reports hub     │                                                             │
│  Audit log       │                                                             │
│  Role & access   │                                                             │
└──────────────────┴─────────────────────────────────────────────────────────────┘
```

**What is live.** The role switcher is the whole demo. Changing user re-fetches
every payload, rebuilds the sidebar from that role's permissions, and re-renders
the current screen — or falls back to the dashboard if the role cannot reach it.
Sidebar badges are counts of work waiting on *you*, pulled from the dashboard.

**Why each item cites a section.** So the console and the functional document can
be read side by side during review.

**What it refuses.** A role reaching a screen it has no nav entry for gets a
plain "Not available to a *Scorer*" panel. The server still enforces access —
the UI hiding is convenience, never security.

---

## §12.1–2 · Tournament list, creation wizard and configuration

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ National Kabaddi Championship 2026                                  §12.2      │
│ AKFI · national · Pune · Tue, Mar 10 to Sat, Mar 14                            │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ STATUS        │ EVENTS        │ UNITS         │ OFFICIALS POOL                 │
│ Active        │ 2             │ 12            │ 74                             │
│ Code NKC-2026 │ 2 confirmed   │ MH HR PB UP…  │ 26 referees                    │
├───────────────┴───────────────┴───────┬───────┴────────────────────────────────┤
│ Configuration                         │ Lifecycle                              │
│ Entry deadline      Fri, Feb 20       │ (Draft)(Configured)(Entries Open)      │
│ Withdrawal deadline Wed, Feb 25       │ (Entries Locked)(Draw Published)       │
│ Category cut-off    Thu, Jan 1 §7.1.2 │ (**Active**)(Completed)(Archived)      │
│ Protest window      30 min · fee 5000 │                                        │
│ Approval chain      2-step      §1.4  │ Every transition is checked against    │
│ Publish results     separate act      │ the §6.1 machine and writes an audit   │
│ Official neutrality enforced          │ entry.                                 │
│ Max events/athlete  1                 │                                        │
│ Min entries to run  4                 │ [ Close tournament ]                   │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**What is live.** The lifecycle buttons change with status — Draft offers
"Validate & configure", Configured offers "Open entries", and so on. Opening
entries emits the §3.1 notification to Team Managers and flips every confirmed
event to Entries Open.

**What it refuses.** "Validate & configure" runs the §5.1 list and shows the
failures as a checklist. Cancelling after Active is refused for anyone but Super
Admin (§6.1). A non-admin sees the configuration read-only with a note naming
§3.2.

The creation wizard (§12.1) collects basics, scope and rules on one page with the
category cut-off field carrying its own hint, because it is the field people get
wrong.

---

## §12.3 · Sport & event setup

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Sport & event setup                                                  §12.3     │
├────────────────────────────────────────────────────────────────────────────────┤
│ Event catalogue                                       2 of 2 confirmed         │
│ ┌──────────┬──────────────┬────────────┬─────────┬──────────┬────────────────┐ │
│ │ ID       │ DISCIPLINE   │ CATEGORY   │ STATUS  │ DRAW     │                │ │
│ ├──────────┼──────────────┼────────────┼─────────┼──────────┼────────────────┤ │
│ │ EVT-0001 │ Team Kabaddi │ SENIOR·Men │ ●Completed│●Published│ [Entries]    │ │
│ │ EVT-0002 │ Team Kabaddi │ SENIOR·Wom │ ●InProgress│●Published│ [Entries]   │ │
│ └──────────┴──────────────┴────────────┴─────────┴──────────┴────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────┤
│ ! 13 classification values are configurable defaults, not rules of play        │
│   Weight limits, age bands, league point values, half length and rest gaps are │
│   set by the organizing federation and revised periodically. Confirm against   │
│   your current technical handbook before the tournament goes live.             │
├───────────────────────────────────────┬────────────────────────────────────────┤
│ Kabaddi scoring template              │ Tie-breaker hierarchy                  │
│ Match structure  2 × 20 min, 5 min    │  1. League points                      │
│ Slot booked      60 min               │  2. Head-to-head  (cohort only)        │
│ League points    win 2 · tie 1 · loss 0│ 3. Score difference                   │
│ Tie resolution   two extra halves,    │  4. Total points scored                │
│                  then a golden raid   │  5. Matches won                        │
│ Squad            7 on the mat, 7–12   │  6. Fewer cards (fair play)            │
│ Rest gap         30 hard / 45 rec.    │  7. Draw of lots (recorded + witnessed)│
│ Standings metric Score Diff           ├────────────────────────────────────────┤
│ Walkover         0–0                  │ Officials panel                        │
│   no points for/against, so the       │  Referee          1  grade A  1 min    │
│   score-difference tie-breaker is     │  Umpire           2  grade B  2 min    │
│   not distorted                       │  Scorer           1  any      1 min    │
│ Presets  junior-15min ·               │  Assistant Scorer 2  any      —        │
│          franchise-league ·           │  Time Keeper      1  any      —        │
│          knockout-golden-raid         │  Match Commission 1  grade A  —        │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**What is live.** The whole right-hand column is read from the sport template,
not hardcoded in the screen — swap the sport and it redraws. "Confirm" locks the
catalogue (§2.7) and is Tournament Admin only.

**What it refuses.** An event with no scoring template cannot be confirmed
(§2.5). A Competition Manager can add events but not confirm the catalogue.

---

## §12.4 · Entry management

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Entry management                                                     §12.4     │
│ EVENT [ Team Kabaddi Women (EVT-0002) ▾ ]          Event status: Entries Locked│
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ CONFIRMED  10 │ BLOCKED     1 │ SCRATCHED   0 │ UNITS ENTERED              10  │
│ Min to run: 4 │ Needs decision│ Kept on record│ Quota 1 per unit per event     │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ Gate to Phase 4 — Format setup                                                 │
│  ✓ entries are locked for this event                                           │
│  ✓ at least 4 confirmed entries                                                │
│  ✗ 1 entry is still Submitted or Blocked; each must be confirmed, corrected,   │
│    overridden or scratched (§3.5)                                              │
├────────────────────────────────────────────────────────────────────────────────┤
│ Override queue                                                                 │
│ ┃ENT-0019 │ West Bengal Women │ WB │ ✕ squad of 6 is outside 7–12 │[Override…]│
├────────────────────────────────────────────────────────────────────────────────┤
│ Entries                                                                        │
│ │ENT-0011│ Maharashtra Women │MH│ 1 │12│ ●Confirmed │ ✓ Passed all checks     │
│ │ENT-0012│ Haryana Women     │HR│ 2 │12│ ●Confirmed │ ✓ Passed all checks     │
│ ┃ENT-0019│ West Bengal Women │WB│ — │ 6│ ●Blocked   │ ✕ squad of 6…           │
│ │ENT-0020│ Odisha Women      │OD│ — │12│ ●Confirmed │ OVERRIDE by ta1: LATE…  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** The gate checklist recomputes on every change. The eligibility
column shows hard failures in red with ✕ and advisories in amber with ⚠ — the
distinction from §3.4. The pool dropdown offers only records another module has
marked Approved, minus those already entered.

**What it refuses.** A Team Manager sees and can enter only their own unit
(§3.2). "Override…" appears for Tournament Admin only and demands a reason code
plus free-text justification before it will submit (§7.1.4). Entering when the
event is not open is refused with the status named.

---

## §12.5 · Format builder

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Format builder                                                       §12.5     │
├───────────────────────────────────────┬────────────────────────────────────────┤
│ Stage structure     10 confirmed      │ Validation panel                       │
│ FORMAT     [ Groups + knockout ▾]     │  ✓ 2 group(s)                          │
│ PER PAIRING[ Single meeting ▾]        │  ✓ 2 × 5 holds 10 sides against 10     │
│ GROUPS     [ 2 ]                      │    entered                             │
│ PER GROUP  [ 5 ]                      │  ✓ Top 2 per group advance             │
│ ADVANCE    [ 2 ]                      │  ✓ 4 qualifier(s) → knockout bracket   │
│   Top n qualify (§4.3)                │    of 4                                │
│                                       │  ✓ 20 group fixture(s)                 │
│                                       │  ✓ Match: 2 × 20 min with a 5 min      │
│                                       │    interval                            │
├───────────────────────────────────────┼────────────────────────────────────────┤
│ Match parameters                      │ Approval                               │
│ PERIODS [2] MIN/PERIOD [20] BREAK [5] │ Format      FMT-0001                   │
│ WIN [2]  TIE [1]  LOSS [0]            │ Status      ● Approved                 │
│ BONUS MARGIN [   ]  BONUS PTS [0]     │ Approved by ta1                        │
│   blank for no losing bonus           │ Locked by draw  yes                    │
│                     [ Update format ] │       [ Go to draw console → ]         │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**What is live.** The validation panel recomputes on every keystroke, showing the
arithmetic rather than a verdict: bracket size, byes implied, fixture count,
qualifier count and whether the qualifiers fill a power-of-two bracket.

**What it refuses.** Groups too small to hold the entries, a group stage with no
progression rule ("dead end"), an advance count above the group size. Once the
draw is published the whole panel greys out with §7.2.7 quoted.

---

## §12.6 · Draw console

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Draw console                                                         §12.6     │
│ EVENT [ Team Kabaddi Men ▾ ]                                      ● Published  │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ BRACKET SIZE  │ BYES          │ SEEDS PLACED  │ FIXTURES                       │
│ 16            │ 4             │ 4             │ 23                             │
│ 12 entries    │ to top seeds  │ conventional  │ 0 bye fixture(s)               │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ ✓ Validation passed                                                            │
│   No duplicate pairing, no participant twice in one round, bye count correct,   │
│   separation rules honoured, every progression slot mapped (§5.3).             │
├────────────────────────────────────────────────────────────────────────────────┤
│ Draw parameters        [Re-run auto-draw] [Verify reproducibility] [Publish]   │
│ SEEDS [4]  SEPARATION [Same unit apart in round 1 ▾]  BYE [Top seeds ▾]        │
│ RNG SEED [ EVT-0001:NKC2026-MEN-DRAW ]   stored so it can be replayed (§7.2.9) │
├────────────────────────────────────────────────────────────────────────────────┤
│ Bracket                        click any fixture to open its match console      │
│   G1·R1            G1·R2            G1·R3            SF                F       │
│ ┌───────────┐    ┌───────────┐    ┌───────────┐   ┌───────────┐  ┌───────────┐ │
│ │M01  09:15 │    │M03  11:15 │    │M05  14:15 │   │M21  14:15 │  │M23  18:45 │ │
│ │UP      26 │    │Kerala  18 │    │**MH**  23 │   │**MH**  31 │  │**MH**  33 │ │
│ │Kerala  21 │    │**MH**  22 │    │Delhi   19 │   │Rajast. 28 │  │Karnat. 30 │ │
│ └───────────┘    └───────────┘    └───────────┘   └───────────┘  └───────────┘ │
├───────────────────────────────────────┬────────────────────────────────────────┤
│ Slot map                              │ Draw record                            │
│ 0  seed 1  Maharashtra Men  MH  [1]   │ Draw ID    DRW-0001                    │
│ 1  seed 16 BYE                        │ RNG seed   EVT-0001:NKC2026-MEN-DRAW   │
│ 2  seed 8  Rajasthan Men    RJ        │ Algorithm  mulberry32/v1               │
│ 3  seed 9  Gujarat Men      GJ        │ Generated  cm1 at 10 Mar 09:02         │
│ …                                     │ Approved   ta1 · published 10 Mar 09:14│
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**What is live.** "Verify reproducibility" actually regenerates the draw from the
stored seed and compares the slot map, then reports the result — the button that
settles a dispute. The bracket highlights winners in green from approved results.
Every fixture tile is a link to its match console.

**What it refuses.** A draw with validation errors cannot be published, with the
errors listed. Manual swaps are offered only while the draw is a draft (§5.4),
and each one is logged with before/after and re-validates the whole draw. Only
an Admin sees the publish button (§3.2).

---

## §12.7 · Scheduling board

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Scheduling board                                                     §12.7     │
│ EVENT [ Team Kabaddi Men ▾ ]  DAY [ 2026-03-10 ▾ ]     ● Published  version 1  │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ FIXTURES   23 │ HARD CONFLICTS│ SOFT CONFLICTS│ FIELDS OF PLAY              3  │
│ 23 placed     │ 0  None       │ 0  0 unack'd  │ Shree Shiv Chhatrapati…        │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ Grid — 2026-03-10        a red fixture carries a conflict                      │
│ ┌──────┬────────────────────┬────────────────────┬────────────────────┐        │
│ │ TIME │ Mat 1 (Main)       │ Mat 2              │ Mat 3              │        │
│ ├──────┼────────────────────┼────────────────────┼────────────────────┤        │
│ │ 09:00│ M01 09:15 group    │ M02 09:15 group    │ M11 09:15 group    │        │
│ │      │ UP v Kerala        │ Karnataka v Delhi  │ Punjab v Gujarat   │        │
│ │ 10:00│ M12 10:15 group    │ M03 11:15 group    │                    │        │
│ │ 13:00│                    │                    │ ▓ MAINTENANCE ▓    │        │
│ │ 14:00│ M05 14:15 group    │ M13 14:15 group    │ M15 16:15 group    │        │
│ │ 18:00│ M07 18:45 SF       │ M08 18:45 SF       │                    │        │
│ └──────┴────────────────────┴────────────────────┴────────────────────┘        │
│                        [ Run auto-scheduler ]  [ Publish schedule ]            │
├────────────────────────────────────────────────────────────────────────────────┤
│ All fixtures  a published fixture is immutable: a reschedule creates a new      │
│               version and keeps the prior slot in history (§7.2.10)            │
│ │M01│group│G1│2026-03-10│09:15│V1-MAT-1│morning│UP v Kerala│●Completed│1│[…]   │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** The grid is field-of-play × time for the selected day, built
from the venue's operating hours and session blocks. Maintenance windows render
as hard blocks. A fixture carrying any conflict turns red. Clicking one opens its
console.

**What it refuses.** Publish is hidden while any hard conflict exists, and while
any soft conflict is unacknowledged — §7.2.11 requires an explicit
acknowledgment, so there is an "Acknowledge all" action and a table of what is
being acknowledged. A reschedule demands a reason code and re-runs every check;
if the new slot introduces a hard conflict the move is refused and the original
plan is untouched.

---

## §12.8 · Officials assignment board

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Officials assignment board                                           §12.8     │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ POOL       74 │ DUTY ASSIGNS  │ BELOW MINIMUM │ NEUTRALITY FAILURES         0  │
│ 72 qualified  │ 248           │ 0  All staffed│ None waived                    │
│ for Kabaddi   │ panel = 8     │               │                                │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ ✓ Every fixture meets its minimum panel                                        │
│   All 23 playable fixtures have at least 1 Referee, 2 Umpire, 1 Scorer.        │
├────────────────────────────────────────────────────────────────────────────────┤
│ Fixture × panel                                                                │
│ │M01│2026-03-10│09:15│UP v Kerala│8/8│(Referee: R. Deshmukh (AS))(Umpire: …)   │
├───────────────────────────────────────┬────────────────────────────────────────┤
│ Duty load per official                │ Pool by seat                           │
│ A. Deshmukh    4   busiest day 2      │ Referee          1  grade A  26  26    │
│ B. Gowda       4   busiest day 2      │ Umpire           2  grade B  48  48    │
│ …                                     │ Scorer           1  any      36  36    │
│ The engine caps an official at four   │ …                                      │
│ matches a day and prefers a fresher   │ 23 fixtures × 8 seats =                │
│ official (§6.6)                       │ 184 seat-assignments needed            │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**What is live.** "Fill panel" runs the assignment engine for one fixture. Duty
load shows the busiest day per official, flagging anyone over the cap. "Pool by
seat" shows the arithmetic behind whether the pool is large enough — see
[gap 20](03-gap-analysis.md#20--officials-pool-sizing-is-implied-but-never-computed).

**What it refuses.** The board's point is showing *why* a candidate was refused:
wrong sport, not certified for the seat, grade too low, accreditation lapsed,
declared unavailable, from a competing unit, already on duty, too little travel
buffer, or over the daily cap. An unfilled seat lists the reasons the top
candidates failed, so a pool gap is distinguishable from a rule block.

---

## §12.9 · Match console — the match-day screen

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Match console                                                        §12.9     │
│ FIXTURE [ M11 · QF · Haryana Women v Tamil Nadu Women · Live ▾]                │
│                                       ( QF )( V1-MAT-3 · 2026-03-10 09:15 )    │
├────────────────────────────────┬──────────────┬────────────────────────────────┤
│      Haryana Women             │   Half 1     │      Tamil Nadu Women          │
│                                │   12:30      │                                │
│           18                   │ raid #24 by A│            15                  │
│                                │ ● Live       │                                │
│      6 on the mat · 1 out      │[DO OR DIE]   │      7 on the mat              │
├────────────────────────────────┴──────────────┴────────────────────────────────┤
│ Match control          Status machine: Live. Every transition is checked        │
│                        against §6.2.                        CLOCK (S) [ 750 ]  │
│ [ End match ]                                                                  │
├───────────────────────────────────────┬────────────────────────────────────────┤
│ Haryana Women — scoring               │ Tamil Nadu Women — scoring             │
│ Raiding this turn                     │ Defending this turn                    │
│ ┌──────────────┬──────────────┐       │ ┌──────────────┬──────────────┐        │
│ │ Raid touch   │ Bonus        │       │ │ Raid touch   │ Bonus        │        │
│ │ 1 pt per     │ needs 6+     │       │ │              │              │        │
│ │ defender     │ defenders    │       │ │              │              │        │
│ ├──────────────┼──────────────┤       │ ├──────────────┼──────────────┤        │
│ │ Empty raid   │ Tackle       │       │ │ Empty raid   │ Tackle       │        │
│ │ 3rd in a row │ auto-upgrades│       │ │              │ auto-upgrades│        │
│ │ = do-or-die  │ to super at ≤3│      │ │              │ to super at ≤3│       │
│ ├──────────────┴──────────────┤       │ ├──────────────┴──────────────┤        │
│ │ Technical point             │       │ │ Technical point             │        │
│ └─────────────────────────────┘       │ └─────────────────────────────┘        │
├───────────────────────────────────────┴────────────────────────────────────────┤
│ Match events  cards, time outs, substitutions, injuries, half-time whistle     │
│ [Green card][Yellow card][Red card][Time out][Substitution][Injury][End half]  │
├────────────────────────────────────────────────────────────────────────────────┤
│ Exceptions    each enforces its deciding role, demands a reason code, and      │
│               requires a second-role ratification where high-impact            │
│ [Suspend] [Disqualify] [Abandon] [Offline entry]                               │
├───────────────────────────────────────┬────────────────────────────────────────┤
│ Event log                             │ Match statistics                       │
│ italic rows are derived by the rules  │                    HARYANA  TAMIL NADU │
│ engine                                │ Raid points             11          9  │
│ 12:30 A raid touch              +1    │ Bonus points             2          1  │
│ 12:30 A *revive ×1*             +1    │ Tackle points            3          5  │
│ 12:00 B tackle                  +1    │ Super tackles            0          1  │
│ 11:30 A *all-out (B all out)*   +2    │ All outs                 1          0  │
│ 11:30 A raid touch              +3    │ Raid success %          62         54  │
│ …                                     │ …                                      │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**What is live — this is the screen where it matters most.**

- The scoreboard is rebuilt from the stored event log on every render, so a
  reload or a second device shows the same state.
- The pad is **generated from the sport template's `consoleActions`**. A
  different sport draws different buttons with no change to this screen.
- Each side's pad is labelled with whether that side is raiding this turn.
- The DO OR DIE indicator appears when the next raid must produce a point.
- "on the mat" counts update from all-outs and revivals the engine derived.
- The event log shows derived events in italics, so a verifier can tell what a
  human recorded from what the rules concluded.
- Cards prompt for the player and the reason before submitting.

**What it refuses.** Every button press goes to the server, which validates
against the sport rules and refuses illegally. The refusal appears as a message
naming the rule and the score does not change:

```
  ✕  A is raiding; a raid point cannot be credited to B
  ✕  a bonus needs 6+ defenders on the mat; 3 are on
  ✕  cannot touch 5 defenders — only 3 are on the mat
  ✕  "all-out" is derived by the rules engine and cannot be entered directly
  ✕  clock cannot move backwards (last event at 750s, this one at 300s)
```

The control buttons change with status: Scheduled offers only "Open console",
and that is disabled with the gate checklist shown if the schedule is
unpublished or the officials panel is short (§7.3.15). Check-in offers
attendance, toss and start. Start is refused if anyone is unmarked or absent —
resolve it or rule a no-show. Accreditation-invalid attendance is refused
outright (§11).

---

## §12.10–11 · Result verification, approval, and correction

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Result verification & approval                                    §12.10–11    │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ AWAITING ENTRY│ AWAITING VERIF│ IN WINDOW     │ AWAITING APPROVAL              │
│ 0             │ 1             │ 2             │ 1                              │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ Queue                                                                          │
│ │M14│Rajasthan v Punjab│●Verified│approval      │sc1│—        │      │[Open]  │
│ ┃M15│Gujarat v Haryana │●Entered │verification  │sc1│—        │Overdue│[Open] │
│ │M16│Punjab v Kerala   │●Verified│protest window│sc1│22 min   │      │[Open]  │
├────────────────────────────────────────────────────────────────────────────────┤
│ M14 — Rajasthan Men v Punjab Men                                               │
│ (Pending)(Entered)(**Verified**)(Approved + LOCKED)                            │
│                                                                                │
│ Score        24 – 13            Entered by   sc1 at 10 Mar 15:31               │
│ Outcome      played             Verified by  to1                               │
│ Winner       Rajasthan Men      Approved by  —                                 │
│                                 Locked at    not locked                        │
│ Referee sign-off: M. Gaikwad at 10 Mar 15:29                                   │
│                                                                                │
│         [ Return with remarks ]   [ Approve & lock ]                           │
├────────────────────────────────────────────────────────────────────────────────┤
│ Digital record — what the verifier checks against the signed scoresheet        │
│ │19:30│A│raid touch  │1│sc1│        │                                          │
│ │19:00│B│tackle      │1│sc1│        │                                          │
│ │18:30│A│raid bonus  │1│sc1│        │                                          │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** The chain strip shows where this result is, with the current
step highlighted and any branch (Under Protest, Correction in Progress,
Re-verified) appended. The queue classifies every finished fixture by what it is
waiting on, and flags one overdue. The digital record is the side-by-side the
screen list asks for — the last thirty events with any offline entry marked.

**What it refuses.** Every button can be pressed and the server refuses with the
rule:

```
  ✕  maker–checker violation: the user who entered this result cannot verify it (§7.4.17)
  ✕  a 2-step approval chain requires the verifier and the approver to be
     different people (§3.2 maker–checker)
  ✕  the protest window is still open for another 22 min (closes 15:59);
     approving now would lock the result before teams may contest it (§8.3)
  ✕  RES-0014 is Under Protest (PRT-0001); the protest must be ruled by the
     Jury before the result can be approved (§7.4.19)
  ✕  publishing is restricted to Tournament Admin and Super Admin (§3.2)
```

Approving inside the window prompts for a reason rather than simply refusing, and
records it.

### The correction workflow (§12.11)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Correction / unlock workflow                                                   │
│ ! This result is approved and locked                                           │
│   Editing it requires a reason-coded unlock approved by a second role, then a  │
│   correction, a re-verification and a re-approval. Standings, progression and  │
│   medals recompute automatically, and every old and new value is stored (§8.7).│
│                                                                                │
│   Correcting this result would disturb:                                        │
│   │M21│SF│Scheduled│side A came directly from M14│                             │
│   │M23│F │Scheduled│downstream of M14 via 1 further round(s)│                  │
│                                              [ Unlock for correction… ]        │
├────────────────────────────────────────────────────────────────────────────────┤
│ Correction history                                                             │
│ │finalScore│{"a":24,"b":13}│{"a":24,"b":15}│DATA_ENTRY_ERROR│ta1│ta2│10 Mar…   │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** The downstream-impact list is computed by walking the
progression graph, so the Admin sees what else changes *before* unlocking.
Correction history shows old and new values side by side.

**What it refuses.** Unlock demands a reason code and an initiator who is not the
approver (§7.6.26). The person who applied the correction cannot re-verify it.
A correction that changes nothing is refused.

---

## §12.12 · Standings and progression

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Standings & progression                                              §12.12    │
│ EVENT [ Team Kabaddi Men ▾ ]                              [ Recompute now ]    │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ LEAGUE POINTS │ METRIC        │ GROUPS      2 │ QUALIFIED                   4  │
│ 2 / 1 / 0     │ Score Diff    │ 10 row(s)     │ flagged Q once decided         │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ Group G1                                                                       │
│ │# │TEAM             │UNIT│P│W│D│L│Pts│For│Ag │Diff│Q/E│TIE-BREAK              │
│ │1 │Maharashtra Men  │MH  │4│4│0│0│ 8 │ 85│ 73│ 12 │ Q │                       │
│ │2 │Karnataka Men    │KA  │4│2│1│1│ 5 │ 66│ 57│  9 │ Q │                       │
│ │3 │Uttar Pradesh Men│UP  │4│2│0│2│ 4 │ 63│ 57│  6 │ E │                       │
│ │4 │Kerala Men       │KL  │4│1│1│2│ 3 │ 76│ 83│ -7 │ E │                       │
│ │5 │Delhi Men        │DL  │4│0│0│4│ 0 │ 73│ 93│-20 │ E │                       │
│ Group G2                                                                       │
│ │1 │Rajasthan Men    │RJ  │4│3│0│1│ 6 │ 90│ 63│ 27 │ Q │separated on Head-to-  │
│ │  │                 │    │ │ │ │ │   │   │   │    │   │head result            │
│ │2 │Haryana Men      │HR  │4│3│0│1│ 6 │ 70│ 69│  1 │ Q │separated on Head-to-  │
│ │3 │Punjab Men       │PB  │4│3│0│1│ 6 │ 72│ 67│  5 │ E │head result            │
├────────────────────────────────────────────────────────────────────────────────┤
│ Tie-breaker hierarchy   applied strictly in this order. If every rung is       │
│                         exhausted the row says so and demands a recorded       │
│                         draw of lots (§7.5.22)                                 │
│  1. League points   2. Head-to-head result (counted only among the sides still │
│  tied)   3. Score difference   4. Total points scored   5. Matches won         │
│  6. Fewer cards (fair play)   7. Draw of lots (last resort; outcome and at     │
│  least two witnesses are recorded)                                             │
├────────────────────────────────────────────────────────────────────────────────┤
│ Progression tracker   a result Under Protest freezes only its own bracket path │
│ ✓ Every progression slot is filled                                             │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** The **tie-break column** is the point of this screen. Three
sides on six points in G2, separated on head-to-head, and each row says so — a
Team Manager can see why they finished third without asking anyone. The
hierarchy is printed underneath, read from the sport template. The progression
tracker lists any pending slot with what it is waiting on and why.

**What it refuses.** Nothing to refuse — there is no editing. §7.5.21 says points
tables are never manually edited, and there is no setter for a standings row
anywhere in the codebase. "Recompute now" re-derives from the approved results.

---

## §12.13 · Medal management

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Medal management                                                     §12.13    │
│ EVENT [ Team Kabaddi Men ▾ ]        ( Medal rule: joint-bronze )  ● Published   │
├────────────────────────────────────────────────────────────────────────────────┤
│ i Joint bronze                                                                 │
│   Both losing semi-finalists take bronze and no bronze play-off is held. This   │
│   comes from the Kabaddi sport template, not from the medal code (§7.5.24).    │
├────────────────────────────────────────────────────────────────────────────────┤
│ ✓ Verification checklist passed                                                │
│   Every playable fixture has an Approved result, no protest is open, the podium │
│   is complete, and no medallist carries an integrity flag (§7.5.23).           │
├───────────────────────────────────────┬────────────────────────────────────────┤
│ Final ranking                         │ Verification checklist                 │
│ │#│PARTICIPANT      │UNIT│MEDAL │JOINT│  ✓ Every playable fixture has an       │
│ │1│Maharashtra Men  │MH  │●Gold │     │    Approved result                     │
│ │2│Karnataka Men    │KA  │●Silver│    │  ✓ No protest is open on this event    │
│ │3│Haryana Men      │HR  │●Bronze│joint│ ✓ The podium is complete for the      │
│ │3│Rajasthan Men    │RJ  │●Bronze│joint│   medal rule                          │
│                  [ Verify & publish… ]│  ✓ No medallist carries a doping or    │
│                                       │    DQ flag                             │
│                                       ├────────────────────────────────────────┤
│                                       │ Medal tally                            │
│                                       │ 1  MH  1  0  0  1                      │
│                                       │ 2  KA  0  1  0  1                      │
│                                       │ 3  HR  0  0  1  1                      │
│                                       │ 3  RJ  0  0  1  1                      │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**What is live.** The checklist is the engine's own verification result, fetched
read-only — rendering this screen never writes. Joint bronze shows two rows at
position 3, both flagged. The tally shares rank 3 between units level on medals.

**What it refuses.** Publish appears only when the checklist passes, and
publishing prompts for the verifying Technical Official's ID, refusing if it
matches the approver (maker–checker on medals too). The blockers are listed by
name:

```
  ✕  M22 result is Verified, not Approved (§7.5.23)
  ✕  M20 is Under Protest; medals cannot be published while a protest is open
  ✕  Maharashtra Men would take G but carries an open flag: doping sample B pending
  ✕  M23 (F) still has an unresolved side "Winner of M21"
```

---

## §12.14 · Protest and exception register

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Protest & exception register                                         §12.14    │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ OPEN PROTESTS │ UPHELD      0 │ REJECTED    0 │ EXCEPTIONS LOGGED           1  │
│ 1  Frozen     │               │               │ 1 distinct scenario            │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ ✕ Open protests freeze their bracket path (§7.4.19)                            │
│   PRT-0001 on M13: Substitution made after the two-minute suspension expired… │
├────────────────────────────────────────────────────────────────────────────────┤
│ Protests                                                                       │
│ ┃PRT-0001│M13│TN│10 Mar 16:02│Substitution…│5000│●Filed│—│—│[Rule…]           │
├────────────────────────────────────────────────────────────────────────────────┤
│ Exception log                                                                  │
│ │EXC-000001│●walkover│M04│CONCEDED│Karnataka conceded…│to1 (Technical Official)│
├────────────────────────────────────────────────────────────────────────────────┤
│ The exception playbook   all fourteen rows of §8, with the count in this        │
│                          tournament                                            │
│ │1 │Walkover        │One side concedes before the start│…│Tech Official│ 1     │
│ │2 │No-show         │Absent at the deadline           │…│Tech Official│ 0     │
│ │3 │Disqualification│Conduct, doping, ineligibility…   │…│Tech/Jury    │ 0     │
│ …                                                                              │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** The playbook table is the §8 reference with a live count per
scenario, so an Admin can see at a glance what has gone wrong in this
tournament. A Team Manager with an open protest window gets a filing panel with
the countdown.

**What it refuses.** Filing outside the window, or with an underpaid fee, or
without grounds. A ruling must be recorded in writing. Only the Jury, a Technical
Official or an Admin may rule.

---

## §12.15 · Reports hub

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Reports hub                                                          §12.15    │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ AVAILABLE  14 │ EXTERNAL    7 │ INTERNAL    7 │ ROWS IN PREVIEW            10  │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ Catalogue                                                                      │
│ │1 │Fixture / Draw report │Official draw publication │●Published│(event)│PDF…  │
│ │8 │Points table/standings│Group/league position     │●Published│(event)│PDF…  │
│ │13│Audit trail extract   │Compliance / dispute      │●Draft    │(tournament)  │
├────────────────────────────────────────────────────────────────────────────────┤
│ Points table / standings                  [Download CSV] [Print / save as PDF] │
│ EVENT [All events ▾]  PROVISIONAL [Approved data only ▾]      [Apply filters]  │
│                                                                                │
│ i Notes                                                                        │
│   Team Kabaddi: metric is Score Diff; tie-breakers apply strictly in order —   │
│   1. League points, 2. Head-to-head result, 3. Score difference, … (§7.5.22)   │
│                                                                                │
│ │Team Kabaddi│G1│1│Maharashtra Men│MH│4│4│0│0│8│85│73│12│0│Q│                  │
├────────────────────────────────────────────────────────────────────────────────┤
│ i Every export is logged                                                       │
│   These are controlled documents, so each export writes an audit entry         │
│   recording who ran which report, in which format, and when (§5.8).            │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** The catalogue is filtered to what the acting role may run. The
preview renders the real dataset. CSV downloads with RFC-4180 quoting; "Print /
save as PDF" opens print-ready HTML and uses the browser's own print-to-PDF, so
the module needs no PDF dependency. Each report's notes carry its caveats — which
tie-breakers applied, which data was excluded and why.

**What it refuses.** A Viewer asking for the audit extract gets *"Viewer may not
run the 'audit-extract' report (§10)"*. The provisional-data toggle appears only
for internal reports (§5.8).

---

## §12.17 · Audit log viewer

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Audit log                                                            §12.17    │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ ENTRIES   353 │ ENTITY TYPES 9│ ACTIONS    28 │ REASON-CODED ACTIONS       31  │
│ Scoped to this│ tournament,   │               │ terminal, exception, override  │
│ tournament    │ event, entry… │               │                                │
├────────────────────────────────────────────────────────────────────────────────┤
│ i Append-only by construction                                                  │
│   There is no edit or delete control on this screen because the store exposes  │
│   no such operation: the audit table is insert-and-select only, so the rule is │
│   enforced structurally rather than by policy (§7.6.27).                       │
├────────────────────────────────────────────────────────────────────────────────┤
│ Filters  ENTITY TYPE [All ▾]  ACTION [All ▾]  ENTITY ID [ ]  [Filter] [Clear] │
├────────────────────────────────────────────────────────────────────────────────┤
│ │10 Mar 17:04│R. Kulkarni│Admin│medals.publish │medals│EVT-0001│  │[…]│       │
│ ┃10 Mar 16:31│R. Kulkarni│Admin│entry.override │entry │ENT-0020│…│…│LATE_ENTRY│
│ │10 Mar 15:31│N. Joshi   │Scorer│result.enter  │result│RES-0014│  │…│         │
├────────────────────────────────────────────────────────────────────────────────┤
│ Action frequency                                                               │
│ │result.enter   │23│[Filter]│   │draw.generate │ 2│[Filter]│                   │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** Filters by entity type, action and entity ID. Reason-coded rows
get a left rule and the code as a badge, so the exceptional actions stand out.
Action frequency doubles as a filter shortcut.

**What it refuses.** Everything — it is read-only by construction. Visibility is
scoped by role per §3.2: Super Admin sees everything, Tournament Admin their
tournament, Competition Manager their sport, Technical Official their matches.

---

## §12.18 · Role and access management

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Role & access management                                             §12.18    │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ ROLES      10 │ FUNCTIONS  17 │RECONCILIATIONS│ USERS                      97  │
│               │               │ 4             │ 9 distinct roles in use        │
├────────────────────────────────────────────────────────────────────────────────┤
│ i Legend                                                                       │
│   C create · E edit · A approve · P publish · L lock/unlock · V view · — none  │
│   A parenthesis narrows the grant, e.g. "C (own-entries)". A named verb —      │
│   verify, recommend, unlock, rule — is the matrix's own wording. An amber cell │
│   is one this build had to reconcile.                                          │
├────────────────────────────────────────────────────────────────────────────────┤
│ Permission matrix                                                              │
│ │FUNCTION            │Super Admin│Tournament Admin│Competition Mgr│…           │
│ │Tournament creation │CEAPL      │CEP             │V              │…           │
│ │Sport/discipline cfg│CE         │CE              │▓EC reconciled▓│…           │
│ │Result approval&lock│L          │AL              │▓V+recommend▓  │…           │
├────────────────────────────────────────────────────────────────────────────────┤
│ Reconciliations against the phase tables                                       │
│ Competition Manager — sport.config                                    +C       │
│  Matrix says      §3.2 grants Competition Manager only "E" on Sport/…         │
│  Phase table says §2.1–2.6 assign "Add sport(s)", … to the Competition Manager │
│  Call made        Phase 2 cannot run without create rights. Without this, no   │
│                   event can exist and the Phase 2 gate is unreachable.         │
├────────────────────────────────────────────────────────────────────────────────┤
│ Structural rule applied to the whole matrix                                    │
│  Rule   Any of C, E, A, P or L implies V                                       │
│  Why    §3.2 lists Tournament Admin as "A P" on draw generation with no V.     │
│         Read literally, an Admin could not open the draw they must approve.    │
│  Scope  Applied once as a notation rule. It never widens access: a role with   │
│         no cell at all still has none.                                         │
└────────────────────────────────────────────────────────────────────────────────┘
```

**What is live.** The matrix is the enforced one, with reconciled cells
highlighted in amber and each reconciliation expanded below with both citations
and the call made. This is the screen a Business Analyst uses to check the
implementation's judgement calls without reading code.

---

## §12.20 · Public / viewer portal

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ National Kabaddi Championship 2026                                   §12.20    │
│ Pune · 2026 · organised by Amateur Kabaddi Federation of India                 │
├────────────────────────────────────────────────────────────────────────────────┤
│ i Published data only                                                          │
│   This portal shows what has been published: fixtures, live scores, approved    │
│   and published results, standings and the medal tally. Draws in draft,        │
│   unapproved results and anything held under protest do not appear (§7.6.25).  │
├───────────────┬───────────────┬───────────────┬────────────────────────────────┤
│ EVENTS      2 │ LIVE NOW    1 │ RESULTS    24 │ MEDALS AWARDED              4  │
├───────────────┴───────────────┴───────────────┴────────────────────────────────┤
│ Live now                                                                       │
│ │M13│Team Kabaddi Women│V1-MAT-2│Gujarat Women v Haryana Women│● LIVE│         │
├────────────────────────────────────────────────────────────────────────────────┤
│ Fixtures & results     DAY [ 2026-03-10 ▾ ]                                    │
│ │2026-03-10│09:15│M01│Team Kabaddi Men│group│MAT-1│UP v Kerala│26–21│● Final│  │
│ │2026-03-10│12:15│M04│Team Kabaddi Men│group│MAT-1│KA v UP    │ —   │●Walkover│
│ │2026-03-11│14:15│M21│Team Kabaddi Men│SF   │MAT-1│MH v RJ    │31–28│● Final│  │
├───────────────────────────────────────┬────────────────────────────────────────┤
│ Medal tally                           │ Medallists                             │
│ │1│MH│1│0│0│1│                        │ │Team Kabaddi Men│●Gold  │MH│         │
│ │2│KA│0│1│0│1│                        │ │Team Kabaddi Men│●Silver│KA│         │
│ │3│HR│0│0│1│1│                        │ │Team Kabaddi Men│●Bronze│HR│joint    │
│ │3│RJ│0│0│1│1│                        │ │Team Kabaddi Men│●Bronze│RJ│joint    │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**What is live.** Only published data reaches this screen, and it is filtered
server-side — the payload for a Viewer contains no unpublished result at all,
rather than the client hiding them. The status column follows the **result**, not
the match: see [gap 6](03-gap-analysis.md#6--match-status-never-advances-past-completed-provisional). A walkover shows as a walkover with
no score, per the Kabaddi convention.

---

## Design decisions worth naming

**Dark by default.** A scorer's console lives at a venue, often in low light on a
laptop beside a mat. Light mode follows the system setting.

**Status is never colour alone.** Every badge carries its own text, and flagged
table rows get a left rule as well as a tint. Colour is a second signal, never
the only one.

**Every screen cites its section.** A small monospace reference next to each
title and in the sidebar, so the console and the functional document can be read
together during review.

**Refusals are the product.** The most important text on most of these screens is
the message explaining why something cannot be done, with the rule that says so.
A generic "invalid request" would make the governance the document specifies
invisible. Every server rejection carries its section reference and surfaces
verbatim.

**Gates render as checklists.** A blocked action shows what is satisfied and what
is not, so the next step is obvious without asking anyone.

**Dense tables, not cards.** This is an operations tool. A Venue Manager scanning
a run sheet wants forty rows on screen, not eight cards.
