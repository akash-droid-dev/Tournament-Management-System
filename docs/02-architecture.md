# Architecture

How the module is put together, and why each boundary sits where it does.

---

## The layers

```
┌───────────────────────────────────────────────────────────────────────────┐
│  web/                                       the operations console        │
│  ─────────────────────────────────────────────────────────────────────    │
│  Zero-build ES modules. Each screen is render(ctx) → DOM node.            │
│  ctx.api is the only route out. The UI hides what a role cannot do but    │
│  never relies on that hiding for security.                               │
└────────────────────────────────┬──────────────────────────────────────────┘
                                 │  a pluggable transport
                    ┌────────────┴────────────┐
                    │                         │
┌───────────────────▼──────────┐  ┌───────────▼──────────────────────────────┐
│  src/api/server.ts           │  │  web/static-boot.js                      │
│  ─────────────────           │  │  ───────────────────                     │
│  node:http, no framework.    │  │  The same table, called directly in the  │
│  Body parsing, static files, │  │  tab. No server, no network. This is     │
│  resolveUser() — the single  │  │  what the GitHub Pages demo is.          │
│  authentication seam.        │  │                                          │
└───────────────────┬──────────┘  └───────────┬──────────────────────────────┘
                    └────────────┬────────────┘
┌────────────────────────────────▼──────────────────────────────────────────┐
│  src/api/routes.ts                          routing                       │
│  ─────────────────────────────────────────────────────────────────────    │
│  The route table and dispatch, with no platform import. Content           │
│  negotiation for reports (JSON / CSV / printable HTML). A route cannot    │
│  exist in one host and be missing from the other.                         │
└────────────────────────────────┬──────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼──────────────────────────────────────────┐
│  src/api/service.ts                         orchestration                 │
│  ─────────────────────────────────────────────────────────────────────    │
│  The only layer that knows about both the domain and the world.           │
│  Every mutating method: check §3.2 → call the domain → persist →          │
│  commit the audit writes the domain returned. One transaction.            │
└───────┬──────────────────────┬──────────────────────┬─────────────────────┘
        │                      │                      │
┌───────▼────────┐  ┌──────────▼──────────┐  ┌────────▼──────────────────────┐
│ src/workflow/  │  │   src/engines/      │  │  src/store/                   │
│ ─────────────  │  │   ───────────       │  │  ──────────                   │
│ phase gates    │  │ eligibility         │  │  node:sqlite. Aggregates as   │
│ approval chain │  │ rng  (seeded)       │  │  JSON documents beside the    │
│ exceptions     │  │ draw               │  │  TmsStoreLike: node:sqlite or │
│                │  │ scheduler          │  │  Maps. The audit table is     │
│ PURE           │  │ officials          │  │  insert-and-select only.      │
│                │  │ standings          │  │                               │
│                │  │ progression        │  │  THE SEAM a host GMS replaces │
│                │  │ medals             │  │                               │
│                │  │        PURE        │  └───────────────────────────────┘
└───────┬────────┘  └──────────┬──────────┘
        │                      │
        └──────────┬───────────┘
                   │
┌──────────────────▼────────────────────┐  ┌────────────────────────────────┐
│  src/domain/                          │  │  src/sports/                   │
│  ───────────                          │  │  ───────────                   │
│  types      §13 entities              │◄─┤  registry   the contract       │
│  rbac       §3.2 matrix               │  │  kabaddi    the only file that │
│  status     §6 state machines         │  │             knows what a raid  │
│  audit      append-only log           │  │             is                 │
│  ids        readable identifiers      │  │                                │
└───────────────────────────────────────┘  └────────────────────────────────┘
```

**The dependency rule:** arrows only point down and inward. `src/sports/`
imports domain types; nothing in the engines imports from `src/sports/kabaddi.ts`
directly — they ask the registry. `src/domain/` imports nothing from the layers
above it.

---

## Why the engines are pure

Every engine is a function of its inputs. `generateDraw` takes entries and
parameters and returns a draw; it does not read a database, does not write an
audit entry, does not know what time it is except through an argument.

That buys three things:

1. **The rules are testable in isolation.** 255 tests run in 24 seconds, most of
   them in microseconds, because there is nothing to set up.
2. **A dispute can be replayed.** `verifyReproducible` regenerates a draw from
   its stored seed and compares. That is only possible because the draw is a
   pure function of (entries, parameters, seed).
3. **The host GMS can reuse them.** A GMS that wants only the draw engine can
   import it without dragging in a database.

### The audit-trail trick

A pure function cannot write to a log. But the audit trail is not optional — the
document's fourth design principle is that every action is audited.

So the workflow functions return the audit entries the caller must commit:

```ts
export interface WorkflowOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
  /** Audit writes the caller must commit. Never empty on a successful change. */
  audit: AuditWrite[];
}
```

The service layer commits them in the same transaction as the state change. The
domain stays pure, and forgetting the audit trail means ignoring a field that is
sitting in your return value.

---

## The sport boundary

This is the boundary that earns the most. The document's fifth design principle
is "sport-configurable, not sport-hardcoded", and the test of that is whether
adding a sport touches anything outside `src/sports/`.

```
                        ┌──────────────────────────────────┐
                        │  SportConfigTemplate             │
                        │  ──────────────────              │
   draw engine  ────────┤  matchDefaults                   │
   scheduler    ────────┤  restGap                         │
   officials    ────────┤  officials.panel                 │
                        │  officials.minimumToStart        │
   standings    ────────┤  tieBreakers[]                   │
                        │  sportMetric.compute()           │
   medals       ────────┤  medalRuleDefault                │
   approval     ────────┤  walkover                        │
   match console ───────┤  consoleActions[]                │
                        │  scoring: SportScoringEngine     │
   eligibility  ────────┤  categories, roster              │
                        └──────────────────────────────────┘
                                       ▲
                        ┌──────────────┴───────────────┐
                        │                              │
                 src/sports/kabaddi.ts          (the next sport)
```

Adding Volleyball is: a new file exporting a `SportConfigTemplate`, one
`register()` call, and one line in `src/sports/index.ts`. Nothing in the engines
changes. The match console's scoring pad regenerates from the new template's
`consoleActions`, so even the UI needs no edit.

### What a scoring engine has to provide

```ts
interface SportScoringEngine<S> {
  initialState(params): S;
  validate(state, event): ValidationResult;     // §7.4.16 — refuse at entry
  apply(state, event): { state: S; derived: [] }; // derived = what the rules imply
  summarize(state): { a, b, statistics };
  isComplete(state, params): boolean;
  describeState(state): string;                  // one line for the console
  replay(params, events): S;                     // rebuild after a reload
}
```

`derived` is the interesting one. When a Kabaddi side is emptied, the rules
produce an all-out worth two points and return the full complement to the mat —
the Scorer did not enter that, the engine did. Returning it as a derived event
keeps the timeline complete and lets the console show it in italics, so a
verifier can tell what a human recorded from what the rules concluded.

---

## Data flow through a match

The path a single result takes, and what each step touches:

```
 SCORER presses "Raid touch"
        │
        ▼
 POST /api/matches/:id/score
        │
        ▼
 service.recordScore
        │  1. can(user, 'match.score', 'E', { matchId })          §3.2
        │  2. match must be Live                                  §6.2
        │  3. sport.scoring.replay(storedEvents)      ← rebuild current state
        │  4. sport.scoring.validate(state, event)    ← §7.4.16, refuse illegal
        │  5. sport.scoring.apply(state, event)       ← returns derived events
        │  6. persist the event plus its derived events
        ▼
 the console re-renders from the stored log
        │
        ▼ ... at full time ...
 service.endMatch  →  Live → Completed (Provisional)              §6.2
        │
        ▼
 service.enterResult   ← auto-filled from the live score          §8.1
        │  maker recorded
        ▼
 service.verifyResult  ← a DIFFERENT user                         §8.2, §7.4.17
        │
        ▼
 protest window opens (anchored to verification)                  §8.3
        │
        ▼
 service.approveResult ← a THIRD user; refuses inside the window  §8.4
        │  approval LOCKS in the same call                         §7.4.18
        ▼
 service.recomputeEvent
        │  computeStandings   ← pure, from approved results only   §5.7
        │  propagate          ← winner into the next slot          §8.5
        │                       a protest freezes only its path    §7.4.19
        ▼
 notification emitted for the Notification module                 §11
```

