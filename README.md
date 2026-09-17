# Tournament Management System (TMS)

The competition-operations module of a Games Management System, configured for
**Kabaddi**. It turns approved master data — athletes, teams, officials, venues,
owned by other GMS modules — into a governed competition: configured events,
validated entries, reproducible draws, conflict-free schedules, disciplined
match-day operations, and locked, auditable results that drive standings,
progression, medals and the games-wide medal tally.

Built from the *TMS Functional Workflow Document v1.0*. Every module cites the
section it implements, so the code and the document can be read side by side.

**[▶ Open the live demo](https://akash-droid-dev.github.io/Tournament-Management-System/)**
— the real rules running in your browser, no install. See
[Try it in a browser](#try-it-in-a-browser) for what that does and does not
prove.

---

## Run it

```bash
npm install          # one devDependency: typescript. No runtime dependencies.
npm run seed         # builds a demo National Kabaddi Championship
npm start            # http://localhost:4321
```

Or in one step: `npm run demo`.

| Command | What it does |
| --- | --- |
| `npm start` | Serves the API and the operations console on `:4321` |
| `npm run seed` | Drives a full tournament through all ten phases (`-- --reset` to wipe first) |
| `npm test` | 298 tests (`node:test`); the browser pass skips itself without Playwright |
| `npm run test:ui` | Browser smoke test alone — needs `npm i -D playwright` |
| `npm run typecheck` | `tsc --noEmit` over the server and static configs |
| `npm run typecheck:ui` | The browser test's config — needs `npm i -D playwright` |
| `npm run build:static` | Builds `dist/` — the module with no server, for GitHub Pages |

Sign in from the picker in the top bar. The demo seeds one user per role plus
the whole officials panel; switching user re-renders every screen through that
role's permissions.

| User | Role | Worth looking at |
| --- | --- | --- |
| `ta1` | Tournament Admin | Pending-actions queue, publish controls, audit log |
| `cm1` | Competition Manager | Draw console, scheduling board, officials board |
| `sc1` | Scorer | Match console — the Kabaddi scoring pad |
| `to1` | Technical Official | Verification queue |
| `vm1` | Venue Manager | Mat utilisation heatmap, run sheet |
| `tm-mh` | Team Manager | Own unit only, protest window timers |
| `vw1` | Viewer | Public portal — published data only |

---

## Try it in a browser

The [live demo](https://akash-droid-dev.github.io/Tournament-Management-System/)
is not a mock-up of the screens. It is this module with its storage swapped.

`docs/02-architecture.md` claims the store is "the seam a host GMS replaces".
The Pages build is that claim being cashed: `src/store/memory.ts` implements the
same `TmsStoreLike` contract over plain Maps instead of `node:sqlite`, and
because the domain, sport rules, engines and workflow have **no platform
imports at all**, they run unchanged in a tab.

```
   SERVER                                  BROWSER (GitHub Pages)
   ──────                                  ──────────────────────
   web/  ── fetch ──▶ node:http            web/  ── direct call ──┐
                          │                                       │
                          ▼                                       ▼
                    src/api/routes.ts  ◀── the same route table ──┘
                          │
                          ▼
                    src/api/service.ts
                          │
      domain · sports · engines · workflow   ← identical, byte for byte
                          │
                          ▼
              TmsStoreLike (the seam)
                    │            │
              node:sqlite     Maps
```

**So the rules are real.** On the published page, crediting a raid point to the
defending side is refused by `src/sports/kabaddi.ts`; a hand-entered all-out is
refused because the engine derives it; a Scorer approving a result is refused by
the §3.2 matrix. Verified in a headless browser against an API-free static
server — nine pages, seven roles, **zero** network requests to `/api/*`:

```
  open console                     200   Check-in
  start (no attendance)            400   attendance must be confirmed before the match can start (§7.2)
  start                            200   Live
  raid-touch A 4                   200   H1 00:30 · 4–0 · raid #2 by B · on mat 7v3
  raid-touch A 3 (wrong raider)    400   B is raiding; a raid point cannot be credited to A
  all-out entered by hand          400   "all-out" is derived by the rules engine and cannot be entered directly
  Scorer approves own result       403   Scorer has no access to Result approval & lock
```

**What it does not prove.** Storage is per-tab: a reload starts over from the
seeded snapshot, and nothing is shared between visitors. That is correct for a
demo and wrong for a tournament, which is what the banner on the page says.
One behaviour also genuinely differs — SQLite enforces foreign keys and the
Maps do not — and that divergence is pinned down by a test rather than left to
be discovered (`test/store-contract.test.ts`).

The 43 store-contract tests run every assertion against **both**
implementations, so the seam cannot quietly drift.

---

## Why it is built this way

**Zero runtime dependencies.** Node's built-ins only: `node:sqlite` for
persistence, `node:http` for the API, `node:test` for tests. TypeScript is a
devDependency for typechecking; Node runs the `.ts` sources directly. The point
is that this module drops into any GMS stack — Next.js, NestJS, plain Express —
without dragging a framework with it.

**The domain is pure; only the service layer touches the world.** The engines
(`src/engines/`) and the workflow (`src/workflow/`) are functions of their
inputs. They return the new state *plus the audit entries the caller must
commit*, which makes the audit trail impossible to forget without making the
domain aware of a database.

**Nothing is sport-hardcoded.** `src/sports/kabaddi.ts` is the only file that
knows what a raid is. The draw, schedule, standings, medal and approval code
drives a `SportConfigTemplate`, so adding Volleyball is a new file plus one line
in the bundle.

**Rule provenance is explicit.** Structural rules of play (seven on the mat, an
all-out is worth two, a bonus needs six defenders) are marked `'rule-of-play'`.
Numbers federations set and revise (weight limits, league point values, half
length, rest gaps) are marked `'configurable-default'` and surfaced as editable
fields, because they must be confirmed against the current technical handbook
before a tournament goes live. See [docs/05-kabaddi-reference.md](docs/05-kabaddi-reference.md).

**The permission matrix is transcribed, not paraphrased.** `SPEC_MATRIX` in
`src/domain/rbac.ts` is the §3.2 table cell by cell. Where it contradicts the
§4 phase tables, the conflict is listed in `RECONCILIATIONS` with both
citations rather than silently patched, and the Role & Access screen shows them.

---

## Structure

```
src/
  domain/      entities (§13), the §3.2 permission matrix, §6 status machines,
               append-only audit log
  sports/      sport config registry + the Kabaddi template (scoring engine,
               officials panel, tie-breakers, categories, walkover convention)
  engines/     pure algorithms — eligibility, seeded draw, scheduler, officials,
               standings, progression, medals
  workflow/    the ten phase gates, the result approval chain, the fourteen
               exception scenarios
  store/       node:sqlite schema + repository (the seam a host GMS replaces)
  api/         service layer (engines meet the store) + node:http routes
  reports/     the fourteen reports from §10, with CSV and print-to-PDF
  seed/        the demo Kabaddi tournament
web/           zero-build ES-module console for the twenty §12 screens
test/          255 tests, organised by the rule each one protects
docs/          see below
```

---

## Documentation

| Document | For |
| --- | --- |
| [01 — The workflow in plain language](docs/01-workflow-plain-language.md) | Every step of all ten phases, explained simply, with tile diagrams |
| [02 — Architecture](docs/02-architecture.md) | Layers, data flow, why each boundary is where it is |
| [03 — Gap analysis](docs/03-gap-analysis.md) | Every gap and contradiction in the source document, and the call made on each |
| [04 — UI/UX wireframes](docs/04-wireframes.md) | Every screen, its layout, and the live logic behind each control |
| [05 — Kabaddi reference](docs/05-kabaddi-reference.md) | The encoded rules, what is a rule of play and what needs confirming |
| [06 — API reference](docs/06-api-reference.md) | Every endpoint, its permission, and the rule it enforces |

---

## The five guarantees

The document rests on five promises. Each is enforced structurally rather than
by convention, and each has tests naming it:

1. **Eligibility is enforced at the gate.** Nothing enters a draw without
   upstream approval and rule validation. The entry pool contains only records
   another module has marked Approved; there is no free-text participant.
2. **Publishing is deliberate.** Draws, schedules, results and medals each have
   a draft state and an explicit publish act restricted to admins. A Team
   Manager sees their own entries and published data, nothing else.
3. **Results follow maker–checker–lock.** The user who enters a result can never
   verify or approve it; a two-step chain needs a third pair of hands; approval
   locks automatically; the only way back in is a reason-coded unlock approved
   by a second role, followed by a re-verify and a re-approve.
4. **Computation is automatic.** Points, tie-breakers, progression and medals
   are recomputed by the system on every approval and every correction. There is
   no setter for a standings row anywhere in the codebase.
5. **Every action is traceable.** The audit log is insert-and-select only — for
   every role, including Super Admin — because the store exposes no update or
   delete for it.

---

## What is deliberately not built

Stated plainly so nobody mistakes a boundary for an oversight:

- **Authentication.** The GMS owns identity. `resolveUser` in
  `src/api/server.ts` reads a header naming the acting user; replacing that one
  function wires real sessions.
- **The upstream GMS modules.** Athlete Registration, Team Management,
  Accreditation, Venue Management and Officials Management are consumed as
  snapshots read by reference. The seeder fabricates them; a real deployment
  points the store's snapshot tables at those modules.
- **Notification delivery.** TMS emits typed events (`fixture_published`,
  `reschedule`, `result_approved`, `duty_assigned`, `protest_ruling`, …). Fanning
  them out over push, email, SMS or WhatsApp is the Notification module's job.
- **Event merger.** §7.1.6 offers "cancellation **or merger**" when an event is
  short of entries. Cancellation is implemented; merging two events is not — see
  [gap 18](docs/03-gap-analysis.md).
- **Fair-play tie-breaker data.** The rung exists in the Kabaddi hierarchy
  because §5.7 lists it, but no entity aggregates card counts per side across a
  group, so it currently returns zero — see [gap 12](docs/03-gap-analysis.md).
