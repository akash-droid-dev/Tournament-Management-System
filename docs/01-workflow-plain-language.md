# The TMS workflow in plain language

Every step of the functional document, in ordinary words, with what actually
happens in the system underneath. Section numbers refer to the *TMS Functional
Workflow Document v1.0*.

---

## What this module is for, in one paragraph

A tournament is a long chain of decisions where each one depends on the last.
You cannot draw a bracket before you know who entered. You cannot know who
entered until you know the events. You cannot start a match until someone has
been assigned to referee it. And once a result is signed off, a great deal —
the points table, who plays whom next, who gets a medal — follows from it
automatically, so the result had better be right.

TMS is the machine that keeps that chain honest. It does not own the athletes or
the venues; other parts of the Games Management System do. What it owns is the
competition: the gates between each step, who may open each gate, and a record
of everyone who opened one.

---

## The ten phases as tiles

Each tile is a phase. The line under it is the **gate** — the condition that
must be true before the next tile can begin.

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ 1  TOURNAMENT        │  │ 2  SPORT & EVENTS    │  │ 3  ENTRIES           │
│    CREATION          │→ │    CONFIGURATION     │→ │    (registration     │
│                      │  │                      │  │     mapping)         │
│ Name it, date it,    │  │ Add Kabaddi, add the │  │ Team Managers pick   │
│ set the rules        │  │ events, attach rules │  │ from an approved pool│
├──────────────────────┤  ├──────────────────────┤  ├──────────────────────┤
│ GATE status =        │  │ GATE ≥1 event        │  │ GATE entries locked  │
│ Configured           │  │ confirmed + template │  │ + minimum met        │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
                                                               │
        ┌──────────────────────────────────────────────────────┘
        ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ 4  FORMAT SETUP      │  │ 5  DRAW GENERATION   │  │ 6  SCHEDULE &        │
│                      │→ │                      │→ │    OFFICIALS         │
│ Knockout? Groups?    │  │ Seeds, byes, a       │  │ When, which mat,     │
│ How do teams advance │  │ recorded random draw │  │ and who officiates   │
├──────────────────────┤  ├──────────────────────┤  ├──────────────────────┤
│ GATE format approved │  │ GATE draw published  │  │ GATE schedule        │
│ by the Admin         │  │ (validation clean)   │  │ published + panel    │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
                                                               │
        ┌──────────────────────────────────────────────────────┘
        ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ 7  MATCH OPERATIONS  │  │ 8  RESULTS,          │  │ 9  MEDALS &          │
│    (match day)       │→ │    STANDINGS,        │→ │    RANKINGS          │
│                      │  │    PROGRESSION       │  │                      │
│ Check in, toss,      │  │ Enter → verify →     │  │ Who won what, and    │
│ score, sign off      │  │ approve → LOCK       │  │ nothing published    │
│                      │  │                      │  │ until it is clean    │
├──────────────────────┤  ├──────────────────────┤  ├──────────────────────┤
│ GATE match complete  │  │ GATE all results     │  │ GATE checklist       │
│ or ruled             │  │ approved             │  │ passes               │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
                                                               │
        ┌──────────────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 10  REPORTS & CLOSURE                                                    │
│     Produce the record pack, close every open item, lock the tournament,  │
│     archive it so it can seed the next edition                            │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why gates matter.** Without them, a tournament goes wrong quietly. Someone
draws a bracket while entries are still open, then two more people build a
schedule on that bracket, and the error surfaces on match day. A gate turns that
into an immediate, explained refusal: the screen shows a checklist of what is
missing, not a bare "not ready".

In the code, every gate is a function in `src/workflow/phases.ts` that returns
the reasons it is *not* satisfied. The UI renders that list directly.

---

## Phase 1 — Creating the tournament

**In plain words:** somebody writes down what this competition is. Its name and
code, who is running it, what level it is (school up to international), when it
starts and ends, where, which units are taking part, and — importantly — the
rules that will be argued about later.

### The steps (§1.1–1.6)

