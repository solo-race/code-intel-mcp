# P4 A–C — Global Installation and Workspace Routing Execution Plan

Status: **SEALED — the plan and Phases A–C are accepted by independent reviewer PASS, including C1–C3 and A–C regression closure after C-01.**

Revision status: **C-TOML-R1 — SEALED (CstrictPlanReview); implementation accepted in the final independent reviewer PASS after C-01.** A/B acceptance remains valid. Other C contracts, the master sequence, and the deadline are unchanged.

This document refines and records acceptance of A–C of [`05-global-mcp-installation-and-workspace-routing.md`](05-global-mcp-installation-and-workspace-routing.md). It does not replace the master plan or declare all P4 complete.

## Objective and scope

Deliver three outcomes in order:

1. **A:** Establish a reproducible, read-only host and MCP baseline.
2. **B:** Support explicit request-level workspace selection while binding apply authority to the workspace frozen in each preview.
3. **C:** Provide a stable runtime entry and reversible Codex user-scope installation, validated using an isolated `CODEX_HOME`.

Preserve the master sequence A → B → C → D → E → F. This execution slice authorizes only A–C.

The following remain excluded:

- D’s retirement or broader restructuring of existing P3 provider bootstrap.
- E’s `doctor`, request auditing, and adoption diagnostics.
- F’s real-agent selection and complete sandbox acceptance.
- Daemons, scheduled tasks, HTTP endpoints, system-scope installation, OMP installation, automatic provider registration, and additional MCP tools.
- Changes to the live user `~/.codex/config.toml` or another MCP provider’s configuration/store.
- Dependency upgrades, unrelated packages, indexing, semantic inference, or transactional multi-file apply.

Completion of A–C must not be reported as completion of all P4.

## Evidence and baseline

### Repository evidence

The planning packet identifies initial HEAD as `242d7776a20fc759865b6d062226d0cfa71393df`, initially clean. Targeted repository reads confirmed the following source behavior.

| Source | Observed fact | Implementation implication |
| --- | --- | --- |
| `README.md`; `docs/architecture.md` | Five public tools; preview-first mutation; fixed startup workspace; existing P3 bootstrap | Update affected current contracts during implementation without rewriting historical P3 evidence |
| `package.json` | Private package, no bin entry, direct dependency on `@oh-my-pi/pi-natives` exactly `18.0.3` | Add a stable CLI entry; preserve the exact pin |
| `scripts/mcp-launch.mjs` | Calls `startServer(process.cwd())` in the same Bun process | Existing launcher depends on host cwd |
| `index.ts` | Explicit `--workspace-root` startup; `startServer` canonicalizes the root and starts bootstrap | Preserve this legacy path; create a separate rootless global serving path |
| `src/server.ts:52` | `createMcpServer` closes over one workspace | Resolve workspace per request in global mode |
| `src/server.ts:57` | One `PreviewRegistry` per server | Retain a single registry |
| `src/workspace.ts:58` | Root creation uses realpath and directory validation | Reuse canonicalization rather than inventing another workspace model |
| `src/workspace.ts:102` | Targets undergo lexical and canonical containment checks | Preserve both checks |
| `src/ast/preview-state.ts:227` | Preview capture receives `execution.workspace` | Capture canonical root at the existing state-binding point |
| `src/ast/preview-state.ts:251` | Stored state currently omits workspace root | Add immutable canonical root to preview state |
| `src/ast/preview-registry.ts` | State is copied/frozen; claim performs ready → applying without yielding | Preserve atomic claim and lifecycle behavior |
| `src/ast/guarded-apply.ts:225` | Apply receives workspace externally, claims first, then revalidates state and fresh dry-run plan | Remove caller-supplied workspace authority |
| `src/ast/transformation-plan.ts` | Transformation previews use the existing edit-preview/capture path | Bind roots through shared capture, including plan step previews |

These observations support the decisions below. They do not establish that B or C is already implemented.

### Host compatibility and operational baseline

Host facts were supplied by the read-only host scout; test facts were supplied by the independent tester and the supervisor’s supplemental evidence. Repository paths are relative to the repository root; host executable paths are relative to the user home. Evidence locations are relative to `AppData/Local/CodexRepoCaches/code-intel-mcp/` under that home.

