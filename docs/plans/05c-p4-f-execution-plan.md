# P4-F — Bounded acceptance execution

Status: **PHASE_ACCEPTED by the controller; A–F accepted within the Codex
user-scope stdio scope.** The operator withdrew further reviewer delegation
and requested direct final acceptance. The decision combines the completed
user-reported full suite, focused process tests, independently validated
refusal-evidence tests and typecheck, and verified retained native-host evidence.
The observed denial is `HOST_POLICY` before process creation, not OS filesystem
denial. Evidence provenance and limits are recorded below.

## Scope and evidence contract

F covers the nine master acceptance rows below. Before/after version comparison
and a genuine-predecessor upgrade gate are cancelled requirements: they are not
run, required, or blockers. No old/private history is needed. The native runtime
remains pinned to `@oh-my-pi/pi-natives@18.0.3`.

| Master matrix row | Evidence owner and required observation | Current F status |
| --- | --- | --- |
| Global install is discoverable | Runner isolated install, native `mcp get/list` absolute argv readback, then configured `doctor` initialize/exact five-tool catalog/unique explicit-root fixture. `tests/cli.test.ts`, `tests/cli-codex-integration.test.ts` retain installer/launch contracts. | PASS: current user fresh installation independently checked; retained native readback and configured doctor verified |
| One instance, multiple projects | `tests/mcp-workspace-routing.test.ts`: existing A/B/A test and new parallel A/B searches/previews through one process and shared registry. | PASS: focused process tests and user full suite |
| Preview identity binds authority | Same routing file: new interleaved ID-only B/A applies assert frozen canonical targets/postconditions, unchanged other root, stale/replay rejection and separate consumption; existing drift/alias/apply-override tests remain. | PASS: focused process tests and user full suite |
| No unexpected provider effects | `tests/bootstrap-startup-stdio.test.ts`, `tests/bootstrap-launcher.test.ts`: isolated marker/config fixtures remain unchanged across startup and requests. Runner does not inspect or mutate live provider stores. | PASS: user full suite and isolated follow-up preservation checks |
| Path and sandbox boundaries | Routing confinement/root-validation and alias tests; independently, the actual outside-target write attempt under read-only/never-approval must be denied by host enforcement and preserve the fixture. Unsupported conditional symlink branches do not establish portability. | PASS: process boundaries passed; exact attempted write rejected by `HOST_POLICY` before process creation. No OS filesystem denial or universal MCP inheritance claim |
| Reversible host setup | Runner byte/tree no-write dry-run, owned install, new native sessions for readback, unchanged reinstall, finally uninstall restoring unrelated seed bytes/entry, unchanged repeated uninstall. `tests/cli-codex-config.test.ts` retains the wider refusal/backup matrix. | PASS: retained lifecycle stdout/readbacks verified; historical byte/tree restoration is runner-recorded |
| Clear failures | `tests/cli-doctor.test.ts` retains distinguishable prerequisite/configuration/spawn/handshake/catalog/read failures; runner invokes the real configured healthy diagnostic. | PASS: user full suite and verified retained healthy doctor output |
| Actual adoption | Runner raw native completed `mcp_tool_call` record with public `pattern/path/workspaceRoot` arguments (no `language`), expected unique A result, and one paired fresh successful file-audit event. A direct SDK probe does not satisfy this row. | PASS: actual native completed AST call and matching success audit directly re-read; timing bounds are runner-recorded |
| Existing AST safety | Existing AST/guarded apply/transformation/verification tests and `tests/mcp-apply-stdio.test.ts`; new routing stdio invalid-late-plan test requires a valid early step, rejection without usable identities, and unchanged A/B bytes. | PASS: user reports 205 pass, zero failures, exit 0; separate four refusal-evidence tests and current typecheck pass |

## Reproduce

Run from the repository with Bun and an existing complete local dependency
installation. The runner resolves the repository from `import.meta.url`, not cwd.
Its artifact base must be under the allowed local cache; each invocation creates
a new GUID subdirectory. In PowerShell:

