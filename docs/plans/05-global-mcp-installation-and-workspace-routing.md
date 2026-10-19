# P4 — Global MCP Installation, Multi-Workspace Routing, and Agent Adoption

Status: **A–F accepted for Codex user-scope stdio integration; P4 complete within that scope.** A–E retain their independent acceptance and evidence in [05a](05a-p4-abc-execution-plan.md) and [05b](05b-p4-de-execution-plan.md); C-NET-01 and E3-01 remain resolved. F is `PHASE_ACCEPTED` by the controller under the operator's explicit direction to perform final acceptance directly. The operator reported a completed 205-pass full suite; independent follow-up passed four additional refusal-evidence tests and typecheck, and verified the retained native host/lifecycle/adoption evidence. These are separate runs, not a claimed combined full suite. The observed outside-write restriction was a host-policy rejection before process creation; it does not establish OS filesystem denial or universal MCP sandbox inheritance. [05c](05c-p4-f-execution-plan.md) owns the nine-row matrix, reproduction and provenance limits. Before/after version comparison and the predecessor upgrade gate were cancelled by the operator. This plan supersedes the *deployment assumptions* of P3, not the AST preview/apply safety contracts.

## Problem and observed baseline (before P4)

`code-intel-mcp` implements five stdio tools (`ast_search`, `ast_edit_preview`, `ast_transform_preview`, `ast_transform_plan_preview`, `ast_edit_apply`), but there is no clear, reproducible path from an installation to an agent invoking one. The current launcher (`scripts/mcp-launch.mjs`) treats `process.cwd()` as a single workspace root; direct startup requires `--workspace-root`. Both approaches couple the MCP process to one repository and assume the host launches it from the expected directory.

P3's "project registration" is *outbound*: at server startup, it probes the `codebase-memory-mcp` project store (without registering missing projects) and tries to register a missing root in `gpt-repo-stdio` at `read` permission. This does **not** register `code-intel-mcp` with an agent host. The result is logged on stderr, not exposed as a host-installation diagnosis. Registration with a provider, registration of a server in a host, MCP `tools/list` discovery, and actual model tool invocation are four separate states.

The P3 plan records an installation of `code_intel_mcp` in `~/.codex/config.toml`, but this historical claim alone does not establish the currently deployed host configuration or any actual agent calls. Read-only live verification is required; do not infer success from a plan's completion status. The `gpt-repo-mcp` precedent is its documented, explicit CLI/stdio client setup and project-management commands; the `codebase-memory-mcp` precedent is reducing per-project manual work, not forcing its index-coupled registration interface into this server.

### Outcome

An operator installs `code-intel-mcp` **once per agent host**, verifies it with a diagnostic command, and then uses it against any workspace that the host process can legitimately access, without registering each workspace in another MCP's registry. Existing structural safety checks remain in force. An agent-use smoke test must demonstrate at least one actual tool invocation; a healthy MCP handshake alone is insufficient evidence of use.

## Binding decisions