| Step | What happens | Why it matters later |
| --- | --- | --- |
| 1.1 | Open the creation wizard; the tournament starts as **Draft** | Nothing is visible to anyone yet |
| 1.2 | Basic details: name, code, body, level, season, dates, host city | The code must be unique — two tournaments with one code is an audit nightmare |
| 1.3 | Scope: age groups, gender categories, participating units, max entries per unit | This becomes the quota the eligibility engine enforces |
| 1.4 | **Rules**: entry deadline, withdrawal deadline, protest window and fee, approval chain depth, walkover policy, minimum entries to run an event | Every one of these is a decision someone will contest. Settling them now means the system can point at a stored value instead of a person's memory |
| 1.5 | Assign the tournament team: Competition Managers per sport, Venue Managers, admin staff | A Competition Manager must exist before entries open, or nobody can approve an entry |
| 1.6 | Submit for activation → validation runs → status becomes **Configured** | The first gate |

### The one field people miss: the category cut-off date

An under-17 event does not mean "under 17 today". It means "under 17 on a
specific date". If the system used today's date, the same athlete would be
eligible in March and ineligible in April, and two clerks entering the same
athlete a week apart would get different answers.

So the tournament stores a **category cut-off date**, and every age check is
computed against it (§7.1.2). `ageOnCutOff()` in `src/engines/eligibility.ts` is
eleven lines long and prevents an entire class of dispute.

### What the validation actually checks (§5.1)

```
✓ end date is on or after the start date
✓ entry deadline falls before the start date
✓ withdrawal deadline is on or after the entry deadline
✓ organizing body exists in the GMS master
✓ tournament code is unique
✓ at least one sport is intended
✓ at least one Competition Manager is assigned
✓ a category cut-off date is set
✓ protest window and fee are configured
```

Fail any one and the tournament stays Draft with that line shown in red.

---

## Phase 2 — Setting up the sport and its events

**In plain words:** a tournament is not one competition, it is several. "Kabaddi"
is a sport; "Senior Men's Team Kabaddi" is an event. Each event gets its own
entries, its own format, its own draw, its own medals.

### The steps (§2.1–2.7)

| Step | What happens |
| --- | --- |
| 2.1 | Add the sport from the GMS sport master |
| 2.2 | Add disciplines or events within it |
| 2.3 | Set the participation type — individual, team, pair, relay, mixed |
| 2.4 | Apply classifications — weight categories, age bands, gender, para-class |
| 2.5 | **Attach a scoring template** — how points work, how ties break |
| 2.6 | Set entry limits per unit, the seeding source, the reserve policy |
| 2.7 | The Tournament Admin **confirms** the catalogue; new events after this need Admin approval |

### The scoring template is the whole trick

The document's fifth design principle is "sport-configurable, not
sport-hardcoded". This is where that is paid for. A scoring template says:

- **Match shape** — Kabaddi: two halves of twenty minutes with a five-minute
  interval.
- **How points are scored** — raid points, bonus points, tackle points, all-outs,
  technical points, and what each is worth.
- **League points** — win, tie, loss, and whether there is a losing bonus.
- **Tie-breakers, in order** — points, head-to-head, score difference, points
  scored, matches won, fair play, then a draw of lots.
- **Officials panel** — who must be present, and the minimum before a match may
  start.
- **Medal rule** — for Kabaddi, joint bronze: both losing semi-finalists take a
  medal and there is no bronze play-off.
- **Rest gap** — the minimum time between a side's matches.
- **Walkover convention** — what result is created when nobody plays.

Everything downstream reads from that template. Nothing in the draw, schedule,
standings or medal code contains the word "raid".

### Which numbers you must confirm before going live

Some of the values above are rules of play and will not change. Others are set
by a federation and revised periodically. The Sport & Event Setup screen marks
the second kind, and so does the code:

| Marked | Meaning | Examples |
| --- | --- | --- |
| `rule-of-play` | Structural; will not change | Seven on the mat, an all-out is worth two, a bonus needs six defenders, the do-or-die raid |
| `configurable-default` | A starting value your federation must confirm | Weight limits, age bands, league point values, half length for juniors, rest gaps, the walkover convention |

---

