# P3-D — Resolver State Machine and Idempotence Rules

Status: **Specification.** No resolver code exists. Consumes the identity contract
of [`04b`](04b-p3-b-identity-and-path-contract.md) and the adapter contract of
[`04c`](04c-p3-c-provider-adapter-contract.md).

## 1. Per-provider states

```text
unknown
  -> probe
     -> registered      => no action; final state registered
     -> not-registered  => register(mode: read)
                            -> applied            => final state registered(by-bootstrap)
                            -> already-registered => final state registered; no further write
                            -> failed             => final state failed
     -> indeterminate   => no action; final state indeterminate
     -> unavailable     => no action; final state unavailable
     -> failed          => no action; final state failed (probe failure: timeout |
                           unauthorized | malformed-registry | ineligible |
                           unsupported | conflict, carried in error.code)
     -> not-registered  => probe-only provider (B1): no register operation exists,
                           no write attempted, final state not-registered
```

`already-registered` is reserved: it is the only transition that would record a
registration this process did not perform. V1 adapters do not produce it, because
neither provider reports an existing entry as a successful no-op and a failed
invocation is classified as `failed` with the re-probe evidence attached
(`04c` rule 3). The transition stays in the machine for completeness and is
exercised by a fake adapter in P3-H; it is never inferred from a provider error
string and never derived from a re-probe.

## 2. Rules

1. **Independence.** Each provider is probed and resolved on its own. A failure,
   `indeterminate`, or `unavailable` result for one provider never changes the
   other provider's probe, action, or final state (R5).
2. **No write on `registered`.** No re-insert, no refresh, no permission change,
   no path respelling, no index trigger. The resolver does not touch a provider
   that already reports the project (R4).
3. **No write on `indeterminate` or `unavailable`.** Ambiguity is reported, never
   resolved by writing; an unreachable provider is left alone rather than
   retried within the process.
4. **Read-only mode is the only mode.** Every register call passes `read`; no code
   path can request another mode, and no provider elevation is attempted (R3).
5. **At most one attempt per provider per process start.** No retries, no
   backoff, no background work, no watchers, no periodic refresh, and no state
   carried into a later session (R13).
6. **No cross-provider transaction.** A failure for one provider does not roll
   back a successful registration for the other. Partial outcomes are reported as
   partial (architecture: failure and degradation policy).
7. **Determinism.** Identical workspace and provider state produce identical
   decisions and identical report contents; provider order in the report is fixed
   (codebase-memory-mcp, then gpt-repo-stdio), and no decision depends on wall
   clock, cwd, process id, or environment beyond what P3-C's adapters require.

## 3. Outcome matrix

| Provider A | Provider B | Result |
| --- | --- | --- |
| registered | registered | pure no-op; zero writes; report records two `registered` states |
| registered | not-registered | exactly one registration (B, mode read) |
| not-registered | registered | provider A is probe-only (B1): no write is possible, final state `not-registered` for A, `registered` for B |
| not-registered | not-registered | one registration for B; A stays `not-registered` with its probe-only note |
| indeterminate / unavailable / failed (either) | any | the other provider still resolves normally; the affected one is reported and left unresolved |

## 4. Idempotence

Second and later startups must perform zero writes when provider state has not
changed. Per final state:

| Final state | Second-run behaviour |
| --- | --- |
| `registered` (pre-existing) | probe only; no write |
| `registered(by-bootstrap)` | probe reports registered; no write, no re-index, no timestamp refresh |
| `not-registered` (probe-only provider) | probe again; still no write, and the note is reported again |
| `indeterminate` | probe again; still no write |
| `unavailable` / `failed` | probe again; a still-failing provider is not written |

The resolver never treats its own previous action as authority: the probe result
from the provider is the only input to the decision.

## 5. Non-goals

No registration cache, no cross-session persistence, no repair or reconciliation
of conflicting entries, no retry or repair queue, no automatic elevation, no
parallel registration, no provider index/coverage/freshness interaction, no
per-request registration checks, and no dependency on provider-internal
idempotence.

## 6. Failure semantics

- A failed probe must never be treated as `not-registered`, and a failed register
  must never be reported as `registered`; its one read-only re-probe is recorded
  as `detail.finalObservedState` evidence only (`04c` rule 3).
- `conflict` (duplicate/ambiguous entry) and `ineligible` (provider policy
  rejection) perform no write and produce warnings for human resolution.
- A provider-side side effect observed during a register call (for example an
  index pass) is reported as a note; it never upgrades the provider's state claim
  beyond `registered`, and it never becomes fresh/indexed evidence.

## 7. Acceptance criteria

Met when: the full transition table including probe failure, register failure,
`already-registered`, `indeterminate`, `conflict`, both-missing, and second-run
no-op is stated; every final state has a defined second-run behaviour; the
"no write on registered/indeterminate/unavailable" rules are explicit; and no rule
requires provider idempotence, cross-provider coordination, or state of its own.