1. **Separate three responsibilities.** (a) Host installation/discovery is owned by a local installer and the agent host; (b) per-call workspace selection is owned by `code-intel-mcp`; (c) provider project/index registries remain owned by `codebase-memory-mcp` and `gpt-repo-mcp`. No component's registry entry is treated as proof of another component's availability.
2. **Global installation, not a global filesystem root.** One stdio server instance can serve multiple workspaces in a session. Its startup does not derive workspace authority from the install directory, CLI working directory, or a provider's registered roots. Each search/preview request supplies an explicit absolute `workspaceRoot`. `ast_edit_apply` continues to accept **only** `previewId`; the frozen preview selects the workspace and target. No default implicit root in global mode.
3. **No obligatory project allowlist or Git requirement.** A caller may select any existing accessible directory, including a non-Git workspace. Server-side lexical/canonical confinement applies **within that request's selected root**; it is not an unrelated provider-project admission check. Native file access remains bounded by OS permissions and the host's configured sandbox. Do not assume all clients actually provide a sandbox.
4. **Preserve guarded writes.** Preview-first mutation, unique/expiring/replay-protected preview IDs, frozen plans, revalidation, stale-state rejection, symlink confinement, and terminal uncertainty semantics remain mandatory. A preview stores the immutable canonical `workspaceRoot` together with its scope and target; apply must never accept a new root or rebind an existing preview to another workspace. Keep multi-step preview/apply semantics nontransactional unless separately designed.
5. **No hidden cross-MCP mutations at MCP startup.** D1 retires P3's provider probes and registration implementation without an optional replacement. Global, legacy, and fallback startup do not index, register, or rewrite another provider's state. Git, provider CLIs/configuration, registration, and indexing are not AST startup prerequisites.
6. **Explicit, reversible host configuration.** Do not silently edit all discovered clients. Installation targets a user-selected host/scope, shows a dry-run diff, preserves unrelated configuration, checks for an existing entry, and supports idempotent reinstall/uninstall. A host config that cannot be safely edited must produce an exact manual snippet instead of being overwritten.
7. **Diagnostic proof has levels.** Verify `configuration present -> process spawn -> MCP initialize -> tools/list -> fixture read call -> optional guarded write -> recorded real-agent call` separately. A successful tool list never implies that an agent selected the tool. Avoid claiming negative evidence beyond available host/MCP logs.
8. **Codex first, portable next.** Codex user-level local stdio integration is the first supported, tested path. Inspect the installed versions of Codex and OMP before committing their exact config schema or reload behavior. Add OMP support after the same contract is validated; provide an explicit stdio configuration snippet for other hosts. HTTP, tunnels, scheduled tasks, and a background daemon are out of scope.

## Implemented operator interface

The stable source-installation invocation and absolute executable/launcher paths
are documented in the README. The CLI implements:

```text
code-intel install --host codex --scope user --dry-run
code-intel install --host codex --scope user
code-intel doctor --host codex
code-intel doctor --host codex --config <selected-config-path>
code-intel print-config --host generic-stdio
code-intel uninstall --host codex --scope user
```

`doctor` reads the selected configuration without mutation and separates local
dependencies, configuration, executable, spawn, initialize, exact five-tool
catalog, fixture AST read, root binding, sandbox/approval, and cleanup. Its
preflight runs before dependency-backed imports and never installs packages.
Requests are limited to 10 seconds within a 30-second probe deadline, with
two-second graceful cleanup before owned-child termination. Sandbox/approval
is `unknown` without trustworthy evidence. The installed entry refers to the
service runtime/launcher, not a workspace. Doctor success does not demonstrate
host reload propagation or model-selected use.

Implemented public MCP tool contracts:

| Tool | Workspace selection | Mutation |
| --- | --- | --- |
| `ast_search` | Required absolute `workspaceRoot` plus existing `path`/`glob` scope | None |
| `ast_edit_preview` | Required absolute `workspaceRoot` plus existing target/operations | Dry-run only |
| `ast_transform_preview` | Required absolute `workspaceRoot` plus existing explicit transformation | Dry-run only |
| `ast_transform_plan_preview` | Required absolute `workspaceRoot` plus ordered scoped steps | Dry-run only |
| `ast_edit_apply` | `previewId` only; internally resolve frozen canonical workspace and target | Guarded, revalidated write |

`workspaceRoot` names the intended trust/containment scope. A target may not escape that root lexically or through aliases/symlinks, even when the host grants broader process access. In a multi-root process, two previews targeting the same absolute file through different selected roots are distinct reviewed scopes; neither may borrow the other's authority. Do not use the native AST target path alone as a substitute for frozen root identity.

## Delivery plan

### P4-A — Verify host exposure and establish the installation contract (read-only)