```powershell
$fArtifacts = Join-Path $env:LOCALAPPDATA 'CodexRepoCaches/code-intel-mcp/phase-f'
bun run scripts/validate-phase-f.ts --artifacts $fArtifacts --self-check
bun run scripts/validate-phase-f.ts --artifacts $fArtifacts
bun run scripts/validate-phase-f.ts --artifacts $fArtifacts --fresh
```

`--codex <absolute-native.exe>` selects a native executable explicitly. Without
it, normal Windows APPDATA npm package locations are checked exactly; no process
or filesystem-wide discovery is used. Bun is `process.execPath`. Host gates
require Windows and available legitimate native authentication. The runner
neither reads nor copies the legitimate `CODEX_HOME`; only the actual native
host inherits it for authentication, with `--ignore-user-config --ephemeral`.
Do not point the legitimate host at the disposable authless lifecycle home.

The default is **REUSE_NOT_FRESH**: copy only runtime source/entry/manifests and
link the existing local dependencies into a space/Unicode installation path.
`--fresh` instead uses an isolated initially empty Bun cache and a frozen-lock
normal-registry install with normal archive integrity checking, bounded to
120 seconds including cleanup reserve. There is no integrity bypass, package
upgrade, or fallback to reused dependencies after a failed fresh install.
The current F user-terminal receipt records 22 packages installed from the normal
registry into an isolated source installation with an empty cache. Independent
checks confirmed matching manifest/lock bytes, dependencies resolved inside that
installation, native `18.0.3`, the five-tool catalog, an AST read, and fixture
preservation. This satisfies current fresh-install evidence without another
download. It does not claim the new runner's `--fresh` mode was executed; that
mode remains optional reproduction. Earlier A–E receipts remain owned by 05b.

`--self-check` is offline and mutually exclusive with `--fresh`. It checks local
prerequisites before dependency-backed imports, the actual rendered public
`ast_search` schema, the unique fixture result, and argument/event handling.
It starts only the local MCP entry, with isolated caches; it starts no native
Codex host and reads no host configuration or authentication. Exit 0 means
`SELF_CHECK_PASS_ONLY`, never native F acceptance.

## Host and lifecycle limits

All installer mutations select an isolated seeded `CODEX_HOME`. Its unrelated
comments/settings/entry are safe fixture data. Dry-run and repeat operations
compare complete selected-home bytes and entries in memory. Real native
`mcp get/list` runs are new sessions reading installed configuration; this is
the restart contract, with no hot-reload claim. The configured diagnostic
checks initialize/catalog and an expected fixture result from a distinct root
and child cwd. Registration remains installed through actual host runs and is
uninstalled in `finally`, including when adoption or shell evidence is blocked.

Actual native host runs use the absolute copied stable entry plus `serve`, an
invocation-only MCP entry and a fresh bounded file audit, read-only sandbox,
and never-approval syntax. Each has a total 180-second budget including cleanup
reserve; prompts go through stdin. No full-access option, policy weakening,
authentication copying, or provider reconfiguration is used. Existing host
policy may still prevent a run; record that exact external BLOCK.

The AST task must select the public tool and return the unique A sentinel while
cwd B contains a decoy. Native JSON evidence is read from completed
`mcp_tool_call` items, including `result.structured_content`; started items,
agent prose, a tool list, or an SDK result cannot stand in for adoption.
The independent shell task asks for exactly one bounded write to the runner's
owned outside file without escalation. Evidence must identify the intended
`Set-Content` command, outside target and per-run marker. It may be a completed
native `command_execution` denial or a native `codex_core::tools::router`
`exec_command` / `CreateProcess` rejection frame in retained stderr. The latter
is labelled `HOST_POLICY`: it proves a tool attempt rejected before process
creation, not a spawned command blocked by the filesystem sandbox. Structured
OS/filesystem denial is labelled separately; an unspecified command enforcement
layer remains unspecified. Model prose/refusal alone is BLOCK; a successful
write/command is FAIL and overrides denial evidence. This distinction does not
establish universal sandboxing. The controller accepted this actual denied
outside-write request as the master host-boundary observation; no OS filesystem
denial is inferred. MCP confinement
is covered separately by process tests. Universal inheritance of the host
sandbox by MCP processes is not an F gate and is not claimed measured here.