## Phase 3 — Entries

**In plain words:** Team Managers say who is coming. The system's job is to stop
anyone entering who should not be there, and to explain why when it does.

### The steps (§3.1–3.7)

| Step | What happens |
| --- | --- |
| 3.1 | The entry window opens; Team Managers are notified |
| 3.2 | The system pulls the eligible pool — **only** records another module has marked Approved, with valid accreditation |
| 3.3 | The Team Manager selects athletes or teams, with coaches and support staff |
| 3.4 | **The eligibility engine runs, in real time, on every entry** |
| 3.5 | Failures are shown with the reason; they can be corrected, escalated, or overridden by a Tournament Admin with a reason code |
| 3.6 | On the deadline, entries **freeze**; late entries need Admin approval and leave an audit entry |
| 3.7 | Event-wise entry lists are generated — the basis for the draw |

### What the eligibility engine checks, and the hard/soft split

This distinction matters more than it looks. A **hard** failure blocks the entry.
A **soft** failure warns and lets it through. Getting this wrong in either
direction is costly: too hard and a clerk cannot enter a legitimate athlete; too
soft and an ineligible one reaches a draw.

```
HARD — the entry is blocked                    SOFT — advisory only
──────────────────────────────                 ──────────────────────────────
✗ not Approved upstream                        ⚠ cross-event clash: this athlete
✗ open doping flag                               is in another event whose
✗ accreditation missing or expired               session may overlap
✗ age outside the band on the cut-off date     ⚠ no declared weight — will be
✗ gender does not match the event                confirmed at the weigh-in
✗ declared weight over the limit               ⚠ declared weight within limit,
✗ already entered in this event                  but still provisional
✗ unit quota already full                      ⚠ squad larger than the maximum —
✗ over the cross-event limit                     can be trimmed at check-in
✗ squad below the minimum on the mat
```

Two of those deserve a note:

**Weight is provisional until the weigh-in.** A declared weight is a claim. The
real check happens at the official weigh-in, and a failure there means a scratch
or a category move — a decision, not a silent acceptance (§7.1.5).

**A cross-event clash cannot be hard at entry time.** Sessions are not known
until Phase 6, so at Phase 3 the system can only say "this may clash". Blocking
on a maybe would be wrong.

### The override path

A hard failure is not the end. A Tournament Admin — and only a Tournament Admin
— can override it, and only with a reason code that is written to the audit log
against their name (§7.1.4). The Entry Management screen shows blocked entries
as an **override queue**, so nothing sits invisibly refused.

---

## Phase 4 — Choosing the format

**In plain words:** how will this event be decided? Straight knockout? Everyone
plays everyone? Groups first and then a knockout? And however it is decided, how
do teams get from one stage to the next?

### The steps (§4.1–4.6)

| Step | What happens |
| --- | --- |
| 4.1 | Pick the format — knockout, league (single or double), groups + knockout, pools, qualification + finals, repechage, heats–semis–finals |
| 4.2 | Define the stage structure — how many groups, how many per group, one meeting or home and away |
| 4.3 | Define progression — "top two per group into the semi-finals", group winners kept apart |
| 4.4 | Set match parameters — duration, periods, tie-break mode, points per result |
| 4.5 | **Validate the format against the entry count** |
| 4.6 | The Tournament Admin approves; the format then locks |

### The validation is arithmetic, and it catches real mistakes

```
For a knockout of 12 entries:
  bracket size  = next power of two ≥ 12  = 16
  byes          = 16 − 12                 = 4
  fixtures      = 16 − 1                  = 15
  rounds        = log₂(16)                = 4

For 2 groups of 5, top 2 advancing:
  group capacity = 2 × 5 = 10  vs  10 entered      ✓
  group fixtures = 2 × (5×4/2) = 20
  qualifiers     = 2 × 2 = 4  → a bracket of 4      ✓ no byes needed
```

The Format Builder recomputes this on every keystroke. A configuration that
leaves teams with nowhere to go — a group stage with no progression rule, groups
too small to hold the entries, an odd number of qualifiers — is refused with the
sum shown, not a generic error.