Every one of those steps appends to the audit log. A single match generates
roughly 30 to 60 audit entries; the demo tournament generates around 350.

---

## Persistence, and the seam

The store keeps each aggregate as a JSON document beside the columns the
application actually filters on:

```sql
CREATE TABLE matches (
  match_id       TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,     -- indexed: list a event's fixtures
  match_no       TEXT NOT NULL,
  stage          TEXT NOT NULL,
  status         TEXT NOT NULL,
  scheduled_date TEXT,              -- indexed: the day's run sheet
  fop_id         TEXT,              -- indexed with date: mat conflicts
  doc            TEXT NOT NULL      -- the whole Match entity
);
```

**Why this shape.** The §13 entities have deep nested structures the document
treats as single fields — a draw's slot map, a match's score-event log, a
result's correction history, a fixture's reschedule history. Normalising them
would produce a dozen join tables to reconstruct one entity that is always read
whole. Keeping them as documents, with indexes on what we query, keeps the
schema close to the specification.

**`TmsStoreLike` is the seam, and it is a real one.** A host GMS has its own
database. Replacing the store with a Postgres or Prisma implementation changes
nothing above it, because the service talks to the interface in
`src/store/store.ts` — methods, not SQL.

The module ships two implementations, which is how the claim gets tested rather
than merely asserted:

| | `TmsStore` (`db.ts`) | `MemoryStore` (`memory.ts`) |
| --- | --- | --- |
| Backing | `node:sqlite` | plain `Map`s |
| Used by | the server | tests, and the browser build |
| Transaction | `BEGIN` / `COMMIT` / `ROLLBACK` | snapshot and restore |
| Foreign keys | enforced by the schema | **not enforced** |

`test/store-contract.test.ts` runs every assertion against both, so a method
that behaves differently in one is a failing test rather than a surprise on
match day. The foreign-key row is the one place they genuinely differ, and it
has its own test saying so — in production an orphan write fails loudly at the
store, in the browser it would succeed. Not a hole in practice, because the
service resolves a parent and throws `not found` before it writes a child, but
worth knowing rather than discovering.

### What the second implementation buys

Because `MemoryStore` has no platform imports — and neither, after the
`node:crypto` removal in `domain/ids.ts`, does anything in `domain/`,
`sports/`, `engines/` or `workflow/` — the whole module runs in a browser:

```
  npm run build:static   →   dist/   →   GitHub Pages
```

The published demo is not a mock-up. It compiles the real domain to ESM, runs
the real seeder in Node to produce a snapshot, and points the UI's transport at
`handleRequest` in the tab. Every rule a visitor meets is the shipped rule; only
storage is swapped. See **Try it in a browser** in the README.

### The audit table is structurally append-only

§7.6.27 says no role, including Super Admin, can edit or delete an audit entry.
Rather than enforcing that with a policy check somebody can forget, the store
simply has no such method:

```ts
appendAudit(e: AuditLogEntry): void      // insert
queryAudit(q): AuditLogEntry[]           // select
// there is no updateAudit and no deleteAudit
```

The in-process `AuditLog` class does the same: entries are frozen on write, and
`query()` hands back a copy.

---

## Where the authentication boundary is

The document defines ten roles in detail and never says where identity comes
from — correctly, because that is the parent system's job.

The whole seam is one function:

```ts
function resolveUser(req, url, service): User {
  const id = req.headers['x-tms-user'] ?? url.searchParams.get('as');
  if (!id) throw new ServiceError('no acting user …', 401);
  const user = service.store.getUser(id);
  if (!user) throw new ServiceError(`unknown user "${id}"`, 401);
  return user;
}
```

Replace it with a session lookup, a JWT verification, or a call to the GMS
identity service, and nothing else changes. Everything downstream takes a `User`
and checks the matrix.

