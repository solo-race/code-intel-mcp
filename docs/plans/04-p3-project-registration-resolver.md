# P3 — Deterministic Project Registration Bootstrap

Migration note: P4-D1 retires this bootstrap implementation and its exclusive
tests from both startup paths, retaining legacy explicit-root AST serving.
No optional synchronization replacement is retained. See
[05b](05b-p4-de-execution-plan.md) for current implementation and acceptance
status. The P3 completion and evidence below are historical and unchanged.

Status: **Complete.** All units P3-A…P3-H are complete by their gates: the
interfaces are confirmed with recorded evidence (`04a`), the contracts are written
and independently reviewed (`04b`–`04g`), the resolver and startup integration are
implemented (`src/bootstrap/`, `index.ts`, `scripts/mcp-launch.mjs`), and the
validation matrix — typecheck, focused tests, full suite, native smoke check,
repository validation profile `all`, and an external registration/idempotence run
against the real provider CLI — has passed. Residual uncertainties are listed in
the gate-status table below.

## Goal

Give `code-intel-mcp` one bounded startup (bootstrap/control-plane) action: after
the canonical workspace root is established, check whether the current project is
registered in the project/repository registries that `codebase-memory-mcp` and
`gpt-repo-stdio` read, register only the missing provider with read-only
permission, and emit one structured bootstrap report to the host.

The action is deterministic and local: no model, agent, or LLM call; no semantic
retrieval; no inference from code content, project type, or language; no MCP
transport call to a sibling server.

