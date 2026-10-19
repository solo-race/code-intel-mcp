# P3-C — Provider Adapter Contract

Status: **Specification.** No adapter code exists. Implements the evidence in
[`04a-p3-a-provider-interface-investigation.md`](04a-p3-a-provider-interface-investigation.md)
under the identity rules of
[`04b-p3-b-identity-and-path-contract.md`](04b-p3-b-identity-and-path-contract.md).

## 1. Operations

Two adapters, one per provider, exposing the same shape:

```text
probe(identity, ctx)                  -> { state: "registered" | "not-registered" | "indeterminate" | "unavailable" | "failed",
                                           detail, error?: { code: <taxonomy value> } }
register(identity, "read", ctx)       -> { outcome: "applied" | "failed", detail,
                                           error?: { code: <taxonomy value> }, finalObservedState?: <state> }
```

A `failed` probe carries the taxonomy code that explains it (`timeout`,
`unauthorized`, `malformed-registry`, `ineligible`, `unsupported`, `conflict`);
`unavailable` is its own state because a missing provider CLI is a different
operator problem from a rejected or failed call. Both operations are
asynchronous, bounded by an explicit caller-supplied timeout, and return values
rather than throwing into startup. `ctx` carries the resolved config path where
the provider needs one and the timeout budget; it carries no provider secrets and
no cwd-relative assumptions. `already-registered` is a legal resolver state
(P3-D) but not an outcome these adapters produce in v1 — see rule 3.

## 2. Provider mechanics

| | `codebase-memory-mcp` | `gpt-repo-stdio` |
| --- | --- | --- |
| Probe | `codebase-memory-mcp cli --json list_projects --limit 100` followed by `--offset` pages until `has_more` is `false`; compare each `root_path` per P3-B and aggregate per P3-B section 3.1 | `gpt-repo-local invoke repo_list_roots` with `{}` written to stdin and stdin closed, and `GPT_REPO_CONFIG` bound in the child environment to the resolved config path; compare each `root` per P3-B and aggregate per P3-B section 3.1 |
| Probe success shape | exit 0, envelope `{content, structuredContent, isError:false}`, projects under `structuredContent.projects[]` with `root_path` | exit 0, `structuredContent.repos[]` with `root`; **no `isError` key on success**, so success must be keyed on the exit code plus the presence of `structuredContent.repos`, not on `isError === false` |
| Probe failure shape | exit 1, envelope with `isError:true` and `structuredContent.error` | exit 1 (tool error) or 2 (CLI/input error), envelope `{"isError":true,"structuredContent":{"ok":false,"error":{"code":…}}}`; empty stdin is the `VALIDATION_ERROR` case |
| Register | **none — probe-only by decision B1**: bootstrap never calls `index_repository`, because registration there is inseparable from indexing | `connect-gpt add <canonical-root> --mode read --config <resolved config>` |
| Register success signal | exit 0 with the `isError:false` envelope | exit 0, five stdout lines (`Added repo_id=…`, `mode=read`, `root=…`) |
| Register failure signal | exit 1 with `structuredContent.error` | exit 1 with `Error: <message>` on stderr, and the config file untouched |
| Config binding | none — the provider resolves its cache directory itself; the adapter inherits the environment and must not set `CBM_CACHE_DIR` or any other provider-scoped override | probe: none — the provider's own CLI resolves the file exactly as the deployed server does (env bindings against cwd, then its package-root fallback). register: `--config <path>` is passed only when `GPT_REPO_CONFIG` or `REPO_READER_CONFIG` is set in this process's environment; when neither is, the adapter does not guess a path and answers `unsupported` with a note naming the missing binding, because a cwd-relative guess could write a document the running server never reads |

Probe enumeration must be complete. A truncated page must never produce
`not-registered`: if enumeration cannot be completed, the probe result is
`indeterminate` (with the paging state in `detail`), never a missing project.
Envelope shapes differ between providers and must not be parsed by one shared
routine. Neither provider implements a CLI-level timeout: the timeout is the
caller's, and expiry is a `timeout` failure, not a hang.

## 3. Rules

