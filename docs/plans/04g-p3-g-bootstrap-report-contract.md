# P3-G — Bootstrap Report Contract

Status: **Specification.** No report is emitted yet. Consumes
[`04c`](04c-p3-c-provider-adapter-contract.md) and
[`04d`](04d-p3-d-resolver-state-machine.md).

## 1. Record

One record per process start, emitted after the resolver completes and before
serving begins:

```text
{
  version: 1,
  identity: <canonical root from Workspace.create>,
  workspaceRootAsSupplied: <the --workspace-root argument, verbatim>,
  providers: [
    {
      id: "codebase-memory-mcp" | "gpt-repo-stdio",
      interface: { command: <executable>, args: [<argument shapes, no secrets>] },
      initialState: "registered" | "not-registered" | "indeterminate" | "unavailable" | "failed",
      action: "none" | "registered" | "already-registered" | "probe-failed" | "register-failed",
      finalState: "registered" | "not-registered" | "failed" | "indeterminate" | "unavailable",
      permission: "read" | "not-applicable",
      note?: <provider-side side effect or comparison caveat>,
      error?: { code: <P3-C taxonomy value, e.g. "ineligible" | "conflict" | "timeout" | "unsupported">, message: <provider message, redacted of secrets> },
      finalObservedState?: <state the mandatory post-failure re-probe observed, verbatim from the provider>
    },
    ...
  ],
  summary: "no-op" | "registered" | "partial" | "failed" | "indeterminate"
}
```

`action: "already-registered"` is reserved and unreachable in v1: it would record
a registration this process did not perform, and a failed register is `failed`
with `finalObservedState` evidence instead (`04c` rule 3, `04d` section 1).

Field semantics that the evidence settled:

- `summary` is derived from the provider entries, not chosen independently:
  `no-op` when every provider is `registered` and none was registered by this
  process; `registered` when every provider is `registered` and at least one was
  registered by this process; `partial` when at least one provider is
  `registered` and at least one is not; `indeterminate` when none is registered
  and every provider ended `indeterminate`; `failed` otherwise. A probe-only
  provider that reported `not-registered` counts as unresolved, so "provider A
  missing (probe-only) and provider B registered" is `partial` — the shape the
  P3-H external validation observed.

- `finalState: "not-registered"` is emitted for a **probe-only provider** (decision
  B1: `codebase-memory-mcp`) whose probe found the project missing. It records
  "the provider does not hold this project and no write was possible or
  attempted" — it is the intended probe-only outcome, not a failure, and it is
  never used for a provider that could have registered and did not.
- `permission` is `read` for `gpt-repo-stdio` (its read mode writes
  `writes.enabled=false` and `operations.enabled=false`) and `not-applicable` for
  `codebase-memory-mcp`, whose registration record has no permission model. The
  report must not claim that a provider was granted `read` when that provider has
  no such concept.
- `note` carries observed provider-side side effects (for example an index pass
  triggered by a provider's own registration path) and comparison caveats, never
  index, coverage, watch, or freshness claims.
- Provider entries appear in the fixed resolver order (codebase-memory-mcp, then
  gpt-repo-stdio); field order is fixed as written above.
- No timestamps, durations, process ids, or other volatile values are required;
  if such a value is ever added it must be explicitly marked volatile so
  determinism comparisons stay meaningful.

## 2. Delivery

- Emitted exactly once per process start, on the existing startup diagnostic
  channel (stderr), when the resolver completes. Because the resolver runs
  concurrently with serving, the record may be emitted after the first request;
  it is never emitted before the workspace root is canonicalized.
- Never on stdout: stdout carries the stdio MCP protocol.
- Not an MCP tool, resource, prompt, or logging notification in this stage; no
  model-invoked surface observes registration state (R7, R13).
- Emitted regardless of outcome, including the pure no-op case; emission happens
  once even when bootstrap degrades.

## 3. Invariants

- The record never claims indexing, coverage, watching, or freshness.
- The record never implies a permission other than the effective one.
- The record contains no secrets, credentials, or environment dumps; provider
  error messages are redacted the way each provider itself redacts paths.
- No control flow depends on the report: nothing in the process reads it back.

## 4. Worked examples

**No-op (both providers report the project registered).**

```text
{ version: 1, identity: "D:/CodexProjects/x", workspaceRootAsSupplied: ".",
  providers: [
    { id: "codebase-memory-mcp", interface: { command: "codebase-memory-mcp", args: ["cli", "--json", "list_projects", "--limit", "100", "--offset", "<n>"] },
      initialState: "registered", action: "none", finalState: "registered", permission: "not-applicable" },
    { id: "gpt-repo-stdio", interface: { command: "gpt-repo-local", args: ["invoke", "repo_list_roots"] },
      initialState: "registered", action: "none", finalState: "registered", permission: "read" } ],
  summary: "no-op" }
```

**One provider missing (`gpt-repo-stdio`), one already registered.**

```text
  providers: [
    { id: "codebase-memory-mcp", ..., initialState: "registered", action: "none", finalState: "registered", permission: "not-applicable" },
    { id: "gpt-repo-stdio", interface: { command: "connect-gpt", args: ["add", "<identity>", "--mode", "read", "--config", "<path>"] },
      initialState: "not-registered", action: "registered", finalState: "registered", permission: "read" } ],
  summary: "registered"
```

**Provider A missing (probe-only) and provider B newly registered.** Provider A's
entry is `{ initialState: "not-registered", action: "none", finalState:
"not-registered", permission: "not-applicable", note: "provider is probe-only:
no registration-only interface exists, so nothing was written" }`; provider B's
is `{ initialState: "not-registered", action: "registered", finalState:
"registered", permission: "read", note: "provider confirmation: Added
repo_id=…" }`; the summary is `partial`. This is the shape measured end to end
against the real provider CLI in the P3-H external validation, including the
byte-identical second run, which reports provider B as `registered` /
`action: "none"` with the register interface absent from `interface`.

**Provider unavailable.** Provider A's entry is
`{ initialState: "unavailable", action: "probe-failed", finalState: "unavailable", error: { code: "unavailable", message: ... } }`,
provider B resolves normally, and the summary reflects the mix (`partial`).

## 5. Non-goals

No `registration_status` tool or any other model-facing query surface; no
per-request status reporting; no report history, log files, rotation, or metrics;
no notifications to observability backends; no retry command; no report-driven
control flow; no persistence across sessions.

## 6. Failure semantics

If emission fails, startup continues and the failure is noted best-effort on the
diagnostic channel; it never triggers a registration attempt, a provider call, or
an abort. A partially written record is preferable to a missing one only if it
stays valid JSON; otherwise the channel receives the failure note alone.

## 7. Acceptance criteria

Met when: the field list, types, and required/optional status are fixed; the
`permission` and `note` semantics match the provider evidence; delivery channel
and the stdout prohibition are explicit; one example exists per outcome
(no-op, single registration, first-run both-missing, partial failure); and the
record is lifecycle-only with no query surface.