This is deliberately visible rather than hidden behind a plausible-looking
middleware, so nobody deploys it thinking authentication is handled.

---

## Integration with the rest of the GMS

§11 lists the module boundaries. Two rules govern all of them: reads are by
reference, and a failed upstream lookup blocks the dependent action rather than
proceeding on stale data.

```
        INBOUND (TMS reads; never copies)
        ─────────────────────────────────
  Athlete Registration ──► only Approved records, with DOB, gender, unit,
                           para-class. Suspension and doping flags push
                           real-time eligibility alerts.
  Team Management      ──► approved rosters, coaches, support staff;
                           roster-lock dates honoured at entry mapping
  Accreditation        ──► ID and zone validation at check-in; an invalid
                           or expired accreditation blocks attendance
  Venue Management     ──► venues, fields of play, hours, maintenance blocks
  Officials Management ──► the qualified pool, filtered by sport, grade,
                           availability and unit

        OUTBOUND (TMS produces)
        ───────────────────────
  Venue Management     ◄── utilisation and booking data
  Officials Management ◄── duty assignments and completion records
  Result & Medal Tally ◄── every approved result and medal allocation
  Reporting            ◄── all fourteen report datasets
  Notification         ◄── typed events: fixture_published, reschedule,
                           result_approved, duty_assigned, protest_ruling…
  Dashboard            ◄── live status feeds
  Audit / Log service  ◄── every action, append-only
```

In the code, upstream records are `UpstreamRef`:

```ts
interface UpstreamRef {
  id: string;             // the key in the owning module
  displayName: string;    // cached for display only
  module: 'athlete-registration' | 'team-management' | …;
  revalidatedAt?: string; // when TMS last confirmed it is still Approved
}
```

The `module` field means a failed lookup can name the system that is down.
`revalidatedAt` records when the status was last confirmed, because §11 requires
re-validation at every gate — entry, draw, check-in — not once at entry.

---

## Testing strategy

| Layer | How it is tested | Why that way |
| --- | --- | --- |
| Sport rules | Unit tests naming each rule | These are what a federation disputes |
| Engines | Unit tests on pure functions | No setup, so coverage is cheap |
| Workflow | Unit tests on each gate and each refusal | The refusals are the product |
| Store | Every assertion run against **both** implementations | A seam only helps if both sides agree |
| Store + service | The lifecycle test drives the real seeder | Integration bugs live between layers |
| Invariants | Asserted over the whole seeded dataset | Catches what per-function tests miss |
| UI | Headless Chromium, every role × every screen | A screen that throws is invisible to unit tests |
| Static build | Headless Chromium against a server that 404s `/api/*` | Proves the demo needs no server, rather than assuming it |

The invariant tests are the ones that found real bugs. Asserting "no official
holds two overlapping duties" over 248 assignments catches what testing
`assessCandidate` in isolation cannot.

One caveat worth stating: `npm run typecheck` deliberately covers only the
configs that need nothing beyond the declared devDependencies. The browser
smoke test imports Playwright, which is optional and self-skips when absent, so
its config lives in `npm run typecheck:ui`. CI found that the hard way — the
combined check passed locally only because Playwright happened to be installed,
and failed on a clean install.

---

## Performance notes

Nothing here is tuned, because nothing needs to be — but the shape is worth
knowing:

- The seeded tournament (2 events, 38 fixtures, 248 duty assignments, ~350 audit
  entries) builds in about 2 seconds, and that includes simulating every raid of
  every match.
- `computeStandings` is O(fixtures) per group and runs on every approval. For a
  group of 10 that is 45 fixtures — trivial.
- The auto-scheduler is greedy: earliest feasible slot across all fields of play,
  in dependency order. Greedy is the right shape here, not a compromise. It is
  deterministic, it explains itself ("the first slot that satisfied every hard
  constraint"), and §5.4 expects a human to adjust the result on the Scheduling
  Board rather than trust an opaque optimum.
- The separation repair is a bounded hill-climb over unseeded slots. It reports
  honestly when a rule cannot be satisfied instead of looping.