1. `probe` is read-only and must not mutate provider state; `register` is
   reachable only from a `not-registered` probe result.
2. `register` issues exactly one provider invocation. No retry loop, no backoff,
   and no reliance on provider-internal idempotence, even where P3-A observed
   upsert behaviour.
3. A failed register invocation is `failed`. The adapter then performs exactly one
   read-only re-probe and records its observed state in `detail.finalObservedState`
   so the report shows what the provider holds; that evidence never upgrades the
   outcome. The re-probe proves the state, never the actor: for
   `codebase-memory-mcp`, the entry the re-probe sees can have been written by the
   adapter's own index-coupled invocation. `outcome: "already-registered"` is
   therefore reserved for a provider that explicitly reports an existing entry as
   a successful no-op — v1 adapters do not produce it, and P3-H exercises the
   resolver transition with a fake adapter.
4. Duplicate/conflict rejections (`gpt-repo-stdio` rejects duplicate `repo_id` and
   duplicate canonical root) are never treated as success; they map to `conflict`,
   because exit-code-only inspection cannot distinguish them from other failures.
   P3-D's probe-first rule is what keeps this path unreachable in normal
   operation.
5. Adapters own path comparison (P3-B) and provider invocation; they perform no
   resolver state decisions, no identity derivation, and no cross-provider
   coordination.
6. Adapters do not start, stop, or restart provider servers or daemons, and do not
   wait for one to be running. They do not write provider state outside the
   provider's own registration mechanism.
7. Adapter calls must not override provider policy. In particular
   `connect-gpt add` is invoked without `--allow-non-git`: a workspace root that
   the provider does not accept as a git repository is reported as `ineligible`
   rather than forced into the registry, and the same applies to any other
   provider eligibility rule.
8. Adapters do not interpret provider behaviour beyond the returned record: an
   observed provider-side side effect (for example an index pass) is reported as a
   note and never reported as index, coverage, watch, or freshness state.
9. Adapters keep no cache and no state between calls; each call re-reads provider
   state, because neither provider guarantees cross-process freshness for the
   other's writes.

## 4. Failure taxonomy

One fixed taxonomy, mapped from provider-specific signals to the resolver's final
states (P3-D):

| Adapter failure | Meaning | Resolver final state |
| --- | --- | --- |
| `unavailable` | provider CLI missing, not executable, or the npm shim's native-binary probe fails | `unavailable` |
| `unauthorized` | provider refuses the operation for permission or admission reasons (for example a conflicting `codebase-memory-mcp` version/cache-root cohort) | `failed` |
| `conflict` | provider rejects the entry as duplicate or ambiguous | `failed` (warning) |
| `ineligible` | provider policy refuses this root (for example `connect-gpt add` without `--allow-non-git` on a non-git root) | `failed` (warning) |
| `unsupported` | provider interface does not offer the operation (for example a registration-only path) | `failed` (blocker) |
| `timeout` | caller-owned timeout expired | `failed` |
| `malformed-registry` | provider state exists but cannot be read or parsed as expected | `failed` |
| `indeterminate` | comparison or provider answer cannot be decided (P3-B sections 3–4) | `indeterminate` |

Unmapped provider errors are `indeterminate`, never `not-registered` and never
`registered`. A failed probe must never be treated as "not registered".

## 5. Non-goals

No plugin framework, provider discovery, provider registry, configuration DSL, or
third provider. No adapter caching, persistence, background work, or health
monitoring. No index triggering, index status claiming, or freshness logic. No
server lifecycle management. No `codebase-memory-mcp` slug reproduction and no
`gpt-repo-stdio` `repo_id` derivation. No provider policy overrides.

## 6. Acceptance criteria

Met when: both adapter mechanics are fully specified from confirmed evidence (or
explicitly blocked, as provider A's register path is by B1), including complete
paged enumeration and the probe stdin/envelope shapes; the taxonomy covers every
observed provider signal with a conservative default and maps each entry to a
P3-D final state; the mandatory re-probe preserves failure; and the contract
introduces no sibling-MCP transport, no server lifecycle dependency, no provider
policy override, and no state of its own.
