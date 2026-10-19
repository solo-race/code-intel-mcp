# P3-F — Failure and Degradation Policy

Status: **Specification.** No startup integration exists yet. Consumes
[`04c`](04c-p3-c-provider-adapter-contract.md) and
[`04d`](04d-p3-d-resolver-state-machine.md).

## 1. Decision

An invalid workspace root keeps its existing fail-fast startup failure, unchanged.
Every provider condition — probe failure, register failure, timeout, unauthorized
admission, conflict, malformed provider state, or an indeterminate comparison —
is **non-blocking**: `code-intel-mcp` starts, serves its existing tools, and
reports the provider state as a structured warning.

## 2. Rationale

AST execution has no runtime dependency on either provider. `codebase-memory-mcp`
supplies targets and rationale before execution; `gpt-repo-stdio` validates
afterwards; the agent carries both handoffs. Startup order between the servers is
not host-guaranteed, and one provider's registry can fail for reasons unrelated to
this process (a conflicting `codebase-memory-mcp` version/cache-root cohort, an
unwritable config file, a missing native binary). Making bootstrap a hard startup
dependency would convert an external registry outage into loss of the execution
layer while protecting no `code-intel-mcp` invariant.

## 3. Decision table

| Condition | Startup outcome | Report entry | Effect on tools |
| --- | --- | --- | --- |
| Workspace root missing, not a directory, or uncanonicalizable | Fail-fast, unchanged | none (bootstrap does not run) | Server does not start |
| Provider probe succeeds, project registered | Start normally | `registered`, action `none` | None |
| Provider probe succeeds, project missing, register succeeds | Start normally | `registered(by-bootstrap)`, action `registered` | None |
| Register fails; the mandatory re-probe observes the provider's actual state | Start normally | `failed` with taxonomy code plus `finalObservedState` evidence; never `registered` (v1 adapters emit `already-registered` only if a provider itself reports a successful no-op) | None |
| Provider is `unavailable` (CLI missing or not executable) | Start normally | `unavailable`, action `probe-failed` | None |
| Provider probe or register fails or times out (`unauthorized`, `timeout`, `malformed-registry`) | Start normally | `failed` with taxonomy code | None |
| Provider policy refuses the root (`ineligible`, for example a non-git workspace root), or the entry is ambiguous (`conflict`) | Start normally | `failed` with taxonomy code and a warning for human resolution | None |
| Provider is probe-only and the project is missing (`codebase-memory-mcp`, decision B1) | Start normally | `not-registered`, action `none`, note that the provider has no registration-only interface and nothing was written | None |
| Comparison indeterminate (P3-B section 4) | Start normally | `indeterminate` warning | None |
| Provider-side side effect during register (for example an index pass) | Start normally | note on that provider's entry | None |
| Report emission fails | Start normally | best-effort failure note | None |

## 4. Rules

1. Failure is reported, never silently ignored, and never reported as success.
2. Provider work never delays serving: the resolver runs concurrently with the
   stdio surface, so a slow, hanging, or unavailable provider cannot delay the
   `initialize` response, a `tools/list`, or any tool call. Only an invalid
   workspace root aborts startup.
3. A failed or indeterminate provider stays unresolved for the process: no retry,
   no background repair, no persistence, and no later escalation to a hard
   dependency within the session.
4. Degradation never reduces tool capability, never changes tool schemas, and
   never weakens an existing safety contract (preview/apply, workspace
   confinement, apply uncertainty).
5. No tool consults registration state; tool behaviour is identical whether
   bootstrap succeeded, degraded, or could not run.
6. Where a provider couples registration to a heavier side effect (B1), the
   timeout and failure semantics still apply: expiry is a `timeout` failure with a
   note, the provider remains the authority for whatever it actually did, and this
   process performs no rollback or cleanup of provider state.

## 5. Non-goals

No retry policy, backoff, circuit breaker, provider health monitoring, fallback
adapters, background reconciliation, or metrics/alerting integration. No policy
that lets a provider failure alter AST search, transform, preview, apply, or
verification behaviour. No workspace-root tolerance changes: the workspace
contract stays fail-fast.

## 6. Failure semantics

Provider failures are values, not exceptions into startup. A report-emission
failure is itself reported best-effort and never escalates into a registration
attempt or a startup abort. An unavailable provider is never recorded as
`not-registered`.

## 7. Acceptance criteria

Met when: the table above covers every taxonomy entry from P3-C with a defined
startup outcome and report entry; the single startup-abort condition is explicit;
each degradation has an observable report entry; and the rationale is recorded
with the counterfactual (hard dependency) named.