**Work:** Inspect actual Codex and, if available, OMP host MCP settings and version-specific config semantics; distinguish the P3 historical config claim from current state. Capture which executable/args/env the host starts, the actual startup working directory, the relevant restart/reload mechanism, and errors reported for missing Bun, missing dependencies, bad quoting, or invalid config. Probe the existing server with MCP `initialize` and `tools/list` independently of the host, without editing host settings or provider registries. Compare the human setup path with `gpt-repo-mcp`'s `connect-gpt`/stdio conventions and `codebase-memory-mcp`'s automatic workspace experience; record the differing guarantees.

**Deliverables:** A short host-support/compatibility table; a verified baseline reproducer; chosen binary/launcher packaging; documented client config schemas; an explicit answer to "is it registered, discoverable, and ever invoked?" with evidence separated by level. Record limitations if protected local config or agent invocation logs cannot be read.

**Gate:** A maintainer can reproduce a clean-host MCP handshake and name the exact missing link, without relying on P3's success label. Do not modify host configs in this phase.

### P4-B — Decouple workspace selection from server lifetime

**Work:** Refactor the server factory and AST request paths to resolve a `Workspace` from each search/preview request, not from `startServer(process.cwd())`. Validate required absolute `workspaceRoot`, existence/directory shape, canonicalization and lexical containment; preserve cross-platform path/UNC behavior and structured errors. Keep the five-tool surface; update schemas rather than adding a gratuitous project-registration tool.

The current `PreviewRegistry` stores a canonical target and mutation fingerprints, while `guardedAstEditApply(workspace, registry, previewId)` receives the workspace externally. Make the canonical root an immutable part of the preview state and derive the apply workspace **from that state**, never from caller arguments, global mutable "current project" state, or startup cwd. Preserve process-local TTL/capacity and stale checks; test concurrent A/B workspaces and cross-root aliasing. Retain the legacy `--workspace-root` entrypoint temporarily behind an explicitly documented compatibility path, not as a global-mode prerequisite; decide removal only after migration tests.

**Likely files:** `index.ts`, `scripts/mcp-launch.mjs`, `src/server.ts`, `src/workspace.ts`, `src/ast/preview-registry.ts`, `src/ast/preview-state.ts`, `src/ast/guarded-apply.ts`, relevant AST input contracts and tests.

**Gate:** One process can perform `ast_search`/preview against projects A and B without restart; applying B's `previewId` cannot act on A, and workspace changes do not invalidate unrelated previews. Missing root, root escape, symlink escape, stale preview, replay, and invalid target tests pass. Legacy startup compatibility is explicitly covered.

### P4-C — Install/inspect/uninstall the server at the host layer

**Current acceptance:** `PHASE_ACCEPTED`. The user supplied the successful fresh normal-registry empty-cache frozen-install receipt; independent checks of that installed tree and reviewer PASS resolved C-NET-01. This does not claim an independently agent-performed download or model-selected use. See [05b](05b-p4-de-execution-plan.md).

**Work:** Add a stable executable entry (the name `code-intel` above is provisional) and a user-facing installation CLI. Select one reproducible launcher/binary packaging method; handle Windows absolute paths, spaces, non-ASCII names, UNC/WSL distinctions, interpreter discovery, and dependencies without assuming a developer checkout's cwd. Support a Codex user-scope install first, using the *confirmed* local config schema. Discover/modify only the selected host and one owned entry (`code_intel_mcp`, subject to live compatibility check). Provide `--dry-run`, existing-entry reconciliation, atomic writes where supported, backups or fail-closed handling for unsafe merges, uninstall of owned keys only, and manual-snippet fallback.

Do not create a service daemon, a scheduled task, a provider project record, or a per-repository config file. Installation must be an explicit user action, not an import/normal MCP startup side effect. OMP user-scope support is a separate adapter after verifying its actual schema; unknown hosts use `print-config` rather than guessed writes.

**Likely files:** `package.json`, a new `src/cli/` entry, a stable launch entry, focused installer/config parser tests, `README.md` and setup docs on implementation.