| Item | Confirmed evidence | Limitation |
| --- | --- | --- |
| Codex | Version `0.159.2`; executable `AppData/Roaming/npm/codex.ps1`; `mcp` help exposes list/get/add/remove | Existing configuration alone does not prove MCP startup or invocation |
| Bun | Version `1.3.14`; executable `.bun/bin/bun.exe` | Native dependencies remain part of the runtime installation |
| OMP | Version `18.7.0`, Winget executable | MCP schema and reload behavior unconfirmed; installation unsupported in this slice |
| Existing `code_intel_mcp` entry | Absolute Bun executable and absolute repository `scripts/mcp-launch.mjs`; no configured cwd; environment includes `GPT_REPO_CONFIG` | Actual live host child-process cwd remains UNKNOWN; environment values are not reproduced |
| Existing `gpt_repo_stdio` entry | Node plus absolute stdio entry; no configured cwd | This is a host-entry precedent, not evidence that another provider guarantees workspace routing |
| Codex configuration | Scout confirmed command/args/env/env_vars/cwd fields | C must validate the generated entry with the installed Codex CLI |
| Reload guidance | CLI: new session; IDE: restart extension; desktop: Save + Restart | Actual propagation/reload has not been tested |
| Version/help warning | Commands exited successfully with a `.codex/tmp/arg0` permission warning | Warning is not evidence of an MCP failure |
| Baseline test command | `bun.exe test ./tests/bootstrap-launcher.test.ts ./tests/mcp-stdio.test.ts` | Direct fixture/test-client evidence |
| Baseline result | Bun `1.3.14`; exit `0`; `3 pass`, `0 fail`, `60 expect`; `1.92s` | These counts belong only to this baseline run |
| Isolation and repository state | Provider environment fully isolated; HEAD unchanged and clean | No live provider mutation was required |
| Launcher cwd behavior | Launched from an independent temporary cwd; reported identity equals that cwd | Confirms launcher dependence on cwd, not the real host’s cwd |
| Explicit-root behavior | Absolute `index.ts --workspace-root fixture` inherited runner cwd but reported fixture workspace | Confirms the existing explicit-root path |
| MCP protocol and calls | Initialize and tools/list succeeded with exactly five tools; fixture client calls included successful apply | Does not prove a real agent selected a tool |
| Missing runtime | Spawning `absent-bun.exe` produced `ENOENT` | Isolated negative observation; not an installer test |
| Missing dependency | `bun run --no-install` against a temporary intentionally missing-package fixture exited `1` with `Cannot find package` | Does not establish every native dependency failure mode |
| Invalid host configuration | Isolated `CODEX_HOME` with invalid TOML: `codex mcp list` exited `1`, reporting failed bootstrap configuration loading and an unclosed table | No live configuration was involved |
| Paths containing spaces and non-ASCII characters | Correct argument-array invocation through a `工作 space/启动 launcher.mjs` path completed initialize/tools/list with five tools | Establishes correct argv handling for the observed path; not malformed-quoting coverage |
| Bad quoting | **NOT_OBSERVED** | Do not claim coverage; C must verify generated argv and relevant malformed-input rejection |
| Real host use | Live host cwd, reload propagation, and real-agent tool selection remain unverified | Outside this slice’s demonstrated acceptance |

Baseline evidence log:

`p4a-baseline-ec92aa8b701c4ccabd6a66e4fe602a51/test-output.txt`

The supplemental negative observations are separately supplied supervisor evidence; they are not included in the three-test count above.

Keep this compact baseline in this plan. Do not create another permanent document solely for temporary command logs.

## Binding implementation decisions

### Workspace routing and preview authority

1. Retain **one `PreviewRegistry` per MCP server**. Do not add registries per root, mutable “current workspace” state, or a workspace cache. Existing TTL and capacity remain process-local and shared across roots.

2. In global mode, the following tools require a top-level, explicit, absolute `workspaceRoot`:

   - `ast_search`
   - `ast_edit_preview`
   - `ast_transform_preview`
   - `ast_transform_plan_preview`

3. A transformation plan selects one workspace for all its steps. Steps do not independently select roots.

4. Resolve and validate workspace selection at the MCP boundary, then pass `Workspace` to existing AST functions. Keep routing fields out of internal transformation contracts where those contracts already receive a validated workspace separately.

5. Store canonical `workspaceRoot` as an immutable field of preview state. Populate it from `execution.workspace.root` during capture and retain it through all registry transitions.

