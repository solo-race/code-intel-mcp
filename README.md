# code-intel-mcp

`code-intel-mcp` is the deterministic AST execution layer for Codex. It turns
explicit structural targets and operations into reviewed previews, guarded
mutations, and bounded structural verification.

## Three-layer boundary

| Component | Role | Responsibility |
| --- | --- | --- |
| `codebase-memory-mcp` | Knowledge / Where & Why | Indexing, symbol and relationship retrieval, and architecture context. |
| `code-intel-mcp` | Execution / How & Verify | Deterministic AST search, preview, guarded apply, and structural verification. |
| `gpt-repo-stdio` | Repository Control / Diff, Test, Git | Repository status, review, validation, and Git workflow. |

The orchestrator carries explicit targets and rationale from understanding to
execution, then carries reviewed results to repository control. These servers
are not runtime dependencies of one another.

## Public MCP surface

The server exposes exactly five tools:

- `ast_search`
- `ast_edit_preview`
- `ast_transform_preview`
- `ast_transform_plan_preview`
- `ast_edit_apply`

The workflow is preview-first: a preview performs structural dry-run work and
does not write. A non-empty preview returns a process-local opaque identity;
`ast_edit_apply` accepts only that identity, revalidates the reviewed state,
and writes only when the target and mutation plan are still current. Stale
state is rejected before writing. A failure after mutation begins is reported
as uncertain and is not silently retried. Multi-file plans use independent
identities and are not transactions.

In global mode, search and all three preview tools require an explicit absolute
`workspaceRoot`. One process can serve multiple workspaces. Each non-empty
preview freezes its canonical workspace root; apply reconstructs and validates
that root from the stored identity and accepts no workspace argument.

## Provider-independent startup

Global and legacy fixed-root startup serve AST requests without Git, provider
CLIs, provider configuration, project registration, or indexing. P4-D1 removes
the P3 provider probes, registration, and startup reports, including their
implementation; no optional synchronization replacement is retained. Provider
registries remain under their providers' ownership.

Legacy host configuration starts the service through the same-process Bun launcher:

```text
Codex host -> bun scripts/mcp-launch.mjs
           -> startServer(process.cwd()) -> stdio MCP
```

The launcher does not spawn a second Bun process.

## Start and develop

Global request-routed startup (no provider bootstrap):

```bash
bun scripts/code-intel.mjs serve
```

Legacy fixed-root startup:

```bash
bun run index.ts --workspace-root <path>
```

Legacy host-style startup (uses the host process cwd):

```bash
bun scripts/mcp-launch.mjs
```

Each selected workspace root must exist and is canonicalized before execution.
Every tool path must remain inside that canonical boundary. Legacy requests
may omit `workspaceRoot`; an explicit root must canonicalize to the startup
root. Global mode never selects a workspace from cwd and performs no provider
registration. `bun run index.ts serve` is also available for source development.

The AST runtime uses the pinned
`@oh-my-pi/pi-natives` version `18.0.3` directly; OMP agent/session/TUI code is
not part of this runtime.

Useful development commands:

```bash
bun install
bun run typecheck
bun run smoke-ast.ts
bun test
```

## Install for Codex

Keep a complete source installation with its lockfile and installed dependencies,
and retain the Bun runtime. Configuration validation uses
`@ltd/j-toml@1.38.0` in memory, with TOML 1.0 mode and extensions disabled.
Keep its original LGPL-3.0 license and notice files in the installed package.
The package declares a `code-intel` bin; the
authoritative invocation uses absolute paths and does not require a PATH alias:

```text
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs --help
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs install --host codex --scope user --dry-run
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs install --host codex --scope user
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs uninstall --host codex --scope user --dry-run
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs uninstall --host codex --scope user
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs print-config --host generic-stdio
```

Installation is an explicit configuration operation. It targets
`CODEX_HOME/config.toml` when set, otherwise `~/.codex/config.toml`. To evaluate
the installer in isolation, set `CODEX_HOME` to a disposable directory for its
child processes. Dry-run creates no directories, files, temporary files, or
backups. Neither install nor dry-run proves a successful MCP handshake.

The generated stdio entry contains the absolute Bun executable and the absolute
CLI path followed by `serve`; it supplies no workspace, cwd, or provider
environment. Keep the installation directory available. Moving it requires
explicit host reconfiguration. The CLI does not install dependencies, change
PATH, translate Windows/WSL paths, or install OMP/system-scope entries.