**Gate:** Fresh install => recognizable host entry => MCP `tools/list` passes after the documented reload. Repeating install does not duplicate or corrupt entries. Uninstall removes only the owned entry. Existing unrelated entries and comments/unknown settings are retained, or the operation aborts without changes. Host config changes are absent in `--dry-run`.

### P4-D — Remove implicit provider-registration coupling

**Current implementation:** D1 removes the provider bootstrap caller, source,
and exclusive tests; retains global and legacy explicit-root startup; and
includes provider-absence and provider-marker startup coverage. No optional
synchronization facility is retained. D is `PHASE_ACCEPTED`: its prior
mechanical/source review remains valid, and the sole inherited C-NET-01 block
is resolved. See [05b](05b-p4-de-execution-plan.md).

**Work:** Remove P3's external provider probes/registration from all startup paths and retire their source and exclusive tests without an optional replacement. Preserve the global, legacy explicit-root, and cwd-launcher AST contracts and their startup coverage. Never promote a missing `codebase-memory-mcp` project to an automatic `index_repository` call. Do not require `GPT_REPO_CONFIG`, `REPO_READER_CONFIG`, provider CLIs, Git repos, or a provider registration to use an AST tool.

**Gate:** Global and legacy startup serve AST reads without providers or Git; retired bootstrap cannot execute, and no provider-owned configuration/store or fixture source changes occur. The distinction between host installation and provider project registration is documented.

### P4-E — Make discovery and use diagnosable

**Current acceptance:** `PHASE_ACCEPTED`; E3-01 is resolved. E1 doctor and E2
metadata/audit retain their prior validation. The user-terminal native Codex run
selected `ast_search`, returned the expected unique fixture result, and produced
a fresh success audit event. Independent retained-evidence validation and final
major E reviewer PASS accepted E with no findings. Preservation provenance and
owned-process cleanup evidence belong to [05b](05b-p4-de-execution-plan.md).

**Work:** Implement `doctor` with structured verdicts for host entry/config path, executable resolution, process spawn, MCP handshake, expected tool catalog, and a nonmutating disposable-fixture `ast_search` call. Include a diagnostic for a launcher that accidentally targets its installation folder or the host's cwd. Report sandbox/approval status only where host configuration actually exposes trustworthy evidence; otherwise mark it `unknown` with guidance, not "protected".

Tool descriptions/annotations explain structural search, preview nonmutation,
explicit global workspace selection, and reviewed-ID-only apply. Audit is off
by default: `CODE_INTEL_AUDIT=stderr`, or `file` with `CODE_INTEL_AUDIT_FILE`
selecting a new exclusively created artifact under an existing parent. Events
contain only `timestamp`, `tool`, and `resultCategory`; no roots or workspace
identities, content, arguments, IDs, raw errors, or payloads. Limits are 512
UTF-8 bytes including newline per event, 256 events and 128 KiB per process.
Capture stops at the cap without affecting tools and never uses protocol stdout.
Ordinary installer entries contain no audit settings. Missing events after
exhaustion do not demonstrate absence of use.

**Gate:** A deliberately broken config, missing runtime, failing handshake, missing tool, and a healthy server produce distinguishable reports. An actual host-selected AST call is recorded without leaking source. No audit feature writes to stdout (reserved for MCP protocol frames).

### P4-F — Cross-workspace, sandbox, and agent-invocation acceptance

**Current status:** `PHASE_ACCEPTED` by direct controller acceptance, as requested by the operator. Current F process tests, user-reported completed full suite, fresh-install checks, retained native lifecycle/adoption evidence, and independent refusal-evidence/type checks satisfy the matrix. The actual outside write was rejected by host policy before spawning; OS filesystem denial is not claimed. [05c](05c-p4-f-execution-plan.md) records the evidence and preservation limits. No additional reviewer delegation was used for this final acceptance.