6. `ast_edit_apply` remains strict and accepts only `previewId`. Its implementation receives registry and preview ID, claims the record atomically, and derives the workspace from the claimed record. It must not obtain workspace authority from startup cwd, an apply argument, or mutable server state.

7. Recreating the workspace from the saved root must preserve canonical identity. A missing/invalid root or a different canonical resolution rejects the preview before mutation. Preserve existing target confinement, fingerprints, fresh dry-run, mutation-plan comparison, post-state verification, replay prevention, and terminal uncertainty semantics.

8. Keep multi-step previews and applies nontransactional. Existing partial-preview and independent-ID behavior remains.

### Global entry and legacy compatibility

1. Add a rootless global serving path. It starts the MCP server without selecting a workspace and without calling P3 provider bootstrap.

2. Preserve the existing explicit `--workspace-root` entry and old launcher as a documented fixed-root compatibility path. Old fixed-root payloads may omit `workspaceRoot`.

3. If a request supplies `workspaceRoot` in fixed-root mode, its canonical root must equal the startup root. Reject a different canonical root rather than expanding the legacy deployment’s authority.

4. Preserve the existing P3 source and its legacy behavior. Removing or redesigning it belongs to D. Tests that exercise this legacy path must use isolated provider fixtures.

5. Keep exactly five public MCP tools. Do not add a registration, installation, or diagnostic MCP tool.

### Packaging and CLI

1. Use a complete source installation directory containing source, lockfile, installed dependencies, and the existing Bun runtime requirement. Do not bundle `pi-natives` into a speculative standalone binary.

2. Add a stable `scripts/code-intel.mjs` CLI entry and a `code-intel` package bin declaration.

3. The authoritative, reproducible invocation is:

   ```text
   <absolute-bun> <absolute-install-directory>/scripts/code-intel.mjs <command>
   ```

   A shell/PATH alias is optional operator setup and must not be required for the host entry.

4. The generated host entry uses:

   ```text
   command = absolute Bun executable
   args = [absolute CLI entry, "serve"]
   ```

   It contains no workspace root, provider environment configuration, or cwd-based workspace assumption.

5. Derive runtime paths from the installed entry’s location, not the invoking process cwd. Pass executable arguments as an array; do not build a shell command string.

6. The installation directory must remain available. Moving or deleting it requires explicit reconfiguration. The CLI does not silently copy/install dependencies or change the user’s PATH.

7. Expose only the following C-scope commands:

   ```text
   code-intel serve
   code-intel install --host codex --scope user --dry-run
   code-intel install --host codex --scope user
   code-intel uninstall --host codex --scope user --dry-run
   code-intel uninstall --host codex --scope user
   code-intel print-config --host generic-stdio
   ```

8. Reject unsupported write hosts/scopes. Leave `doctor` to E. Installation is an explicit command, never an import or normal MCP startup side effect.

9. The sole parser-related dependency exception is the exact runtime dependency `@ltd/j-toml@1.38.0` and its required lockfile update. This directly supports C’s existing invalid-configuration rejection requirement. Do not upgrade or add unrelated packages. Keep `@oh-my-pi/pi-natives` pinned exactly to `18.0.3`.

   Continue distributing the complete source installation with normal installed dependencies. Retain the parser dependency’s original license and notice files; do not bundle it or omit those files. This revision does not change the existing packaging model.

### Codex configuration ownership

1. Target only Codex user configuration: selected `CODEX_HOME/config.toml`, or the normal user location when an operator explicitly invokes installation without that override. This task’s execution and validation use only isolated `CODEX_HOME` directories.

2. Use `@ltd/j-toml` pinned exactly to `1.38.0` as the necessary in-memory TOML validation dependency. Parse original and candidate configuration with the TOML 1.0 entry:

   ```ts
   parse(text, 1.0, "\n", true, null)
   ```

   Pass `null` for the extension option; do not substitute `{}` or enable extensions. Confirm the actual import shape and TypeScript declarations under the project’s Bun runtime.

   Any parsing failure must produce `CONFIG_EDIT_REFUSED` before creating directories, temporary files, backups, or replacing configuration. Validate the original configuration before reconciliation and validate the candidate before entering the existing write sequence.

   Use parsed data only for existing configuration inspection and reconciliation. Preserve the original byte-based editing strategy; do not stringify or normalize the document through the parser. Do not fall back to `Bun.TOML.parse`, implement a bespoke syntax validator, add another semantic-validation layer, or invoke Codex against temporary configuration to validate dry-run.

