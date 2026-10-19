# Architecture

## Purpose and system boundary

`code-intel-mcp` is the deterministic AST execution layer. It owns structural
search, preview-first mutation, guarded apply, and explicit structural
verification. It does not own indexing, repository governance, or model
orchestration.

| Component | Layer | Responsibility |
| --- | --- | --- |
| `codebase-memory-mcp` | Knowledge / Where & Why | Indexing, symbol and relationship retrieval, semantic context. |
| `code-intel-mcp` | Execution / How & Verify | Deterministic AST search, reviewed preview, guarded apply, verification. |
| `gpt-repo-stdio` | Repository Control / Diff, Test, Git | Repository state, review, validation, and Git operations. |

The orchestration flow is:

```text
understand targets and rationale
-> preview and review structural changes
-> guarded apply and explicit verification
-> repository diff, validation, and Git completion
```

The three servers communicate through orchestrated data, not sibling MCP
transport calls or in-process runtime dependencies.

## Runtime topology

The global startup path is:

```text
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs serve
-> rootless stdio MCP
-> explicit request workspaceRoot
-> canonical Workspace
```

Global serving does not select a startup workspace or invoke provider bootstrap.
One server owns one shared, bounded preview registry across all request roots;
there is no mutable current workspace or per-root registry/cache.

The stable entry resolves source modules relative to its installation, not the
invoking cwd. The installation contains source, lockfile, and installed native
dependencies; Bun remains an external runtime requirement. `index.ts serve`
also exposes the rootless path for source development.

The legacy host startup path is:

```text
Codex host
-> bun scripts/mcp-launch.mjs
-> same-process startServer(process.cwd())
-> canonical Workspace
-> stdio MCP
```

The launcher checks the session working directory and imports `startServer`
directly. It does not spawn a second Bun process. `Workspace.create` establishes
the canonical root before the service accepts requests.

The public MCP surface contains exactly:

- `ast_search`
- `ast_edit_preview`
- `ast_transform_preview`
- `ast_transform_plan_preview`
- `ast_edit_apply`

Schemas and detailed field contracts belong in the relevant plan documents.

### Request and workspace boundary

In global mode, `ast_search`, `ast_edit_preview`, `ast_transform_preview`, and
`ast_transform_plan_preview` require an explicit absolute `workspaceRoot`.
The MCP boundary validates and canonicalizes an existing directory, then passes
the resulting Workspace to AST execution. A plan selects one root for all
steps; step contracts do not accept routing fields.

Legacy startup accepts `--workspace-root <path>`; the old launcher uses
`process.cwd()` as that input. The startup root is reused when requests omit
`workspaceRoot`. A supplied root must be absolute and canonicalize to the same
startup root; a different root is rejected.

Tool paths are repository-relative or otherwise resolved against the canonical
root according to the individual tool contract. Lexical and canonical
containment checks reject paths that escape that root, including traversal
and symlink escapes. Search and edit preview allow absolute targets within the
root; transformation paths must remain repository-relative without parent
traversal. A target must
also satisfy the file or directory shape required by the operation before
native AST discovery or mutation begins.

The server uses stdio for MCP protocol traffic. Diagnostics use stderr so stdout
remains exclusively protocol data. The
launcher itself emits no diagnostic output on stdout and creates no child
process.

The canonical root is execution context, not a provider registry key. Provider
registries do not participate in workspace selection or AST authorization.

### CLI and host configuration ownership

CLI command dispatch is separate from MCP serving. Only explicit
`install/uninstall --host codex --scope user` commands edit the selected Codex
user configuration (`CODEX_HOME/config.toml`, otherwise the normal user home).
Their dry-run performs no writes. `print-config --host generic-stdio` returns
the absolute executable and argument array; help and invalid commands do not
load the configuration editor. Serving performs no installation or provider
registration. No diagnostic or installation MCP tool is added.

The host entry launches the absolute Bun executable with the absolute stable
CLI path and `serve`. It contains no workspace root, cwd, or provider environment.
Installation paths are durable operator-managed storage; relocation requires
explicit reconfiguration. Native OS paths are preserved, including UNC paths;
there is no Windows/WSL translation or shell command construction.