`code-intel-mcp` owns this step because it already receives and canonicalizes one
explicit workspace root at startup, so it is the component that holds a canonical
project identity before any other deterministic work begins. The normative
boundary, startup order, and non-goals live in
[`../architecture.md`](../architecture.md#bootstrap-project-registration-control-plane);
this plan owns the bounded execution path and its gates.

## Stage-level rules

These rules are binding for every unit below and are not reopened per phase.

| # | Rule |
| --- | --- |
| R1 | Bootstrap/control-plane only. No AST, understanding, mutation, repository-control, or orchestration capability is added or widened. |
| R2 | The decision uses explicit workspace and registry state only. Never code content, project type, file names, or model judgement. |
| R3 | Registration permission is fixed at `read`. No elevation path exists; write permission is a separate explicit authorization handled outside bootstrap. |
| R4 | Idempotence: registered providers are never rewritten, refreshed, re-indexed, or re-ordered; a second startup with unchanged state performs zero writes. |
| R5 | Providers are resolved independently. Partial state (registered with one provider, missing from the other) registers exactly the missing provider and leaves the other untouched. |
| R6 | Registration is not indexing. The report never claims index, watch, or freshness state, and provider index status stays that provider's authority. |
| R7 | No MCP tool, prompt, resource, or other model-invoked surface is added. The step is lifecycle-only. |
| R8 | No provider registry format, path, or registration interface is assumed. Unknown interfaces are investigation items until P3-A records evidence. |
| R9 | Provider access goes through one adapter seam per provider; no general plugin framework, provider discovery, or registry abstraction is introduced. |
| R10 | No dependency on a sibling MCP server's transport, and no assumption about cross-server startup order. |
| R11 | Canonical identity comes from `Workspace.create(...)`; provider keys (path spellings, slugs, provider ids) are projections and never the identity. |
| R12 | An invalid workspace root keeps its existing fail-fast behavior. Provider registration failure is non-blocking and reported as structured warning. |
| R13 | Registration outcome is lifecycle reporting only — not a per-request query, cache, history, or repair facility. |
| R14 | Out of scope for the whole stage: LSP, semantic resolution, symbol lookup, Git mutation, automatic commit, model routing, cross-MCP transactions, and permission escalation. |

## Delivery order

| Unit | Objective | Dependencies | Status |
| --- | --- | --- | --- |
| P3-A | External registry and interface investigation | None (entry point) | **Complete** — evidence in [`04a`](04a-p3-a-provider-interface-investigation.md); blockers B1 and B2 recorded there; independently reviewed (round 2 PASS) |
| P3-B | Canonical identity and provider path contract | P3-A | **Specification complete** — [`04b`](04b-p3-b-identity-and-path-contract.md); reviewed (round 7 PASS) |
| P3-C | Provider adapter contract | P3-A, P3-B | **Specification complete** — [`04c`](04c-p3-c-provider-adapter-contract.md); reviewed (round 7 PASS) |
| P3-D | Resolver state machine and idempotence rules | P3-B, P3-C | **Specification complete** — [`04d`](04d-p3-d-resolver-state-machine.md); reviewed (round 7 PASS) |
| P3-E | Startup lifecycle integration | P3-D | **Complete** — bootstrap runs concurrently with serving in `index.ts`; `bun scripts/mcp-launch.mjs` calls same-process `startServer(...)` plus the host entry in `~/.codex/config.toml`; verified by process-level tests and live runs |
| P3-F | Failure and degradation policy | P3-C, P3-D | **Specification complete** — [`04f`](04f-p3-f-failure-degradation-policy.md); reviewed (round 7 PASS) |
| P3-G | Notice and bootstrap report contract | P3-C, P3-D | **Specification complete** — [`04g`](04g-p3-g-bootstrap-report-contract.md); reviewed (round 7 PASS) |
| P3-H | Tests and external validation gate | P3-E, P3-F, P3-G | **Complete** — 48 focused bootstrap tests; full suite 134 pass; typecheck and native smoke pass; repository validation profile `all` 3/3; external registration + byte-identical second run measured against the real provider CLI on a disposable project |

## Implementation entry gate

Implementation of any unit other than P3-A requires all of the following, in
order:

1. P3-A is complete: for **each** of the two providers, the registration source of
   truth and at least one deterministic non-MCP-transport interface are confirmed
   with recorded evidence.
2. The startup dependency review is passed: the confirmed interfaces introduce no
   dependency on a sibling MCP server, no startup cycle, and no assumption about
   server start order.
3. P3-B and P3-C are written and reviewed, including the cases each one marks
   `indeterminate`.
4. The host launch path that starts `code-intel-mcp` for a project is identified,
   so "session/MCP startup" has a defined runtime surface (see P3-A).

Until this gate is met, the repository must contain no resolver code, no registry
writes, no bootstrap CLI flag, and no test that implies an unconfirmed provider
interface.

**Gate status (after implementation, all units independently reviewed):**

| Item | Status |
| --- | --- |
| 1. Provider source of truth + deterministic interface | Met for both providers, with the B1 decision applied: `codebase-memory-mcp` is probe-only, because its registration is the index-coupled `index_repository` upsert |
| 2. Startup dependency review | Met — both interfaces are local CLI invocations over provider-owned on-disk state; no sibling MCP transport, no cycle, no start-order assumption |
| 3. P3-B and P3-C written and reviewed | Met — `04b` and `04c`, reviewed with rounds 1–7 of defect findings all resolved |
| 4. Host launch path identified | Met — decision B2: `bun scripts/mcp-launch.mjs` resolves the session cwd and calls same-process `startServer(...)`, registered as the `code_intel_mcp` server in `~/.codex/config.toml`; the launcher is covered by a process-level test |

All P3 units are complete by their gates. Remaining uncertainty is limited to the
provider interfaces themselves: whether `codebase-memory-mcp`'s projects-row
upsert precedes index completion (not exercised, since B1 forbids the call), the
absence of a mapped-drive-versus-UNC pair on this workstation, and the deployed
`gpt-repo-stdio` config path if a host ever launches it without the env binding.

---

## P3-A — External registry and interface investigation

**Objective.** Establish, per provider, what registration state exists, who owns
it, and through which deterministic interface it can be inspected and extended
without an MCP handshake. Read-only.

**Starting evidence (observed, not yet confirmed, not normative).** Recorded on
2026-09-15 on the current workstation to scope the investigation; every item must
be re-confirmed before it is relied on:

- `codebase-memory-mcp` (observed version 0.10.8) exposes a transport-free
  one-shot CLI, `codebase-memory-mcp cli [--progress] [--json] <tool> [args]`, and
  `codebase-memory-mcp cli --json list_projects` returned the same project set as
  the MCP `list_projects` tool. Its published tool list contains `index_repository`
  but no separate registration tool, and its own config reports `auto_index` and
  `auto_watch`. Project records carry a path-derived slug name and a forward-slash
  `root_path`. Whether a registration-only path exists, and what happens for an
  already-registered project, is unverified.
- `gpt-repo-stdio` (gpt-repo-mcp checkout) resolves its repository registry from
  `GPT_REPO_CONFIG` pointing at a local JSON file whose `repos[]` entries are
  `{ repo_id, display_name, root, writes{...}, operations{...} }` with a top-level
  `limits` block; roots are stored as Windows absolute paths with backslashes
  (UNC form for WSL roots). Its README documents an `add` command with
  `--mode read|write|ship`, and a transport-free `gpt-repo-local catalog|invoke`
  interface exists on `PATH` in the observed environment. Whether registration is
  supported outside the checkout, its atomicity, and its non-interactive
  guarantees are unverified.
- The same project already appears in both registries with different spellings
  and different keys, which is direct evidence for R11.
- `code-intel-mcp` currently has no MCP server entry in the host configuration
  inspected; the launcher that supplies `--workspace-root` per session is
  therefore an open question.

**Questions to answer per provider (all required).**

1. Where is registration state persisted, how is the location resolved (env
   overrides, config discovery, defaults), and which process reads it at which
   point in its lifecycle?
2. Which interfaces can inspect and which can record registration — file write,
   CLI subcommand, library API, MCP tool — and which of them work with no MCP
   handshake and with the provider's MCP server not running?
3. Is there a registration-only path, or is registration coupled to indexing,
   watching, or another side effect? What exactly happens for an
   already-registered project: no-op, refresh, duplicate entry, or error?
4. What permission model applies to read-only registration, and what concretely
   distinguishes read from write in the stored form?
5. How is a project keyed (root path string, derived slug, explicit id), and how
   are duplicates and near-duplicates handled (same basename in different
   directories, case-only differences, trailing separators, symlinked or
   junctioned roots)?
6. Concurrency and reload semantics: when is the registry read, does a running
   provider session observe a later registration, are concurrent writers safe, and
   is there an atomic replace, lock, or backup behavior?
7. Interface stability: is the confirmed interface documented public API or an
   internal detail, what version was observed, and what must the adapter tolerate?
8. Failure surface of the confirmed interface: exit or error codes, structured
   error shape, timeout behavior, offline behavior, and partial-write behavior.
9. Host launch path: what starts `code-intel-mcp` for a project, how is
   `--workspace-root` supplied, and is there any host-level bootstrap hook that
   runs before MCP servers start?

**Method constraints.** Read-only commands only (`--help`, `--version`, config
`list`/`get`, list/status/probe operations, file reads). No registration, no
indexing, no deletion, no config mutation, no registry edit, and no test project
created for this phase. Each claim is recorded with the exact command and its
observed output.

**Outputs.** One interface record per provider containing: source of truth,
confirmed interface(s), permission shape for read-only, identity keying, observed
idempotence behavior, failure surface, version observed, and an explicit unknown
list. Plus a decision on adapter mechanics (CLI invocation, shared registry file,
or library API) with its justification, and the host launch-path finding.

**Invariants.** The investigation changes nothing: no registry entry, index,
permission, or host config may differ after this phase.

**Non-goals.** No adapter code, no registry normalization attempt, no provider
format conversion, no new provider or interface proposal beyond the two providers,
no indexing or coverage measurement of the investigated projects.

**Failure semantics.** If a provider has no deterministic non-MCP-transport
interface, or its registration is inseparable from an unacceptable side effect,
that is a recorded blocker — not a reason to fall back to MCP transport calls. The
plan then narrows to the resolvable provider or stops for a decision; a partial
provider set is never shipped silently.

**Acceptance criteria.** Both records exist and are complete; every interface
claim has an observed command/output anchor; every unconfirmed point is explicitly
listed as an unknown; adapter mechanics are chosen and justified; the startup
dependency review (entry gate item 2) is passed; the host launch path is either
identified or recorded as a blocker for P3-E.

**Dependencies.** None. This is the entry unit.

---

## P3-B — Canonical identity and provider path contract

**Objective.** Define the canonical project identity, the per-provider projection
contract, and the equality rule used to answer "is this project registered?", for
the confirmed interfaces only. Specification only; no conversion code in this
phase.

**Inputs and outputs.** Input: P3-A records plus the existing `Workspace.create`
canonicalization semantics. Output: a written identity/projection/equality
specification covering:

- **Identity.** The canonical root produced by `Workspace.create(...)` at startup
  (lexical checks plus `realpath`, existing fail-fast behavior unchanged). Git
  metadata, directory basename, package metadata, provider slugs, and provider
  `repo_id` values are explicitly not identity sources.
- **Projection.** Per provider, a deterministic, pure mapping from identity to the
  provider's stored path spelling and lookup key, limited to what P3-A confirmed
  (separator form, drive/UNC form, case form, or "provider compares paths itself").
- **Equality.** Per provider, the comparison that decides registered versus
  not-registered, including how the provider's own comparison is relied upon
  rather than duplicated. Pairwise ambiguity is confined to candidate entries and
  answered `indeterminate`; entries that are ambiguous only through an alias form
  (UNC/WSL/drive-relative against a differently-formed identity) or that are
  uncomparable are recorded in the probe detail and do not by themselves make the
  provider indeterminate, so an unrelated alias entry cannot disable registration
  for every other project (see `04b` sections 3–4).
- **Boundary.** Projection may produce the string used for a probe; it never
  rewrites an existing registry entry and never "fixes" a spelling difference. An
  entry that exists in a different but provider-equivalent spelling counts as
  registered.

**Invariants.** Deterministic and side-effect free; no filesystem mutation; no
model or content inspection; independent of git history, branch, and working-tree
state; the same inputs produce the same identity and projection on repeat runs.

**Non-goals.** Implementing Windows/WSL path translation, symlink or junction
normalization, 8.3 short-name handling, Unicode case folding, or cross-provider
path unification. Defining identity from repository content or metadata.

**Failure semantics.** The probe answers `indeterminate` only for a candidate
entry whose ambiguity is confined to one segment; bootstrap then performs no write
and reports a warning (see P3-D and P3-F). Alias-form and uncomparable entries are
reported as detail and leave the provider state decidable.

**Acceptance criteria.** The specification names, for each provider, at least the
same-path, different-spelling, different-case, symlinked-root, alias-form, and
nested-root-in-same-repository cases with an explicit decision; every case left
`indeterminate` at pair level and every case that falls through to the provider
state is listed; the spec is reviewed before P3-C starts.

**Dependencies.** P3-A.

---

## P3-C — Provider adapter contract

**Objective.** Define the single adapter seam the resolver uses, so the resolver
never touches provider internals, and define the failure taxonomy boundaries it
may surface.

**Contract shape.** Two adapters (one per provider) exposing the same operations:

```text
probe(identity)                          -> registered | not-registered | indeterminate | unavailable | failed(code)
register(identity, mode: "read")         -> applied | failed(code)   [already-registered reserved; v1 adapters do not emit it]
```

Each result carries a provider id, the interface used, the projected path/key, and
a structured error or note where applicable. The adapter may additionally report
an observed provider-side side effect (for example, an index pass triggered by the
provider's own registration path); it reports that fact and does not interpret or
claim its outcome (R6).

**Rules.** The adapter owns all provider-specific mechanics: invocation form,
argument construction, timeout, output parsing, and error mapping. It performs no
identity computation (P3-B) and no state-machine decisions (P3-D). `register` is
only reachable from a `not-registered` probe result. The resolver never depends on
a provider being internally idempotent, even when P3-A observed that it is.

**Failure taxonomy.** A fixed, small set the resolver can report:
`unavailable`, `unauthorized`, `conflict`, `ineligible`, `unsupported`, `timeout`,
`malformed-registry`, `indeterminate`. `unavailable` maps to the resolver's own
`unavailable` final state; `unauthorized`, `conflict`, `ineligible`, `unsupported`,
`timeout`, and `malformed-registry` map to `failed`; `indeterminate` maps to
`indeterminate`. Mapping an unknown provider error to any of these must be
conservative: unmapped errors are `indeterminate`, never `not-registered`.

**Invariants.** No adapter call can abort process startup; no adapter writes
outside the provider's own registration mechanism; no adapter deletes, renames,
re-indexes, or repairs provider state; no adapter retries a write automatically.

**Non-goals.** A plugin framework, provider registry, configuration DSL, dynamic
provider discovery, more than two providers, adapter-level caching, or
adapter-level background work.

**Failure semantics.** Every adapter failure returns a structured failure value.
An adapter that cannot be implemented from the P3-A evidence is recorded as a
blocker against that provider rather than approximated.

**Acceptance criteria.** The contract, the failure taxonomy, and the mapping from
provider errors to taxonomy entries are written and reviewed; each adapter names
the deterministic interface the P3-A record confirmed; the contract requires no
MCP transport and no assumption about sibling startup order.

**Dependencies.** P3-A, P3-B.

---

## P3-D — Resolver state machine and idempotence rules

**Objective.** Define the resolver that sequences the two adapters, decides
actions, and fixes the no-op rules.

**Per-provider states and transitions.**

```text
unknown
  -> probe
     -> registered      => no action; final state registered
     -> not-registered  => register(mode: read)
                            -> applied            => final state registered(by-bootstrap)
                            -> already-registered => final state registered; no further write
                                                     (reserved: v1 adapters do not emit it)
                            -> failed(reason)     => final state failed
     -> indeterminate   => no action; final state indeterminate
     -> unavailable     => no action; final state unavailable
     -> failed(reason)  => no action; final state failed (probe failure)
     -> not-registered  => probe-only provider: no action, final state not-registered
```

**Rules.**

- Each provider is probed and resolved independently; a failure or indeterminate
  result for one provider never changes the handling, ordering, or final state of
  the other (R5).
- `registered` performs no write of any kind: no re-insert, no refresh, no
  permission change, no path respelling, no index trigger (R4).
- `indeterminate` performs no write; resolving ambiguity by writing is prohibited.
- Registration mode is always `read` (R3); no code path can request another mode.
- No cross-provider transaction, and no rollback of a successful registration
  because the other provider failed. Partial outcomes are reported, not repaired.
- At most one attempt per provider per process start: no retries, no background
  work, no watchers, no periodic refresh, no state carried between sessions (R13).
- Determinism: identical workspace and registry state produce identical decisions
  and identical report contents apart from volatile fields.

**Outcomes.** All registered (pure no-op), one missing (exactly one registration),
both missing (two registrations), any indeterminate or failed (partial result plus
warnings, execution layer unaffected).

**Invariants.** No write in the `registered`/`indeterminate`/`conflict` paths; no
permission change ever; no dependency on provider-internal idempotence; the
resolver holds no provider state after startup.

**Non-goals.** A registration cache, cross-session persistence, a retry or repair
queue, automatic elevation, reconciliation of conflicting entries, parallel
registration, and any interaction with provider index coverage or freshness.

**Failure semantics.** Every non-success transition has a defined final state and
report entry; a failed probe must never be treated as `not-registered`, and a
failed registration must never be reported as registered.

**Acceptance criteria.** The full transition table including degenerate cases
(probe failure, register failure, indeterminate, conflict, both-missing,
second-run no-op) is written; the second-run no-op rule is stated per final state;
the "no write on registered/indeterminate" rules are explicit.

**Dependencies.** P3-B, P3-C.

---

## P3-E — Startup lifecycle integration

**Objective.** Place the resolver into process startup without changing workspace
fail-fast behavior, the argument contract, or tool availability.

**Inputs and outputs.** Input: the current startup path (`index.ts` argument
parsing, `Workspace.create(...)`, `serveStdio(...)`) and the P3-A host launch-path
finding. Output: the defined startup ordering and the integration contract.

**Ordering.** Argument parsing and `Workspace.create(...)` run first and keep
their current behavior; the resolver then runs **concurrently with serving**, not
before it, and the bootstrap report is emitted once when the resolver completes.
Serving must never wait for provider work: provider probes cost seconds (measured
268 ms to the initialize response without bootstrap versus ~2.9–5.0 s when the
resolver was awaited first, which also broke an existing stdio test), and a slow
or unavailable provider must not delay the host's startup gate.

**Rules.**

- Bootstrap output must never be written to stdout: stdout carries the stdio MCP
  protocol. Startup diagnostics use the existing stderr channel.
- Provider work is bounded by an explicit timeout budget; exceeding it yields
  `timeout` and a degraded report, not a blocked startup.
- The existing `--workspace-root <path>` contract is unchanged, and no new
  required argument or flag is introduced.
- No new configuration surface is introduced speculatively. If P3-A shows a
  provider side effect that cannot be tolerated unconditionally, that becomes an
  explicit decision item recorded in this unit before any option is added.
- The existing tool surface, tool schemas, and lifecycle contracts are untouched;
  no tool observes registration state.
- The resolver does not run on any later trigger: not on tool calls, not per
  request, not on session restart within the same process.

**Invariants.** Startup never aborts because of a provider (R12); the workspace
failure path is byte-for-byte behaviorally unchanged; the process serves tools
whether bootstrap succeeded, degraded, or was not possible.

**Non-goals.** Host-level bootstrap hooks, session-level hooks outside this
process, multi-project sessions, a per-project daemon, plugin or launcher
protocols, and any change to how the host passes the workspace root.

**Failure semantics.** A provider failure degrades the report only. If the host
launch path does not exist yet, P3-E records that the runtime surface is missing
and stops at specification rather than inventing a launcher.

**Acceptance criteria.** Documented ordering with the stderr/stdout invariant;
stated guarantee that tool availability does not depend on provider outcome; no
argument, flag, or config change beyond the existing contract; the launch-path
dependency is resolved or explicitly recorded as blocking.

**Dependencies.** P3-D, and P3-G for the report shape.

---

## P3-F — Failure and degradation policy

**Objective.** Freeze the failure taxonomy, the startup-blocking decision, and the
rationale.

**Decision.** An invalid workspace root keeps its existing fail-fast startup
failure. Every provider condition — probe failure, registration failure, timeout,
unauthorized, conflict, malformed registry, or indeterminate state — is
non-blocking: `code-intel-mcp` starts, serves its existing tools, and reports the
provider state as a structured warning.

**Rationale.** AST execution has no runtime dependency on either provider:
`codebase-memory-mcp` supplies targets and rationale before execution and
`gpt-repo-stdio` validates afterwards, both carried by the agent. Startup order
between the servers is not host-guaranteed. Hard dependency would convert an
external registry outage into loss of the execution layer while protecting no
`code-intel-mcp` invariant, and would make P3 a regression risk for P0–P2
capability.

**Additional rules.** Failure is reported, never silently ignored and never
reported as success. A failed or indeterminate provider stays unresolved for the
process; no retry, no background repair, no persistence, no escalation to a hard
dependency later in the session. Degradation never reduces tool capability or
weakens an existing safety contract.

**Non-goals.** Retry policies, backoff, background reconciliation, provider health
monitoring, fallback adapters, and any policy that lets a provider failure alter
AST search, preview, apply, or verification behavior.

**Acceptance criteria.** A decision table (condition → startup outcome → report
entry → effect on tools) is written; the statement that only an invalid workspace
aborts startup is explicit; each degradation has an observable report entry;
rationale is recorded.

**Dependencies.** P3-C, P3-D.

---

## P3-G — Notice and bootstrap report contract

**Objective.** Define the single structured lifecycle report and its delivery
channel.

**Content.** A schema version, the canonical identity used for decisions, the
workspace root as supplied by the host, and per provider: provider id, interface
used, initial state, action taken, final state, effective permission, structured
error or note, and any observed provider-side side effect. A deterministic field
order and provider order.

**Delivery.** Emitted once per process start on the startup diagnostic channel
(stderr), alongside the existing startup error channel; never as raw stdout and
never as an MCP tool, resource, or prompt. Whether the same record is additionally
surfaced as an MCP log notification is a decision inside this unit and must not
create a query surface.

**Invariants.** The report never claims indexing, coverage, watching, or freshness
(R6); it never implies a permission other than the effective one; it contains no
secrets; it is emitted regardless of outcome, including the pure no-op case; the
same state produces the same report apart from volatile fields.

**Non-goals.** A model-facing "registration status" tool, per-request status
reporting, report history, log files, metrics, dashboards, notifications to
observability backends, and any report-driven control flow.

**Failure semantics.** A report-emission failure is itself reported (best effort)
and never escalates to a registration attempt or a startup abort.

**Acceptance criteria.** Field list with types and required/optional marking; one
worked example record each for no-op, single-provider registration, first-run
both-missing, and partial failure/indeterminate; explicit statement that the
record is lifecycle-only.

**Dependencies.** P3-C, P3-D.

---

## P3-H — Tests and external validation gate

**Objective.** Define the verification that closes P3, including the
external-provider validation that P3's claims require.

**Focused test scope (deterministic, no live provider required).**

- Resolver with fake adapters: every transition in P3-D, including registered
  no-op, not-registered → applied, not-registered → already-registered,
  indeterminate (no write), conflict (no write), probe failure, register failure,
  both-missing, and second-run no-op.
- Independence: one provider in every failure state while the other resolves
  normally; a failed provider never alters the other's state, action, or ordering.
- Identity and projection (P3-B): same path, alternate spelling, case variant,
  symlinked root, alias-form entry, and nested root, using the specification's
  declared outcomes — asserting the pairwise result for cases declared
  `indeterminate` at pair level and the provider state for the alias-form and
  uncomparable cases that fall through to `not-registered`.
- Startup integration (P3-E): process-level startup with an adapter that fails or
  times out still serves the existing tool surface; stdout carries only MCP
  protocol frames; the report appears on the diagnostic channel; the workspace
  fail-fast path is unchanged when the root is missing or not a directory.
- Report contract (P3-G): every field present for each outcome, deterministic
  ordering, and the absence of any index or freshness claim.

**External validation (live provider interfaces, disposable project).** For each
provider independently, in a synthetic project rather than the working repository:
probe finds an existing registration with no registry write; a missing provider is
added at read permission only; a second run leaves the registry content
byte-identical to the first run's post-state. Recorded evidence is the command,
the observed registry state before/after, and the report emitted.

**Invariants.** Tests never mutate a real provider registry except in the
disposable project named for that purpose; no test depends on a sibling MCP server
being started; no test asserts an unconfirmed provider interface.

**Failure semantics.** A failing or unavailable required gate leaves the affected
unit incomplete with the concrete blocker recorded. A provider that cannot be
validated externally keeps its adapter non-implemented; success must never be
simulated by a fake adapter alone.

**Acceptance criteria.** Typecheck, focused tests, full suite, and the existing
native smoke check pass; repository validation and reviewed diff are run through
`gpt-repo-stdio`; both external provider validations are recorded; `README.md`,
`docs/architecture.md` (design-stage status removed), and this plan's unit statuses
are updated; no P0–P2 regression is introduced.

**Dependencies.** P3-E, P3-F, P3-G.

---

## Stage non-goals

Beyond R14, P3 explicitly does not: expand AST search, preview, apply,
verification, or any mutation contract; add LSP, semantic resolution, symbol
lookup, or indexing responsibility; perform Git reads, mutations, commits, or
recovery; orchestrate models or route work between agents; implement cross-MCP
transactions, distributed state, or rollback; grant or negotiate provider write
permission; modify host-level client configuration such as project trust or
server wiring; introduce a general registration framework, provider discovery, or
configuration DSL; or add a model-invoked tool for registration inspection,
refresh, or repair.

## Open risks

- **Late-bound runtime surface.** If no launcher currently starts `code-intel-mcp`
  with a per-project workspace root, P3-E has no place to attach until that wiring
  is decided; P3-A must settle this before P3-E is planned in detail.
- **Registration coupled to indexing.** If a provider's only registration
  interface triggers indexing or watching, bootstrap unavoidably causes that
  provider-side work. The plan requires recording the fact and leaving index
  authority with the provider rather than claiming or hiding it.
- **Registry spelling differences.** Two registries already store the same project
  differently; an overly strict equality rule would produce duplicate
  registrations, and an overly loose one would report registered projects as
  missing. P3-B must state which cases are decided and which stay
  `indeterminate`.
- **Concurrent writers.** Whether a registry tolerates a write while a provider
  process is running is provider-specific; if unconfirmed, registration stays
  non-blocking and reported rather than assumed safe.