3. Preserve the original configuration bytes. Add the generated `code_intel_mcp` entry as a clearly marked owned tail block, including its own separator. Uninstall removes only that exact block and its separator.

4. Reconciliation rules:

   | Existing state | Install behavior | Uninstall behavior |
   | --- | --- | --- |
   | No entry | Append owned block | No-op when absent |
   | Exact owned tail block | No-op | Remove only owned block |
   | Equivalent unowned entry | Report externally managed; no ownership takeover | Do not remove it |
   | Conflicting unowned entry | Fail closed; output manual snippet | Do not remove it |
   | Modified owned block, ambiguous/duplicate entry, or owned block no longer safely removable as a tail block | Fail closed | Fail closed |
   | Invalid TOML | Fail closed | Fail closed |

5. No automatic takeover or replacement of the live existing entry is authorized.

6. A manual snippet must identify the exact command and arguments needed. It must not imply that installation or a handshake succeeded.

### Configuration writes and recovery

For a real mutation:

1. Compute the complete candidate content and validate it before replacement.
2. If the original exists, save its exact bytes in a separate backup. Abort if backup creation fails.
3. Write the candidate to a temporary file in the configuration directory.
4. Before replacement, compare the current configuration bytes with those originally read. Abort on change.
5. Replace atomically where supported. Do not fall back to truncate-and-rewrite.
6. Report the backup location and restore guidance.

Dry-run must create no configuration, directory, temporary file, or backup. Idempotent no-op operations must not create new backups.

No hashes, migration framework, provider synchronization, or multi-file transaction machinery are required.

## Execution units

Dependency order:

```text
A1 → B1 → B2 → B3 → C1 → C2 → C3
```

B1 and B2 may be implemented together to avoid a broken intermediate build, but their acceptance evidence remains separately identifiable.

### A1 — Establish the read-only baseline

**Depends on:** None.

**Scope:**

- Integrate the supplied scout, independent tester, and supplemental negative evidence into this plan’s baseline table.
- Record confirmed host schema, executable paths, runtime versions, reload guidance, and unknowns.
- Select the packaging and installation contract defined above.
- Reuse the completed baseline; do not duplicate scout/tester commands merely to regenerate evidence.

**Acceptance:**

- A maintainer can reproduce the direct MCP handshake from the recorded command and isolation description.
- Registration, process startup, initialize, tools/list, fixture calls, and real-agent calls are distinguished.
- The launcher’s cwd coupling and the explicit-root entry’s behavior are stated accurately.
- No host configuration or provider state was changed.
- Missing-runtime, missing-package, invalid-TOML, and correct argv observations are recorded at their actual evidence level.
- Bad quoting remains explicitly `NOT_OBSERVED`; generated CLI/configuration validation belongs to C.

**Validation:**

- Independent tester result: exit 0, three passing baseline tests, isolated providers, unchanged clean HEAD.
- Host scout result: actual configuration present; actual live host cwd/reload/agent invocation unverified.
- Supplemental evidence: isolated `ENOENT`, missing package, invalid TOML, and successful correct-argv launch from a path containing spaces and non-ASCII characters.
- Recorded baseline evidence is sufficient; no additional broad discovery or repeated baseline run is required.

**Exit:** Baseline evidence is complete. Reviewer may seal the execution plan without waiting for another A test run.

### B1 — Freeze workspace authority into preview state

**Depends on:** A1.

**Scope:**

- `src/ast/preview-registry.ts`
- `src/ast/preview-state.ts`
- `src/ast/guarded-apply.ts`
- Direct callers and focused tests affected by the apply signature change

**Acceptance:**

- Every nonempty preview stores the canonical root used to produce it.
- The stored root is immutable and retained by lifecycle transitions.
- Apply obtains authority exclusively from the claimed preview record.
- Claim remains atomic and precedes asynchronous root reconstruction/revalidation.
- Invalid or changed root identity rejects before native mutation.
- Existing TTL, capacity, stale, replay, dry-run comparison, verification, and uncertainty behavior remains intact.
- Zero-match previews still issue no apply identity.

**Validation:**