### Once the draw is published, the format is frozen

Changing a format after a draw exists invalidates the draw. So §7.2.7 locks it:
a change forces a formal redraw with Admin approval and republication. The
Format Builder greys itself out and says so.

---

## Phase 5 — The draw

**In plain words:** decide who plays whom. This is the step most likely to end up
in a dispute, so it is the step built most carefully.

### The steps (§5.1–5.6)

| Step | What happens |
| --- | --- |
| 5.1 | Configure the parameters — how many seeds, separation rules, bye policy |
| 5.2 | **Run the auto-draw** |
| 5.3 | **Validate it** |
| 5.4 | Manual adjustment, allowed only while the draw is a draft, every swap logged |
| 5.5 | Optionally conduct a public draw ceremony, with the sequence recorded |
| 5.6 | The Tournament Admin approves and **publishes**; notifications fire |

### How the auto-draw works

```
STEP 1  Place the seeds at conventional bracket positions
        A bracket of 8 has seed order  1, 8, 4, 5, 2, 7, 3, 6
        so seed 1 is in the top half and seed 2 in the bottom half,
        and they can only meet in the final.

STEP 2  Allocate the byes
        Byes go to the positions facing the strongest seeds, which is
        what "byes to the top seeds" means in slot terms.

STEP 3  Draw the unseeded entries into what is left
        Using a SEEDED random generator, so the draw can be replayed.

STEP 4  Apply the separation rules
        Two sides from one unit should not meet in round 1. If they do,
        swap an unseeded entry until they do not — moving only unseeded
        entries, so the seeding stays intact.
```

### The bit that settles arguments: reproducibility

§7.2.9 requires that a seeded random draw stores its seed so the draw can be
reproduced for dispute resolution. Two details make that actually true:

1. **`Math.random()` is never used in draw code.** It cannot be replayed. The
   draw uses a deterministic generator seeded from a stored string.
2. **The algorithm identifier is stored alongside the seed.** A seed is useless
   if the generator changes. The Draw Console has a **Verify reproducibility**
   button that regenerates from the stored seed and confirms the slot map is
   identical — and refuses to claim reproducibility if the build's algorithm no
   longer matches the one that produced the draw.

### The validation gate — any error rejects the draw

```
✗ a duplicate pairing anywhere in the draw
✗ a participant in two fixtures of the same round
✗ an entry occupying more than one slot
✗ a bye outside round one
✗ a bye count that does not equal bracket size minus entries
✗ a progression placeholder pointing at a fixture that does not exist
✗ a dead end — a non-final fixture with nowhere to progress to
```

### After publication, there are no quiet edits

A published draw changes only through the formal redraw path: a reason-coded
amendment with Admin approval and republication. The console will not offer a
swap on a published draw.

---

## Phase 6 — Schedule and officials

**In plain words:** when does each match happen, on which mat, and who runs it?
This is the phase where a mistake is most visible, because it means two teams
turning up to the same mat at the same time.

### The steps (§6.1–6.8)

| Step | What happens |
| --- | --- |
| 6.1 | The Venue Manager defines the inventory — venues, mats, operating hours, maintenance windows |
| 6.2 | Build the time grid — session blocks, match duration plus buffer, warm-up |
| 6.3 | **Auto-schedule** the fixtures |
| 6.4 | **Conflict check** |
| 6.5 | Assign officials from the Officials module pool |
| 6.6 | **Official conflict validation** |
| 6.7 | The Tournament Admin publishes the schedule and duty roster; notifications fire |
| 6.8 | Rescheduling, when it is needed, re-runs every check |

### Hard versus soft, again — and this time it gates publication

```
HARD — blocks publishing                       SOFT — must be acknowledged
──────────────────────────────                 ──────────────────────────────
✗ the same mat double-booked                   ⚠ rest gap below the recommended
✗ a side in two overlapping fixtures             (but above the hard minimum)
✗ an official double-booked                    ⚠ a side in two events in one
✗ round order broken                             session
✗ outside venue operating hours                ⚠ an official without the travel
✗ inside a maintenance window                    buffer between two venues
✗ a rest gap below the sport's hard minimum    ⚠ a unit made to hop venues in a
✗ a playable fixture left unscheduled            single day
```