`src/cli/codex-config.ts` validates original and candidate content entirely in
memory using `@ltd/j-toml@1.38.0` in TOML 1.0 mode with extensions disabled
(`parse(text, 1.0, "\n", true, null)`). Parsing failures become
`CONFIG_EDIT_REFUSED` before filesystem mutation. It preserves original bytes by appending a marked owned
tail with its own separator. Exact ownership is required for removal.
Equivalent unowned entries remain externally managed; conflicts, duplicate or
ambiguous configuration, invalid TOML, and modified/non-tail owned blocks fail
closed. The editor never rewrites unrelated settings or takes over an entry.

Real mutations validate the candidate, create an exclusive exact-byte backup
when an original exists, write a same-directory temporary file, reread and
compare original bytes, and rename to replace. Backup/write/compare/rename
failure aborts without a truncate fallback. Successful edits report backup
and recovery guidance. Dry-run and no-op operations create no backups or files.
This is a single-file replacement contract; it does not claim a filesystem
compare-and-write transaction.

Install dry-run and Codex's own get/list commands provide configuration
inspection. Independent integration uses an isolated Codex home and launches
the command/argv read back from the real CLI. These checks do not establish
live reload propagation, agent tool selection, or full host sandbox acceptance.

### Read-only doctor

`doctor --host codex [--config path]` inspects only the selected configuration,
using the same `CODEX_HOME`/default selection as installation unless overridden.
It does not call installer mutation paths or create missing configuration.
Built-in local dependency preflight runs before dependency-backed imports and
returns structured failure without automatic installation or download.

The JSON report separates local prerequisites, configuration, executable,
spawn, initialize, exact catalog, fixture read, root binding, sandbox/approval,
and cleanup. Stages use stable reason categories and safe detail, with
`pass`/`fail`/`skipped`/`unknown` status; configuration, environment, source, and
raw errors are excluded. The selected absolute executable and argument array
are launched without shell reconstruction. Separate disposable child-cwd and
workspace fixtures establish explicit-root AST behavior rather than inferring
it from a handshake; fixed-root launchers and wrong-root results are diagnosed.
Fixtures and native cache writes are isolated from the installation and selected
configuration. Request/initialize limits are 10 seconds within a 30-second
probe deadline. Cleanup closes SDK resources, allows two seconds for graceful
shutdown, then terminates only the owned child and removes fixtures; cleanup
failure is reported. Sandbox/approval remains `unknown` without actual host
evidence. Doctor health is not evidence of model tool selection.

### Tool metadata and bounded audit

Search is annotated read-only and idempotent; previews are read-only and
non-idempotent because they issue process-local identities. Apply is destructive,
non-read-only, and non-idempotent. All five tools declare `openWorldHint: false`.
These hints preserve the schemas and guarded preview/apply authority.

Audit emits one event per completed supported tool request until its budget
is exhausted, without changing results. It is
off by default; `CODE_INTEL_AUDIT=stderr` selects stderr, while `file` plus
`CODE_INTEL_AUDIT_FILE` exclusively creates a new artifact under an existing
parent. Ordinary installer entries remain unchanged. Every event contains only
`timestamp`, `tool`, and `resultCategory` (`success`, `tool_error`, or
`internal_error`). Arguments, roots, content, prompts, previews, IDs, raw errors,
and result payloads are excluded. Each event is at most 512 UTF-8 bytes including
its newline; one process emits at most 256 events and 128 KiB across its server
instances. Capture stops at the cap without overflow events; absence after
exhaustion cannot establish non-use. Destination failures produce safe stderr
diagnostics without changing AST behavior. Audit never writes protocol stdout.
Fresh audit evidence must be paired with a host record to establish native
model-selected use; an SDK probe or audit event alone is insufficient.

## AST execution model

The unified lifecycle is:

```text
explicit target and operations
-> structural preview
-> opaque preview identity
-> state-bound revalidation
-> guarded apply
-> explicit verification
```

Preview is non-mutating. A non-empty preview stores the reviewed mutation
contract and immutable canonical workspace root and returns a process-local
identity; a zero-match preview has no pending identity. Apply accepts only that
identity, claims it synchronously before yielding, reconstructs the saved root,
and rejects missing, invalid, or differently canonicalized roots before mutation.
It then re-confines the target,
revalidates the reviewed file state, and compares a fresh dry-run plan before
enabling native mutation. Preview identities do not survive process restart.