- Extend preview-registry tests to cover root storage and immutability.
- Extend guarded-apply tests for frozen-root use and root invalidation before write.
- Exercise concurrent claims, expired IDs, replay, stale content, fresh-plan mismatch, and uncertain post-mutation results using existing focused tests.
- Verify rejection paths leave fixture bytes unchanged.

**Exit:** Focused state/apply tests pass, and apply no longer accepts externally selected workspace authority.

### B2 — Route requests and preserve fixed-root compatibility

**Depends on:** B1.

**Scope:**

- `src/server.ts`
- `src/workspace.ts`
- MCP schema composition and request handlers
- Global and legacy startup entrypoints
- Focused workspace/schema/startup tests

**Acceptance:**

- Global search and all three preview tools require an absolute `workspaceRoot`.
- Root validation checks presence, absolute-path form, existence, directory shape, and canonicalization.
- Existing lexical and canonical target confinement remains effective.
- Transformation plans use one request root across all steps.
- Apply rejects added root/path/operation fields and still accepts only `previewId`.
- Exactly five tools remain.
- Global serving selects no implicit workspace and performs no provider bootstrap.
- Legacy startup and payloads remain usable; an explicitly supplied differing canonical root is rejected.

**Validation:**

- Schema tests for missing/relative root and unexpected apply fields.
- Workspace tests for nonexistent root, file-as-root, traversal, sibling-prefix escape, and symlink escape where supported.
- Legacy tests for omitted root, equivalent canonical root, and differing root.
- Verify global startup does not call provider registration paths.
- Run the existing launcher checks with isolated providers.

**Exit:** Request routing and compatibility checks pass without weakening existing containment.

### B3 — Prove multi-workspace process behavior

**Depends on:** B2.

**Scope:**

- Focused process-level MCP tests
- Existing MCP apply tests affected by request schemas
- Relevant README and architecture updates

**Acceptance:**

- One process supports A → B → A requests without restart.
- A and B previews may coexist; changing request workspace does not invalidate unrelated previews.
- Applying B’s identity modifies only its frozen B scope.
- All four search/preview surfaces use request workspace selection.
- Preview-only calls leave source bytes unchanged.
- Two previews selecting the same file through different canonical parent/child roots retain distinct reviewed authority.
- Existing nontransactional plan behavior and five-tool catalog remain unchanged.
- Documentation distinguishes global mode from legacy fixed-root mode and describes frozen preview authority.

**Validation:**

- Initialize and tools/list verify the exact catalog and schemas.
- Process tests alternate and overlap A/B requests.
- Verify fixture bytes before preview, after preview, and after selected apply.
- Exercise stale and replayed previews and distinct-root scope binding.
- Run existing relevant guarded-apply and MCP integration regressions.

**Exit:** Multi-workspace process tests and related regressions pass; affected current documentation is accurate.

### C1 — Provide the stable CLI and runtime entry

**Depends on:** B3.

**Scope:**

- `package.json` bin declaration
- `scripts/code-intel.mjs`
- Necessary `src/cli/` command dispatch
- Rootless global serving entry
- Generic stdio snippet generation
- Focused runtime/CLI tests

**Acceptance:**

- The absolute Bun plus absolute CLI invocation works independently of cwd.
- The generated host entry launches `serve` without a workspace, provider env, or shell quoting dependency.
- `pi-natives` remains pinned exactly to `18.0.3`.
- Runtime dependencies remain in the complete installation directory.
- Missing runtime/dependency and invalid invocation failures are explicit.
- MCP stdout contains only protocol traffic.
- Unsupported commands/hosts/scopes do not trigger writes.
- Generated argv preserves paths containing spaces and non-ASCII characters as single argument values.

**Validation:**

- Launch the new stable entry from an unrelated cwd.
- Exercise installation/fixture paths containing spaces and non-ASCII characters.
- Verify generated command/argument arrays, including read-back through Codex in C3.
- Use isolated fixtures for missing executable/dependency and malformed invocation/configuration cases; do not damage the actual runtime installation.
- Confirm failures do not modify configuration or provider state.
- Confirm the stable entry completes initialize and tools/list.
- Do not label the earlier correct-argv baseline as a bad-quoting test; report any new malformed-input test by its actual behavior.

**Exit:** Stable launch and failure cases pass with no unrelated dependency change.

### C2 — Implement reversible Codex user configuration

**Depends on:** C1.