Cleanup tracks directly spawned PIDs and, for actual native hosts, only children
queried by exact known parent PID. It does not perform a broad process census
or broad kill. Tracking unavailability blocks host evidence. Cleanup allows
two seconds for graceful shutdown before terminating remaining known owned
PIDs. Scratch deletion verifies containment inside the current GUID run.

## Retained results and handoff

Each run retains `summary.json`/`summary.md`, exact local invocations, raw host
JSONL and stderr, prompts containing only fixture data, fresh bounded audit
files, lifecycle receipts, and minimal source/fixture/configuration preservation
comparison results. Comparisons use in-memory bytes and tree entries, without
hashes. Source preservation is scoped to copied runtime inputs; status capture
records names/status without reading unrelated user files. Concurrent source
or status changes cannot be attributed to this runner merely from a difference.
Live host configuration preservation is labelled `NOT_READ`, not a claimed
before/after byte proof. Raw configuration/environment/authentication values
and private absolute paths or run identifiers must not be copied into public
documentation.

Exit codes are 0 only when every selected runner gate passes, 2 for external
blocks or missing adoption/denial evidence, and 1 for a failed contract or
observed successful forbidden write. Unreached gates remain `NOT_RUN`. A default
reuse pass alone does not satisfy fresh-install evidence; the independently
checked current user receipt supplies that separate evidence.

## Current validation and final acceptance

- External focused routing/apply/plan tests passed: 26 tests, 404 assertions.
  These include the new late-invalid-plan and parallel A/B process cases.
- Runner offline self-check exited 0 with the actual catalog/schema and unique
  AST fixture result. It establishes no native host adoption or sandbox denial.
- The operator reported a completed full suite: **205 pass, zero failures,
  exit 0**. This is `USER_REPORTED`, not an independently repeated run. It
  predates the four refusal-evidence tests added afterward.
- Independent follow-up ran `bun test ./scripts/validate-phase-f.test.ts`:
  **4 pass, zero failures, 22 assertions, exit 0**. Attribution negatives,
  Windows denial wording, successful-command precedence and both enforcement
  layers are covered. Current `bun run typecheck` also exited 0. These checks
  are separate; no combined 209-test full-suite result is claimed.
- The retained native run verifies installed argv, healthy doctor, unchanged
  reinstall, uninstall/no-op and new-session configuration readback. Its actual
  model-selected `ast_search` returned the unique A fixture from cwd B and has
  a matching successful audit event.
- The original runner summary remains `BLOCK` because its parser missed the
  native router stderr rejection. The corrected parser was independently run
  offline against the unchanged actual prompt/JSONL/stderr: one exact-target,
  per-run-marker attempt and one `HOST_POLICY` denial before process creation,
  with no successful command. No new host run or rewritten historical summary
  is implied by this supplemental result.
- Historical runtime/fixture comparisons, configuration restoration, audit
  timing bounds and owned PID closure are `RUNNER_RECORDED`; follow-up verified
  retained records and current scratch absence, not the original in-memory
  snapshots or historical process state. Live configuration remains `NOT_READ`.
- The controller directly accepted all nine rows under the operator's explicit
  instruction withdrawing further reviewer delegation. The earlier F-01/F-02
  evidence gaps are resolved by the completed user run and verified retained
  native evidence; F-03's factual documentation correction is complete. This
  is controller acceptance, not a new independent reviewer PASS. A–E acceptance
  is unchanged, and before/after version comparison remains cancelled.