If source or repository state changes after preview, the stale identity cannot
write. Multi-file plans issue independent per-step identities and are applied
by caller orchestration; they are not transactions and have no rollback or
aggregate apply authority. Once mutation begins, inability to prove the final
state is terminal `APPLY_STATE_UNCERTAIN`; the runtime does not hide this with
retry or rollback claims.

Migration recipes are data-only materializations of the explicit plan contract.
They add no MCP tool, discovery, callback, or mutation authority. Optional
frozen structural postconditions can prove declared AST match counts after a
successful apply; they do not prove semantic correctness or repository
validation.

### Execution responsibilities

`ast_search` performs structural discovery within the canonical workspace and
returns native structured matches. The preview tools validate explicit
operations, normalize their target scope, and capture the dry-run mutation
plan. They do not resolve symbols, infer intent, or consult an index.

`ast_edit_apply` is the sole mutation continuation. It does not accept fresh
patterns, replacements, workspace roots, paths, globs, or mutation options. The reviewed
identity supplies those values, together with the state captured at preview
time. A zero-match preview therefore has nothing that can be applied.

Transformation metadata such as rationale and opaque symbol references is
review context. It is frozen with the preview contract but does not grant
semantic authority or change native AST behavior. Structural postconditions
are likewise explicit caller assertions, not a general verification engine.

The plan and recipe surfaces preserve caller order. Preflight rejects invalid
steps and duplicate canonical targets before preview state is issued. A native
preview failure can leave earlier step identities available for review, but no
plan-level apply or rollback operation is created. Repository reconciliation
after a partial apply belongs to repository control.

Native AST results remain structured at the MCP boundary. Human-facing prose,
symbol resolution, semantic equivalence, compiler checks, Git review, and
overall correctness judgments remain outside this runtime.

## Safety invariants

- Each request's canonical workspace root bounds its user-supplied paths.
- Path resolution must not escape that root.
- Apply consumes only a reviewed preview identity, its frozen root and contract.
  Later requests selecting other roots cannot redirect that authority.
- Stale state is detected before native mutation; stale-before-write means no
  mutation.
- Uncertainty after mutation is terminal and non-retryable.
- There is no hidden retry, transaction, rollback authority, or cross-preview
  success claim.
- Current source and repository state remain authoritative over stale
  understanding context.

The runtime exposes machine-readable error categories for callers, while the
complete taxonomy and field-level contracts remain in the P1/P2 plans.

The final validation/write interval is not an external compare-and-write
primitive. The runtime therefore states the residual time-of-check/time-of-use
boundary rather than claiming filesystem transactions. Internal preview state
is bounded and process-local; expiry and restart invalidate identities.

## Retired provider bootstrap

P4-D1 removes P3's provider adapters, resolver, identity comparison, and reports.
Neither global nor legacy startup probes providers, registers workspaces,
indexes repositories, or writes provider configuration or stores. Git, provider
CLIs, and provider configuration are not startup prerequisites. There is no
optional synchronization replacement. Invalid legacy workspace roots still
fail before serving; explicit-root and request-routed AST boundaries remain.

Historical contracts and evidence are retained in
[`04-p3-project-registration-resolver.md`](plans/04-p3-project-registration-resolver.md)
and its [`04a`](plans/04a-p3-a-provider-interface-investigation.md)–
[`04d`](plans/04d-p3-d-resolver-state-machine.md), [`04f`](plans/04f-p3-f-failure-degradation-policy.md),
and [`04g`](plans/04g-p3-g-bootstrap-report-contract.md) unit plans.

## Dependency boundary

Codex configuration validation uses the exact runtime dependency
`@ltd/j-toml@1.38.0`. Complete source installations retain its original LGPL-3.0
license and notice files with the installed package; the parser is not bundled.

The AST runtime uses `@oh-my-pi/pi-natives` pinned exactly to `18.0.3` and calls
its native AST primitives directly. OMP agent, session, TUI, and LSP glue do
not enter this runtime. Routing deterministic AST operations through an OMP
agent would add model-driven orchestration to a contract that is intentionally
local and structural.

If future work copies or substantially adapts OMP source, the applicable MIT
attribution and license notice must be retained.

## Non-goals

- Repository indexing, semantic retrieval, or codebase-memory ownership.
- Repository/Git governance or generic file mutation workflows.
- Model, agent, or workflow orchestration.
- LSP mutation and workspace edits.
- Provider lifecycle supervision or reconnect handling.
- Cross-MCP transactions, rollback, or bootstrap permission elevation.