**Scope:**

- Codex user-scope adapter
- Owned tail-block generation/reconciliation
- TOML validation
- Backup, temporary write, byte comparison, and atomic replacement
- Focused installer/uninstaller tests

**Acceptance:**

- Install and uninstall require explicit supported host and scope.
- Dry-run reports the proposed change and creates no files or directories.
- Fresh install creates one owned entry.
- Repeated install is a no-op.
- Uninstall removes only the exact owned entry.
- Equivalent pre-existing unowned entries remain externally managed.
- Unrelated entries, comments, and unknown settings remain byte-for-byte unchanged.
- Unsafe edits fail closed with a manual snippet.
- Real mutations preserve a backup and avoid truncate-and-rewrite.
- Failed or no-op operations do not mutate providers.
- Original and candidate TOML are validated entirely in memory using the exact parser/version/options above.
- Malformed ordinary configuration is rejected as `CONFIG_EDIT_REFUSED` before filesystem mutation.
- Invalid configuration causes both real and dry-run install/uninstall to leave configuration bytes and directory contents unchanged.
- Valid ordinary configuration continues through the existing ownership and byte-preserving reconciliation rules.

**Validation:**

- Fixtures for absent configuration, empty configuration, comments, unknown settings, other MCP entries, and original content without a trailing newline.
- Fixtures for equivalent unowned entries, conflicts, modified owned blocks, blocks followed by other content, duplicate/ambiguous entries, and invalid TOML.
- Install → reinstall → uninstall comparison against original bytes.
- Dry-run comparison of both configuration bytes and directory contents.
- Controlled backup failure, temporary write failure, replacement failure, and configuration change before replacement; prove original configuration is not overwritten.
- Confirm no automatic takeover and no unrelated entry removal.
- Verify the actual Bun import and TypeScript API.
- Preserve the exact regression fixture `"[invalid\n"` and require rejection.
- Cover ordinary unterminated quoted strings, duplicate keys, and duplicate tables.
- Exercise valid ordinary commented configuration with unrelated settings and another MCP entry.
- Verify original-config rejection and candidate validation occur before the write sequence.
- Retain the existing ownership, idempotence, uninstall, backup, concurrent-change detection, atomic-replacement, and dry-run checks.
- Do not expand this repair into an exhaustive TOML conformance suite or exotic-format investigation.

**Exit:** Ownership, preservation, reversibility, and failure tests pass.

### C3 — Validate real Codex integration in isolation

**Depends on:** C2.

**Scope:**

- Temporary isolated `CODEX_HOME`
- Installed real Codex CLI
- MCP client handshake using configuration read back from Codex
- Necessary setup, reload, limitation, and recovery documentation

**Acceptance:**

- Fresh install into isolated user configuration is recognized by real `codex mcp get/list`.
- The command and arguments read back from that configuration start the service successfully.
- Initialize and tools/list return the expected five tools.
- Repeat installation is idempotent.
- Uninstall removes the owned entry and retains unrelated configuration/comments.
- No live user configuration or provider state is modified.
- Documentation separates successful config integration and direct handshake from untested real-agent selection/reload.

**Validation:**

1. Create an isolated home with unrelated settings, another MCP entry, and comments.
2. Set `CODEX_HOME` only for the relevant child processes.
3. Run dry-run and prove no changes.
4. Install.
5. Run real `codex mcp get/list`.
6. Use the returned executable/arguments to start the server and perform initialize/tools/list.
7. Reinstall and prove no changes or duplicate entry.
8. Uninstall and compare the retained configuration with its original bytes.
9. Exercise invalid configuration and launch-failure fixtures without touching live configuration.
10. Include a runtime path containing spaces and non-ASCII characters in generated configuration/read-back validation.

**Exit:** The real Codex configuration and direct MCP integration sequence passes in isolation.

## C-TOML-R1 — Strict in-memory TOML validation

**Status: SEALED — revision approved by independent reviewer PASS (CstrictPlanReview); implementation accepted in the final C1–C3 and A–C review after C-01.**

### Evidence