The installer appends an owned tail block and preserves all original bytes.
Reinstall is a no-op; uninstall removes only the exact owned tail and its
separator. Equivalent existing entries remain externally managed. Conflicts,
invalid TOML, or modified/non-tail owned blocks require manual configuration;
the refusal includes the exact snippet and does not take ownership. Each real
replacement of an existing configuration saves an exclusive byte-exact backup,
reports its location and restore guidance, and aborts if configuration bytes
change before replacement. Check concurrent edits before restoring a backup.

Inspect proposed configuration with install dry-run; inspect the selected
Codex home using `codex mcp get code_intel_mcp --json` and `codex mcp list --json`.
After configuring a live host, start a new CLI session, restart the IDE
extension, or use desktop Save + Restart. Reload propagation and real-agent
tool selection remain separate acceptance work.

For the isolated real-Codex integration test, set `CODE_INTEL_TEST_CODEX` to an
absolute native Codex executable (not a shell wrapper), then run
`bun test ./tests/cli-codex-integration.test.ts`. This test creates its own
`CODEX_HOME`, reads configuration back through Codex, and handshakes using the
returned argv. Without that variable the integration test is skipped; its gate
requires an explicit run. Config inspection and a direct client handshake do
not demonstrate real-agent adoption.

## Diagnose Codex and observe requests

Run doctor through the stable absolute invocation:

```text
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs doctor --host codex
<absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs doctor --host codex --config <selected-config-path>
```

Doctor reads the selected configuration without editing it; missing configuration
stays absent. It reports JSON stages with `id`, `status`, `reason`, and safe
`detail` for local dependencies, configuration, executable, spawn, initialization,
the exact five-tool catalog, fixture AST read, root binding, sandbox/approval,
and cleanup. Local dependency preflight precedes dependency-backed imports;
doctor never installs or downloads packages. It probes a disposable workspace
using an explicit absolute root and a different child cwd. Initialization and
requests are limited to 10 seconds within a 30-second probe deadline; cleanup
allows two seconds of graceful shutdown before terminating the owned child.
A failed diagnostic exits unsuccessfully. Sandbox/approval remains `unknown`
without trustworthy host evidence; a healthy doctor does not prove agent use.

Audit is off by default. Set `CODE_INTEL_AUDIT=stderr` for content-free JSON
events on stderr, or `CODE_INTEL_AUDIT=file` with `CODE_INTEL_AUDIT_FILE` selecting
a new local file under an existing parent. File capture exclusively creates the
artifact and never overwrites one. Ordinary installer entries contain no audit
settings. Each event contains only `timestamp`, `tool`, and `resultCategory`
(`success`, `tool_error`, or `internal_error`): no roots, content, arguments,
IDs, errors, or payloads. Limits are 512 UTF-8 bytes including the newline per
event, 256 events and 128 KiB per process. Capture stops at the cap without
affecting tools; absent events after exhaustion do not prove absence of use.
Destination failure is reported safely on stderr. Audit never uses MCP stdout.

## Current capability status

- P0/P1 structural search, preview, and guarded apply: available.
- P2 explicit transformations, ordered plans, data-only migration recipes,
  and frozen structural postconditions: available.
- P3 deterministic project-registration bootstrap: retired by P4-D1; historical
  evidence remains in the P3 plans.
- P4 A host exposure/installation contract and B request-level workspace routing
  and frozen preview root authority:
  accepted by independent review.
- P4 C stable CLI and reversible Codex user installation:
  `PHASE_ACCEPTED` by independent reviewer PASS. C-NET-01 is resolved by the
  user's fresh normal-registry empty-cache frozen install and independent
  post-install checks, including isolated real-Codex configuration integration.
  The agent did not independently perform the registry download.
- P4 D1 startup retirement: `PHASE_ACCEPTED`; the reviewer confirmed the prior
  mechanical/source review remains valid after the inherited C block resolved.
- P4 E doctor, metadata/audit, and actual Codex-selected AST call:
  `PHASE_ACCEPTED` by final major reviewer PASS; E3-01 is resolved by the
  user-terminal native run and independently verified retained evidence.
- A–E are accepted; F has not run, so P4 completion is not claimed.
  Bounded evidence and preservation provenance are recorded in [05b](docs/plans/05b-p4-de-execution-plan.md).
- LSP mutation, semantic retrieval, provider supervision, and cross-MCP
  transactions: deferred or out of scope.

See [`docs/architecture.md`](docs/architecture.md) for the current normative
design and [`docs/plans/`](docs/plans/) for detailed contracts, decisions, and
stage-specific evidence.

## License boundary

If future work copies or substantially adapts MIT-licensed OMP source, retain
the applicable attribution and license notice.