**Work:** Build hermetic fixtures A and B, plus an out-of-scope directory; use process-level MCP tests and host-level smoke runs. Exercise switching A -> B -> A in one process, native AST search, preview-only no-write, apply-only-reviewed-ID, stale/replayed/cross-root previews, symlink and traversal escape, invalid roots, mixed valid/invalid transformation plans, and parallel requests. Run a host configured with a restrictive sandbox, confirm the sandbox blocks edits outside its grants, and separately verify code-intel's in-root confinement. Do not confuse an MCP-level path check with evidence of a sandbox.

Run at least one **real agent task** whose target clearly benefits from `ast_search`, capture paired host call evidence and a fresh MCP audit event, and report whether the agent actually selected `code-intel-mcp`. A host-specific selection recipe/guideline may be added, but success must not be fabricated from `tools/list`. Test a fresh host install, idempotent reinstall, and uninstall, plus the documented restart behavior. Before/after version comparison and a genuine-predecessor upgrade gate are cancelled requirements and must not block F.

**Gate:** The acceptance matrix below passes and recorded artifacts allow another maintainer to reproduce the results. Failure on the "agent invoked a tool" gate is an adoption defect even if all deterministic runtime tests pass.

## Acceptance matrix

| Scenario | Pass evidence |
| --- | --- |
| Global install is discoverable | Host config inspected, stdio process starts, `initialize` and the same five expected `tools/list` names succeed |
| One instance, multiple projects | A/B/A `ast_search` requests succeed without relaunch or per-project registration |
| Preview identity binds authority | B's preview applies only to frozen B scope; swapping roots, replay, and stale data cannot redirect writes |
| No unexpected provider effects | Provider configs/index remain unchanged across plain MCP startup and AST calls |
| Path and sandbox boundaries | Escape/symlink tests reject out-of-root access; independently, a configured sandbox denies ungranted files |
| Reversible host setup | Dry-run is no-write; install is idempotent; uninstall leaves unrelated client settings unchanged |
| Clear failures | `doctor` distinguishes not installed, spawn error, handshake error, tool mismatch, and healthy read call |
| Actual adoption | At least one tool call from a real agent is evidenced, not inferred from installation or a test client |
| Existing AST safety | Existing tests and focused new tests pass: preview-only, guarded apply, stale detection, postconditions, uncertainties |

## Migration and rollback

- Keep P3/legacy single-root behavior usable during the first implementation slices, with deprecation notices only after global mode and installer tests pass. Do not silently reinterpret existing `--workspace-root` deployments or mutate their provider registries during migration.
- Perform host-config edits only after a visible dry-run and operator-initiated install; produce restore guidance/backup when changed. `uninstall` must not remove any pre-existing entry it did not create or take ownership of.
- If multi-workspace routing or installer release regresses, the documented legacy explicit-root command remains the fallback until a subsequent planned removal. A failed installation must not prevent direct manual MCP startup.
- On completion, update `docs/architecture.md` (runtime and bootstrap normative boundary), `README.md` (quickstart), applicable P3 cross-references, and the actual executable configuration examples. Do not rewrite historical P3 test evidence as though it had never happened.

## Non-goals and open checks

This phase does **not** add indexing, semantic target inference, Git operations, cross-MCP transactions, unrestricted write tools, a model router, automatic system-wide plugin discovery, or an HTTP/remote endpoint. No requirement to register every workspace into `gpt-repo-mcp` or `codebase-memory-mcp` is introduced.

Before locking implementation details, P4-A must confirm: current Codex/OMP configuration forms and whether user-global MCP registration actually propagates into project sessions; startup `cwd` guarantees (if any); sandbox configuration and approval behavior on the target host; whether existing Codex settings already contain a functional `code_intel_mcp` entry; and the simplest durable Windows launcher packaging. When any host lacks a reliable user-level install API, prefer a generated exact manual configuration plus diagnostic verification over speculative config writes.

**Implementation sequence:** P4-A -> P4-B -> P4-C -> P4-D -> P4-E -> P4-F. A phase may be sliced further, but no "P4 complete" claim is valid without the last real-agent invocation gate.