- Independent targeted CLI/config validation returned **23 pass, 1 fail**: `Bun.TOML.parse` accepted invalid configuration `"[invalid\n"`, so the operation did not reject it as required.
- The implementer confirmed the same behavior for string and Buffer inputs, with no available strict option. The original Bun-parser decision cannot enforce the invalid-configuration fail-closed contract.
- Scout excluded `smol-toml@1.9.1` and `@iarna/toml@2.2.5`: the former does not provide the required TOML 1.0 mode, and the latter’s published version declares TOML 0.5.
- Scout’s official-source evidence supports exact `@ltd/j-toml@1.38.0`: TOML 1.0, in-memory string parsing, disabled extensions, CJS/ESM/TypeScript entries, no runtime dependencies, and LGPL-3.0 licensing. Fixed source includes rejection paths for missing `]`, duplicate tables, and duplicate keys. Actual Bun import, type, and runtime checks are covered by the final acceptance evidence below. Sources: [official npm](https://www.npmjs.com/package/%40ltd/j-toml), [fixed-version source directory](https://github.com/LongTengDao/j-toml/tree/b843be0ede8d7857d0d33c5bcff3a33c245a2ec1/dist/NPM).

### Bounded implementation brief

**Objective:** Restore C’s existing invalid-Codex-configuration fail-closed behavior by replacing the inadequate parser. A/B acceptance remains valid.

**Dependencies and order:**

1. Independent reviewer seals this focused revision.
2. Implementer applies the parser replacement, exact dependency/lockfile change, and focused tests under the revised plan.
3. Independent tester validates the candidate.
4. Reviewer evaluates repaired C under the existing unattended acceptance process.

**Allowed scope:**

- `package.json` and the existing lockfile.
- The existing C configuration parsing/validation module and directly affected imports/types.
- Focused CLI/configuration tests.
- The specified execution-plan edits.

No configuration adapter redesign, new provider integration, runtime upgrade, generic parser framework, or additional host support is authorized.

**Implementation requirements:**

- Add only `"@ltd/j-toml": "1.38.0"` as the necessary runtime parser dependency.
- Replace the existing parser call with the TOML 1.0 invocation in “Codex configuration ownership” item 2, mapping exceptions to existing `CONFIG_EDIT_REFUSED` behavior.
- Preserve absent-configuration handling, ownership, manual snippets, byte-preserving edits, backups, and atomic replacement.
- Validate loaded original text and constructed candidate text before mutation, entirely in memory. Reading the selected configuration is allowed; validation must not create a temporary Codex home or file.
- Retain the dependency’s original license files in the complete installation.
- Do not introduce a fallback parser or syntax-specific patch for the observed bracket case.

**Validation requirements:**

| Check | Required evidence |
| --- | --- |
| Import and types | Actual Bun import succeeds; `bun run typecheck` passes |
| Exact regression | `"[invalid\n"` produces `CONFIG_EDIT_REFUSED` |
| Ordinary invalid syntax | Unterminated quoted string, duplicate key, and duplicate table reject |
| No-write rejection | Real/dry-run install and uninstall preserve invalid config bytes and create no directory/temp/backup artifacts |
| Valid configuration | Ordinary valid fixture remains accepted; unrelated content and comments retain original bytes |
| Existing contracts | Targeted CLI/config tests pass, including ownership, no-op reinstall, owned-only uninstall, backup and replacement failures |
| Host integration | Existing isolated `CODEX_HOME` install → real `codex mcp get/list` → read-back launch/handshake → reinstall/uninstall checks pass |
| Repository validation | Existing final typecheck/full-suite requirements remain; legacy provider tests stay isolated |

The **23 pass / 1 fail** result is pre-repair evidence only. Report actual post-repair results rather than predicting counts.

**Exit criteria:**

- The exact regression and ordinary invalid-syntax cases reject before writes.
- Valid configuration and every existing C ownership/dry-run/recovery contract remain intact.
- Bun import/type compatibility and isolated Codex integration pass.
- Package and lockfile changes contain only the necessary parser addition, with the native pin unchanged.
- Independent tester evidence is complete and reviewer accepts repaired C.

**Stop conditions:** Stop and return concrete evidence if the selected parser/options fail required ordinary cases, Bun import/types fail, distribution cannot retain dependency license files, or repair requires a different parser or broader change. Do not lower validation requirements or bypass zero-files dry-run.

The existing hard deadline remains **2026-10-18T16:11:28Z**.

## Validation and phase acceptance

### Observed final acceptance

The independent tester supplied the following post-C-01 results. Final independent reviewer **PASS** accepts C1–C3 and closes A–C regression acceptance; A/B acceptance is retained.

| Check | Observed result |
| --- | --- |
| Targeted CLI/configuration tests | 37 pass, 0 fail, 300 expect |
| Actual native Codex integration | 1 pass, 0 skip, 35 expect |
| Typecheck | Exit 0 |
| Full suite | 186 pass, 0 fail, 1,404 expect, 21 files, 15.36s |

Evidence cache: `p4c-c01-f5b07c76f01c42bd83938013f8af7bb0`.

The parser installation was restored from all 12 official `dist/NPM` files at npm gitHead `e946ce04db3d72ce59653c4e3daad86681f1de37`, retaining the LGPL-3.0 license. The normal registry lock uses the official npm integrity metadata. The restored directory totals 810,956 bytes, while npm metadata reports 811,779 unpacked bytes. Fresh npm registry download and npm tarball byte identity/integrity verification remain **UNVERIFIED**; the existing-install frozen-lockfile check does not establish either.

Acceptance covers A–C only. It does not establish D–F completion, real-agent adoption, live-host reload propagation, or full host sandbox enforcement.

### Acceptance requirements

During implementation, run the smallest relevant checks for each unit. Do not repeat the completed A baseline solely for reassurance.

Before accepting A–C:

- Run `bun run typecheck`.
- Run the existing full test suite after the targeted checks pass.
- Ensure tests exercising legacy bootstrap use isolated provider fixtures.
- Record actual commands, outcomes, and limitations; do not invent test counts.
- Submit the implemented slice and evidence for independent review.
- Under `human_supervisor=false`, acceptance requires reviewer `PASS`.

A–C is complete only when:

1. A’s baseline is recorded accurately.
2. B’s multi-workspace routing, frozen authority, safety regressions, and compatibility pass.
3. C’s installer ownership/recovery tests and isolated real Codex config integration pass.
4. Relevant current README/architecture/setup descriptions match the implementation.
5. Independent review passes.

Do not claim that these results establish real-agent adoption, full host sandbox enforcement, OMP support, or completion of D–F.

## Assumptions and material risks

- The implementation continues to use the installed Bun runtime and exact `pi-natives@18.0.3`.
- The previous assumption that Bun’s built-in parser could enforce invalid-configuration rejection has been falsified by the `"[invalid\n"` regression. The replacement parser’s documented TOML 1.0 mode and disabled-extension invocation must be verified under Bun by focused import, typecheck, and behavioral tests. If the exact dependency or invocation fails those checks, stop C-TOML-R1 and return the concrete failure to the supervisor; do not relax the configuration contract or silently substitute another parser.
- The complete installation directory is durable operator-managed runtime storage. Moving it invalidates absolute configuration paths.
- Windows paths are interpreted by the running OS. Do not automatically translate Windows and WSL paths. Preserve native UNC semantics; report untested environments honestly.
- Existing legacy startup may perform provider registration. Its tests must remain isolated, while global serving must avoid that path.
- Valid configurations outside the safely editable owned-tail form may be rejected. This is an intentional manual-snippet fallback, not permission to rewrite unrelated content.
- Atomic replacement behavior is platform-dependent. If safe replacement cannot be performed, fail closed rather than truncate the existing configuration.
- Existing AST apply retains its documented final validation/write interval and terminal uncertainty semantics; this work does not claim filesystem transactions.
- The live existing `code_intel_mcp` entry is not owned by the new installer. This task does not migrate or remove it.
- Successful correct-argv handling does not establish malformed-quoting behavior. Evidence and final reporting must retain that distinction.

## Stop and escalation conditions

Stop the affected unit and return evidence to the supervisor if:

- A preview or rejected apply writes unexpectedly.
- Root authority can be redirected or a cross-workspace write occurs.
- Configuration outside the owned entry is lost or changed.
- A test or implementation attempts to modify live user configuration or provider state.
- Safe configuration parsing/replacement cannot be achieved within the chosen contract.
- Completion requires D–F work, another host adapter, dependency expansion, or additional authority.
- The independent reviewer returns `BLOCK`.

The execution hard deadline is **2026-10-18T16:11:28Z**. Stop at that boundary, report completed and incomplete units, and preserve validation gaps. Do not weaken acceptance criteria or describe an unverified unit as complete to meet the deadline.

No unresolved user authority decision is required to begin the sealed A–C implementation.