A soft conflict does not block, but §7.2.11 requires an **explicit
acknowledgment** — not silence. The Scheduling Board lists them with an
"Acknowledge all" button and will not offer Publish until they are cleared.

### "Round order" is subtler than it looks

The obvious rule is that a quarter-final cannot start before the round-one match
that feeds it. But a semi-final fed by a **group table** has a harder
constraint: it cannot start until *every* match in that group has finished,
because until then nobody knows who qualified.

Checking only direct feeders misses this entirely — and did, during development,
scheduling semi-finals against their own group stage. Both the scheduler and the
conflict detector now require the whole feeding group to be complete.

### How officials are filtered

```
The pool (from the Officials module)
        │
        ├─ qualified for this sport?                    → no: refused
        ├─ certified for this seat?                     → no: refused
        ├─ grade meets the seat requirement?            → no: refused
        ├─ accreditation valid on the match date?       → no: refused
        ├─ available on that date?                      → no: refused
        ├─ from a unit playing this match?              → yes: refused
        │     (neutrality — configurable per level)
        ├─ already on duty at that time?                → yes: refused
        ├─ enough travel buffer between venues?         → no: refused
        └─ under the per-day cap?                       → no: refused
        │
        ▼
   ranked by freshness and grade, best first
```

The Officials Board shows the **refusals**, not just the successes. A
Competition Manager needs to tell a pool gap ("nobody is certified for this
seat") from a rule block ("everyone qualified is from a competing unit").

### A match cannot start understaffed

§7.3.15: a match must meet its sport's minimum officials template before it can
move to Check-in. For Kabaddi that is one referee, two umpires and a scorer. The
match console's Open button is disabled with the missing seats listed.

---

## Phase 7 — Match day

**In plain words:** the match actually happens. Someone confirms who turned up,
the referee tosses, someone records the score as it goes, and at the end the
referee signs off.

### The steps (§7.1–7.8)

| Step | When | What happens |
| --- | --- | --- |
| 7.1 | T−60 | The Scorer opens the console; status **Scheduled → Check-in** |
| 7.2 | T−30 | Attendance and line-up; accreditation verified; the no-show timer starts |
| 7.3 | T−10 | Toss recorded — in Kabaddi the winner picks the court or the right to raid first |
| 7.4 | T−0 | The referee starts the match; status **→ Live** |
| 7.5 | live | Score entry, point by point, validated as it is entered |
| 7.6 | as needed | In-match exceptions — suspension, injury retirement, disqualification, abandonment |
| 7.7 | full time | Status **→ Completed (Provisional)**; the referee digitally signs the match report |

### The match status machine (§6.2)

```
                    ┌─────────────┐
                    │  Scheduled  │
                    └──────┬──────┘
          ┌────────────────┼────────────────┬──────────────┐
          ▼                ▼                ▼              ▼
    ┌──────────┐    ┌─────────────┐   ┌──────────┐   ┌──────────┐
    │ Check-in │    │  Postponed  │   │Cancelled │   │ Walkover │
    └────┬─────┘    └──────┬──────┘   └──────────┘   └──────────┘
         │                 │            terminal        terminal
         │                 └──► back to Scheduled
    ┌────┴─────┬──────────────┬─────────────┐
    ▼          ▼              ▼             ▼
┌────────┐ ┌──────────┐  ┌──────────┐  (Postponed)
│  Live  │ │ Walkover │  │ ...      │
└───┬────┘ └──────────┘  └──────────┘
    │
    ├──────────────┬────────────────┬──────────────────┐
    ▼              ▼                ▼                  ▼
┌────────────┐ ┌───────────┐  ┌───────────┐  ┌──────────────────┐
│ Completed  │ │ Suspended │  │ Abandoned │  │  Disqualified    │
│(Provisional)│ └─────┬─────┘  └───────────┘  └──────────────────┘
└────────────┘       │         terminal/replay      terminal
  result lifecycle   └──► back to Live (resume)
  takes over
```

**Two rules run through the whole machine.** Every terminal or exception status
requires a **reason code**. And every transition writes an audit entry — no
exceptions, no configuration to turn it off.

### Kabaddi scoring, as the console sees it

A Kabaddi match is a sequence of raids that alternate between the sides. Each
raid ends one of four ways:

| The Scorer presses | What happened | Effect |
| --- | --- | --- |
| **Raid touch** | The raider touched one or more defenders | One point per defender; those defenders go off the mat; the raid ends |
| **Bonus** | The raider crossed the bonus line | One point — but only if six or more defenders are on the mat |
| **Empty raid** | Nothing happened | No points. Two in a row and the next one is do-or-die |
| **Tackle** | The defenders stopped the raider | One point to the defence, or **two** if only three or fewer defenders were on the mat |

Four things the engine derives on its own, so the Scorer cannot get them wrong:

1. **All-out.** When a side is reduced to nobody on the mat, the opponents get
   two extra points and the emptied side brings its full complement back on.
2. **Revival.** When a side scores, one of its out players comes back, in the
   order they went out. A **bonus point does not revive** — a genuine Kabaddi
   rule that is easy to get wrong by hand.
3. **Super tackle.** A tackle with three or fewer defenders on the mat is worth
   two, not one. The engine upgrades it, so pressing "Tackle" can never
   under-award.
4. **Do-or-die.** After two consecutive empty raids, the third must produce a
   point or the raider is out and the defence scores.

### Impossible scores are refused as they are typed

§7.4.16 requires real-time validation. In practice:

```
✗ "touched 5 defenders" when only 3 are on the mat
✗ a bonus when fewer than 6 defenders are on the mat
✗ a raid point credited to the defending side
✗ a super tackle when the defence is not short-handed
✗ an all-out or a revival entered by hand (the engine derives those)
✗ a clock that moves backwards
```

The console shows the refusal as a message naming the rule, and the score does
not change.

---

## Phase 8 — Results

**In plain words:** the score becomes official. This is the most governed step in
the whole system, because everything downstream trusts it.

### The chain

```
  Scorer                Technical Official        Team Manager       Tournament Admin
    │                          │                       │                    │
    ▼                          │                       │                    │
┌─────────┐                    │                       │                    │
│ ENTERED │───────────────────► │                       │                    │
└─────────┘   cross-check      ▼                       │                    │
              against the  ┌──────────┐                │                    │
              signed sheet │ VERIFIED │                │                    │
                           └────┬─────┘                │                    │
                 mismatch?      │    protest window    │                    │
                 back to the    │    (configurable,    │                    │
                 Scorer with    │     e.g. 30 min) ────►│                    │
                 remarks        │                       │                    │
                                │                  protest filed?           │
                                │                       │                    │
                                │              ┌────────▼────────┐          │
                                │              │  UNDER PROTEST  │          │
                                │              └────────┬────────┘          │
                                │                  Jury rules              │
                                │              upheld → amend/replay        │
                                │              rejected → fee forfeited     │
                                │                       │                    │
                                └───────────────────────┴───────────────────►│
                                                                             ▼
                                                                  ┌──────────────────┐
                                                                  │ APPROVED + LOCKED│
                                                                  └────────┬─────────┘
                                                                           │
                                                  ┌────────────────────────┼──────────────────┐
                                                  ▼                        ▼                  ▼
                                          winner advances        points recomputed      published
                                          to the next slot       standings re-ranked    + notified
```

### Maker–checker, enforced three times

The rule (§7.4.17) is that whoever enters a result can never be its sole
approver. In practice the system enforces three separate separations:

1. The person who **entered** cannot **verify**.
2. The person who **entered** cannot **approve**.
3. On a two-step chain, the person who **verified** cannot **approve** either —
   so three distinct people touch every result.

And for a correction, a fourth separation: whoever made the correction cannot
re-verify it.

### Approval locks — it is not a separate step you might forget

§7.4.18: approved results lock automatically. In the code, approval and lock
happen in the same function call. There is no path that approves without
locking.

### Why approval waits for the protest window

The document says a protest may be filed within a configurable window after the
match. It does not explicitly say approval must wait for that window to close —
but if it does not, a result locks before the teams are allowed to contest it,
and the protest right is worthless.

So approval inside an open window is **refused**, with the remaining minutes
shown. An Admin who genuinely must approve early (a broadcast deadline, a
ceremony) can, but only by recording a reason that goes into the audit log.

### The correction path — the only way back into a locked result

```
1  SOMEONE NOTICES        a Competition Manager or Admin initiates,
                          reason code mandatory
                                   │
2  UNLOCK                 a Tournament Admin or Super Admin approves.
                          The initiator cannot approve their own unlock.
                                   │
3  CORRECT                the change is applied. Old value, new value,
                          reason code and both approvers are stored.
                          The prior verification, approval, lock and
                          publication are all cleared.
                                   │
4  RE-VERIFY              a different Technical Official checks it
                                   │
5  RE-APPROVE             re-locked. Standings, progression and medals
                          recompute. Everything is in the audit trail.
```

The Correction screen shows which later fixtures the change disturbs, before it
is made.

### One protest freezes one path, not the tournament

§7.4.19: a result under protest blocks progression of the affected bracket path
until the protest is ruled; unaffected matches continue. The progression engine
is per-path for exactly this reason — one contested quarter-final does not stop
the other half of the draw.

### The points table is never hand-edited

§7.5.21: points tables recompute automatically on every result approval and
every correction. There is no setter for a standings row anywhere in the
codebase — `computeStandings` is a pure function of the approved results, and
the only way to change a table is to change a result.

### Tie-breakers run strictly in order

For Kabaddi:

```
1  League points
2  Head-to-head result   ← counted only among the sides still tied
3  Score difference
4  Total points scored
5  Matches won
6  Fewer cards (fair play)
7  Draw of lots          ← outcome and at least two witnesses recorded
```

Order matters, and getting it wrong changes who qualifies. A side with a much
better score difference can still finish below a side that beat it
head-to-head — because head-to-head sits above score difference. The system
records **which rung separated each row**, so the Standings screen can explain
any position.

If every rung is exhausted, the row says so and demands a recorded draw of lots
rather than picking silently.

---

## Phase 9 — Medals

**In plain words:** work out who finished where, apply the sport's medal rule,
check nothing is outstanding, and publish.

### The steps (§9.1–9.5)

| Step | What happens |
| --- | --- |
| 9.1 | Generate the final ranking — from the bracket, or from the points table for a pure league |
| 9.2 | Apply the medal rules — gold and silver from the final; bronze from a play-off **or** joint bronze to both losing semi-finalists |
| 9.3 | Verify — DQ and doping flags, protests resolved, names and units against accreditation |
| 9.4 | The Tournament Admin approves and publishes; the Medal Tally module updates |
| 9.5 | The victory ceremony sheet is generated |

### Kabaddi awards joint bronze

Both losing semi-finalists take a bronze and there is no bronze play-off. This
comes from the sport template's `medalRuleDefault`, not from the medal code —
so a sport that does hold a play-off is a configuration change.

### The verification checklist is a gate, not a suggestion

§7.5.23 blocks publication while:

```
✗ any playable fixture in the event has no Approved result
✗ any result is Under Protest
✗ any protest is open
✗ a podium fixture still has an unresolved side
✗ the podium is short of its medal positions
✗ any medallist carries an open doping or DQ flag
```

The Medal Management screen shows the failing items by name. And medal approval
enforces maker–checker too: the Technical Official who verified cannot be the
one who approves.

### One thing the document does not settle

§8 exception 3 says medals are "re-allocated if needed" after a
disqualification, but it does not say how a **joint** medal cascades. Promote a
joint-bronze pair and you have two sides level at silver — which the competition
never produced.

Rather than pick one, the system preserves the tie (inventing no ranking) and
sets a flag demanding an explicit ruling from the Jury or the Tournament Admin
before publication. Federations differ on this; it is a human decision, not a
hardcoded rule.

---

## Phase 10 — Reports and closure

**In plain words:** produce the paperwork, close everything out, lock the
tournament, and file it so the next edition can use it.

### The steps (§10.1–10.4)

| Step | What happens |
| --- | --- |
| 10.1 | Generate the full report pack |
| 10.2 | Resolve open items — every protest closed, every result approved, every exception ruled |
| 10.3 | Close the tournament; status **→ Completed**; data becomes read-only except to Super Admin |
| 10.4 | Archive it; it feeds historical records, athlete performance history, and seeding for future editions |

### What "external" means for a report

§5.8 draws a line that is easy to lose: reports render from **live approved data
only**. Provisional and unpublished data is excluded from external reports;
internal operations reports may include it, flagged as such.

Rather than leaving each of the fourteen renderers to remember that, every
report declares whether it is `external` or `internal`, and the filter is
applied once. And every export writes an audit entry recording who ran which
report, in which format, and when — because these are controlled documents.

---

## The exception playbook

Competitions go wrong. §8 lists fourteen ways and what to do about each. All
fourteen are implemented; each enforces its deciding role, demands a reason
code, and requires a second-role ratification where the action is high-impact.

| # | Scenario | Decided by | Second role needed |
| --- | --- | --- | --- |
| 1 | Walkover | Technical Official | — |
| 2 | No-show (after the timer expires) | Technical Official | — |
| 3 | Disqualification | Technical Official / Jury | **yes**, for a forfeit cascade |
| 4 | Postponed match | Competition Manager proposes | **yes**, Admin approves |
| 5 | Cancelled match or event | Tournament Admin | **yes** |
| 6 | Tie at full time | Sport template; Referee executes | — |
| 7 | Suspended match | Referee + Technical Official | — |
| 8 | Abandoned match | Jury / committee | **yes**, Admin ratifies |
| 9 | Protest / appeal | Jury of Appeal | — |
| 10 | Result correction | Admin initiates | **yes**, a different Admin approves |
| 11 | Participant change | Competition Manager | **yes**, Admin approves |
| 12 | Venue / schedule change | Venue Manager proposes | **yes**, Admin approves |
| 13 | Weather / session loss | Competition Manager | **yes**, Admin approves |
| 14 | System outage during a match | Scorer + Technical Official | — |

### Two worth spelling out

**A suspended match resumes from where it stopped.** The score, the clock and
the situation are saved, so a rain delay does not mean replaying the first half.

**A system outage falls back to paper.** The scoresheet is authoritative, the
post-facto entry is marked as an **offline entry**, it must reference the signed
sheet, and verification against that sheet is mandatory before approval.

---

## What each role sees

The permission matrix (§3.2) is dry to read but simple in effect:

| Role | In one sentence |
| --- | --- |
| **Super Admin** | Everything, plus the unlock authority nobody else has |
| **Tournament Admin** | Runs this tournament: configures, approves, publishes, unlocks with a reason |
| **Competition Manager** | Runs a sport: sets up events, formats, draws, schedules, officials — prepares but does not publish |
| **Venue Manager** | Runs a venue: mats, slots, maintenance windows, conflicts on their own venue |
| **Technical Official** | Supervises matches: verifies results, rules exceptions, verifies medal lists |
| **Referee / Umpire** | On-field decisions and the match report signature |
| **Scorer / DEO** | Attendance, toss, live scoring, provisional result entry |
| **Team Manager** | Their own unit only: entries, their schedule, their results, protests |
| **Viewer** | Published data, read-only |
| **Jury of Appeal** | Rules on protests and appeals |

Two cross-cutting rules do most of the work:

- **Competition Managers prepare; Admins publish.** Nothing reaches teams or the
  public without an Admin act.
- **Team Managers see their own entries and published data, nothing else.** All
  cross-team data becomes visible only on publish.

---

## Next

- [Architecture](02-architecture.md) — how the layers fit together
- [Gap analysis](03-gap-analysis.md) — the places the document is silent or
  contradicts itself, and the call made on each
- [Wireframes](04-wireframes.md) — every screen and the live logic behind it
